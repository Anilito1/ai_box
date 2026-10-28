import assert from 'node:assert/strict';
import { test } from 'node:test';
import { limitsOfUsage, usageAccount, noUsage, USAGE_FRESH_MS, usageFailed, usageRead, usageState, windowFigure } from './usage';
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
  assert.deepEqual(usageState(ok), { limits: LIMITS, measuredAt: NOW, failed: false });
  const failed = usageFailed(ok);
  assert.deepEqual(usageState(failed), { limits: LIMITS, measuredAt: NOW, failed: true }, 'the last good reading and its date are kept');
  assert.equal(usageState(usageRead(null, NOW)), null, 'no plan limits: nothing shown');
  assert.equal(usageState(usageFailed(usageRead(null, NOW))), null);
});

test('an account never read is unknown, not zero', () => {
  assert.deepEqual(usageState(undefined), { limits: null, measuredAt: null, failed: false });
  assert.deepEqual(usageState(noUsage()), { limits: null, measuredAt: null, failed: false });
  assert.deepEqual(usageState(usageFailed(undefined)), { limits: null, measuredAt: null, failed: true });
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
