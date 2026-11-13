import assert from 'node:assert/strict';
import { test } from 'node:test';
import { limitsOfUsage, usageAccount, noUsage, USAGE_FRESH_MS, usageFailed, usageRead, usageGauges, usageState, usageWindows, windowFigure } from './usage';
import type { UsageState } from './types';
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
  assert.deepEqual(usageState(ok), { provider: 'anthropic', plan: '', limits: LIMITS, measuredAt: NOW, failed: false });
  const failed = usageFailed(ok);
  assert.deepEqual(usageState(failed), { provider: 'anthropic', plan: '', limits: LIMITS, measuredAt: NOW, failed: true }, 'the last good reading and its date are kept');
  assert.equal(usageState(usageRead(null, NOW)), null, 'no plan limits: nothing shown');
  assert.equal(usageState(usageFailed(usageRead(null, NOW))), null);
});

test('an account never read is unknown, not zero', () => {
  assert.deepEqual(usageState(undefined), { provider: 'anthropic', plan: '', limits: null, measuredAt: null, failed: false });
  assert.deepEqual(usageState(noUsage()), { provider: 'anthropic', plan: '', limits: null, measuredAt: null, failed: false });
  assert.deepEqual(usageState(usageFailed(undefined)), { provider: 'anthropic', plan: '', limits: null, measuredAt: null, failed: true });
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

test('the windows that apply, by provider and plan', () => {
  const at = (provider: string, plan: string) => usageWindows({ provider, plan });
  assert.deepEqual(at('anthropic', 'pro'), ['fiveHour', 'sevenDay'], 'Pro: no Fable');
  assert.deepEqual(at('anthropic', 'max'), ['fiveHour', 'sevenDay', 'fable']);
  assert.deepEqual(at('anthropic', 'Ultra'), ['sevenDay', 'fable'], 'Ultra: no 5 h window');
  assert.deepEqual(at('anthropic', ''), ['fiveHour', 'sevenDay', 'fable'], 'plan not read: the answer decides');
  for (const provider of ['openai', 'deepseek', 'gemini', '']) assert.ok(!at(provider, 'max').includes('fable'), provider);
});

/** A reading taken before the windows of WINDOWS end. */
const READ = Date.parse('2026-10-28T09:00:00Z');
const state = (limits: RateLimits | null, plan = 'max', provider = 'anthropic', measuredAt: number | null = READ): UsageState => ({ provider, plan, limits, measuredAt, failed: false });
const shown = (u: UsageState) => usageGauges(u, READ + 1000).map((g) => `${g.window} ${g.pct}`);

test('the gauges shown: only the windows that apply and hold a figure, never unknown', () => {
  const withFable = limitsOfUsage({ ...WINDOWS, model_scoped: [FABLE] });
  const noFive = limitsOfUsage({ five_hour: null, seven_day: WINDOWS.seven_day, model_scoped: [FABLE] });
  assert.deepEqual(shown(state(withFable)), ['fiveHour 11', 'sevenDay 4', 'fable 23'], 'Max with all three figures');
  assert.deepEqual(shown(state(noFive)), ['sevenDay 4', 'fable 23'], 'Max whose answer has no 5 h window: no 5 h item');
  assert.deepEqual(shown(state(limitsOfUsage(WINDOWS))), ['fiveHour 11', 'sevenDay 4'], 'no Fable figure: no Fable item');
  assert.deepEqual(shown(state(withFable, 'ultra')), ['sevenDay 4', 'fable 23'], 'Ultra: no 5 h, even with a figure');
  assert.deepEqual(shown(state(withFable, 'pro')), ['fiveHour 11', 'sevenDay 4'], 'Pro: no Fable, even if the answer holds one');
  assert.deepEqual(shown(state(withFable, '')), ['fiveHour 11', 'sevenDay 4', 'fable 23'], 'plan not read');
});

test('a Codex or other non-Anthropic account never shows Fable', () => {
  const limits: RateLimits = { ...LIMITS, fablePct: 50, fableResetsAt: null };
  assert.deepEqual(shown(state(limits, '', 'openai')), ['fiveHour 11', 'sevenDay 4']);
  assert.deepEqual(shown(state(limits, 'max', 'gemini')), ['fiveHour 11', 'sevenDay 4']);
});

test('no figure to claim: no gauge at all', () => {
  assert.deepEqual(shown(state(null)), [], 'never read');
  assert.deepEqual(shown(state(LIMITS, 'max', 'anthropic', null)), [], 'no reading date');
  assert.deepEqual(shown(state(LIMITS, 'max', 'anthropic', READ - USAGE_FRESH_MS - 5000)), [], 'too old');
  const ended: RateLimits = { ...LIMITS, fiveHourResetsAt: READ / 1000 };
  assert.deepEqual(shown(state(ended)), ['sevenDay 4'], 'a window ended since its reading is left out');
});

test('an account switch shows the new account only, nothing of the last one', () => {
  const read = usageRead(limitsOfUsage({ ...WINDOWS, model_scoped: [FABLE] }), READ);
  assert.equal(shown(usageState(read, 'max')!).length, 3);
  assert.deepEqual(shown(usageState(undefined, 'pro')!), [], 'the new account, not read yet: nothing');
  assert.equal(usageState(usageRead(null, NOW), 'max'), null, 'an API key: no plan limits at all');
});

test('the plan travels with the usage state', () => {
  assert.equal(usageState(usageRead(LIMITS, NOW), 'ultra')?.plan, 'ultra');
  assert.equal(usageState(usageRead(LIMITS, NOW), 'plus', 'openai')?.provider, 'openai');
  assert.equal(usageState(usageRead(null, NOW), 'ultra'), null);
});
