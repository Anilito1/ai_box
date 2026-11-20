import assert from 'node:assert/strict';
import { test } from 'node:test';
import { batteryOf, indexesOf, probeOf, schemeOf, Win32Energy, type HelperProcess, type RunResult, type Win32System } from './win32';

// The Windows adapter on a fake Windows: powercfg's plans, the helper's answers, the snapshot file. Outputs marked
// "measured" come from the development PC (a desktop, French Windows 11); the laptop ones are fixtures written from
// Microsoft's documentation, not measured on a laptop.

const USER = '9935e61f-1661-40c5-ae2f-8495027d5d5d';
const OTHER = 'a1841308-3541-4fab-bc81-f71556f20b4a';
const BALANCED = '381b4222-f694-41f0-9685-ff5bb260df2e';
const LIDACTION = '5ca83367-6e45-459f-a27b-476b1d01c936';
const STANDBYIDLE = '29f6c1db-86da-48c5-9fdb-f2b67b1f44da';
const BATACTIONCRIT = '637ea02f-bbcb-4015-8e2c-a1c7b9c0b546';

// Measured: powercfg /getactivescheme on the development PC.
const ACTIVE_FR = (g: string) => `GUID du mode de gestion de l’alimentation : ${g}  (AMD Ryzen™ High Performance)\r\n`;
// Fixture, not measured: English Windows.
const ACTIVE_EN = (g: string) => `Power Scheme GUID: ${g}  (Balanced)\r\n`;
// Fixture, not measured: powercfg /qh <plan> SUB_BUTTONS LIDACTION on a laptop (sleep on mains, hibernate on battery).
const LID_QH_EN = `Power Scheme GUID: ${USER}  (Balanced)
  GUID Alias: SCHEME_BALANCED
  Subgroup GUID: 4f971e89-eebd-4455-a8de-9e59040e7347  (Power buttons and lid)
    GUID Alias: SUB_BUTTONS
    Power Setting GUID: 5ca83367-6e45-459f-a27b-476b1d01c936  (Lid close action)
      GUID Alias: LIDACTION
      Possible Setting Index: 000
      Possible Setting Friendly Name: Do nothing
      Possible Setting Index: 001
      Possible Setting Friendly Name: Sleep
      Possible Setting Index: 002
      Possible Setting Friendly Name: Hibernate
      Possible Setting Index: 003
      Possible Setting Friendly Name: Shut down
    Current AC Power Setting Index: 0x00000001
    Current DC Power Setting Index: 0x00000002
`;
// Fixture, not measured: the same in French.
const LID_QH_FR = LID_QH_EN.replace('Current AC Power Setting Index', 'Index actuel du paramètre de courant alternatif').replace(
  'Current DC Power Setting Index',
  'Index actuel du paramètre de courant continu',
);

// The helper's "caps" answer: LidPresent, S3, S4, hiberfile, AoAc, batteries.
const DESKTOP = '0 1 1 1 0 0'; // measured
const LAPTOP_S3 = '1 1 1 1 0 1'; // fixture, not measured
const LAPTOP_S0 = '1 0 1 1 1 1'; // fixture, not measured (Modern Standby)

class FakeWindows implements Win32System {
  active = USER;
  plans = new Map<string, Map<string, [number, number]>>([
    [USER, new Map([[LIDACTION, [1, 2] as [number, number]]])],
    [OTHER, new Map()],
    [BALANCED, new Map()],
  ]);
  files = new Map<string, string>();
  calls: string[] = [];
  /** powercfg verbs that fail, with how many more times. */
  failing = new Map<string, number>();
  caps = LAPTOP_S3;
  status = '0 1 42 5400';
  english = false;
  helpers: FakeHelper[] = [];
  timers: { fn: () => void; ms: number; live: boolean }[] = [];
  /** What the snapshot file held when the copy was made. */
  snapshotAtDuplicate: string | null = null;
  private n = 0;

  async run(file: string, args: string[], input?: string): Promise<RunResult> {
    if (file.toLowerCase().endsWith('powershell.exe')) {
      const lines = (input ?? '').split('\n').slice(1).filter(Boolean);
      this.calls.push(...lines.map((l) => `once ${l}`));
      return { code: 0, stdout: ['ready', ...lines.map((l) => this.answer(l))].join('\r\n') };
    }
    const verb = args[0];
    this.calls.push(`powercfg ${args.join(' ')}`);
    const left = this.failing.get(verb) ?? 0;
    if (left > 0) {
      this.failing.set(verb, left - 1);
      return { code: 1, stdout: '' };
    }
    const fail = { code: 1, stdout: '' };
    switch (verb) {
      case '/getactivescheme':
        return { code: 0, stdout: (this.english ? ACTIVE_EN : ACTIVE_FR)(this.active) };
      case '/list':
        return { code: 0, stdout: [...this.plans.keys()].map((g) => ACTIVE_FR(g)).join('') };
      case '/qh': {
        const v = this.plans.get(args[1])?.get(args[3]);
        if (!v) return fail;
        const out = (this.english ? LID_QH_EN : LID_QH_FR).replace('0x00000001', `0x0000000${v[0]}`).replace('0x00000002', `0x0000000${v[1]}`);
        return { code: 0, stdout: out };
      }
      case '/duplicatescheme': {
        const from = this.plans.get(args[1]);
        if (!from || this.plans.has(args[2])) return fail;
        this.snapshotAtDuplicate = [...this.files.values()][0] ?? null;
        this.plans.set(args[2], new Map(from));
        return { code: 0, stdout: ACTIVE_FR(args[2]) };
      }
      case '/changename':
        return { code: this.plans.has(args[1]) ? 0 : 1, stdout: '' };
      case '/setacvalueindex':
      case '/setdcvalueindex': {
        const plan = this.plans.get(args[1]);
        if (!plan) return fail;
        const v = plan.get(args[3]) ?? [-1, -1];
        plan.set(args[3], verb === '/setacvalueindex' ? [Number(args[4]), v[1]] : [v[0], Number(args[4])]);
        return { code: 0, stdout: '' };
      }
      case '/setactive':
        if (!this.plans.has(args[1])) return fail;
        this.active = args[1];
        return { code: 0, stdout: '' };
      case '/delete':
        if (!this.plans.has(args[1]) || this.active === args[1]) return fail;
        this.plans.delete(args[1]);
        return { code: 0, stdout: '' };
    }
    return fail;
  }

  answer(line: string): string {
    const call = line.split(' ', 1)[0];
    if (call === 'caps') return `ok caps ${this.caps}`;
    if (call === 'status') return `ok status ${this.status}`;
    return `ok ${call} `;
  }

  spawn(): HelperProcess {
    const h = new FakeHelper(this);
    this.helpers.push(h);
    return h;
  }

  read(path: string) {
    return this.files.get(path) ?? null;
  }
  write(path: string, text: string) {
    this.files.set(path, text);
  }
  remove(path: string) {
    this.files.delete(path);
  }
  guid() {
    return `00000000-0000-4000-8000-${String(++this.n).padStart(12, '0')}`;
  }
  setTimer(fn: () => void, ms: number) {
    const t = { fn, ms, live: true };
    this.timers.push(t);
    return () => void (t.live = false);
  }
  /** Fires the live timers of that duration. */
  fire(ms: number) {
    for (const t of this.timers.filter((x) => x.live && x.ms === ms)) {
      t.live = false;
      t.fn();
    }
  }
  plan(g: string) {
    return this.plans.get(g);
  }
}

class FakeHelper implements HelperProcess {
  written: string[] = [];
  guard: [string, string] | null = null;
  ended = false;
  private line: (l: string) => void = () => undefined;
  private exit: (() => void)[] = [];

  constructor(private readonly w: FakeWindows) {
    queueMicrotask(() => this.line('ready'));
  }
  write(text: string) {
    for (const l of text.split('\n').filter(Boolean)) {
      // The first line is the source.
      if (this.written.length === 0 && !l.includes(' ') && l.length > 100) {
        this.written.push('<source>');
        continue;
      }
      this.written.push(l);
      const p = l.split(' ');
      if (p[0] === 'guard') this.guard = [p[1], p[2]];
      if (p[0] === 'unguard') this.guard = null;
      queueMicrotask(() => this.line(this.w.answer(l)));
    }
  }
  onLine(cb: (l: string) => void) {
    this.line = cb;
  }
  onExit(cb: () => void) {
    this.exit.push(cb);
  }
  emit(line: string) {
    this.line(line);
  }
  end() {
    this.ended = true;
    for (const cb of this.exit) cb();
  }
  kill() {
    for (const cb of this.exit) cb();
  }
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

function adapter(w = new FakeWindows()) {
  return { w, e: new Win32Energy({ dataDir: 'D:\\data', sys: w }) };
}

const SNAPSHOT = 'D:\\data\\energy-win32.json';

test('reads powercfg and the helper whatever the language', () => {
  assert.equal(schemeOf(ACTIVE_FR(USER)), USER);
  assert.equal(schemeOf(ACTIVE_EN(USER.toUpperCase())), USER);
  assert.equal(schemeOf('Paramètres non valides'), null);
  assert.deepEqual(indexesOf(LID_QH_EN), [1, 2]);
  assert.deepEqual(indexesOf(LID_QH_FR), [1, 2]);
  assert.equal(indexesOf(''), null);
  assert.deepEqual(probeOf(DESKTOP), { lid: false, s3: true, hibernate: true, modernStandby: false, battery: false });
  assert.deepEqual(probeOf(LAPTOP_S0), { lid: true, s3: false, hibernate: true, modernStandby: true, battery: true });
  assert.equal(probeOf('1 1'), null);
  // Measured on the desktop: on mains, no system battery, percentage and time unknown.
  assert.deepEqual(batteryOf('1 128 255 -1'), { present: false, percent: null, charging: null, source: 'ac', minutesLeft: null });
  assert.deepEqual(batteryOf('0 1 42 5400'), { present: true, percent: 42, charging: false, source: 'battery', minutesLeft: 90 });
  assert.deepEqual(batteryOf('1 8 80 -1'), { present: true, percent: 80, charging: true, source: 'ac', minutesLeft: null });
  assert.equal(batteryOf('x'), null);
});

test('a desktop without lid nor battery says so, and a hold only keeps idle sleep away', async () => {
  const { w, e } = adapter();
  w.caps = DESKTOP;
  const caps = await e.caps();
  assert.equal(caps.holdAwake, true);
  assert.equal(caps.lidClosedAwake, false);
  assert.equal(caps.battery, false);
  assert.equal(caps.needsElevation, false);
  assert.ok(caps.notes.length >= 2);
  const h = await e.hold({ reason: 'workers', lidClosed: true, allowDisplaySleep: true });
  assert.equal(h.lidClosedEffective, false);
  assert.equal(h.lidAction, undefined);
  assert.equal(w.active, USER);
  assert.equal(w.plans.size, 3);
  assert.deepEqual(w.helpers[0].written, ['<source>', 'require 0 workers']);
  await h.release();
  assert.deepEqual(w.helpers[0].written.slice(2), ['free']);
  assert.equal(w.helpers[0].ended, true);
});

test('lid closed: a copy of the user plan, snapshot first, put back at release', async () => {
  const { w, e } = adapter();
  const h = await e.hold({ reason: 'workers', lidClosed: true, allowDisplaySleep: true });
  assert.equal(h.lidClosedEffective, true);
  const copy = w.active;
  assert.notEqual(copy, USER);
  assert.deepEqual(JSON.parse(w.snapshotAtDuplicate ?? '{}').scheme, copy);
  assert.deepEqual(w.plan(copy)?.get(LIDACTION), [0, 0]);
  assert.deepEqual(w.plan(copy)?.get(BATACTIONCRIT)?.[1], 2);
  // The user's plan itself is never written.
  assert.deepEqual(w.plan(USER)?.get(LIDACTION), [1, 2]);
  assert.equal(w.plan(copy)?.has(STANDBYIDLE), false);
  assert.deepEqual(w.helpers[0].guard, [USER, copy]);
  // What the lid would have done: sleep on mains, hibernate on battery.
  assert.equal(h.lidAction, 'sleep');
  await e.battery();
  assert.equal(h.lidAction, 'hibernate');
  await h.release();
  await h.release();
  assert.equal(w.active, USER);
  assert.equal(w.plans.has(copy), false);
  assert.equal(w.files.has(SNAPSHOT), false);
  assert.equal(w.helpers[0].guard, null);
  assert.equal(w.helpers[0].ended, true);
  assert.equal(w.calls.filter((c) => c.startsWith('powercfg /setactive')).length, 2);
});

test('Modern Standby: the copy never sleeps on idle, even without the lid', async () => {
  const { w, e } = adapter();
  w.caps = LAPTOP_S0;
  const h = await e.hold({ reason: 'workers', lidClosed: false, allowDisplaySleep: true });
  assert.equal(h.lidClosedEffective, false);
  const copy = w.active;
  assert.notEqual(copy, USER);
  assert.deepEqual(w.plan(copy)?.get(STANDBYIDLE), [0, 0]);
  assert.deepEqual(w.plan(copy)?.get(LIDACTION), [1, 2]);
  await h.release();
  assert.equal(w.active, USER);
  assert.equal(w.plans.size, 3);
});

test('a command failing half-way undoes what was done, then rejects', async () => {
  const { w, e } = adapter();
  w.failing.set('/setactive', 1);
  await assert.rejects(e.hold({ reason: 'workers', lidClosed: true, allowDisplaySleep: true }), /setactive/);
  assert.equal(w.active, USER);
  assert.equal(w.plans.size, 3);
  assert.equal(w.files.has(SNAPSHOT), false);
  assert.equal(w.helpers[0].ended, true);
  assert.ok(w.helpers[0].written.includes('free'));
  // And the next hold works.
  const h = await e.hold({ reason: 'workers', lidClosed: true, allowDisplaySleep: true });
  assert.notEqual(w.active, USER);
  await h.release();
  assert.equal(w.active, USER);
});

test('a plan that does not become active (a policy) is undone too', async () => {
  const { w, e } = adapter();
  const real = w.run.bind(w);
  w.run = async (file, args, input) => (args[0] === '/setactive' && args[1] !== USER ? { code: 0, stdout: '' } : real(file, args, input));
  await assert.rejects(e.hold({ reason: 'workers', lidClosed: true, allowDisplaySleep: true }), /did not become active/);
  assert.equal(w.active, USER);
  assert.equal(w.plans.size, 3);
});

test('what cannot be put back stays in the snapshot for the next start', async () => {
  const { w, e } = adapter();
  const h = await e.hold({ reason: 'workers', lidClosed: true, allowDisplaySleep: true });
  const copy = w.active;
  w.failing.set('/delete', 1);
  await h.release();
  assert.equal(w.active, USER);
  assert.equal(w.plans.has(copy), true);
  assert.equal(w.files.has(SNAPSHOT), true);
  // The helper keeps its guard: it tries again when it ends.
  assert.deepEqual(w.helpers[0].guard, [USER, copy]);
  const next = new Win32Energy({ dataDir: 'D:\\data', sys: w });
  assert.equal(await next.restoreLeftovers(), 1);
  assert.equal(w.plans.has(copy), false);
  assert.equal(w.files.has(SNAPSHOT), false);
  assert.equal(await next.restoreLeftovers(), 0);
});

test('after a crash: the user plan back and the copy gone, a plan the user picked meanwhile kept', async () => {
  const { w, e } = adapter();
  await e.hold({ reason: 'workers', lidClosed: true, allowDisplaySleep: true });
  const copy = w.active;
  // The hub dies here: the next start finds the snapshot.
  const next = new Win32Energy({ dataDir: 'D:\\data', sys: w });
  assert.equal(await next.restoreLeftovers(), 2);
  assert.equal(w.active, USER);
  assert.equal(w.plans.has(copy), false);

  const b = adapter();
  await b.e.hold({ reason: 'workers', lidClosed: true, allowDisplaySleep: true });
  const copy2 = b.w.active;
  b.w.active = OTHER;
  assert.equal(await new Win32Energy({ dataDir: 'D:\\data', sys: b.w }).restoreLeftovers(), 1);
  assert.equal(b.w.active, OTHER);
  assert.equal(b.w.plans.has(copy2), false);

  // The user's plan deleted meanwhile: Windows' Balanced plan instead.
  const c = adapter();
  await c.e.hold({ reason: 'workers', lidClosed: true, allowDisplaySleep: true });
  c.w.plans.delete(USER);
  assert.equal(await new Win32Energy({ dataDir: 'D:\\data', sys: c.w }).restoreLeftovers(), 2);
  assert.equal(c.w.active, BALANCED);

  // A snapshot that makes no sense is dropped, nothing touched.
  const d = adapter();
  d.w.files.set(SNAPSHOT, '{"original":"x","scheme":"; del"}');
  assert.equal(await d.e.restoreLeftovers(), 0);
  assert.equal(d.w.files.has(SNAPSHOT), false);
  assert.equal(d.w.calls.length, 0);
});

test('a helper that ends during a hold is started again with what it held', async () => {
  const { w, e } = adapter();
  const h = await e.hold({ reason: 'workers', lidClosed: true, allowDisplaySleep: false });
  const copy = w.active;
  w.helpers[0].kill();
  w.fire(15_000);
  await settle();
  assert.equal(w.helpers.length, 2);
  assert.deepEqual(w.helpers[1].written, ['<source>', 'require 1 workers', `guard ${USER} ${copy}`]);
  await h.release();
  assert.equal(w.active, USER);
});

test('lid and power source events, while subscribed', async () => {
  const { w, e } = adapter();
  const lids: boolean[] = [];
  const levels: (number | null)[] = [];
  const offLid = e.onLidChange((closed) => lids.push(closed));
  const offPower = e.onPowerSourceChange((b) => levels.push(b.percent));
  await settle();
  assert.equal(w.helpers.length, 1);
  assert.ok(w.helpers[0].written.includes('watch'));
  w.helpers[0].emit('event lid 0');
  w.helpers[0].emit('event lid 1');
  w.status = '0 1 14 600';
  w.helpers[0].emit('event percent 14');
  await settle();
  assert.deepEqual(lids, [true, false]);
  assert.deepEqual(levels, [14]);
  offLid();
  offPower();
  assert.equal(w.helpers[0].ended, true);
});

test('hibernation asked where there is none: sleep', async () => {
  const { w, e } = adapter();
  w.caps = '1 1 0 0 0 1';
  await e.suspend('hibernate');
  await settle();
  assert.ok(w.calls.includes('once suspend 0'));
  w.caps = LAPTOP_S3;
  const b = adapter();
  await b.e.suspend('hibernate');
  await settle();
  assert.ok(b.w.calls.includes('once suspend 1'));
});
