import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { t } from '../i18n';
import type { BatteryInfo, EnergyCaps, EnergyDeps, EnergyPlatform, Hold, HoldOptions, PowerSource, SuspendMode } from './types';

// Windows: keeping the PC awake while workers run, lid closed included. Measured on the development PC (desktop,
// S3 sleep and hibernation, no Modern Standby, no lid, no battery; standard user):
//
// - Idle sleep: a SystemRequired power request (PowerCreateRequest), held by a small PowerShell helper whose life is
//   the hold's. Electron's powerSaveBlocker only takes ExecutionRequired, which implies SystemRequired on S3 machines
//   but not on Modern Standby ones; and it has no lid event. The helper compiles its calls when it starts (0.2 s
//   measured) like winJobs.ts, so no native module ships. When the hub ends, however it ends, the helper's input
//   closes: Windows drops its request with the process.
// - The lid: no power request survives a sleep the user asks for (lid, power button), so the lid's action has to be
//   "do nothing". The user's plan is left alone: a copy of it (powercfg /duplicatescheme) gets LIDACTION 0 on mains
//   and battery and is made active for the hold, then the original comes back and the copy is deleted. All of it
//   works without administrator rights (measured: duplicate, set values, set active, back, delete in 1.2 s).
//   On Modern Standby machines a battery request ends 5 minutes after the sleep timeout, so the copy also never
//   sleeps on idle (STANDBYIDLE 0); there, it is used for every hold, lid or not.
// - What could be left changed: a snapshot file is written before the copy exists. A hub that crashes leaves its
//   helper, which puts the original plan back once its input closes; the next start (restoreLeftovers) does it
//   otherwise. Only what we changed is undone: a plan the user picked meanwhile stays.
// - The screen: Windows turns the built-in panel off when the lid closes, so nothing is done there; displayOff()
//   is the user's own button (SC_MONITORPOWER).
// - Battery and events: GetSystemPowerStatus, and the lid, power source and battery percentage notifications
//   (PowerSettingRegisterNotification), through the same helper while a hold or a subscription needs it.
// - Radios: left alone. Wi-Fi is the workers' link to their providers; Bluetooth saves little and cutting it would
//   drop the user's devices.

const SYSTEM = process.env.SystemRoot ?? 'C:\\Windows';
const POWERCFG = join(SYSTEM, 'System32', 'powercfg.exe');
const POWERSHELL = join(SYSTEM, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const SUB_BUTTONS = '4f971e89-eebd-4455-a8de-9e59040e7347';
const LIDACTION = '5ca83367-6e45-459f-a27b-476b1d01c936';
const SUB_SLEEP = '238c9fa8-0aad-41ed-83f4-97be242c8f20';
const STANDBYIDLE = '29f6c1db-86da-48c5-9fdb-f2b67b1f44da';
const SUB_BATTERY = 'e73a048d-bf27-4f12-9731-8b2076e8891f';
const BATACTIONCRIT = '637ea02f-bbcb-4015-8e2c-a1c7b9c0b546';
/** Windows' own Balanced plan: where we go back when the user's plan no longer exists. */
const BALANCED = '381b4222-f694-41f0-9685-ff5bb260df2e';

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SNAPSHOT = 'energy-win32.json';

const SOURCE = `
using System;
using System.Runtime.InteropServices;
public static class HubPower {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr PowerCreateRequest(ref REASON reason);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool PowerSetRequest(IntPtr request, int type);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool PowerClearRequest(IntPtr request, int type);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool GetSystemPowerStatus(out STATUS s);
  [DllImport("powrprof.dll")] static extern bool GetPwrCapabilities([Out] byte[] caps);
  [DllImport("powrprof.dll")] static extern uint PowerSettingRegisterNotification(ref Guid setting, uint flags, ref SUBSCRIBE recipient, out IntPtr handle);
  [DllImport("powrprof.dll", SetLastError = true)] static extern bool SetSuspendState(bool hibernate, bool force, bool noWakeEvents);
  [DllImport("user32.dll")] static extern bool PostMessageW(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct REASON { public uint Version, Flags; public string Text; }
  [StructLayout(LayoutKind.Sequential)] struct STATUS { public byte Ac, Flag, Percent, Saver; public int Seconds, FullSeconds; }
  delegate uint Changed(IntPtr context, uint type, IntPtr setting);
  [StructLayout(LayoutKind.Sequential)] struct SUBSCRIBE { public Changed Callback; public IntPtr Context; }
  static readonly Guid Lid = new Guid("ba3e0f4d-b817-4094-a2d1-d56379e6a0f3");
  static readonly Guid Source = new Guid("5d3e9a59-e9d5-4b00-a6bd-ff34ff516548");
  static readonly Guid Percent = new Guid("a7ad8041-b45a-4cae-87a3-eecbb468a9e1");
  static IntPtr request = IntPtr.Zero;
  static string reasonText = null;
  static bool display = false;
  static Changed changed;
  // SYSTEM_POWER_CAPABILITIES by offset: LidPresent, SystemS3, SystemS4, HiberFilePresent, AoAc, SystemBatteriesPresent.
  public static string Caps() {
    byte[] c = new byte[76];
    if (!GetPwrCapabilities(c)) throw new Exception("caps");
    return c[2] + " " + c[5] + " " + c[6] + " " + c[8] + " " + c[20] + " " + c[30];
  }
  public static string Status() {
    STATUS s;
    if (!GetSystemPowerStatus(out s)) throw new Exception("status");
    return s.Ac + " " + s.Flag + " " + s.Percent + " " + s.Seconds;
  }
  public static string Require(bool screen, string reason) {
    if (request != IntPtr.Zero && reason != reasonText) Free();
    if (request == IntPtr.Zero) {
      REASON r = new REASON();
      r.Version = 0;
      r.Flags = 1;
      r.Text = reason;
      IntPtr h = PowerCreateRequest(ref r);
      if (h == IntPtr.Zero || h == new IntPtr(-1)) throw new Exception("request " + Marshal.GetLastWin32Error());
      request = h;
      reasonText = reason;
    }
    if (!PowerSetRequest(request, 1)) throw new Exception("system " + Marshal.GetLastWin32Error());
    if (screen && !display) {
      if (!PowerSetRequest(request, 0)) throw new Exception("display " + Marshal.GetLastWin32Error());
      display = true;
    } else if (!screen && display) {
      PowerClearRequest(request, 0);
      display = false;
    }
    return "";
  }
  public static string Free() {
    if (request == IntPtr.Zero) return "";
    PowerClearRequest(request, 1);
    if (display) PowerClearRequest(request, 0);
    CloseHandle(request);
    request = IntPtr.Zero;
    display = false;
    return "";
  }
  public static string Watch() {
    if (changed != null) return "";
    changed = OnChange;
    Register(Lid);
    Register(Source);
    Register(Percent);
    return "";
  }
  static void Register(Guid setting) {
    SUBSCRIBE s = new SUBSCRIBE();
    s.Callback = changed;
    s.Context = IntPtr.Zero;
    IntPtr handle;
    uint e = PowerSettingRegisterNotification(ref setting, 2, ref s, out handle);
    if (e != 0) throw new Exception("watch " + e);
  }
  // POWERBROADCAST_SETTING: the setting's GUID, then its length, then its value (a DWORD for these three).
  static uint OnChange(IntPtr context, uint type, IntPtr setting) {
    if (type != 0x8013 || setting == IntPtr.Zero) return 0;
    byte[] g = new byte[16];
    Marshal.Copy(setting, g, 0, 16);
    Guid id = new Guid(g);
    string name = id == Lid ? "lid" : id == Source ? "source" : id == Percent ? "percent" : null;
    if (name != null) Console.Out.WriteLine("event " + name + " " + Marshal.ReadInt32(setting, 20));
    return 0;
  }
  public static string DisplayOff() {
    PostMessageW(new IntPtr(0xffff), 0x0112, new IntPtr(0xF170), new IntPtr(2));
    return "";
  }
  public static string Suspend(bool hibernate) {
    if (!SetSuspendState(hibernate, false, false)) throw new Exception("suspend " + Marshal.GetLastWin32Error());
    return "";
  }
}`;

// The source comes as the first line of the input. Each later line is a call, answered "ok <call> <out>" or
// "err <call> <why>"; notifications come as "event <name> <value>". A guard (the user's plan, then ours) is put back
// when the input closes without "unguard": the hub ended without releasing its hold.
const LOOP = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine())))',
  '$guard = $null',
  "[Console]::Out.WriteLine('ready')",
  'while ($null -ne ($line = [Console]::In.ReadLine())) {',
  "  $p = $line.Split(' ', 3)",
  '  try {',
  '    $out = switch ($p[0]) {',
  "      'caps' { [HubPower]::Caps() }",
  "      'status' { [HubPower]::Status() }",
  "      'require' { [HubPower]::Require($p[1] -eq '1', $p[2]) }",
  "      'free' { [HubPower]::Free() }",
  "      'watch' { [HubPower]::Watch() }",
  "      'guard' { if ($p[1] -notmatch '^[0-9a-f-]{36}$' -or $p[2] -notmatch '^[0-9a-f-]{36}$') { throw 'guid' }; $guard = @($p[1], $p[2]); '' }",
  "      'unguard' { $guard = $null; '' }",
  "      'display-off' { [HubPower]::DisplayOff() }",
  "      'suspend' { [HubPower]::Suspend($p[1] -eq '1') }",
  "      default { throw 'unknown' }",
  '    }',
  '    [Console]::Out.WriteLine("ok $($p[0]) $out")',
  '  } catch { [Console]::Out.WriteLine("err $($p[0]) $($_.Exception.Message)") }',
  '}',
  'if ($guard) {',
  "  $pc = Join-Path $env:SystemRoot 'System32\\powercfg.exe'",
  "  if ((& $pc /getactivescheme) -match $guard[1]) { & $pc /setactive $guard[0] | Out-Null; if ($LASTEXITCODE -ne 0) { & $pc /setactive " +
    BALANCED +
    ' | Out-Null } }',
  '  & $pc /delete $guard[1] | Out-Null',
  '}',
].join('\n');

const HELPER_ARGS = ['-NoProfile', '-NonInteractive', '-Command', LOOP];
const SOURCE_LINE = `${Buffer.from(SOURCE, 'utf8').toString('base64')}\n`;

/** The helper compiles its calls when it starts: a few seconds on a loaded machine. */
const START_TIMEOUT_MS = 30_000;
const ANSWER_TIMEOUT_MS = 10_000;
const RUN_TIMEOUT_MS = 30_000;
/** A helper that ended during a hold is started again, but not in a loop. */
const RESTART_AFTER_MS = 15_000;

export interface RunResult {
  code: number | null;
  stdout: string;
}

/** A program kept running: lines in, lines out. */
export interface HelperProcess {
  write(text: string): void;
  onLine(cb: (line: string) => void): void;
  onExit(cb: () => void): void;
  /** Closes its input: the helper finishes what it has, puts back its guard, and ends. */
  end(): void;
  kill(): void;
}

/** Everything the adapter asks of Windows: tests give a fake one. */
export interface Win32System {
  run(file: string, args: string[], input?: string): Promise<RunResult>;
  spawn(file: string, args: string[]): HelperProcess;
  read(path: string): string | null;
  write(path: string, text: string): void;
  remove(path: string): void;
  guid(): string;
  setTimer(fn: () => void, ms: number): () => void;
}

export const realWin32System: Win32System = {
  run: (file, args, input) =>
    new Promise((resolve) => {
      const child = execFile(file, args, { windowsHide: true, timeout: RUN_TIMEOUT_MS, maxBuffer: 4_000_000 }, (err, stdout) =>
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout) }),
      );
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(input ?? '');
    }),
  spawn: (file, args) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    // The hub (or a test) never waits for it to exit.
    child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr] as unknown as { unref?(): void }[]) stream.unref?.();
    child.stdin.on('error', () => undefined);
    child.stderr.resume();
    const exits: (() => void)[] = [];
    let gone = false;
    const exited = () => {
      if (gone) return;
      gone = true;
      for (const cb of exits) cb();
    };
    child.on('error', exited);
    child.on('exit', exited);
    const lines = createInterface({ input: child.stdout });
    return {
      write: (text) => void child.stdin.write(text),
      onLine: (cb) => void lines.on('line', cb),
      onExit: (cb) => void exits.push(cb),
      end: () => child.stdin.end(),
      kill: () => void child.kill(),
    };
  },
  read: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  write: (path, text) => {
    writeFileSync(`${path}.tmp`, text);
    renameSync(`${path}.tmp`, path);
  },
  remove: (path) => rmSync(path, { force: true }),
  guid: () => randomUUID(),
  setTimer: (fn, ms) => {
    const h = setTimeout(fn, ms);
    h.unref();
    return () => clearTimeout(h);
  },
};

// ---------- what Windows answers ----------

/** The first plan GUID in powercfg's output (/getactivescheme, /duplicatescheme). */
export function schemeOf(out: string): string | null {
  return GUID.exec(out)?.[0].toLowerCase() ?? null;
}

/** A setting's current index on mains and on battery: the last two hex values of `powercfg /qh <plan> <sub> <setting>`
 *  (the text around them is in the user's language). */
export function indexesOf(out: string): [number, number] | null {
  const hex = [...out.matchAll(/0x([0-9a-f]{8})/gi)].map((m) => parseInt(m[1], 16));
  return hex.length >= 2 ? [hex[hex.length - 2], hex[hex.length - 1]] : null;
}

export interface Probe {
  lid: boolean;
  s3: boolean;
  hibernate: boolean;
  modernStandby: boolean;
  battery: boolean;
}

/** The helper's "caps" answer: LidPresent, S3, S4, hiberfile, AoAc, batteries, as 0/1. */
export function probeOf(out: string): Probe | null {
  const v = out.trim().split(/\s+/).map(Number);
  if (v.length !== 6 || v.some((n) => !Number.isInteger(n))) return null;
  return { lid: v[0] !== 0, s3: v[1] !== 0, hibernate: v[2] !== 0 && v[3] !== 0, modernStandby: v[4] !== 0, battery: v[5] !== 0 };
}

/** The helper's "status" answer: SYSTEM_POWER_STATUS's ACLineStatus, BatteryFlag, BatteryLifePercent, BatteryLifeTime. */
export function batteryOf(out: string): BatteryInfo | null {
  const v = out.trim().split(/\s+/).map(Number);
  if (v.length !== 4 || v.some((n) => !Number.isInteger(n))) return null;
  const [ac, flag, percent, seconds] = v;
  // 128: no system battery; 255: unknown.
  const present = flag !== 255 && (flag & 128) === 0;
  const source: PowerSource = ac === 0 ? 'battery' : 'ac';
  return {
    present,
    percent: present && percent <= 100 ? percent : null,
    charging: present ? (flag & 8) !== 0 : null,
    source,
    minutesLeft: present && source === 'battery' && seconds >= 0 ? Math.round(seconds / 60) : null,
  };
}

/** LIDACTION's index as what the core does: never a shutdown, a hibernation instead. */
function lidActionOf(index: number): 'none' | SuspendMode {
  return index === 0 ? 'none' : index === 1 ? 'sleep' : 'hibernate';
}

// ---------- the helper ----------

type Waiter = { call: string; done: (out: string | null) => void };

/** One helper process, started when a hold or a subscription needs it and ended when none does. */
class Helper {
  private proc: HelperProcess | null = null;
  private ready: Promise<boolean> | null = null;
  private waiting: Waiter[] = [];
  private users = 0;
  private cancelRestart: (() => void) | null = null;

  constructor(
    private readonly sys: Win32System,
    private readonly onEvent: (name: string, value: number) => void,
    /** Asked again of a helper started anew: what the old one held. */
    private readonly resync: () => Promise<void>,
  ) {}

  use(): void {
    this.users++;
  }

  unuse(): void {
    this.users = Math.max(0, this.users - 1);
    if (this.users === 0) this.stop();
  }

  get running(): boolean {
    return this.proc !== null;
  }

  private up(): Promise<boolean> {
    if (this.ready && this.proc) return this.ready;
    this.ready = new Promise<boolean>((resolve) => {
      let proc: HelperProcess;
      try {
        proc = this.sys.spawn(POWERSHELL, HELPER_ARGS);
      } catch {
        return resolve(false);
      }
      this.proc = proc;
      const late = this.sys.setTimer(() => proc.kill(), START_TIMEOUT_MS);
      proc.onExit(() => {
        late();
        resolve(false);
        if (this.proc !== proc) return;
        this.proc = null;
        this.ready = null;
        for (const w of this.waiting) w.done(null);
        this.waiting = [];
        // Ended under a hold: what it held is gone with it, so a new one takes it up.
        if (this.users > 0 && !this.cancelRestart) {
          this.cancelRestart = this.sys.setTimer(() => {
            this.cancelRestart = null;
            if (this.users > 0) void this.up().then((ok) => (ok ? this.resync() : undefined));
          }, RESTART_AFTER_MS);
        }
      });
      proc.onLine((line) => {
        if (this.proc !== proc) return;
        if (line === 'ready') {
          late();
          return resolve(true);
        }
        if (line.startsWith('event ')) {
          const [, name, value] = line.split(' ');
          return this.onEvent(name, Number(value));
        }
        const w = this.waiting.shift();
        if (!w) return;
        const [status, call] = line.split(' ', 2);
        w.done(status === 'ok' && call === w.call ? line.slice(status.length + call.length + 2) : null);
      });
      proc.write(SOURCE_LINE);
    });
    return this.ready;
  }

  /** The answer to a call; rejects when the helper cannot start, refuses the call or does not answer in time. */
  async ask(line: string): Promise<string> {
    if (!(await this.up()) || !this.proc) throw new Error('energy helper unavailable');
    const call = line.split(' ', 1)[0];
    const proc = this.proc;
    return new Promise((resolve, reject) => {
      const w: Waiter = {
        call,
        done: (out) => {
          stopTimer();
          if (out === null) reject(new Error(`energy helper: ${call} failed`));
          else resolve(out);
        },
      };
      // A helper that does not answer is stuck: ended, and started again if a hold still needs it.
      const stopTimer = this.sys.setTimer(() => proc.kill(), ANSWER_TIMEOUT_MS);
      this.waiting.push(w);
      proc.write(`${line}\n`);
    });
  }

  private stop(): void {
    this.cancelRestart?.();
    this.cancelRestart = null;
    const proc = this.proc;
    this.proc = null;
    this.ready = null;
    for (const w of this.waiting) w.done(null);
    this.waiting = [];
    proc?.end();
  }
}

// ---------- the adapter ----------

interface Snapshot {
  /** The user's plan, active before the hold. */
  original: string;
  /** Our copy. */
  scheme: string;
  at: number;
}

interface Plan extends Snapshot {
  users: number;
  /** LIDACTION of the user's plan, on mains and on battery. */
  lid: [number, number] | null;
  /** The copy does nothing when the lid closes. */
  lidOff: boolean;
}

interface HoldState {
  display: boolean;
  reason: string;
  plan: boolean;
}

export class Win32Energy implements EnergyPlatform {
  private readonly sys: Win32System;
  private readonly file: string;
  private readonly helper: Helper;
  private probed: Promise<{ probe: Probe | null; powercfg: boolean }> | null = null;
  private plan: Plan | null = null;
  private planBusy: Promise<unknown> = Promise.resolve();
  private readonly holds = new Set<HoldState>();
  private watching = false;
  private lid: boolean | null = null;
  private source: PowerSource = 'ac';
  private readonly lidCbs = new Set<(closed: boolean) => void>();
  private readonly powerCbs = new Set<(b: BatteryInfo) => void>();

  constructor(deps: EnergyDeps & { sys?: Win32System }) {
    this.sys = deps.sys ?? realWin32System;
    this.file = join(deps.dataDir, SNAPSHOT);
    this.helper = new Helper(this.sys, (name, value) => this.event(name, value), () => this.resync());
  }

  private probe() {
    this.probed ??= (async () => {
      const [caps, active] = await Promise.all([this.once('caps').catch(() => null), this.sys.run(POWERCFG, ['/getactivescheme']).catch(() => null)]);
      const found = { probe: caps === null ? null : probeOf(caps), powercfg: active?.code === 0 && schemeOf(active.stdout) !== null };
      // Not found this time: asked again next time.
      if (!found.probe) this.probed = null;
      return found;
    })();
    return this.probed;
  }

  /** One call, from a helper started for it alone. */
  private async once(line: string): Promise<string> {
    const r = await this.sys.run(POWERSHELL, HELPER_ARGS, `${SOURCE_LINE}${line}\n`);
    const call = line.split(' ', 1)[0];
    const answer = r.stdout.split(/\r?\n/).find((l) => l.startsWith(`ok ${call}`));
    if (answer === undefined) throw new Error(`energy helper: ${call} failed`);
    return answer.slice(call.length + 4);
  }

  async caps(): Promise<EnergyCaps> {
    const { probe, powercfg } = await this.probe();
    const why: NonNullable<EnergyCaps['why']> = {};
    if (!probe) why.holdAwake = t('energy.note.noHelper');
    else if (!probe.lid) why.lidClosedAwake = t('energy.note.noLid');
    else if (!powercfg) why.lidClosedAwake = t('energy.note.noPowercfg');
    if (probe && !probe.battery) why.battery = t('energy.note.noBattery');
    const notes = [why.holdAwake, why.lidClosedAwake, why.battery, t('energy.note.radios')].filter((n): n is string => !!n);
    return {
      platform: 'win32',
      holdAwake: probe !== null,
      lidClosedAwake: probe !== null && probe.lid && powercfg,
      needsElevation: false,
      battery: probe?.battery ?? false,
      displayOff: probe !== null,
      radios: false,
      notes,
      why,
    };
  }

  async battery(): Promise<BatteryInfo> {
    const out = this.helper.running ? await this.helper.ask('status') : await this.once('status');
    const b = batteryOf(out);
    if (!b) throw new Error('energy: unreadable power status');
    this.source = b.source;
    return b;
  }

  async hold(o: HoldOptions): Promise<Hold> {
    const { probe, powercfg } = await this.probe();
    if (!probe) throw new Error('energy helper unavailable');
    const lidClosed = o.lidClosed && probe.lid && powercfg;
    const state: HoldState = { display: !o.allowDisplaySleep, reason: o.reason, plan: lidClosed || (probe.modernStandby && powercfg) };
    this.helper.use();
    try {
      this.holds.add(state);
      await this.require();
      if (state.plan) await this.serial(() => this.takePlan(o.reason, lidClosed, probe));
    } catch (err) {
      // takePlan undid its own changes: only the request is left to put back.
      this.holds.delete(state);
      await this.require().catch(() => undefined);
      this.helper.unuse();
      throw err;
    }
    let released: Promise<void> | null = null;
    const lid = state.plan ? this.plan?.lid : null;
    const source = () => this.source;
    return {
      lidClosedEffective: lidClosed,
      get lidAction() {
        return lid ? lidActionOf(lid[source() === 'battery' ? 1 : 0]) : undefined;
      },
      release: () =>
        (released ??= (async () => {
          this.holds.delete(state);
          if (state.plan) await this.serial(() => this.dropPlan()).catch(() => undefined);
          await this.require().catch(() => undefined);
          this.helper.unuse();
        })()),
    };
  }

  /** The power request as the holds want it: none left, or the screen kept on by one of them. */
  private async require(): Promise<void> {
    if (this.holds.size === 0) {
      if (this.helper.running) await this.helper.ask('free');
      return;
    }
    const display = [...this.holds].some((h) => h.display);
    const reason = [...this.holds][0].reason.replace(/[\r\n]+/g, ' ').slice(0, 200) || 'AI Box';
    await this.helper.ask(`require ${display ? 1 : 0} ${reason}`);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.planBusy.then(fn, fn);
    this.planBusy = next.catch(() => undefined);
    return next;
  }

  private async powercfg(args: string[]): Promise<string> {
    const r = await this.sys.run(POWERCFG, args);
    if (r.code !== 0) throw new Error(`powercfg ${args[0]} failed (${r.code})`);
    return r.stdout;
  }

  /** Our copy of the user's plan, active: made at the first hold that needs it, shared by the next ones. */
  private async takePlan(reason: string, lidClosed: boolean, probe: Probe): Promise<void> {
    if (this.plan) {
      // Shared with a hold that did not need the lid (Modern Standby): the lid is set now, then taken by Windows.
      if (lidClosed && !this.plan.lidOff) {
        await this.lidOff(this.plan.scheme, probe);
        await this.powercfg(['/setactive', this.plan.scheme]);
        this.plan.lidOff = true;
      }
      this.plan.users++;
      return;
    }
    // A copy an earlier release could not put back is undone first (or nothing is changed): the snapshot never
    // forgets it, and the user's plan is not mistaken for that copy.
    if (this.sys.read(this.file) !== null) await this.restoreLeftovers();
    const original = schemeOf(await this.powercfg(['/getactivescheme']));
    if (!original) throw new Error('powercfg: no active plan');
    const lid = probe.lid ? indexesOf(await this.powercfg(['/qh', original, SUB_BUTTONS, LIDACTION]).catch(() => '')) : null;
    const plan: Plan = { original, scheme: this.sys.guid().toLowerCase(), at: Date.now(), users: 1, lid, lidOff: lidClosed };
    // Written before anything changes: a crash from here on is undone at the next start.
    this.sys.write(this.file, JSON.stringify({ original: plan.original, scheme: plan.scheme, at: plan.at } satisfies Snapshot));
    try {
      await this.powercfg(['/duplicatescheme', original, plan.scheme]);
      await this.powercfg(['/changename', plan.scheme, 'AI Box', reason.replace(/[\r\n"]+/g, ' ').slice(0, 200)]);
      if (lidClosed) await this.lidOff(plan.scheme, probe);
      if (probe.modernStandby) await this.set(plan.scheme, SUB_SLEEP, STANDBYIDLE, 0, 0);
      await this.powercfg(['/setactive', plan.scheme]);
      // A policy can keep a plan from becoming active without an error.
      if (schemeOf(await this.powercfg(['/getactivescheme'])) !== plan.scheme) throw new Error('powercfg: the plan did not become active');
      this.plan = plan;
      await this.helper.ask(`guard ${plan.original} ${plan.scheme}`);
    } catch (err) {
      this.plan = null;
      await this.putBack(plan);
      throw err;
    }
  }

  private async set(scheme: string, sub: string, setting: string, ac: number | null, dc: number): Promise<void> {
    if (ac !== null) await this.powercfg(['/setacvalueindex', scheme, sub, setting, String(ac)]);
    await this.powercfg(['/setdcvalueindex', scheme, sub, setting, String(dc)]);
  }

  private async lidOff(scheme: string, probe: Probe): Promise<void> {
    await this.set(scheme, SUB_BUTTONS, LIDACTION, 0, 0);
    // The lid closed, nobody sees the battery run down: at its critical level the PC hibernates (or sleeps).
    if (probe.battery) await this.set(scheme, SUB_BATTERY, BATACTIONCRIT, null, probe.hibernate ? 2 : 1);
  }

  private async dropPlan(): Promise<void> {
    const plan = this.plan;
    if (!plan || --plan.users > 0) return;
    this.plan = null;
    if (await this.putBack(plan)) await this.helper.ask('unguard').catch(() => undefined);
  }

  /** The user's plan active again (unless they picked another meanwhile) and our copy gone. True once nothing is left,
   *  the snapshot then removed; otherwise it stays for the next start. */
  private async putBack(s: Snapshot): Promise<boolean> {
    try {
      await this.undo(s);
    } catch {
      return false;
    }
    this.sys.remove(this.file);
    return true;
  }

  /** How many changes were undone; throws when one could not be. */
  private async undo(s: Snapshot): Promise<number> {
    let n = 0;
    if (schemeOf(await this.powercfg(['/getactivescheme'])) === s.scheme) {
      await this.powercfg(['/setactive', s.original]).catch(() => this.powercfg(['/setactive', BALANCED]));
      n++;
    }
    const listed = async () => (await this.powercfg(['/list'])).toLowerCase().includes(s.scheme);
    if (await listed()) {
      await this.powercfg(['/delete', s.scheme]).catch(() => '');
      if (await listed()) throw new Error('powercfg: the copy could not be deleted');
      n++;
    }
    return n;
  }

  async restoreLeftovers(): Promise<number> {
    const raw = this.sys.read(this.file);
    if (raw === null) return 0;
    let s: Partial<Snapshot> = {};
    try {
      s = JSON.parse(raw) as Partial<Snapshot>;
    } catch {
      // Unreadable: nothing to go by.
    }
    const valid = (g: unknown): g is string => typeof g === 'string' && GUID.test(g) && g.length === 36;
    if (!valid(s.original) || !valid(s.scheme)) {
      this.sys.remove(this.file);
      return 0;
    }
    const n = await this.undo({ original: s.original.toLowerCase(), scheme: s.scheme.toLowerCase(), at: s.at ?? 0 });
    this.sys.remove(this.file);
    return n;
  }

  async displayOff(): Promise<void> {
    await this.once('display-off');
  }

  async suspend(mode: SuspendMode): Promise<void> {
    const { probe } = await this.probe();
    const hibernate = mode === 'hibernate' && probe?.hibernate === true;
    // SetSuspendState returns only once the PC is awake again: the call is not waited for.
    void this.once(`suspend ${hibernate ? 1 : 0}`).catch(() => undefined);
  }

  onLidChange(cb: (closed: boolean) => void): () => void {
    return this.subscribe(this.lidCbs, cb, () => {
      if (this.lid !== null) cb(this.lid);
    });
  }

  onPowerSourceChange(cb: (b: BatteryInfo) => void): () => void {
    return this.subscribe(this.powerCbs, cb, () => undefined);
  }

  private subscribe<T>(set: Set<T>, cb: T, now: () => void): () => void {
    set.add(cb);
    this.helper.use();
    void this.watch().then(now, () => undefined);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      set.delete(cb);
      this.helper.unuse();
      if (this.lidCbs.size === 0) this.lid = null;
      if (this.lidCbs.size + this.powerCbs.size === 0) this.watching = false;
    };
  }

  private async watch(): Promise<void> {
    if (this.watching && this.helper.running) return;
    this.watching = true;
    await this.helper.ask('watch');
  }

  private event(name: string, value: number): void {
    if (name === 'lid') {
      // GUID_LIDSWITCH_STATE_CHANGE: 0 closed, 1 open.
      this.lid = value === 0;
      for (const cb of this.lidCbs) cb(this.lid);
      return;
    }
    if (name === 'source') this.source = value === 0 ? 'ac' : 'battery';
    if (this.powerCbs.size === 0) return;
    void this.battery().then(
      (b) => {
        for (const cb of this.powerCbs) cb(b);
      },
      () => undefined,
    );
  }

  /** A helper started again during a hold: the request, the guard and the notifications it held. */
  private async resync(): Promise<void> {
    await this.require().catch(() => undefined);
    if (this.plan) await this.helper.ask(`guard ${this.plan.original} ${this.plan.scheme}`).catch(() => undefined);
    if (this.lidCbs.size + this.powerCbs.size > 0) {
      this.watching = false;
      await this.watch().catch(() => undefined);
    }
  }
}

export const win32Energy = (deps: EnergyDeps & { sys?: Win32System }): EnergyPlatform => new Win32Energy(deps);
