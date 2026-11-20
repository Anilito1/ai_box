// The energy module's contract with the operating system: keeping the PC awake while workers run, lid closed
// included, and putting back everything it changed. The core (manager.ts) knows nothing of a platform; each adapter
// (win32.ts, linux.ts) implements EnergyPlatform with its system calls behind a function it is given, so tests run
// on a fake system and never touch the machine.

export type PowerSource = 'ac' | 'battery';

export interface BatteryInfo {
  present: boolean;
  /** 0-100, null when the system does not say. */
  percent: number | null;
  charging: boolean | null;
  source: PowerSource;
  minutesLeft: number | null;
}

export interface EnergyCaps {
  platform: 'win32' | 'linux';
  /** Keeps idle sleep away. */
  holdAwake: boolean;
  /** Keeps running with the lid closed. */
  lidClosedAwake: boolean;
  /** lidClosedAwake needs administrator (root) rights. */
  needsElevation: boolean;
  battery: boolean;
  displayOff: boolean;
  radios: boolean;
  /** Why a capability is missing, in words the user can be shown. */
  notes: string[];
}

export interface HoldOptions {
  /** Shown by the system where it lists what keeps the PC awake. */
  reason: string;
  lidClosed: boolean;
  allowDisplaySleep: boolean;
}

export type SuspendMode = 'sleep' | 'hibernate';

export interface Hold {
  /** Puts back everything the hold changed. Idempotent; never rejects: what it could not put back stays recorded
   *  for restoreLeftovers at the next start. */
  release(): Promise<void>;
  /** The lid can be closed without the PC going to sleep (lidClosed was asked and the system took it). */
  readonly lidClosedEffective: boolean;
  /** What the system would have done on closing the lid without the hold, for the current power source. The core
   *  does it itself when a hold ends with the lid closed (otherwise the PC stays awake until the battery is empty).
   *  Absent: the adapter cannot tell, the core assumes 'sleep'. */
  readonly lidAction?: 'none' | SuspendMode;
}

export interface EnergyPlatform {
  caps(): Promise<EnergyCaps>;
  battery(): Promise<BatteryInfo>;
  /** Reversible: release() puts back everything that was changed. A failure half-way undoes what was done, then rejects. */
  hold(o: HoldOptions): Promise<Hold>;
  /** After a crash: undoes what an earlier run left changed (its snapshot file). Returns how many changes it undid. */
  restoreLeftovers(): Promise<number>;
  displayOff(): Promise<void>;
  /** Asks the system to sleep (or hibernate; sleep where hibernation is unavailable). Resolves once asked. */
  suspend(mode: SuspendMode): Promise<void>;
  /** Called with the current state soon after subscribing, then on each change. Returns the unsubscribe. */
  onLidChange?(cb: (closed: boolean) => void): () => void;
  onPowerSourceChange?(cb: (b: BatteryInfo) => void): () => void;
}

/** What every adapter is built with; each adds its own injectable system (`sys`) for tests. */
export interface EnergyDeps {
  /** Where the adapter keeps its snapshot of what it changed. */
  dataDir: string;
}
