import type { EnergyReason, EnergySettings, EnergyView } from '../../shared/energy';
import type { BatteryInfo, EnergyCaps, EnergyPlatform, Hold } from './types';

// When the PC is kept awake, whatever the platform: while workers work (and a little after, so a worker between two
// turns does not switch plans back and forth), for as long as the user asked, while workers move to or from the
// server. On battery at or under the user's floor it lets go and, lid closed or nobody at the keyboard, hibernates
// the PC rather than letting it die; nothing is held again until it is plugged in or charged. A hold that ends with
// the lid closed does what the lid would have done, so the PC does not stay awake in a bag until it is empty.

export interface Timers {
  set(fn: () => void, ms: number): () => void;
  now(): number;
}

const realTimers: Timers = {
  set: (fn, ms) => {
    const h = setTimeout(fn, ms);
    h.unref();
    return () => clearTimeout(h);
  },
  now: () => Date.now(),
};

export interface EnergyManagerOptions {
  /** Null where the module does not run. */
  platform: EnergyPlatform | null;
  settings(): EnergySettings;
  /** Seconds since the last keyboard or mouse input. */
  idleSeconds(): number;
  /** Shown by the system with the hold. */
  reason(): string;
  publish(view: EnergyView): void;
  log?(message: string): void;
  timers?: Timers;
  /** How long the PC stays held after the last worker stopped. */
  lingerMs?: number;
  /** How often the battery is read while it matters, on top of the system's notifications. */
  checkMs?: number;
}

/** Charged this much above the floor, the battery guard lets holds come back. */
const GUARD_MARGIN = 5;
/** Nobody at the keyboard for this long: the battery guard hibernates the PC even with its lid open. */
const AWAY_S = 300;
/** A hold that ends with the lid closed and someone typing (an external keyboard) does not put the PC to sleep. */
const LID_IDLE_S = 60;
/** A hold wanted and not there (refused, or the system not answering) is asked again this much later, not in a loop. */
const RETRY_MS = 60_000;
/** The system asked again for its capabilities this many times at most, then only when the settings open. */
const CAPS_TRIES = 5;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class EnergyManager {
  private readonly timers: Timers;
  private caps: EnergyCaps | null = null;
  private battery: BatteryInfo | null = null;
  private hold: Hold | null = null;
  private holdLid = false;
  private busy = false;
  private lingering = false;
  private cancelLinger: (() => void) | null = null;
  /** The user's own request: undefined none, null until stopped, else its end. */
  private manualUntil: number | null | undefined = undefined;
  private cancelManual: (() => void) | null = null;
  private moves = 0;
  private guard = false;
  private lid: boolean | null = null;
  private error: string | null = null;
  private chain: Promise<void> = Promise.resolve();
  private unwatch: (() => void)[] = [];
  private cancelCheck: (() => void) | null = null;
  private cancelRetry: (() => void) | null = null;
  private capsTries = 0;
  private stopped = false;

  constructor(private readonly o: EnergyManagerOptions) {
    this.timers = o.timers ?? realTimers;
  }

  /** Undoes what a crashed run left, then reads what the system can do. */
  async start(): Promise<void> {
    const p = this.o.platform;
    if (p) {
      try {
        const n = await p.restoreLeftovers();
        if (n > 0) this.o.log?.(`energy: ${n} change(s) left by an earlier run undone`);
      } catch (err) {
        this.o.log?.(`energy: leftovers not undone: ${message(err)}`);
      }
      await this.readCaps();
      await this.readBattery();
    }
    await this.reconcile();
  }

  private async readCaps(): Promise<void> {
    const p = this.o.platform;
    if (!p) return;
    this.capsTries++;
    try {
      this.caps = await p.caps();
    } catch (err) {
      this.error = message(err);
    }
  }

  view(): EnergyView {
    return {
      caps: this.caps,
      battery: this.battery,
      awake: this.hold !== null,
      lidClosed: this.hold?.lidClosedEffective ?? false,
      reasons: this.reasons(),
      until: this.manualUntil ?? null,
      guard: this.guard,
      error: this.error,
    };
  }

  /** Reads the battery again (the settings opened, the PC woke up). */
  async refresh(): Promise<EnergyView> {
    if (!this.caps?.holdAwake) await this.readCaps();
    await this.readBattery();
    this.publish();
    return this.view();
  }

  /** Whether any worker is at work: called on every change of the sessions, acted on at each turn of it. */
  setBusy(busy: boolean): void {
    if (busy === this.busy) return;
    this.busy = busy;
    this.cancelLinger?.();
    this.cancelLinger = null;
    if (busy) this.lingering = false;
    else {
      this.lingering = true;
      this.cancelLinger = this.timers.set(() => {
        this.cancelLinger = null;
        this.lingering = false;
        void this.reconcile();
      }, this.o.lingerMs ?? 120_000);
    }
    void this.reconcile();
  }

  /** Kept awake for that many minutes, or until stopped (null); 0 stops it. */
  keepAwake(minutes: number | null): void {
    this.cancelManual?.();
    this.cancelManual = null;
    if (minutes === 0) this.manualUntil = undefined;
    else if (minutes === null) this.manualUntil = null;
    else {
      const ms = Math.max(1, minutes) * 60_000;
      this.manualUntil = this.timers.now() + ms;
      this.cancelManual = this.timers.set(() => {
        this.cancelManual = null;
        this.manualUntil = undefined;
        void this.reconcile();
      }, ms);
    }
    void this.reconcile();
  }

  /** Kept awake until the returned function is called (workers moving to or from the server). */
  claim(): () => void {
    this.moves++;
    void this.reconcile();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.moves--;
      void this.reconcile();
    };
  }

  settingsChanged(): void {
    if (this.guard && this.battery) this.judge(this.battery);
    void this.reconcile();
  }

  /** The hub quits: everything put back, the PC left as it was. */
  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const cancel of [this.cancelLinger, this.cancelManual, this.cancelCheck, this.cancelRetry]) cancel?.();
    this.cancelLinger = this.cancelManual = this.cancelCheck = this.cancelRetry = null;
    await this.reconcile();
  }

  /** The screen off now (the user's button); the PC goes on. */
  async displayOff(): Promise<void> {
    await this.o.platform?.displayOff();
  }

  /** True while something is to be put back at quit. */
  holding(): boolean {
    return this.hold !== null;
  }

  private reasons(): EnergyReason[] {
    const r: EnergyReason[] = [];
    if (this.o.settings().whileWorking && (this.busy || this.lingering)) r.push('workers');
    if (this.manualUntil !== undefined) r.push('manual');
    if (this.moves > 0) r.push('move');
    return r;
  }

  /** What hold there should be now: none, or one with the lid closable or not. */
  private wanted(): { lidClosed: boolean } | null {
    if (this.stopped || !this.o.platform || !this.caps?.holdAwake || this.guard || this.reasons().length === 0) return null;
    return { lidClosed: this.o.settings().lidClosed && this.caps.lidClosedAwake };
  }

  /** One change at a time: a hold is never taken while the previous one is still being put back. */
  private reconcile(): Promise<void> {
    this.chain = this.chain.then(() => this.apply()).catch((err: unknown) => this.o.log?.(`energy: ${message(err)}`));
    return this.chain;
  }

  private async apply(): Promise<void> {
    const wanting = !this.stopped && this.o.platform !== null && this.reasons().length > 0;
    // The system did not answer at start (a slow login, a refused helper): asked again while a hold is wanted.
    if (wanting && !this.caps?.holdAwake && this.capsTries < CAPS_TRIES) await this.readCaps();
    let want = this.wanted();
    if (this.hold && (!want || want.lidClosed !== this.holdLid)) await this.drop(!want);
    if (want && !this.hold && this.caps?.battery) {
      // No hold taken at or under the floor: the battery is read first.
      await this.readBattery();
      want = this.wanted();
    }
    if (want && !this.hold && this.o.platform) {
      try {
        this.hold = await this.o.platform.hold({ reason: this.o.reason(), lidClosed: want.lidClosed, allowDisplaySleep: true });
        this.holdLid = want.lidClosed;
        this.error = null;
      } catch (err) {
        this.error = message(err);
      }
    }
    if (wanting && !this.hold && !this.guard && (this.caps?.holdAwake || this.capsTries < CAPS_TRIES)) {
      this.cancelRetry ??= this.timers.set(() => {
        this.cancelRetry = null;
        void this.reconcile();
      }, RETRY_MS);
    }
    this.watch(this.hold !== null || (this.guard && !this.stopped));
    this.publish();
  }

  /** `ending`: no hold follows. With the lid closed and nobody typing, the PC then does what its lid asks. */
  private async drop(ending: boolean): Promise<void> {
    const hold = this.hold;
    if (!hold) return;
    this.hold = null;
    const lidAction = hold.lidAction ?? 'sleep';
    const closed = this.lid === true && hold.lidClosedEffective;
    await hold.release();
    if (ending && closed && !this.guard && !this.stopped && lidAction !== 'none' && this.o.idleSeconds() >= LID_IDLE_S) {
      this.o.log?.(`energy: hold over with the lid closed: ${lidAction}`);
      await this.o.platform?.suspend(lidAction).catch((err: unknown) => this.o.log?.(`energy: ${lidAction} refused: ${message(err)}`));
    }
  }

  /** The lid and the power source followed, and the battery read every so often, while a hold or the guard needs it. */
  private watch(on: boolean): void {
    const p = this.o.platform;
    if (!on || !p) {
      for (const off of this.unwatch) off();
      this.unwatch = [];
      this.cancelCheck?.();
      this.cancelCheck = null;
      this.lid = null;
      return;
    }
    if (this.unwatch.length === 0) {
      if (p.onLidChange)
        this.unwatch.push(
          p.onLidChange((closed) => {
            this.lid = closed;
            this.publish();
          }),
        );
      if (p.onPowerSourceChange) this.unwatch.push(p.onPowerSourceChange((b) => this.judge(b)));
      // Nothing to unsubscribe: still marks the watch as on.
      if (this.unwatch.length === 0) this.unwatch.push(() => undefined);
    }
    if (!this.cancelCheck) this.check();
  }

  private check(): void {
    this.cancelCheck = this.timers.set(() => {
      this.cancelCheck = null;
      if (this.stopped || (!this.hold && !this.guard)) return;
      void this.readBattery().then(() => {
        if (!this.cancelCheck && !this.stopped && (this.hold || this.guard)) this.check();
      });
    }, this.o.checkMs ?? 60_000);
  }

  private async readBattery(): Promise<void> {
    const p = this.o.platform;
    if (!p || (this.caps && !this.caps.battery)) return;
    try {
      this.judge(await p.battery());
    } catch {
      // Unreadable this time: the last reading stays.
    }
  }

  /** The battery guard, at each reading. */
  private judge(b: BatteryInfo): void {
    this.battery = b;
    const floor = this.o.settings().batteryFloor;
    const low = b.present && b.source === 'battery' && b.percent !== null && b.percent <= floor;
    if (this.guard) {
      if (b.source === 'ac' || (b.percent !== null && b.percent >= floor + GUARD_MARGIN)) {
        this.guard = false;
        void this.reconcile();
      } else this.publish();
      return;
    }
    if (!low) return this.publish();
    if (!this.hold) {
      // A hold about to be taken is not: nobody was kept awake, so nothing hibernates.
      if (this.reasons().length === 0) return this.publish();
      this.guard = true;
      void this.reconcile();
      return;
    }
    this.guard = true;
    const closed = this.lid === true;
    this.o.log?.(`energy: battery at ${b.percent}% (floor ${floor}%): hold ended`);
    void this.reconcile().then(async () => {
      // Plugged in meanwhile: the guard is off again, the PC stays as it is.
      if (this.stopped || !this.guard || !(closed || this.o.idleSeconds() >= AWAY_S)) return;
      this.o.log?.('energy: battery low, nobody at the PC: hibernating');
      await this.o.platform?.suspend('hibernate').catch((err: unknown) => this.o.log?.(`energy: hibernation refused: ${message(err)}`));
    });
  }

  private publish(): void {
    this.o.publish(this.view());
  }
}
