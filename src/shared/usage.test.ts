import assert from 'node:assert/strict';
import { test } from 'node:test';
import { limitsOfUsage, usageAccount, noUsage, USAGE_FRESH_MS, usageFailed, usageRead, usageState, usageWindows, windowFigure } from './usage';
import type { RateLimits } from './types';

const NOW = 1_800_000_000_000;
const LIMITS: RateLimits = { fiveHourPct: 11, fiveHourResetsAt: NOW / 1000 + 3600, sevenDayPct: 4, sevenDayResetsAt: NOW / 1000 + 86400 };

test('the windows of the /usage answer become percentages and reset times', () => {
  const got = limitsOfUsage({
    five_hour: { utilization: 11, resets_at: '2026-10-28T10:30:00.442391+00:00', limit_dollars: null },
    seven_day: { utilization: 0, resets_at: '2026-11-03T20:00:00+00:00' },
    model_scoped: [],
  });
  assert.equal(got?.fiveHourPct, 11);
  assert.equal(got?.fiveHourResetsAt, Date.parse('2026-10-28T10:30:00.442391+00:00') / 1000);
  assert.equal(got?.sevenDayPct, 0, 'a real zero stays a zero');
});

test('a window the answer lacks falls back on the limits list', () => {
  const got = limitsOfUsage({
    five_hour: null,
    limits: [
      { kind: 'session', percent: 7, resets_at: '2026-10-28T11:49:59+00:00' },
      { kind: 'weekly_all', percent: 3, resets_at: '2026-11-03T15:59:59+00:00' },
    ],
  });
  assert.equal(got?.fiveHourPct, 7);
  assert.equal(got?.sevenDayPct, 3);
});

test('figures are clamped, numeric strings read, junk is no figure', () => {
  assert.equal(limitsOfUsage({ five_hour: { utilization: '42.5' } })?.fiveHourPct, 42.5);
  assert.equal(limitsOfUsage({ five_hour: { utilization: 130 } })?.fiveHourPct, 100);
  assert.equal(limitsOfUsage({ five_hour: { utilization: -3 } })?.fiveHourPct, 0);
  assert.equal(limitsOfUsage({ five_hour: { utilization: 5, resets_at: 'soon' } })?.fiveHourResetsAt, null);
  assert.equal(limitsOfUsage({ five_hour: { utilization: 'many' }, seven_day: { utilization: NaN } }), null);
});

test('an answer with no figure is nothing, never zero', () => {
  for (const raw of [null, undefined, {}, 'x', 12, { five_hour: null, seven_day: null }, { five_hour: { utilization: null, resets_at: null } }, { limits: [] }]) {
    assert.equal(limitsOfUsage(raw), null);
  }
});

test('a reading, a failure after it, and an account with no plan limits', () => {
  const ok = usageRead(LIMITS, NOW);
  assert.deepEqual(usageState(ok), { plan: '', limits: LIMITS, measuredAt: NOW, failed: false });
  const failed = usageFailed(ok);
  assert.deepEqual(usageState(failed), { plan: '', limits: LIMITS, measuredAt: NOW, failed: true }, 'the last good reading and its date are kept');
  assert.equal(usageState(usageRead(null, NOW)), null, 'no plan limits: nothing shown');
  assert.equal(usageState(usageFailed(usageRead(null, NOW))), null);
});

test('an account never read is unknown, not zero', () => {
  assert.deepEqual(usageState(undefined), { plan: '', limits: null, measuredAt: null, failed: false });
  assert.deepEqual(usageState(noUsage()), { plan: '', limits: null, measuredAt: null, failed: false });
  assert.deepEqual(usageState(usageFailed(undefined)), { plan: '', limits: null, measuredAt: null, failed: true });
});

test('a figure is claimed only while fresh and in its window', () => {
  const at = NOW - 60_000;
  assert.equal(windowFigure(11, NOW / 1000 + 600, at, NOW), 11);
  assert.equal(windowFigure(0, NOW / 1000 + 600, at, NOW), 0, 'a measured zero is a zero');
  assert.equal(windowFigure(11, NOW / 1000 + 600, NOW - USAGE_FRESH_MS - 1, NOW), null, 'too old');
  assert.equal(windowFigure(11, NOW / 1000 - 1, at, NOW), null, 'its window has ended');
  assert.equal(windowFigure(11, null, at, NOW), 11, 'no reset time known: fresh is enough');
  assert.equal(windowFigure(null, null, at, NOW), null);
  assert.equal(windowFigure(11, null, null, NOW), null, 'never measured');
});

test('the limits are those of the account the process runs on, even after the active account changed', () => {
  // The master started while the user's own sign-in was active; "Claude 2" became the active account since.
  assert.equal(usageAccount('own', 'default', 'a-aaaaaaaa'), 'own');
  // Not running: the account it would start on now.
  assert.equal(usageAccount('', 'default', 'a-aaaaaaaa'), 'a-aaaaaaaa');
  assert.equal(usageAccount('', 'default', ''), 'own');
  assert.equal(usageAccount('', 'a-bbbbbbbb', 'a-aaaaaaaa'), 'a-bbbbbbbb');
});

const WINDOWS = {
  five_hour: { utilization: 11, resets_at: '2026-10-28T10:30:00+00:00' },
  seven_day: { utilization: 4, resets_at: '2026-11-03T20:00:00+00:00' },
};
const FABLE = { display_name: 'Fable', utilization: 23, resets_at: '2026-11-03T21:00:00+00:00' };

test('the Fable window is read from model_scoped, with its reset time', () => {
  const got = limitsOfUsage({ ...WINDOWS, model_scoped: [{ display_name: 'Opus', utilization: 50, resets_at: null }, FABLE] });
  assert.equal(got?.fablePct, 23);
  assert.equal(got?.fableResetsAt, Date.parse('2026-11-03T21:00:00+00:00') / 1000);
  assert.equal(limitsOfUsage({ ...WINDOWS, model_scoped: [{ ...FABLE, utilization: 0 }] })?.fablePct, 0, 'a real zero stays a zero');
});

test('the Fable window falls back on the scoped row of the limits list', () => {
  const got = limitsOfUsage({
    ...WINDOWS,
    limits: [
      { kind: 'weekly_scoped', percent: 9, resets_at: '2026-11-03T21:00:00+00:00', scope: { model: { display_name: 'Opus' } } },
      { kind: 'weekly_scoped', percent: 31, resets_at: '2026-11-03T22:00:00+00:00', scope: { model: { display_name: 'Fable' } } },
    ],
  });
  assert.equal(got?.fablePct, 31);
  assert.equal(got?.fableResetsAt, Date.parse('2026-11-03T22:00:00+00:00') / 1000);
});

test('no Fable figure in the answer: no Fable field at all, never zero', () => {
  for (const extra of [{}, { model_scoped: [] }, { model_scoped: [{ display_name: 'Opus', utilization: 5, resets_at: null }] }, { model_scoped: [{ display_name: 'Fable', utilization: null, resets_at: null }] }]) {
    const got = limitsOfUsage({ ...WINDOWS, ...extra });
    assert.equal(got?.sevenDayPct, 4);
    assert.ok(got && !('fablePct' in got), JSON.stringify(extra));
  }
});

test('an Ultra account without a 5 h window still has its weekly figures', () => {
  const got = limitsOfUsage({ five_hour: null, seven_day: WINDOWS.seven_day, model_scoped: [FABLE] });
  assert.equal(got?.fiveHourPct, null);
  assert.equal(got?.sevenDayPct, 4);
  assert.equal(got?.fablePct, 23);
});

test('the windows shown by plan: Pro, Max and Ultra, with and without a Fable figure', () => {
  const withFable = limitsOfUsage({ ...WINDOWS, model_scoped: [FABLE] });
  const without = limitsOfUsage(WINDOWS);
  const shown = (plan: string, limits: typeof without) => usageWindows({ plan, limits });
  assert.deepEqual(shown('pro', withFable), ['fiveHour', 'sevenDay'], 'Pro: no Fable, even if the answer holds one');
  assert.deepEqual(shown('pro', without), ['fiveHour', 'sevenDay']);
  assert.deepEqual(shown('max', withFable), ['fiveHour', 'sevenDay', 'fable']);
  assert.deepEqual(shown('max', without), ['fiveHour', 'sevenDay'], 'Max without the field: nothing for Fable');
  assert.deepEqual(shown('ultra', withFable), ['sevenDay', 'fable'], 'Ultra: no 5 h window');
  assert.deepEqual(shown('Ultra', without), ['sevenDay']);
  assert.deepEqual(shown('', withFable), ['fiveHour', 'sevenDay'], 'plan not read: as before');
  assert.deepEqual(shown('max', null), ['fiveHour', 'sevenDay'], 'never read: no Fable item');
});

test('the plan travels with the usage state', () => {
  assert.equal(usageState(usageRead(LIMITS, NOW), 'ultra')?.plan, 'ultra');
  assert.equal(usageState(usageRead(null, NOW), 'ultra'), null);
});
