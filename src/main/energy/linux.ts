import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname, posix } from 'node:path';
import { createInterface } from 'node:readline';
import type { BatteryInfo, EnergyCaps, EnergyDeps, EnergyPlatform, Hold, HoldOptions, SuspendMode } from './types';

// Linux: keeping the machine awake, lid closed included, for as long as workers run.
//
// Every lock is held by a child process whose life is the hold's: `systemd-inhibit … sh -c 'echo held; exec cat'`
// takes logind's lock, then `cat` reads the hub's end of a pipe. When the hub quits or crashes the pipe closes, `cat`
// ends and logind drops the lock: nothing to clean up after a crash. The desktops' wrappers do not pass our stdin on,
// so under them the program checks every 15 s that the hub is alive instead. Layers, each one its own process:
// - logind (systemd or elogind): `sleep` always, `idle` unless the display may sleep, `handle-lid-switch` for a closed
//   lid. logind.conf's LidSwitchIgnoreInhibited (yes by default) makes the lid ignore a plain `sleep` lock: only the
//   low-level `handle-lid-switch` lock, always honoured, keeps the lid from suspending. polkit grants it without a
//   password to the active local session; over SSH or from another seat it is refused, and then the lid only stays
//   harmless if logind.conf says so (HandleLidSwitch*=ignore|lock, or LidSwitchIgnoreInhibited=no).
// - the desktop's own session lock (gnome-session-inhibit, kde-inhibit): GNOME and KDE suspend on idle themselves.
//   KDE's PowerDevil also takes the lid from logind and acts on its own setting, read from powerdevilrc.
// With the lid really shut (UPower's LidIsClosed, watched through `gdbus monitor`), a lid-closed hold also switches
// to the power-saver profile and turns Bluetooth off when nothing is connected to it and no external display is
// plugged in; both come back when the lid opens or the hold ends. Wi-Fi is never touched: workers need the network.
// What was changed is written down before changing it (energy-linux.json in the app's data folder), so a crash in
// between is undone at the next start, and only if it is still as we left it.
// With logind's lid handling held off, nothing turns the built-in panel off under a shut lid (GNOME keeps a lone
// panel lit): the hold blanks the screen when the lid shuts with no external display, and wakes it when the lid
// opens. Blanking: X11 DPMS, GNOME's Mutter (Wayland), KDE's kscreen-doctor (Wayland).
// When a hold ends with the lid shut, logind looks at the lid again by itself (it keeps rechecking a closed lid); the
// core may also call suspend(), which logind then refuses as already under way.

export interface RunResult {
  /** Exit code; null when the program is missing, timed out or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
}

/** A program kept running: printed lines as they come, and its end. */
export interface Child {
  onLine(cb: (line: string) => void): void;
  readonly exited: Promise<RunResult>;
  /** Closes its stdin (the lifeline) and terminates it. */
  stop(): void;
}

/** Every contact with the system, so tests can stand in for it. */
export interface LinuxSystem {
  run(cmd: string, args: string[]): Promise<RunResult>;
  start(cmd: string, args: string[]): Child;
  read(path: string): Promise<string | null>;
  list(dir: string): Promise<string[]>;
  write(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
  env: Record<string, string | undefined>;
  /** The hub's own process: the desktops' locks live while it does. */
  pid: number;
}

const RUN_TIMEOUT_MS = 10_000;
/** polkit may ask for a password: past this, the lock counts as refused. */
const HOLD_TIMEOUT_MS = 15_000;
const MONITOR_RETRY_MS = 5_000;
const MONITOR_RETRIES = 5;
const WHO = 'AI Box';
const SNAPSHOT = 'energy-linux.json';
/** The program logind's lock runs: says it holds once the lock is taken, then lives as long as its stdin, our pipe. */
const PIPE_LIFELINE = ['sh', '-c', 'echo held; exec cat >/dev/null'];
/**
 * The desktops' wrappers do not hand our stdin down (kde-inhibit keeps its own pipe, gnome-session-inhibit may give
 * /dev/null), so under them the program lives while the hub and the wrapper both do: a check every 15 s.
 */
const pidLifeline = (pid: number) => ['sh', '-c', 'echo held; while kill -0 "$1" 2>/dev/null && kill -0 "$PPID" 2>/dev/null; do sleep 15; done', 'sh', String(pid)];
/** A lock lost while held is taken again after these waits, then given up. */
const RETRY_MS = [0, 3_000, 15_000];
/** release() puts things back for at most this long before letting go of the locks anyway. */
const UNDO_WAIT_MS = 20_000;
const TOOLS = [
  'systemd-inhibit', 'elogind-inhibit', 'busctl', 'upower', 'gdbus', 'rfkill', 'bluetoothctl', 'powerprofilesctl', 'tlp',
  'gnome-session-inhibit', 'kde-inhibit', 'xset', 'kscreen-doctor', 'systemctl', 'loginctl',
] as const;
type Tool = (typeof TOOLS)[number];

export function nodeSystem(env: Record<string, string | undefined> = process.env): LinuxSystem {
  // Untranslated output: the parsers read English.
  const childEnv = { ...env, LC_ALL: 'C', LANG: 'C' };
  return {
    env,
    pid: process.pid,
    run: (cmd, args) =>
      new Promise((resolve) => {
        execFile(cmd, args, { env: childEnv, timeout: RUN_TIMEOUT_MS, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
          const code = !err ? 0 : typeof err.code === 'number' ? err.code : null;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) || (err && code === null ? err.message : '') });
        });
      }),
    start(cmd, args) {
      const p = spawn(cmd, args, { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
      const listeners: ((line: string) => void)[] = [];
      let stderr = '';
      createInterface({ input: p.stdout }).on('line', (l) => listeners.forEach((cb) => cb(l)));
      p.stderr.on('data', (d) => {
        if (stderr.length < 4096) stderr += String(d);
      });
      p.stdin.on('error', () => {});
      const exited = new Promise<RunResult>((resolve) => {
        p.on('error', (e) => resolve({ code: null, stdout: '', stderr: e.message }));
        p.on('close', (code) => resolve({ code, stdout: '', stderr }));
      });
      return {
        onLine: (cb) => void listeners.push(cb),
        exited,
        stop() {
          p.stdin.end();
          p.kill('SIGTERM');
        },
      };
    },
    read: (path) => fs.readFile(path, 'utf8').catch(() => null),
    list: (dir) => fs.readdir(dir).catch(() => []),
    async write(path, text) {
      await fs.mkdir(dirname(path), { recursive: true });
      await fs.writeFile(`${path}.tmp`, text);
      await fs.rename(`${path}.tmp`, path);
    },
    remove: (path) => fs.rm(path, { force: true }),
  };
}

// ---- Parsers (pure, exported for the tests) ----

export interface UpowerDump {
  daemon: Record<string, string>;
  devices: { path: string; kind: string; props: Record<string, string> }[];
}

/** `upower -d`: unindented "Device: <path>" and "Daemon:" headers, indented "key: value" lines, a bare kind word. */
export function parseUpowerDump(text: string): UpowerDump {
  const dump: UpowerDump = { daemon: {}, devices: [] };
  let props: Record<string, string> | null = null;
  let device: UpowerDump['devices'][number] | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) {
      const m = /^Device:\s*(\S+)/.exec(line);
      device = m ? { path: m[1], kind: '', props: {} } : null;
      if (device) dump.devices.push(device);
      props = device ? device.props : /^Daemon:/.test(line) ? dump.daemon : null;
      continue;
    }
    if (!props) continue;
    const kv = /^\s+([^:]+?):\s*(.*)$/.exec(line);
    if (kv) props[kv[1].trim()] ??= kv[2].trim().replace(/^'(.*)'$/, '$1');
    else if (device && !device.kind) device.kind = line.trim();
  }
  return dump;
}

/** "4.7 hours", "45.0 minutes", "1.2 days", "30 seconds" → minutes. */
export function upowerMinutes(s: string | undefined): number | null {
  const m = /^([\d.]+)\s*(second|minute|hour|day)/.exec(s ?? '');
  if (!m) return null;
  const n = Number(m[1]) * { second: 1 / 60, minute: 1, hour: 60, day: 1440 }[m[2] as 'second'];
  return Number.isFinite(n) ? Math.round(n) : null;
}

const chargingOf = (state: string | undefined): boolean | null =>
  !state || state === 'unknown' ? null : state === 'charging';

/** The battery as UPower sums it up (its DisplayDevice, else the first system battery); null without UPower data. */
export function batteryFromUpower(dump: UpowerDump): BatteryInfo | null {
  const dev =
    dump.devices.find((d) => d.path.endsWith('/DisplayDevice')) ??
    dump.devices.find((d) => d.kind === 'battery' && d.props['power supply'] === 'yes');
  if (!dev && !dump.daemon['on-battery']) return null;
  const p = dev?.props ?? {};
  const present = p.present === 'yes';
  const percent = present && p.percentage ? Math.round(parseFloat(p.percentage)) : null;
  const charging = present ? chargingOf(p.state) : null;
  return {
    present,
    percent: Number.isFinite(percent) ? percent : null,
    charging,
    source: dump.daemon['on-battery'] === 'yes' ? 'battery' : 'ac',
    minutesLeft: present && charging === false ? upowerMinutes(p['time to empty']) : null,
  };
}

/** One /sys/class/power_supply entry: its files, read. */
export type SysSupply = Record<string, string | undefined>;

/** The kernel's view when UPower is missing: system batteries summed, peripherals (scope=Device) left out. */
export function batteryFromSysfs(supplies: SysSupply[]): BatteryInfo {
  const n = (v: string | undefined) => (v === undefined || v.trim() === '' ? NaN : Number(v));
  const bats = supplies.filter((s) => s.type === 'Battery' && s.scope !== 'Device' && s.present !== '0');
  const mains = supplies.filter((s) => s.type !== 'Battery' && s.scope !== 'Device' && s.online !== undefined);
  const discharging = bats.some((b) => b.status === 'Discharging');
  const source = mains.length ? (mains.some((m) => m.online === '1') ? 'ac' : 'battery') : discharging ? 'battery' : 'ac';
  if (!bats.length) return { present: false, percent: null, charging: null, source, minutesLeft: null };
  // Energy (µWh, µW) or, on some firmwares, charge (µAh, µA): the same arithmetic.
  const sum = (keys: string[]) =>
    bats.reduce((t, b) => {
      const v = keys.map((k) => n(b[k])).find((x) => Number.isFinite(x));
      return t + (v ?? NaN);
    }, 0);
  const now = sum(['energy_now', 'charge_now']);
  const full = sum(['energy_full', 'charge_full']);
  const rate = sum(['power_now', 'current_now']);
  const caps = bats.map((b) => n(b.capacity));
  const percent =
    Number.isFinite(now) && full > 0 ? Math.round((now / full) * 100) : caps.every(Number.isFinite) ? Math.round(caps.reduce((a, b) => a + b, 0) / caps.length) : null;
  const statuses = bats.map((b) => b.status ?? 'Unknown');
  const charging = statuses.includes('Charging') ? true : statuses.every((s) => s === 'Unknown') ? null : false;
  const minutesLeft = discharging && Number.isFinite(now) && rate > 0 ? Math.round((now / Math.abs(rate)) * 60) : null;
  return { present: true, percent: percent === null ? null : Math.min(100, Math.max(0, percent)), charging, source, minutesLeft };
}

export interface Radio {
  id: number;
  name: string;
  type: string;
  soft: boolean;
  hard: boolean;
}

/** `rfkill list`: "0: hci0: Bluetooth" then indented "Soft blocked: no" / "Hard blocked: no". */
export function parseRfkill(text: string): Radio[] {
  const radios: Radio[] = [];
  for (const line of text.split(/\r?\n/)) {
    const head = /^(\d+):\s*([^:]+):\s*(.+)$/.exec(line);
    if (head) radios.push({ id: Number(head[1]), name: head[2].trim(), type: head[3].trim(), soft: false, hard: false });
    const st = /^\s+(Soft|Hard) blocked:\s*(yes|no)/.exec(line);
    const r = radios[radios.length - 1];
    if (st && r) r[st[1] === 'Soft' ? 'soft' : 'hard'] = st[2] === 'yes';
  }
  return radios;
}

export interface Inhibitor {
  what: string[];
  who: string;
  why: string;
  mode: string;
  uid: number;
  pid: number;
}

/** `busctl --json=short call … ListInhibitors`: {"type":"a(ssssuu)","data":[[[what,who,why,mode,uid,pid],…]]}. */
export function parseInhibitors(json: string): Inhibitor[] {
  try {
    const rows = (JSON.parse(json) as { data: unknown[][] }).data[0] as [string, string, string, string, number, number][];
    return rows.map(([what, who, why, mode, uid, pid]) => ({ what: what.split(':'), who, why, mode, uid, pid }));
  } catch {
    return [];
  }
}

/** `busctl --json=short get-property …`: {"type":"s","data":"suspend"}. */
export function busctlValue(json: string): string | boolean | number | null {
  try {
    const d = (JSON.parse(json) as { data: unknown }).data;
    return typeof d === 'string' || typeof d === 'boolean' || typeof d === 'number' ? d : null;
  } catch {
    return null;
  }
}

/** `gdbus monitor` on UPower: a PropertiesChanged line carrying LidIsClosed and/or OnBattery. */
export function parseUpowerSignal(line: string): { lidClosed?: boolean; onBattery?: boolean } {
  const out: { lidClosed?: boolean; onBattery?: boolean } = {};
  const lid = /'LidIsClosed':\s*<(true|false)>/.exec(line);
  const bat = /'OnBattery':\s*<(true|false)>/.exec(line);
  if (lid) out.lidClosed = lid[1] === 'true';
  if (bat) out.onBattery = bat[1] === 'true';
  return out;
}

/**
 * Whether KDE's PowerDevil does nothing (0) or only locks (32) when the lid closes, on every profile. Plasma 6 keeps it
 * in powerdevilrc ([AC][SuspendAndShutdown] LidAction), Plasma 5 in powermanagementprofilesrc ([AC][HandleButtonEvents]
 * lidAction); a missing key is PowerDevil's default, sleep.
 */
export function kdeLidHarmless(powerdevilrc: string | null, profilesrc: string | null): boolean {
  const read = (text: string, group: string, key: string): string | undefined => {
    let inGroup = false;
    for (const line of text.split(/\r?\n/)) {
      const g = /^\s*(\[.+\])\s*$/.exec(line);
      if (g) inGroup = g[1] === group;
      else if (inGroup) {
        const kv = /^\s*([^=]+?)\s*=\s*(.*?)\s*$/.exec(line);
        if (kv && kv[1] === key) return kv[2];
      }
    }
    return undefined;
  };
  const harmless = (v: string | undefined) => v === '0' || v === '32';
  const profiles = ['AC', 'Battery', 'LowBattery'];
  if (powerdevilrc !== null) return profiles.every((p) => harmless(read(powerdevilrc, `[${p}][SuspendAndShutdown]`, 'LidAction')));
  if (profilesrc !== null) return profiles.every((p) => harmless(read(profilesrc, `[${p}][HandleButtonEvents]`, 'lidAction')));
  return false;
}

// ---- The platform ----

interface Snapshot {
  /** The profile to go back to, power-saver having been set by us. */
  profile?: string;
  /** Bluetooth was on and we turned it off. */
  bluetooth?: boolean;
}

interface Session {
  kind: 'x11' | 'wayland' | 'none';
  gnome: boolean;
  kde: boolean;
}

interface Probe {
  tools: Set<Tool>;
  inhibit: string | null;
  session: Session;
}

export interface LinuxEnergyOptions extends EnergyDeps {
  sys?: LinuxSystem;
  /** Waits before taking a lost lock again (tests shorten them). */
  retryMs?: number[];
}

const wait = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms).unref?.()) : Promise.resolve());

/** A listener's throw stays its own. */
const safely = <T>(cb: (v: T) => void, v: T) => {
  try {
    cb(v);
  } catch {
    /* the listener's problem */
  }
};

export function linuxEnergy({ dataDir, sys = nodeSystem(), retryMs = RETRY_MS }: LinuxEnergyOptions): EnergyPlatform {
  const snapshotPath = posix.join(dataDir, SNAPSHOT);
  let probed: Promise<Probe> | null = null;

  const probe = (): Promise<Probe> =>
    (probed ??= (async () => {
      const script = 'for c in "$@"; do command -v "$c"; done';
      const r = await sys.run('sh', ['-c', script, 'sh', ...TOOLS]);
      const found = new Set(r.stdout.split(/\r?\n/).map((l) => l.trim().split('/').pop() ?? ''));
      const tools = new Set(TOOLS.filter((t) => found.has(t)));
      const desktop = (sys.env.XDG_CURRENT_DESKTOP ?? '').toUpperCase().split(':');
      const type = (sys.env.XDG_SESSION_TYPE ?? '').toLowerCase();
      const kind: Session['kind'] =
        type === 'wayland' || (sys.env.WAYLAND_DISPLAY && type !== 'x11') ? 'wayland' : type === 'x11' || sys.env.DISPLAY ? 'x11' : 'none';
      return {
        tools,
        inhibit: tools.has('systemd-inhibit') ? 'systemd-inhibit' : tools.has('elogind-inhibit') ? 'elogind-inhibit' : null,
        session: { kind, gnome: desktop.some((d) => d.includes('GNOME')), kde: desktop.includes('KDE') },
      };
    })());

  const run = async (tools: Set<Tool>, tool: Tool, args: string[]): Promise<RunResult> =>
    tools.has(tool) ? sys.run(tool, args) : { code: null, stdout: '', stderr: `${tool} missing` };

  const logindProp = async (tools: Set<Tool>, name: string) => {
    const r = await run(tools, 'busctl', ['--json=short', 'get-property', 'org.freedesktop.login1', '/org/freedesktop/login1', 'org.freedesktop.login1.Manager', name]);
    return r.code === 0 ? busctlValue(r.stdout) : null;
  };

  const upower = async (tools: Set<Tool>): Promise<UpowerDump | null> => {
    const r = await run(tools, 'upower', ['-d']);
    return r.code === 0 ? parseUpowerDump(r.stdout) : null;
  };

  const sysfsBattery = async (): Promise<BatteryInfo> => {
    const base = '/sys/class/power_supply';
    const files = ['type', 'scope', 'present', 'online', 'status', 'capacity', 'energy_now', 'energy_full', 'power_now', 'charge_now', 'charge_full', 'current_now'];
    const supplies = await Promise.all(
      (await sys.list(base)).map(async (name) => {
        const vals = await Promise.all(files.map((f) => sys.read(`${base}/${name}/${f}`)));
        return Object.fromEntries(files.map((f, i) => [f, vals[i]?.trim()])) as SysSupply;
      }),
    );
    return batteryFromSysfs(supplies);
  };

  const battery = async (): Promise<BatteryInfo> => {
    const { tools } = await probe();
    const dump = await upower(tools);
    return (dump && batteryFromUpower(dump)) ?? sysfsBattery();
  };

  /** Whether the lid is shut now: UPower, else logind; null when neither knows. */
  const lidClosedNow = async (tools: Set<Tool>): Promise<boolean | null> => {
    const dump = await upower(tools);
    const v = dump?.daemon['lid-is-closed'];
    if (v === 'yes' || v === 'no') return v === 'yes';
    const l = await logindProp(tools, 'LidClosed');
    return typeof l === 'boolean' ? l : null;
  };

  // -- Snapshot of what we changed --

  const readSnapshot = async (): Promise<Snapshot> => {
    try {
      return JSON.parse((await sys.read(snapshotPath)) ?? '{}') as Snapshot;
    } catch {
      return {};
    }
  };
  const writeSnapshot = async (s: Snapshot) => {
    if (s.profile === undefined && !s.bluetooth) await sys.remove(snapshotPath);
    else await sys.write(snapshotPath, JSON.stringify(s));
  };

  // -- Lid-closed savings: power-saver and Bluetooth --

  let changed: Snapshot = {};
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = queue.then(fn);
    queue = p.catch(() => {});
    return p;
  };

  const externalDisplay = async (): Promise<boolean> => {
    const base = '/sys/class/drm';
    const outs = (await sys.list(base)).filter((c) => /^card\d+-/.test(c) && !/-(eDP|LVDS|DSI)-/.test(c));
    const st = await Promise.all(outs.map((c) => sys.read(`${base}/${c}/status`)));
    return st.some((s) => s?.trim() === 'connected');
  };

  /** Bluetooth may go off: all of it on, nothing connected (a keyboard, headphones), no external display (docked). */
  const bluetoothCanGo = async (tools: Set<Tool>): Promise<boolean> => {
    const radios = parseRfkill((await run(tools, 'rfkill', ['list'])).stdout).filter((r) => r.type === 'Bluetooth');
    if (!radios.length || radios.some((r) => r.soft || r.hard)) return false;
    // Without bluetoothctl, or with bluetoothd not answering, nothing says the radio is unused. Switched off in the
    // desktop's settings (powered off in BlueZ, rfkill still open), it is the user's: unblocking it later would not be.
    const show = await run(tools, 'bluetoothctl', ['show']);
    if (show.code !== 0 || !/Powered:\s*yes/.test(show.stdout)) return false;
    const c = await run(tools, 'bluetoothctl', ['devices', 'Connected']);
    if (c.code !== 0 || /^Device /m.test(c.stdout)) return false;
    return !(await externalDisplay());
  };

  const applySavings = () =>
    serial(async () => {
      const { tools } = await probe();
      if (changed.profile === undefined && tools.has('powerprofilesctl')) {
        const cur = (await run(tools, 'powerprofilesctl', ['get'])).stdout.trim();
        if (cur && cur !== 'power-saver') {
          changed.profile = cur;
          await writeSnapshot(changed);
          if ((await run(tools, 'powerprofilesctl', ['set', 'power-saver'])).code !== 0) {
            delete changed.profile;
            await writeSnapshot(changed);
          }
        }
      }
      if (!changed.bluetooth && (await bluetoothCanGo(tools))) {
        changed.bluetooth = true;
        await writeSnapshot(changed);
        if ((await run(tools, 'rfkill', ['block', 'bluetooth'])).code !== 0) {
          delete changed.bluetooth;
          await writeSnapshot(changed);
        }
      }
    });

  /** Undoes what `s` records, each part only if it is still as we left it; returns what came back, keeps the rest. */
  const undo = async (s: Snapshot): Promise<{ restored: number; left: Snapshot }> => {
    const { tools } = await probe();
    const left: Snapshot = {};
    let restored = 0;
    if (s.profile !== undefined) {
      const cur = await run(tools, 'powerprofilesctl', ['get']);
      if (cur.code !== 0) left.profile = s.profile;
      else if (cur.stdout.trim() === 'power-saver') {
        if ((await run(tools, 'powerprofilesctl', ['set', s.profile])).code === 0) restored++;
        else left.profile = s.profile;
      }
    }
    if (s.bluetooth) {
      const list = await run(tools, 'rfkill', ['list']);
      const bt = parseRfkill(list.stdout).filter((r) => r.type === 'Bluetooth');
      if (list.code !== 0) left.bluetooth = true;
      else if (bt.some((r) => r.soft)) {
        if ((await run(tools, 'rfkill', ['unblock', 'bluetooth'])).code === 0) restored++;
        else left.bluetooth = true;
      }
    }
    return { restored, left };
  };

  const undoSavings = () =>
    serial(async () => {
      if (changed.profile === undefined && !changed.bluetooth) return;
      const { left } = await undo(changed);
      changed = left;
      await writeSnapshot(changed);
    });

  // -- UPower events, one `gdbus monitor` for every listener --

  const lidListeners = new Set<(closed: boolean) => void>();
  const sourceListeners = new Set<(b: BatteryInfo) => void>();
  let monitor: Child | null = null;
  let monitorRetries = 0;
  /** Lid events heard: a state read before the last one is stale. */
  let lidSeq = 0;
  /** Power source events: only the last one's battery reading is told. */
  let sourceSeq = 0;

  const syncMonitor = async () => {
    if (!lidListeners.size && !sourceListeners.size) {
      monitor?.stop();
      monitor = null;
      return;
    }
    if (monitor) return;
    const { tools } = await probe();
    if (!tools.has('gdbus') || monitor || (!lidListeners.size && !sourceListeners.size)) return;
    const child = sys.start('gdbus', ['monitor', '--system', '--dest', 'org.freedesktop.UPower', '--object-path', '/org/freedesktop/UPower']);
    monitor = child;
    child.onLine((line) => {
      monitorRetries = 0;
      const s = parseUpowerSignal(line);
      if (s.lidClosed !== undefined) lidSeq++, lidListeners.forEach((cb) => safely(cb, s.lidClosed!));
      if (s.onBattery === undefined || !sourceListeners.size) return;
      const n = ++sourceSeq;
      void battery()
        .catch(() => null)
        .then((b) => {
          if (b && n === sourceSeq) sourceListeners.forEach((cb) => safely(cb, { ...b, source: s.onBattery ? 'battery' : 'ac' }));
        });
    });
    void child.exited.then(() => {
      if (monitor !== child) return;
      monitor = null;
      if (++monitorRetries > MONITOR_RETRIES) return;
      // Changes missed while it was down: listeners hear the lid's state again when it is back.
      setTimeout(() => void syncMonitor().then(() => tellLid([...lidListeners])), MONITOR_RETRY_MS).unref?.();
    });
  };

  const tellLid = async (cbs: ((closed: boolean) => void)[]) => {
    const seq = lidSeq;
    const closed = await lidClosedNow((await probe()).tools);
    if (closed !== null && seq === lidSeq) cbs.filter((cb) => lidListeners.has(cb)).forEach((cb) => safely(cb, closed));
  };

  const listen = <T>(set: Set<T>, cb: T) => {
    set.add(cb);
    void syncMonitor();
    return () => {
      set.delete(cb);
      void syncMonitor();
    };
  };

  /** The contract's lid subscription: the current state soon after subscribing, then each change. */
  const onLidChange = (cb: (closed: boolean) => void) => {
    const stop = listen(lidListeners, cb);
    void tellLid([cb]);
    return stop;
  };

  // -- Screen under a shut lid --

  let blanked = false;
  const lidScreen = (closed: boolean) =>
    serial(async () => {
      const { tools, session } = await probe();
      if (closed && !blanked && !(await externalDisplay())) {
        const cmd = displayCommand(session, tools, 'off');
        blanked = !!cmd && (await sys.run(cmd[0], cmd.slice(1))).code === 0;
      } else if (!closed && blanked) {
        blanked = false;
        const cmd = displayCommand(session, tools, 'on');
        if (cmd) await sys.run(cmd[0], cmd.slice(1));
      }
    });

  /** The last lid-closed hold ended: the lid is no longer watched, so a blanked screen is forgotten (woken if open). */
  const screenAfterHolds = () =>
    serial(async () => {
      if (!blanked) return;
      blanked = false;
      const { tools, session } = await probe();
      const cmd = displayCommand(session, tools, 'on');
      if (cmd && (await lidClosedNow(tools)) === false) await sys.run(cmd[0], cmd.slice(1));
    });

  /** Lid-closed holds running: the savings and the blanked screen last until the last one ends. */
  let lidHolds = 0;
  const onLid = (closed: boolean) => {
    void (closed ? applySavings() : undoSavings()).catch(() => {});
    void lidScreen(closed).catch(() => {});
  };

  // -- Holding --

  /** Starts `cmd args… lifeline…`; resolves with the child once it holds, or with why it does not. */
  const holdWith = (cmd: string, args: string[]): Promise<Child | string> =>
    new Promise((resolve) => {
      const child = sys.start(cmd, args);
      const timer = setTimeout(() => {
        child.stop();
        resolve(`${cmd}: no answer`);
      }, HOLD_TIMEOUT_MS);
      child.onLine((l) => {
        if (l.trim() !== 'held') return;
        clearTimeout(timer);
        resolve(child);
      });
      void child.exited.then((r) => {
        clearTimeout(timer);
        resolve(`${cmd}: ${r.stderr.trim() || `exit ${r.code}`}`);
      });
    });

  /** How logind and KDE treat the lid, apart from our lock. */
  const lidState = async (tools: Set<Tool>, session: Session) => {
    const [sw, ext, docked, ignoreInhibited] = await Promise.all(
      ['HandleLidSwitch', 'HandleLidSwitchExternalPower', 'HandleLidSwitchDocked', 'LidSwitchIgnoreInhibited'].map((p) => logindProp(tools, p)),
    );
    const inhib = await run(tools, 'busctl', ['--json=short', 'call', 'org.freedesktop.login1', '/org/freedesktop/login1', 'org.freedesktop.login1.Manager', 'ListInhibitors']);
    const kdeOwnsLid =
      session.kde ||
      parseInhibitors(inhib.stdout).some((i) => i.mode === 'block' && i.what.includes('handle-lid-switch') && i.who !== WHO && /powerdevil|kde/i.test(`${i.who} ${i.why}`));
    let kdeOk = true;
    if (kdeOwnsLid) {
      const cfg = sys.env.XDG_CONFIG_HOME || (sys.env.HOME ? `${sys.env.HOME}/.config` : '');
      kdeOk = cfg ? kdeLidHarmless(await sys.read(`${cfg}/powerdevilrc`), await sys.read(`${cfg}/powermanagementprofilesrc`)) : false;
    }
    const none = (v: unknown) => lidActionOf(v) === 'none';
    return {
      /** logind does nothing on the lid, on battery or on mains. */
      logindIgnoresLid: none(sw) && (ext === null || none(ext)),
      /** LidSwitchIgnoreInhibited=no: a plain sleep lock keeps the lid too. */
      sleepLockKeepsLid: ignoreInhibited === false,
      kdeOwnsLid,
      kdeOk,
      /** What logind would do on the lid now: docked first, then on mains, then on battery. */
      async action(): Promise<'none' | SuspendMode | undefined> {
        if (kdeOwnsLid) return kdeOk ? 'none' : undefined;
        if ((await logindProp(tools, 'Docked')) === true && docked !== null) return lidActionOf(docked);
        const onMains = (await battery()).source === 'ac';
        return lidActionOf(onMains && ext !== null ? ext : sw);
      },
    };
  };

  const hold = async (o: HoldOptions): Promise<Hold> => {
    const { tools, inhibit, session } = await probe();
    const what = ['sleep', ...(o.allowDisplaySleep ? [] : ['idle'])];
    const layers: { child: Child; cmd: string; args: string[]; lid: boolean; pending: Promise<Child | string> | null }[] = [];
    const errors: string[] = [];
    let lidLock = false;
    let released = false;
    let releasing: Promise<void> | null = null;
    let stopLid: (() => void) | null = null;
    let restarts = 0;

    const add = async (cmd: string, args: string[], lid = false) => {
      const full = [...args, ...(cmd === inhibit ? PIPE_LIFELINE : pidLifeline(sys.pid))];
      const r = await holdWith(cmd, full);
      if (typeof r === 'string') return errors.push(r), false;
      const layer = { child: r, cmd, args: full, lid, pending: null as Promise<Child | string> | null };
      layers.push(layer);
      // A lock lost while still wanted (logind or the desktop restarted) is taken again, a few times in all.
      const watch = (): void =>
        void layer.child.exited.then(async () => {
          while (!released && restarts < retryMs.length) {
            await wait(retryMs[restarts++]);
            if (released) return;
            layer.pending = holdWith(layer.cmd, layer.args);
            const again = await layer.pending;
            layer.pending = null;
            if (typeof again === 'string') continue;
            if (released) return again.stop();
            layer.child = again;
            return watch();
          }
          // The lid lock is gone for good: say so rather than let the lid put the machine to sleep unannounced.
          if (!released && layer.lid) lidClosedEffective = false;
        });
      watch();
      return true;
    };

    const letGo = async () => {
      released = true;
      try {
        if (stopLid) {
          stopLid();
          // Another lid-closed hold still running keeps the savings. Putting back may hang (bluetoothd not
          // answering): the locks go after a while anyway, what is not back stays recorded.
          if (--lidHolds === 0) await Promise.race([Promise.all([undoSavings(), screenAfterHolds()]).catch(() => {}), wait(UNDO_WAIT_MS)]);
        }
        if (lidAct) lidAction = await lidAct().catch(() => undefined);
      } finally {
        for (const l of layers) l.child.stop();
        await Promise.all(
          layers.map(async (l) => {
            const p = await l.pending;
            if (p && typeof p !== 'string') p.stop();
            await l.child.exited;
          }),
        );
      }
    };
    const release = () => (releasing ??= letGo());

    let lidClosedEffective = false;
    let lidAction: 'none' | SuspendMode | undefined;
    let lidAct: (() => Promise<'none' | SuspendMode | undefined>) | null = null;
    try {
      if (inhibit) {
        const base = (w: string[]) => [`--what=${w.join(':')}`, `--who=${WHO}`, `--why=${o.reason}`, '--mode=block'];
        if (o.lidClosed && (await add(inhibit, base([...what, 'handle-lid-switch']), true))) lidLock = true;
        else await add(inhibit, base(what));
      }
      if (session.gnome && tools.has('gnome-session-inhibit'))
        await add('gnome-session-inhibit', ['--app-id', 'ai-box', '--reason', o.reason, '--inhibit', o.allowDisplaySleep ? 'suspend' : 'suspend:idle']);
      if (session.kde && tools.has('kde-inhibit')) await add('kde-inhibit', ['--power', ...(o.allowDisplaySleep ? [] : ['--screenSaver'])]);
      if (!layers.length) throw new Error(`Linux: no lock could be taken (${errors.join('; ') || 'neither logind nor a known desktop'})`);

      if (o.lidClosed && inhibit) {
        const lid = await lidState(tools, session);
        lidAct = lid.action;
        lidAction = await lid.action();
        lidClosedEffective = (lidLock || lid.logindIgnoresLid || lid.sleepLockKeepsLid) && (!lid.kdeOwnsLid || lid.kdeOk);
      }
      if (lidClosedEffective) {
        lidHolds++;
        stopLid = onLidChange((closed) => onLid(closed));
      }
    } catch (e) {
      await release();
      throw e;
    }

    return {
      get lidClosedEffective() {
        return lidClosedEffective;
      },
      get lidAction() {
        return lidAction;
      },
      release: () => release().catch(() => {}),
    };
  };


  // -- Capabilities --

  const caps = async (): Promise<EnergyCaps> => {
    const { tools, inhibit, session } = await probe();
    const notes: string[] = [];
    let holdAwake = false;
    let lidClosedAwake = false;
    let needsElevation = false;

    const sessionLock = (session.gnome && tools.has('gnome-session-inhibit')) || (session.kde && tools.has('kde-inhibit'));
    const dump = await upower(tools);
    const lidPresent = dump?.daemon['lid-is-present'];
    if (!inhibit) {
      holdAwake = sessionLock;
      notes.push(
        sessionLock
          ? "systemd-logind est absent : AI Box ne bloque que la veille décidée par le bureau, pas celle du système."
          : "Ni systemd-logind ni bureau GNOME/KDE : AI Box ne peut pas empêcher la mise en veille.",
      );
    } else {
      const probeLock = (w: string) => run(tools, inhibit as Tool, [`--what=${w}`, `--who=${WHO}`, '--why=check', '--mode=block', 'true']);
      const both = await probeLock('sleep:handle-lid-switch');
      const sleepOnly = both.code === 0 ? both : await probeLock('sleep');
      holdAwake = sleepOnly.code === 0 || sessionLock;
      if (sleepOnly.code !== 0) notes.push(`logind refuse le verrou de veille : ${sleepOnly.stderr.trim() || `code ${sleepOnly.code}`}.`);
      const lid = await lidState(tools, session);
      const denied = both.code !== 0;
      if (lidPresent === 'no') notes.push('Aucun capot détecté.');
      else if (denied && !lid.logindIgnoresLid && !lid.sleepLockKeepsLid) {
        needsElevation = /denied|authori[sz]|permission/i.test(both.stderr);
        notes.push(
          'Le verrou capot de logind (handle-lid-switch) est refusé (session non active, SSH ?). Avec LidSwitchIgnoreInhibited=yes, ' +
            'réglage par défaut, un simple verrou de veille ne suffit pas au capot : il faut une règle polkit pour ' +
            "org.freedesktop.login1.inhibit-handle-lid-switch, ou HandleLidSwitch=ignore dans logind.conf.",
        );
      }
      lidClosedAwake = lidPresent !== 'no' && (!denied || lid.logindIgnoresLid || lid.sleepLockKeepsLid) && (!lid.kdeOwnsLid || lid.kdeOk);
      if (lid.kdeOwnsLid && !lid.kdeOk)
        notes.push(
          "KDE Plasma gère lui-même la fermeture du capot : réglez « Quand l'écran est rabattu » sur « Ne rien faire » " +
            "(Configuration du système > Gestion de l'énergie) pour que les sessions continuent capot fermé.",
        );
    }
    if (!tools.has('gdbus')) notes.push("gdbus est absent : AI Box ne voit pas le capot se fermer ni le secteur se débrancher.");

    const b = (dump && batteryFromUpower(dump)) ?? (await sysfsBattery());
    if (!b.present) notes.push('Aucune batterie détectée.');

    let displayOff = false;
    if (session.kind === 'none') notes.push("Pas de session graphique : pas d'écran à éteindre.");
    else {
      displayOff = displayCommand(session, tools, 'off') !== null;
      if (!displayOff)
        notes.push(
          session.kind === 'wayland'
            ? "Session Wayland sans moyen connu d'éteindre l'écran (pris en charge : GNOME, KDE avec kscreen-doctor)."
            : "xset est absent : l'écran ne peut pas être éteint.",
        );
    }

    const bt = tools.has('rfkill') ? parseRfkill((await run(tools, 'rfkill', ['list'])).stdout).filter((r) => r.type === 'Bluetooth') : [];
    const radios = bt.length > 0 && tools.has('bluetoothctl');
    if (!tools.has('rfkill')) notes.push("rfkill est absent : le Bluetooth reste allumé capot fermé.");
    else if (!bt.length) notes.push('Pas de Bluetooth à couper capot fermé.');
    else if (!tools.has('bluetoothctl'))
      notes.push("bluetoothctl est absent : AI Box ne peut pas vérifier qu'aucun appareil Bluetooth n'est connecté, il le laisse allumé.");
    if (!tools.has('powerprofilesctl'))
      notes.push(
        tools.has('tlp')
          ? "TLP règle déjà l'énergie selon le secteur ou la batterie ; AI Box n'y touche pas (il faudrait les droits root)."
          : "Ni power-profiles-daemon ni TLP : pas de mode économie d'énergie capot fermé.",
      );

    return { platform: 'linux', holdAwake, lidClosedAwake, needsElevation, battery: b.present, displayOff, radios, notes };
  };

  const displayOff = async () => {
    const { tools, session } = await probe();
    const cmd = displayCommand(session, tools, 'off');
    if (!cmd) throw new Error('Linux: no way to turn the display off in this session');
    const r = await sys.run(cmd[0], cmd.slice(1));
    if (r.code !== 0) throw new Error(`Linux: ${cmd[0]} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  };

  /** logind does it; a hibernation it cannot do (no swap, secure boot) falls back to sleep. */
  const suspend = async (mode: SuspendMode) => {
    const { tools } = await probe();
    const ctl = tools.has('systemctl') ? 'systemctl' : tools.has('loginctl') ? 'loginctl' : null;
    if (!ctl) throw new Error('Linux: neither systemctl nor loginctl to suspend with');
    const ask = async (verb: string) => {
      const r = await sys.run(ctl, [verb]);
      // logind already on its way (a lid it rechecked as the hold ended): asked is asked.
      return r.code === 0 || /already|in progress/i.test(r.stderr) ? null : r.stderr.trim() || `exit ${r.code}`;
    };
    if (mode === 'hibernate' && (await ask('hibernate')) === null) return;
    const err = await ask('suspend');
    if (err) throw new Error(`Linux: ${ctl} suspend failed: ${err}`);
  };

  const restoreLeftovers = () =>
    serial(async () => {
      // This run's own changes are not leftovers.
      if (changed.profile !== undefined || changed.bluetooth) return 0;
      const s = await readSnapshot();
      if (s.profile === undefined && !s.bluetooth) return 0;
      const { restored, left } = await undo(s);
      await writeSnapshot(left);
      return restored;
    });

  return {
    caps,
    battery,
    hold,
    restoreLeftovers,
    displayOff,
    suspend,
    onLidChange,
    onPowerSourceChange: (cb) => listen(sourceListeners, cb),
  };
}

/** What the lid would make logind (or KDE) do, from its HandleLidSwitch* value; undefined when unknown. */
export function lidActionOf(v: unknown): 'none' | SuspendMode | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  if (v === 'ignore' || v === 'lock') return 'none';
  return v === 'hibernate' ? 'hibernate' : 'sleep';
}

/** The command that blanks the screen (it wakes on input) or wakes it, or null in this session. */
function displayCommand(session: Session, tools: Set<Tool>, state: 'off' | 'on'): string[] | null {
  if (session.kind === 'x11') return tools.has('xset') ? ['xset', 'dpms', 'force', state] : null;
  if (session.kind !== 'wayland') return null;
  if (session.gnome && tools.has('gdbus'))
    return [
      'gdbus', 'call', '--session', '--dest', 'org.gnome.Mutter.DisplayConfig', '--object-path', '/org/gnome/Mutter/DisplayConfig',
      '--method', 'org.freedesktop.DBus.Properties.Set', 'org.gnome.Mutter.DisplayConfig', 'PowerSaveMode', state === 'off' ? '<int32 3>' : '<int32 0>',
    ];
  if (session.kde && tools.has('kscreen-doctor')) return ['kscreen-doctor', '--dpms', state];
  return null;
}
