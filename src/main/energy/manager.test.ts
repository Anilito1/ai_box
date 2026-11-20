import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ENERGY_DEFAULTS, type EnergySettings, type EnergyView } from '../../shared/energy';
import { EnergyManager, type Timers } from './manager';
import type { BatteryInfo, EnergyCaps, EnergyPlatform, Hold, HoldOptions, SuspendMode } from './types';

// The core on a fake platform and a fake clock: when the PC is held, with the lid or not, and the battery guard.

const LAPTOP: EnergyCaps = { platform: 'win32', holdAwake: true, lidClosedAwake: true, needsElevation: false, battery: true, displayOff: true, radios: false, notes: [] };
const onBattery = (percent: number): BatteryInfo => ({ present: true, percent, charging: false, source: 'battery', minutesLeft: null });
const onMains = (percent: number): BatteryInfo => ({ present: true, percent, charging: true, source: 'ac', minutesLeft: null });

class FakePlatform implements EnergyPlatform {
  caps_ = LAPTOP;
  battery_ = onMains(80);
  holds: { o: HoldOptions; released: boolean }[] = [];
  suspended: SuspendMode[] = [];
  leftovers = 0;
  failHold = false;
  lidAction: 'none' | SuspendMode | undefined = 'sleep';
  lidCb: ((closed: boolean) => void) | null = null;
  powerCb: ((b: BatteryInfo) => void) | null = null;

  async caps() {
    return this.caps_;
  }
  async battery() {
    return this.battery_;
  }
  async hold(o: HoldOptions): Promise<Hold> {
    if (this.failHold) throw new Error('refused');
    const rec = { o, released: false };
    this.holds.push(rec);
    const lidAction = this.lidAction;
    return {
      lidClosedEffective: o.lidClosed,
      lidAction,
      release: async () => void (rec.released = true),
    };
  }
  async restoreLeftovers() {
    return this.leftovers;
  }
  async displayOff() {}
  async suspend(mode: SuspendMode) {
    this.suspended.push(mode);
  }
  onLidChange(cb: (closed: boolean) => void) {
    this.lidCb = cb;
    return () => void (this.lidCb = null);
  }
  onPowerSourceChange(cb: (b: BatteryInfo) => void) {
    this.powerCb = cb;
    return () => void (this.powerCb = null);
  }
  /** Holds not released yet. */
  live() {
    return this.holds.filter((h) => !h.released);
  }
}

class Clock implements Timers {
  t = 0;
  private due: { at: number; fn: () => void; live: boolean }[] = [];
  set(fn: () => void, ms: number) {
    const d = { at: this.t + ms, fn, live: true };
    this.due.push(d);
    return () => void (d.live = false);
  }
  now() {
    return this.t;
  }
  advance(ms: number) {
    this.t += ms;
    for (const d of this.due.filter((x) => x.live && x.at <= this.t)) {
      d.live = false;
      d.fn();
    }
  }
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

async function setup(settings: Partial<EnergySettings> = {}, p = new FakePlatform()) {
  const s: EnergySettings = { ...ENERGY_DEFAULTS, ...settings };
  const clock = new Clock();
  const views: EnergyView[] = [];
  let idle = 0;
  const m = new EnergyManager({
    platform: p,
    settings: () => s,
    idleSeconds: () => idle,
    reason: () => 'workers at work',
    publish: (v) => views.push(v),
    timers: clock,
  });
  await m.start();
  return { m, p, s, clock, views, setIdle: (n: number) => (idle = n) };
}

test('held while workers work, and a little after', async () => {
  const { m, p, clock } = await setup();
  m.setBusy(true);
  await settle();
  assert.equal(p.live().length, 1);
  assert.deepEqual(p.live()[0].o, { reason: 'workers at work', lidClosed: false, allowDisplaySleep: true });
  assert.deepEqual(m.view().reasons, ['workers']);
  // A worker between two turns: no release, no new hold.
  m.setBusy(false);
  clock.advance(60_000);
  m.setBusy(true);
  await settle();
  assert.equal(p.holds.length, 1);
  m.setBusy(false);
  clock.advance(119_000);
  await settle();
  assert.equal(p.live().length, 1);
  clock.advance(1_000);
  await settle();
  assert.equal(p.live().length, 0);
  assert.equal(m.view().awake, false);
});

test('workers do not hold the PC when the user turned it off', async () => {
  const { m, p } = await setup({ whileWorking: false });
  m.setBusy(true);
  await settle();
  assert.equal(p.holds.length, 0);
});

test('the lid setting: taken where the system can, a new hold when it changes', async () => {
  const { m, p, s } = await setup({ lidClosed: true });
  m.setBusy(true);
  await settle();
  assert.equal(p.live()[0].o.lidClosed, true);
  assert.equal(m.view().lidClosed, true);
  s.lidClosed = false;
  m.settingsChanged();
  await settle();
  assert.equal(p.holds.length, 2);
  assert.equal(p.live().length, 1);
  assert.equal(p.live()[0].o.lidClosed, false);
  // Changing the hold with the lid closed does not put the PC to sleep.
  assert.deepEqual(p.suspended, []);

  const desk = new FakePlatform();
  desk.caps_ = { ...LAPTOP, lidClosedAwake: false, battery: false };
  const d = await setup({ lidClosed: true }, desk);
  d.m.setBusy(true);
  await settle();
  assert.equal(desk.live()[0].o.lidClosed, false);
});

test('the user asks for a while, or until they stop it', async () => {
  const { m, p, clock } = await setup();
  m.keepAwake(60);
  await settle();
  assert.equal(p.live().length, 1);
  assert.equal(m.view().until, 3_600_000);
  clock.advance(3_600_000);
  await settle();
  assert.equal(p.live().length, 0);
  m.keepAwake(null);
  await settle();
  assert.equal(p.live().length, 1);
  assert.equal(m.view().until, null);
  assert.deepEqual(m.view().reasons, ['manual']);
  m.keepAwake(0);
  await settle();
  assert.equal(p.live().length, 0);
});

test('workers moving to the server hold it until done', async () => {
  const { m, p } = await setup();
  const done = m.claim();
  await settle();
  assert.equal(p.live().length, 1);
  done();
  done();
  await settle();
  assert.equal(p.live().length, 0);
});

test('battery guard: under the floor, lid closed, the hold ends and the PC hibernates', async () => {
  const { m, p, clock } = await setup({ lidClosed: true, batteryFloor: 15 });
  m.setBusy(true);
  await settle();
  p.lidCb?.(true);
  p.powerCb?.(onBattery(16));
  await settle();
  assert.equal(p.live().length, 1);
  p.battery_ = onBattery(15);
  p.powerCb?.(p.battery_);
  await settle();
  assert.equal(p.live().length, 0);
  assert.deepEqual(p.suspended, ['hibernate']);
  assert.equal(m.view().guard, true);
  // Nothing held again on battery, even when workers start again.
  m.setBusy(false);
  m.setBusy(true);
  clock.advance(60_000);
  await settle();
  assert.equal(p.live().length, 0);
  // Plugged in: holds come back.
  p.battery_ = onMains(16);
  p.powerCb?.(p.battery_);
  await settle();
  assert.equal(m.view().guard, false);
  assert.equal(p.live().length, 1);
});

test('battery guard with the lid open: no hibernation while someone uses the PC', async () => {
  const { m, p, setIdle } = await setup({ batteryFloor: 20 });
  m.setBusy(true);
  await settle();
  p.lidCb?.(false);
  setIdle(30);
  p.powerCb?.(onBattery(19));
  await settle();
  assert.equal(p.live().length, 0);
  assert.deepEqual(p.suspended, []);

  const away = await setup({ batteryFloor: 20 });
  away.m.setBusy(true);
  await settle();
  away.setIdle(600);
  away.p.powerCb?.(onBattery(12));
  await settle();
  assert.deepEqual(away.p.suspended, ['hibernate']);
});

test('battery guard: the periodic reading too, and charged above the margin it lets holds back', async () => {
  const { m, p, clock } = await setup({ batteryFloor: 15 });
  m.setBusy(true);
  await settle();
  p.battery_ = onBattery(10);
  clock.advance(60_000);
  await settle();
  assert.equal(p.live().length, 0);
  assert.equal(m.view().guard, true);
  p.battery_ = onBattery(19);
  clock.advance(60_000);
  await settle();
  assert.equal(m.view().guard, true);
  p.battery_ = { ...onBattery(20), charging: true };
  clock.advance(60_000);
  await settle();
  assert.equal(m.view().guard, false);
  assert.equal(p.live().length, 1);
});

test('a hold ending with the lid closed does what the lid would have done', async () => {
  const { m, p, clock, setIdle } = await setup({ lidClosed: true });
  m.setBusy(true);
  await settle();
  p.lidCb?.(true);
  setIdle(600);
  m.setBusy(false);
  clock.advance(120_000);
  await settle();
  assert.equal(p.live().length, 0);
  assert.deepEqual(p.suspended, ['sleep']);

  // "Do nothing" on that power source, or someone typing on an external keyboard: left awake.
  for (const [action, idle] of [
    ['none', 600],
    ['sleep', 5],
  ] as const) {
    const o = await setup({ lidClosed: true });
    o.p.lidAction = action;
    o.m.setBusy(true);
    await settle();
    o.p.lidCb?.(true);
    o.setIdle(idle);
    o.m.keepAwake(0);
    o.m.setBusy(false);
    o.clock.advance(120_000);
    await settle();
    assert.equal(o.p.live().length, 0);
    assert.deepEqual(o.p.suspended, []);
  }
});

test('quitting puts everything back without putting the PC to sleep', async () => {
  const { m, p, setIdle } = await setup({ lidClosed: true });
  m.setBusy(true);
  await settle();
  p.lidCb?.(true);
  setIdle(600);
  assert.equal(m.holding(), true);
  await m.shutdown();
  assert.equal(p.live().length, 0);
  assert.deepEqual(p.suspended, []);
  assert.equal(m.holding(), false);
  m.setBusy(false);
  m.setBusy(true);
  await settle();
  assert.equal(p.live().length, 0);
});

test('a refused hold is shown and tried again at the next change, leftovers undone at start', async () => {
  const p = new FakePlatform();
  p.failHold = true;
  p.leftovers = 2;
  const logs: string[] = [];
  const m = new EnergyManager({ platform: p, settings: () => ENERGY_DEFAULTS, idleSeconds: () => 0, reason: () => 'r', publish: () => undefined, log: (l) => logs.push(l), timers: new Clock() });
  await m.start();
  assert.ok(logs.some((l) => l.includes('2 change')));
  m.setBusy(true);
  await settle();
  assert.equal(m.view().error, 'refused');
  assert.equal(m.view().awake, false);
  p.failHold = false;
  m.keepAwake(null);
  await settle();
  assert.equal(m.view().error, null);
  assert.equal(p.live().length, 1);
});

test('a hold refused while workers keep working is asked again a minute later', async () => {
  const { m, p, clock } = await setup();
  p.failHold = true;
  m.setBusy(true);
  await settle();
  assert.equal(m.view().error, 'refused');
  p.failHold = false;
  clock.advance(60_000);
  await settle();
  assert.equal(p.live().length, 1);
  assert.equal(m.view().error, null);
});

test('capabilities unreadable at start are asked again while a hold is wanted', async () => {
  const p = new FakePlatform();
  const real = p.caps.bind(p);
  let fail = true;
  p.caps = async () => {
    if (fail) throw new Error('helper slow');
    return real();
  };
  const { m, clock } = await setup({}, p);
  assert.equal(m.view().caps, null);
  fail = false;
  m.setBusy(true);
  await settle();
  assert.equal(p.live().length, 1);
  clock.advance(60_000);
  await settle();
  assert.equal(p.holds.length, 1);
});

test('workers starting at or under the floor on battery: no hold, no hibernation', async () => {
  const p = new FakePlatform();
  p.battery_ = onBattery(12);
  const { m } = await setup({ batteryFloor: 15 }, p);
  assert.equal(m.view().guard, false);
  m.setBusy(true);
  await settle();
  assert.equal(p.holds.length, 0);
  assert.equal(m.view().guard, true);
  assert.deepEqual(p.suspended, []);
  p.battery_ = onMains(12);
  p.powerCb?.(p.battery_);
  await settle();
  assert.equal(p.live().length, 1);
});

test('no platform: nothing held, nothing thrown', async () => {
  const m = new EnergyManager({ platform: null, settings: () => ENERGY_DEFAULTS, idleSeconds: () => 0, reason: () => 'r', publish: () => undefined, timers: new Clock() });
  await m.start();
  m.setBusy(true);
  m.keepAwake(null);
  await settle();
  assert.equal(m.view().caps, null);
  assert.equal(m.view().awake, false);
});
