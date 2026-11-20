import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  batteryFromSysfs,
  batteryFromUpower,
  kdeLidHarmless,
  lidActionOf,
  linuxEnergy,
  parseInhibitors,
  parseRfkill,
  parseUpowerDump,
  parseUpowerSignal,
  upowerMinutes,
  type Child,
  type LinuxSystem,
  type RunResult,
  type SysSupply,
} from './linux';

// ---- Fixtures: what these tools print on a real laptop (values made up, layout as printed) ----

const UPOWER_LAPTOP = `Device: /org/freedesktop/UPower/devices/line_power_AC
  native-path:          AC
  power supply:         yes
  updated:              Fri 20 Nov 2026 17:58:12 CET (31 seconds ago)
  has history:          no
  has statistics:       no
  line-power
    warning-level:       none
    online:              no
    icon-name:          'ac-adapter-symbolic'

Device: /org/freedesktop/UPower/devices/battery_BAT0
  native-path:          BAT0
  vendor:               SMP
  model:                5B10W13930
  power supply:         yes
  updated:              Fri 20 Nov 2026 17:58:40 CET (3 seconds ago)
  has history:          yes
  has statistics:       yes
  battery
    present:             yes
    rechargeable:        yes
    state:               discharging
    warning-level:       none
    energy:              38.52 Wh
    energy-full:         52.77 Wh
    energy-rate:         8.2 W
    voltage:             11.9 V
    time to empty:       4.7 hours
    percentage:          73%
    capacity:            92.4%
    technology:          lithium-polymer
    icon-name:          'battery-full-symbolic'

Device: /org/freedesktop/UPower/devices/mouse_hidpp_battery_0
  native-path:          hidpp_battery_0
  model:                MX Master 3
  power supply:         no
  updated:              Fri 20 Nov 2026 17:50:02 CET (520 seconds ago)
  has history:          yes
  has statistics:       yes
  mouse
    present:             yes
    rechargeable:        yes
    state:               discharging
    warning-level:       none
    percentage:          55%
    icon-name:          'battery-good-symbolic'

Device: /org/freedesktop/UPower/devices/DisplayDevice
  power supply:         yes
  updated:              Fri 20 Nov 2026 17:58:40 CET (3 seconds ago)
  has history:          no
  has statistics:       no
  battery
    present:             yes
    state:               discharging
    warning-level:       none
    energy:              38.52 Wh
    energy-full:         52.77 Wh
    energy-rate:         8.2 W
    time to empty:       4.7 hours
    percentage:          73%
    icon-name:          'battery-full-symbolic'

Daemon:
  daemon-version:  1.90.4
  on-battery:      yes
  lid-is-closed:   no
  lid-is-present:  yes
  critical-action: HybridSleep
`;

const UPOWER_DESKTOP = `Device: /org/freedesktop/UPower/devices/DisplayDevice
  power supply:         no
  updated:              Thu 01 Jan 1970 01:00:00 CET (1763657920 seconds ago)
  has history:          no
  has statistics:       no
  unknown
    warning-level:       none
    percentage:          0%
    icon-name:          ''

Daemon:
  daemon-version:  1.90.2
  on-battery:      no
  lid-is-closed:   no
  lid-is-present:  no
  critical-action: PowerOff
`;

const RFKILL = `0: tpacpi_bluetooth_sw: Bluetooth
	Soft blocked: no
	Hard blocked: no
1: phy0: Wireless LAN
	Soft blocked: no
	Hard blocked: no
2: hci0: Bluetooth
	Soft blocked: no
	Hard blocked: no
`;
const BT_SHOW = `Controller 00:00:00:00:00:01 (public)
	Manufacturer: 0x0002 (2)
	Version: 0x0c (12)
	Name: laptop
	Alias: laptop
	Class: 0x007c010c (8126732)
	Powered: yes
	PowerState: on
	Discoverable: no
	Pairable: yes
`;

const RFKILL_BT_OFF = RFKILL.replace(/(Bluetooth\n\tSoft blocked: )no/g, '$1yes');

const INHIBITORS_KDE = JSON.stringify({
  type: 'a(ssssuu)',
  data: [
    [
      ['sleep', 'ModemManager', 'ModemManager needs to reset devices', 'delay', 0, 1009],
      ['handle-power-key:handle-suspend-key:handle-hibernate-key:handle-lid-switch', 'PowerDevil', 'KDE handles power events', 'block', 1000, 1882],
    ],
  ],
});

const SYS_LAPTOP: Record<string, SysSupply> = {
  AC: { type: 'Mains', online: '0' },
  BAT0: { type: 'Battery', present: '1', status: 'Discharging', capacity: '73', energy_now: '38520000', energy_full: '52770000', power_now: '8200000' },
  'hid-0005:046D:B023.0001-battery': { type: 'Battery', scope: 'Device', present: '1', status: 'Discharging', capacity: '55' },
};

// ---- A fake Linux ----

class FakeChild implements Child {
  stopped = false;
  ended = false;
  private cbs: ((l: string) => void)[] = [];
  private done!: (r: RunResult) => void;
  readonly exited = new Promise<RunResult>((r) => (this.done = r));
  constructor(
    readonly cmd: string,
    readonly args: string[],
  ) {}
  onLine(cb: (l: string) => void) {
    this.cbs.push(cb);
  }
  emit(line: string) {
    this.cbs.forEach((cb) => cb(line));
  }
  exit(code: number | null, stderr = '') {
    this.ended = true;
    this.done({ code, stdout: '', stderr });
  }
  stop() {
    this.stopped = true;
    this.exit(143);
  }
}

type Answer = string | RunResult | ((args: string[]) => string | RunResult);
type ChildPlan = 'held' | 'deny' | 'silent';

interface FakeOptions {
  tools?: string[];
  env?: Record<string, string>;
  /** Answers by "cmd arg arg…"; a missing one exits 1. */
  run?: Record<string, Answer>;
  files?: Record<string, string>;
  dirs?: Record<string, string[]>;
  child?: (cmd: string, args: string[]) => ChildPlan;
}

const LAPTOP_TOOLS = ['systemd-inhibit', 'busctl', 'upower', 'gdbus', 'rfkill', 'bluetoothctl', 'powerprofilesctl', 'gnome-session-inhibit', 'xset', 'systemctl'];
const PROP = 'busctl --json=short get-property org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager';
const prop = (v: string | boolean) => JSON.stringify({ type: typeof v === 'string' ? 's' : 'b', data: v });

function logind(p: Partial<Record<'HandleLidSwitch' | 'HandleLidSwitchExternalPower' | 'HandleLidSwitchDocked' | 'LidSwitchIgnoreInhibited' | 'Docked' | 'LidClosed', string | boolean>> = {}) {
  const all = { HandleLidSwitch: 'suspend', HandleLidSwitchExternalPower: 'suspend', HandleLidSwitchDocked: 'ignore', LidSwitchIgnoreInhibited: true, Docked: false, LidClosed: false, ...p };
  return Object.fromEntries(Object.entries(all).map(([k, v]) => [`${PROP} ${k}`, prop(v)]));
}

function fakeLinux(o: FakeOptions = {}) {
  const runs: string[] = [];
  const children: FakeChild[] = [];
  const files: Record<string, string> = { ...o.files };
  const answers: Record<string, Answer> = {
    'upower -d': UPOWER_LAPTOP,
    'rfkill list': RFKILL,
    'bluetoothctl show': BT_SHOW,
    'bluetoothctl devices Connected': '',
    'powerprofilesctl get': 'balanced\n',
    'powerprofilesctl set power-saver': '',
    'powerprofilesctl set balanced': '',
    'rfkill block bluetooth': '',
    'rfkill unblock bluetooth': '',
    'xset dpms force off': '',
    'xset dpms force on': '',
    ...logind(),
    ...o.run,
  };
  const tools = o.tools ?? LAPTOP_TOOLS;
  const sys: LinuxSystem = {
    env: o.env ?? { XDG_CURRENT_DESKTOP: 'ubuntu:GNOME', XDG_SESSION_TYPE: 'x11', DISPLAY: ':0', HOME: '/home/u' },
    pid: 4242,
    async run(cmd, args) {
      if (cmd === 'sh') return { code: 0, stdout: args.slice(3).filter((t) => tools.includes(t)).map((t) => `/usr/bin/${t}\n`).join(''), stderr: '' };
      const key = [cmd, ...args].join(' ');
      runs.push(key);
      if (cmd.endsWith('-inhibit') && args.includes('true')) return o.child?.(cmd, args) === 'deny' ? { code: 1, stdout: '', stderr: 'Failed to inhibit: Access denied' } : { code: 0, stdout: '', stderr: '' };
      const a = answers[key];
      if (a === undefined) return { code: 1, stdout: '', stderr: `unexpected: ${key}` };
      const v = typeof a === 'function' ? a(args) : a;
      return typeof v === 'string' ? { code: 0, stdout: v, stderr: '' } : v;
    },
    start(cmd, args) {
      const c = new FakeChild(cmd, args);
      children.push(c);
      const plan = o.child?.(cmd, args) ?? (cmd === 'gdbus' ? 'silent' : 'held');
      setImmediate(() => (plan === 'held' ? c.emit('held') : plan === 'deny' ? c.exit(1, 'Failed to inhibit: Access denied') : undefined));
      return c;
    },
    read: async (path) => {
      const sysfs = /^\/sys\/class\/power_supply\/([^/]+)\/(\w+)$/.exec(path);
      if (sysfs && o.files?.[path] === undefined) return SYS_LAPTOP[sysfs[1]]?.[sysfs[2]] ?? null;
      return files[path] ?? null;
    },
    list: async (dir) => o.dirs?.[dir] ?? (dir === '/sys/class/power_supply' ? Object.keys(SYS_LAPTOP) : dir === '/sys/class/drm' ? ['card1', 'card1-eDP-1', 'card1-HDMI-A-1'] : []),
    write: async (path, text) => void (files[path] = text),
    remove: async (path) => void delete files[path],
  };
  if (!o.files?.['/sys/class/drm/card1-HDMI-A-1/status']) files['/sys/class/drm/card1-HDMI-A-1/status'] = 'disconnected\n';
  const live = () => children.filter((c) => !c.ended && c.cmd !== 'gdbus');
  const monitor = () => children.find((c) => c.cmd === 'gdbus' && !c.ended);
  return { sys, runs, children, files, live, monitor };
}

const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};
const SNAP = '/data/energy-linux.json';
const LID = (closed: boolean) =>
  `/org/freedesktop/UPower: org.freedesktop.DBus.Properties.PropertiesChanged ('org.freedesktop.UPower', {'LidIsClosed': <${closed}>}, @as [])`;

// ---- Parsers ----

test('upower -d: the summed battery, the source from the daemon, a mouse never counts', () => {
  const dump = parseUpowerDump(UPOWER_LAPTOP);
  assert.equal(dump.devices.length, 4);
  assert.equal(dump.daemon['lid-is-present'], 'yes');
  assert.deepEqual(batteryFromUpower(dump), { present: true, percent: 73, charging: false, source: 'battery', minutesLeft: 282 });
  const charging = UPOWER_LAPTOP.replace(/state:\s+discharging/g, 'state:               charging').replace('on-battery:      yes', 'on-battery:      no');
  assert.deepEqual(batteryFromUpower(parseUpowerDump(charging)), { present: true, percent: 73, charging: true, source: 'ac', minutesLeft: null });
  assert.deepEqual(batteryFromUpower(parseUpowerDump(UPOWER_DESKTOP)), { present: false, percent: null, charging: null, source: 'ac', minutesLeft: null });
  assert.equal(batteryFromUpower(parseUpowerDump('')), null);
});

test("upower's durations, in minutes", () => {
  assert.equal(upowerMinutes('4.7 hours'), 282);
  assert.equal(upowerMinutes('45.0 minutes'), 45);
  assert.equal(upowerMinutes('1.5 days'), 2160);
  assert.equal(upowerMinutes('30 seconds'), 1);
  assert.equal(upowerMinutes(undefined), null);
});

test('/sys/class/power_supply: energy or charge, peripherals left out, the mains decide the source', () => {
  assert.deepEqual(batteryFromSysfs(Object.values(SYS_LAPTOP)), { present: true, percent: 73, charging: false, source: 'battery', minutesLeft: 282 });
  const charge = [{ type: 'Mains', online: '1' }, { type: 'Battery', status: 'Charging', charge_now: '2000000', charge_full: '4000000', current_now: '1000000' }];
  assert.deepEqual(batteryFromSysfs(charge), { present: true, percent: 50, charging: true, source: 'ac', minutesLeft: null });
  // Two batteries (ThinkPad), one empty: summed, not averaged.
  const two = [
    { type: 'Battery', status: 'Discharging', energy_now: '30000000', energy_full: '40000000', power_now: '5000000' },
    { type: 'Battery', status: 'Unknown', energy_now: '0', energy_full: '20000000', power_now: '0' },
  ];
  assert.equal(batteryFromSysfs(two).percent, 50);
  assert.equal(batteryFromSysfs(two).source, 'battery');
  assert.deepEqual(batteryFromSysfs([{ type: 'Mains', online: '1' }]), { present: false, percent: null, charging: null, source: 'ac', minutesLeft: null });
});

test('rfkill list, logind inhibitors, UPower signals, lid actions', () => {
  assert.deepEqual(
    parseRfkill(RFKILL_BT_OFF).map((r) => [r.id, r.name, r.type, r.soft, r.hard]),
    [
      [0, 'tpacpi_bluetooth_sw', 'Bluetooth', true, false],
      [1, 'phy0', 'Wireless LAN', false, false],
      [2, 'hci0', 'Bluetooth', true, false],
    ],
  );
  const inh = parseInhibitors(INHIBITORS_KDE);
  assert.equal(inh[1].who, 'PowerDevil');
  assert.ok(inh[1].what.includes('handle-lid-switch'));
  assert.deepEqual(parseInhibitors('not json'), []);
  assert.deepEqual(parseUpowerSignal(LID(true)), { lidClosed: true });
  assert.deepEqual(parseUpowerSignal("('org.freedesktop.UPower', {'OnBattery': <false>, 'LidIsClosed': <false>}, @as [])"), { lidClosed: false, onBattery: false });
  assert.equal(lidActionOf('ignore'), 'none');
  assert.equal(lidActionOf('lock'), 'none');
  assert.equal(lidActionOf('suspend-then-hibernate'), 'sleep');
  assert.equal(lidActionOf('hibernate'), 'hibernate');
  assert.equal(lidActionOf(null), undefined);
});

test("KDE's lid setting: harmless only when every profile does nothing or locks", () => {
  const p6 = (ac: string, bat: string, low: string) =>
    `[AC][SuspendAndShutdown]\nLidAction=${ac}\n\n[Battery][SuspendAndShutdown]\nLidAction=${bat}\n\n[LowBattery][SuspendAndShutdown]\nLidAction=${low}\n`;
  assert.equal(kdeLidHarmless(p6('0', '0', '32'), null), true);
  assert.equal(kdeLidHarmless(p6('0', '1', '0'), null), false);
  assert.equal(kdeLidHarmless('[AC][Display]\nDimDisplayIdleTimeoutSec=60\n', null), false);
  assert.equal(kdeLidHarmless(null, '[AC][HandleButtonEvents]\nlidAction=0\n[Battery][HandleButtonEvents]\nlidAction=0\n[LowBattery][HandleButtonEvents]\nlidAction=0\n'), true);
  assert.equal(kdeLidHarmless(null, null), false);
});

// ---- The platform ----

test('battery: UPower first, the kernel when UPower is missing', async () => {
  assert.equal((await linuxEnergy({ dataDir: '/data', sys: fakeLinux().sys }).battery()).minutesLeft, 282);
  const noUpower = fakeLinux({ tools: LAPTOP_TOOLS.filter((t) => t !== 'upower') });
  assert.deepEqual(await linuxEnergy({ dataDir: '/data', sys: noUpower.sys }).battery(), { present: true, percent: 73, charging: false, source: 'battery', minutesLeft: 282 });
});

test('a lid-closed hold on GNOME: logind with handle-lid-switch and the session lock, all let go on release', async () => {
  const f = fakeLinux();
  const e = linuxEnergy({ dataDir: '/data', sys: f.sys });
  const h = await e.hold({ reason: '2 workers running', lidClosed: true, allowDisplaySleep: false });
  assert.equal(h.lidClosedEffective, true);
  assert.equal(h.lidAction, 'sleep');
  const [logind, gnome] = f.live();
  assert.equal(logind.cmd, 'systemd-inhibit');
  assert.deepEqual(logind.args.slice(0, 4), ['--what=sleep:idle:handle-lid-switch', '--who=AI Box', '--why=2 workers running', '--mode=block']);
  assert.deepEqual(logind.args.slice(4), ['sh', '-c', 'echo held; exec cat >/dev/null']);
  assert.equal(gnome.cmd, 'gnome-session-inhibit');
  assert.ok(gnome.args.includes('suspend:idle'));
  // Under the desktop's wrapper the program watches the hub's pid, not a stdin the wrapper does not pass on.
  assert.deepEqual(gnome.args.slice(-2), ['sh', '4242']);
  assert.match(gnome.args[gnome.args.length - 3], /kill -0 "\$1".*kill -0 "\$PPID"/);
  assert.ok(f.monitor(), 'the lid is watched');
  await h.release();
  await h.release();
  assert.equal(f.live().length, 0);
  await settle();
  assert.equal(f.monitor(), undefined, 'nothing left watching');
});

test('lidAction follows the power source and docking; a display that may sleep takes no idle lock', async () => {
  const f = fakeLinux({ run: { ...logind({ HandleLidSwitchExternalPower: 'ignore' }), 'upower -d': UPOWER_LAPTOP.replace('on-battery:      yes', 'on-battery:      no') } });
  const h = await linuxEnergy({ dataDir: '/data', sys: f.sys }).hold({ reason: 'r', lidClosed: true, allowDisplaySleep: true });
  assert.equal(h.lidAction, 'none');
  assert.equal(f.live()[0].args[0], '--what=sleep:handle-lid-switch');
  assert.ok(f.live()[1].args.includes('suspend'));
  await h.release();
  const d = fakeLinux({ run: logind({ Docked: true, HandleLidSwitchDocked: 'hibernate' }) });
  const hd = await linuxEnergy({ dataDir: '/data', sys: d.sys }).hold({ reason: 'r', lidClosed: true, allowDisplaySleep: true });
  assert.equal(hd.lidAction, 'hibernate');
  await hd.release();
});

test('the lid lock refused (SSH): sleep only, not effective, unless logind leaves the lid alone', async () => {
  const deny = (cmd: string, args: string[]): ChildPlan => (cmd === 'systemd-inhibit' && args[0].includes('handle-lid-switch') ? 'deny' : 'held');
  const f = fakeLinux({ child: deny });
  const h = await linuxEnergy({ dataDir: '/data', sys: f.sys }).hold({ reason: 'r', lidClosed: true, allowDisplaySleep: true });
  assert.equal(h.lidClosedEffective, false);
  assert.equal(f.live()[0].args[0], '--what=sleep');
  await h.release();
  // LidSwitchIgnoreInhibited=no: logind honours the plain sleep lock for the lid too.
  const g = fakeLinux({ child: deny, run: logind({ LidSwitchIgnoreInhibited: false }) });
  const hg = await linuxEnergy({ dataDir: '/data', sys: g.sys }).hold({ reason: 'r', lidClosed: true, allowDisplaySleep: true });
  assert.equal(hg.lidClosedEffective, true);
  await hg.release();
  const i = fakeLinux({ child: deny, run: logind({ HandleLidSwitch: 'ignore', HandleLidSwitchExternalPower: 'lock' }) });
  const hi = await linuxEnergy({ dataDir: '/data', sys: i.sys }).hold({ reason: 'r', lidClosed: true, allowDisplaySleep: true });
  assert.equal(hi.lidClosedEffective, true);
  assert.equal(hi.lidAction, 'none');
  await hi.release();
});

test('KDE: PowerDevil owns the lid; effective only when its lid action does nothing', async () => {
  const kde = { XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', HOME: '/home/u' };
  const tools = [...LAPTOP_TOOLS.filter((t) => t !== 'gnome-session-inhibit'), 'kde-inhibit', 'kscreen-doctor'];
  const run = { 'busctl --json=short call org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager ListInhibitors': INHIBITORS_KDE };
  const f = fakeLinux({ env: kde, tools, run });
  const e = linuxEnergy({ dataDir: '/data', sys: f.sys });
  const h = await e.hold({ reason: 'r', lidClosed: true, allowDisplaySleep: false });
  assert.equal(h.lidClosedEffective, false);
  assert.deepEqual(f.live()[1].args.slice(0, 2), ['--power', '--screenSaver']);
  await h.release();
  const c = await e.caps();
  assert.equal(c.lidClosedAwake, false);
  assert.ok(c.notes.some((n) => n.includes('Ne rien faire')));
  const cfg = ['AC', 'Battery', 'LowBattery'].map((p) => `[${p}][SuspendAndShutdown]\nLidAction=0\n`).join('\n');
  const g = fakeLinux({ env: kde, tools, run, files: { '/home/u/.config/powerdevilrc': cfg } });
  const hg = await linuxEnergy({ dataDir: '/data', sys: g.sys }).hold({ reason: 'r', lidClosed: true, allowDisplaySleep: false });
  assert.equal(hg.lidClosedEffective, true);
  assert.equal(hg.lidAction, 'none');
  await hg.release();
});

test('no lock at all: hold rejects and leaves nothing running', async () => {
  const f = fakeLinux({ child: () => 'deny' });
  await assert.rejects(linuxEnergy({ dataDir: '/data', sys: f.sys }).hold({ reason: 'r', lidClosed: true, allowDisplaySleep: true }), /no lock/);
  assert.equal(f.live().length, 0);
  const none = fakeLinux({ tools: [] });
  await assert.rejects(linuxEnergy({ dataDir: '/data', sys: none.sys }).hold({ reason: 'r', lidClosed: false, allowDisplaySleep: true }), /neither logind/);
});

test('a failure half-way through a hold lets go of the locks already taken, then rejects', async () => {
  const kde = { XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'x11', DISPLAY: ':0', HOME: '/home/u' };
  const f = fakeLinux({ env: kde, tools: [...LAPTOP_TOOLS, 'kde-inhibit'] });
  f.sys.read = async () => {
    throw new Error('EIO');
  };
  await assert.rejects(linuxEnergy({ dataDir: '/data', sys: f.sys }).hold({ reason: 'r', lidClosed: true, allowDisplaySleep: true }), /EIO/);
  assert.equal(f.live().length, 0);
  assert.ok(f.children.length >= 2);
});

test('the lid shuts: power-saver, Bluetooth off, screen blanked, written down first; it opens: all back, record gone', async () => {
  const f = fakeLinux();
  const order: string[] = [];
  const write = f.sys.write;
  f.sys.write = async (p, t) => (order.push(`write ${t}`), write(p, t));
  const run = f.sys.run;
  f.sys.run = async (c, a) => (c !== 'sh' && !a.includes('get-property') && order.push([c, ...a].join(' ')), run(c, a));
  const e = linuxEnergy({ dataDir: '/data', sys: f.sys });
  const h = await e.hold({ reason: 'r', lidClosed: true, allowDisplaySleep: true });
  await settle();
  assert.ok(!f.runs.includes('powerprofilesctl set power-saver'), 'lid open: nothing changed');
  f.monitor()!.emit(LID(true));
  await settle();
  const i = (s: string) => order.indexOf(s);
  assert.ok(i('write {"profile":"balanced"}') >= 0 && i('write {"profile":"balanced"}') < i('powerprofilesctl set power-saver'));
  assert.ok(i('write {"profile":"balanced","bluetooth":true}') < i('rfkill block bluetooth'));
  assert.ok(f.runs.includes('xset dpms force off'));
  assert.equal(JSON.parse(f.files[SNAP]).bluetooth, true);
  assert.ok(!f.runs.some((r) => r.includes('wlan') || r.includes('wifi')), 'Wi-Fi is never touched');
  // Opened: what we changed comes back, only because it is still as we left it.
  f.sys.run = async (c, a) => {
    if ([c, ...a].join(' ') === 'powerprofilesctl get') return { code: 0, stdout: 'power-saver\n', stderr: '' };
    if ([c, ...a].join(' ') === 'rfkill list') return { code: 0, stdout: RFKILL_BT_OFF, stderr: '' };
    return run(c, a);
  };
  f.monitor()!.emit(LID(false));
  await settle();
  assert.ok(f.runs.includes('powerprofilesctl set balanced'));
  assert.ok(f.runs.includes('rfkill unblock bluetooth'));
  assert.ok(f.runs.includes('xset dpms force on'));
  assert.equal(f.files[SNAP], undefined);
  await h.release();
});

test('Bluetooth stays on with a device connected, an external display, or no bluetoothctl', async () => {
  const cases: FakeOptions[] = [
    { run: { 'bluetoothctl devices Connected': 'Device 00:11:22:33:44:55 Headset\n' } },
    { files: { '/sys/class/drm/card1-HDMI-A-1/status': 'connected\n' } },
    { tools: LAPTOP_TOOLS.filter((t) => t !== 'bluetoothctl') },
    { run: { 'bluetoothctl devices Connected': { code: null, stdout: '', stderr: 'Waiting to connect to bluetoothd...' } } },
    // Switched off in the desktop's settings: BlueZ powered off, rfkill open. The user's choice, not ours to undo.
    { run: { 'bluetoothctl show': BT_SHOW.replace('Powered: yes', 'Powered: no') } },
  ];
  for (const c of cases) {
    const f = fakeLinux(c);
    const h = await linuxEnergy({ dataDir: '/data', sys: f.sys }).hold({ reason: 'r', lidClosed: true, allowDisplaySleep: true });
    f.monitor()!.emit(LID(true));
    await settle();
    assert.ok(!f.runs.includes('rfkill block bluetooth'), JSON.stringify(c));
    assert.ok(f.runs.includes('powerprofilesctl set power-saver'));
    await h.release();
  }
  // With an external display the screen is not blanked either (it would blank that one too).
  const ext = fakeLinux({ files: { '/sys/class/drm/card1-HDMI-A-1/status': 'connected\n' } });
  const h = await linuxEnergy({ dataDir: '/data', sys: ext.sys }).hold({ reason: 'r', lidClosed: true, allowDisplaySleep: true });
  ext.monitor()!.emit(LID(true));
  await settle();
  assert.ok(!ext.runs.includes('xset dpms force off'));
  await h.release();
});

test('a profile switch that fails is struck from the record; Bluetooth still goes off', async () => {
  const f = fakeLinux({ run: { 'powerprofilesctl set power-saver': { code: 1, stdout: '', stderr: 'denied' } } });
  const h = await linuxEnergy({ dataDir: '/data', sys: f.sys }).hold({ reason: 'r', lidClosed: true, allowDisplaySleep: true });
  f.monitor()!.emit(LID(true));
  await settle();
  assert.deepEqual(JSON.parse(f.files[SNAP]), { bluetooth: true });
  await h.release();
});

test('release with the lid shut: a restore that fails stays recorded, release still resolves; the next start puts it back', async () => {
  const f = fakeLinux({ run: { 'upower -d': UPOWER_LAPTOP.replace('lid-is-closed:   no', 'lid-is-closed:   yes') } });
  const e = linuxEnergy({ dataDir: '/data', sys: f.sys });
  const h = await e.hold({ reason: 'r', lidClosed: true, allowDisplaySleep: true });
  await settle();
  assert.ok(f.runs.includes('powerprofilesctl set power-saver'), 'already shut when the hold began');
  const run = f.sys.run;
  f.sys.run = async (c, a) => {
    const k = [c, ...a].join(' ');
    if (k === 'powerprofilesctl get') return { code: 0, stdout: 'power-saver\n', stderr: '' };
    if (k === 'rfkill list') return { code: 0, stdout: RFKILL_BT_OFF, stderr: '' };
    if (k === 'rfkill unblock bluetooth') return { code: 1, stdout: '', stderr: 'Operation not permitted' };
    return run(c, a);
  };
  await h.release();
  assert.equal(f.live().length, 0);
  assert.deepEqual(JSON.parse(f.files[SNAP]), { bluetooth: true });
  // Next start (a crash, or the same failure): a new instance finds the record.
  f.sys.run = async (c, a) => ([c, ...a].join(' ') === 'rfkill list' ? { code: 0, stdout: RFKILL_BT_OFF, stderr: '' } : run(c, a));
  assert.equal(await linuxEnergy({ dataDir: '/data', sys: f.sys }).restoreLeftovers(), 1);
  assert.equal(f.files[SNAP], undefined);
  assert.equal(await linuxEnergy({ dataDir: '/data', sys: f.sys }).restoreLeftovers(), 0);
});

test('leftovers the user changed since are left alone', async () => {
  const f = fakeLinux({ files: { [SNAP]: JSON.stringify({ profile: 'balanced', bluetooth: true }) }, run: { 'powerprofilesctl get': 'performance\n' } });
  assert.equal(await linuxEnergy({ dataDir: '/data', sys: f.sys }).restoreLeftovers(), 0);
  assert.ok(!f.runs.some((r) => r.startsWith('powerprofilesctl set') || r.startsWith('rfkill unblock')));
  assert.equal(f.files[SNAP], undefined);
  const broken = fakeLinux({ files: { [SNAP]: '{not json' } });
  assert.equal(await linuxEnergy({ dataDir: '/data', sys: broken.sys }).restoreLeftovers(), 0);
});

test('two lid-closed holds: the savings last until the last one ends', async () => {
  const f = fakeLinux();
  const e = linuxEnergy({ dataDir: '/data', sys: f.sys });
  const a = await e.hold({ reason: 'a', lidClosed: true, allowDisplaySleep: true });
  const b = await e.hold({ reason: 'b', lidClosed: true, allowDisplaySleep: true });
  f.monitor()!.emit(LID(true));
  await settle();
  await a.release();
  assert.ok(!f.runs.includes('powerprofilesctl set balanced'));
  assert.ok(f.monitor(), 'still watching for b');
  f.sys.run = ((run) => async (c: string, a: string[]) => ([c, ...a].join(' ') === 'powerprofilesctl get' ? { code: 0, stdout: 'power-saver\n', stderr: '' } : run(c, a)))(f.sys.run);
  await b.release();
  assert.ok(f.runs.includes('powerprofilesctl set balanced'));
});

test('a lock lost while held is taken again', async () => {
  const f = fakeLinux();
  const h = await linuxEnergy({ dataDir: '/data', sys: f.sys, retryMs: [0] }).hold({ reason: 'r', lidClosed: false, allowDisplaySleep: true });
  const first = f.live()[0];
  first.exit(1, 'logind restarted');
  await settle();
  assert.equal(f.children.filter((c) => c.cmd === 'systemd-inhibit').length, 2);
  await h.release();
  assert.equal(f.live().length, 0);
});

test('lid events: the current state right after subscribing, then changes; power source changes carry the battery', async () => {
  const f = fakeLinux();
  const e = linuxEnergy({ dataDir: '/data', sys: f.sys });
  const lids: boolean[] = [];
  const offLid = e.onLidChange!((c) => lids.push(c));
  await settle();
  assert.deepEqual(lids, [false]);
  f.monitor()!.emit(LID(true));
  const sources: string[] = [];
  const offSrc = e.onPowerSourceChange!((b) => sources.push(`${b.source} ${b.percent}`));
  f.monitor()!.emit("/org/freedesktop/UPower: org.freedesktop.DBus.Properties.PropertiesChanged ('org.freedesktop.UPower', {'OnBattery': <false>}, @as [])");
  await settle();
  assert.deepEqual(lids, [false, true]);
  assert.deepEqual(sources, ['ac 73']);
  assert.equal(f.children.filter((c) => c.cmd === 'gdbus').length, 1, 'one monitor for every listener');
  offLid();
  offSrc();
  await settle();
  assert.equal(f.monitor(), undefined);
});

test('caps on a GNOME laptop: everything', async () => {
  const c = await linuxEnergy({ dataDir: '/data', sys: fakeLinux().sys }).caps();
  assert.deepEqual({ ...c, notes: [] }, { platform: 'linux', holdAwake: true, lidClosedAwake: true, needsElevation: false, battery: true, displayOff: true, radios: true, notes: [] });
  assert.deepEqual(c.notes, []);
});

test('caps say what is missing: SSH session, no systemd, a desktop without lid or screen', async () => {
  const ssh = await linuxEnergy({ dataDir: '/data', sys: fakeLinux({ child: (_c, a) => (a[0].includes('handle-lid-switch') ? 'deny' : 'held') }).sys }).caps();
  assert.equal(ssh.lidClosedAwake, false);
  assert.equal(ssh.needsElevation, true);
  assert.ok(ssh.notes.some((n) => n.includes('LidSwitchIgnoreInhibited') && n.includes('polkit')));
  const bare = await linuxEnergy({ dataDir: '/data', sys: fakeLinux({ tools: [], env: {}, dirs: { '/sys/class/power_supply': [] } }).sys }).caps();
  assert.deepEqual({ ...bare, notes: [] }, { platform: 'linux', holdAwake: false, lidClosedAwake: false, needsElevation: false, battery: false, displayOff: false, radios: false, notes: [] });
  assert.ok(bare.notes.some((n) => n.includes('systemd-logind')));
  assert.ok(bare.notes.some((n) => n.includes('session graphique')));
  const desk = await linuxEnergy({
    dataDir: '/data',
    sys: fakeLinux({ run: { 'upower -d': UPOWER_DESKTOP, 'rfkill list': '' }, env: { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-1', XDG_CURRENT_DESKTOP: 'sway' } }).sys,
  }).caps();
  assert.equal(desk.lidClosedAwake, false);
  assert.equal(desk.battery, false);
  assert.equal(desk.displayOff, false);
  assert.ok(desk.notes.includes('Aucun capot détecté.'));
  assert.ok(desk.notes.some((n) => n.includes('Wayland')));
});

test('displayOff per session: X11 DPMS, GNOME Wayland through Mutter, KDE Wayland through kscreen-doctor', async () => {
  const x = fakeLinux();
  await linuxEnergy({ dataDir: '/data', sys: x.sys }).displayOff();
  assert.ok(x.runs.includes('xset dpms force off'));
  const mutter =
    'gdbus call --session --dest org.gnome.Mutter.DisplayConfig --object-path /org/gnome/Mutter/DisplayConfig --method org.freedesktop.DBus.Properties.Set org.gnome.Mutter.DisplayConfig PowerSaveMode <int32 3>';
  const g = fakeLinux({ env: { XDG_CURRENT_DESKTOP: 'GNOME', XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }, run: { [mutter]: '()\n' } });
  await linuxEnergy({ dataDir: '/data', sys: g.sys }).displayOff();
  assert.ok(g.runs.includes(mutter));
  const k = fakeLinux({ env: { XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' }, tools: [...LAPTOP_TOOLS, 'kscreen-doctor'], run: { 'kscreen-doctor --dpms off': '' } });
  await linuxEnergy({ dataDir: '/data', sys: k.sys }).displayOff();
  assert.ok(k.runs.includes('kscreen-doctor --dpms off'));
  await assert.rejects(linuxEnergy({ dataDir: '/data', sys: fakeLinux({ env: {} }).sys }).displayOff(), /no way/);
});

test('suspend: hibernate falls back to sleep; a sleep already under way counts as asked', async () => {
  const f = fakeLinux({ run: { 'systemctl hibernate': { code: 1, stdout: '', stderr: 'Not enough suitable swap space for hibernation' }, 'systemctl suspend': '' } });
  await linuxEnergy({ dataDir: '/data', sys: f.sys }).suspend('hibernate');
  assert.deepEqual(f.runs.filter((r) => r.startsWith('systemctl')), ['systemctl hibernate', 'systemctl suspend']);
  const busy = fakeLinux({ run: { 'systemctl suspend': { code: 1, stdout: '', stderr: "There's already a shutdown or sleep operation in progress" } } });
  await linuxEnergy({ dataDir: '/data', sys: busy.sys }).suspend('sleep');
  const no = fakeLinux({ run: { 'systemctl suspend': { code: 1, stdout: '', stderr: 'Operation inhibited by "Steam"' } } });
  await assert.rejects(linuxEnergy({ dataDir: '/data', sys: no.sys }).suspend('sleep'), /inhibited/);
  const elogind = fakeLinux({ tools: ['elogind-inhibit', 'loginctl'], run: { 'loginctl suspend': '' } });
  await linuxEnergy({ dataDir: '/data', sys: elogind.sys }).suspend('sleep');
  assert.ok(elogind.runs.includes('loginctl suspend'));
});

test('the lid lock lost for good: the hold says it no longer keeps the lid; a retake in flight is stopped by release', async () => {
  let deny = false;
  const f = fakeLinux({ child: (c) => (deny && c === 'systemd-inhibit' ? 'deny' : 'held') });
  const h = await linuxEnergy({ dataDir: '/data', sys: f.sys, retryMs: [0, 0] }).hold({ reason: 'r', lidClosed: true, allowDisplaySleep: true });
  assert.equal(h.lidClosedEffective, true);
  deny = true;
  f.live()[0].exit(1, 'logind gone');
  await settle();
  assert.equal(h.lidClosedEffective, false);
  await h.release();
  // A retake still waiting for its lock when release comes is let go too.
  const g = fakeLinux({ child: (c) => (c === 'systemd-inhibit' && g.children.length > 2 ? 'silent' : 'held') });
  const hg = await linuxEnergy({ dataDir: '/data', sys: g.sys, retryMs: [0] }).hold({ reason: 'r', lidClosed: false, allowDisplaySleep: true });
  g.live()[0].exit(1, 'logind restarted');
  await settle();
  const pending = g.children[g.children.length - 1];
  assert.equal(pending.cmd, 'systemd-inhibit');
  const done = hg.release();
  await settle();
  pending.emit('held');
  await done;
  assert.equal(g.live().length, 0);
});

test('release twice at once: one letting go, both wait for it', async () => {
  const f = fakeLinux();
  const h = await linuxEnergy({ dataDir: '/data', sys: f.sys }).hold({ reason: 'r', lidClosed: false, allowDisplaySleep: true });
  await Promise.all([h.release(), h.release()]);
  assert.equal(f.live().length, 0);
});

test('our own lid lock is not taken for KDE, whatever the reason says', async () => {
  const own = JSON.stringify({ type: 'a(ssssuu)', data: [[['sleep:handle-lid-switch', 'AI Box', 'kde app build', 'block', 1000, 5000]]] });
  const f = fakeLinux({ run: { 'busctl --json=short call org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager ListInhibitors': own } });
  const h = await linuxEnergy({ dataDir: '/data', sys: f.sys }).hold({ reason: 'kde app build', lidClosed: true, allowDisplaySleep: true });
  assert.equal(h.lidClosedEffective, true);
  await h.release();
});

test('a screen blanked under the lid is forgotten when the last hold ends, so the next hold blanks it again', async () => {
  const f = fakeLinux();
  const e = linuxEnergy({ dataDir: '/data', sys: f.sys });
  const a = await e.hold({ reason: 'a', lidClosed: true, allowDisplaySleep: true });
  f.monitor()!.emit(LID(true));
  await settle();
  await a.release();
  const b = await e.hold({ reason: 'b', lidClosed: true, allowDisplaySleep: true });
  await settle();
  f.monitor()!.emit(LID(true));
  await settle();
  assert.equal(f.runs.filter((r) => r === 'xset dpms force off').length, 2);
  await b.release();
});

test('a listener that throws does not stop the others', async () => {
  const f = fakeLinux();
  const e = linuxEnergy({ dataDir: '/data', sys: f.sys });
  const heard: boolean[] = [];
  const off1 = e.onLidChange!(() => {
    throw new Error('boom');
  });
  const off2 = e.onLidChange!((c) => heard.push(c));
  await settle();
  f.monitor()!.emit(LID(true));
  await settle();
  assert.deepEqual(heard, [false, true]);
  off1();
  off2();
});
