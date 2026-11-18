import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escalate, FRESH_START_PCT, FRESH_START_WORK, freshStartDue, modelGrid, needsFreshStart, normalizeRole, workTokens } from './team';
import type { Metrics } from './types';

const at = (tokens: number): Metrics => ({ contextTokens: tokens, contextSize: 1_000_000, contextPct: tokens / 10_000, costUsd: 0 });

test('work is what a conversation gained past its first reading, in that conversation only', () => {
  const base = { id: 'c1', tokens: 45_000 };
  assert.equal(workTokens(at(70_000), base, 'c1'), 25_000);
  assert.equal(workTokens(at(30_000), base, 'c1'), 0);
  assert.equal(workTokens(at(70_000), base, 'c2'), 0);
  assert.equal(workTokens(at(70_000), null, 'c1'), 0);
  assert.equal(workTokens(null, base, 'c1'), 0);
});

test('a permanent worker starts afresh after a mission past 20k tokens of work, whatever its context size', () => {
  assert.equal(FRESH_START_WORK, 20_000);
  assert.equal(freshStartDue({ working: false, worked: 20_000 }), false);
  assert.equal(freshStartDue({ working: false, worked: 20_001 }), true);
  assert.equal(freshStartDue({ working: false, worked: workTokens(at(80_000), { id: 'c', tokens: 52_000 }, 'c') }), true);
});

test('an ad-hoc worker starts afresh at 90% of its window, like the master: 900k of 1M, not before', () => {
  assert.equal(FRESH_START_PCT, 90);
  assert.equal(needsFreshStart(at(899_000)), false);
  assert.equal(needsFreshStart(at(900_000)), true);
  assert.equal(needsFreshStart(null), false);
});

test('a permanent worker at work, or with background tasks, is never renewed', () => {
  assert.equal(freshStartDue({ working: true, worked: 600_000 }), false);
});

test('a post keeps its Ultracode only when it is exactly true', () => {
  assert.equal(normalizeRole({ name: 'a', ultracode: true }).ultracode, true);
  for (const v of [false, 'true', 1, null, undefined]) assert.equal(normalizeRole({ name: 'a', ultracode: v }).ultracode, false, String(v));
});

test('a failed delivery moves one step up: the effort first, then the next family, Fable at the top', () => {
  const allowed = ['opus', 'sonnet', 'haiku', 'claude-fable-5-2', 'claude-fable-5-2[1m]', 'fable'];
  assert.deepEqual(escalate({ model: 'claude-sonnet-5-5', effort: 'medium' }, allowed, 'xhigh'), { model: 'claude-sonnet-5-5', effort: 'high', switches: false });
  assert.deepEqual(escalate({ model: 'sonnet', effort: '' }, allowed, 'xhigh'), { model: 'sonnet', effort: 'high', switches: false });
  assert.deepEqual(escalate({ model: 'claude-sonnet-5-5', effort: 'high' }, allowed, 'xhigh'), { model: 'opus', effort: 'high', switches: true });
  // Past Opus, Fable in its 1M variant; past Fable, nothing by rule.
  assert.deepEqual(escalate({ model: 'claude-opus-5-5', effort: 'xhigh' }, allowed, 'xhigh'), { model: 'claude-fable-5-2[1m]', effort: 'xhigh', switches: true });
  assert.equal(escalate({ model: 'claude-fable-5-2[1m]', effort: 'high' }, allowed, 'xhigh'), null);
  assert.equal(escalate({ model: 'claude-opus-5-5', effort: 'high' }, ['opus', 'sonnet'], 'xhigh'), null);
  assert.equal(escalate({ model: '', effort: 'high' }, allowed, 'xhigh'), null);
  assert.deepEqual(escalate({ model: 'claude-fable-5-2', effort: 'medium' }, allowed, 'xhigh'), { model: 'claude-fable-5-2', effort: 'high', switches: false });
});

test('the step up respects the effort ceiling and the allowed models', () => {
  assert.deepEqual(escalate({ model: 'sonnet', effort: 'low' }, ['sonnet'], 'medium'), { model: 'sonnet', effort: 'medium', switches: false });
  assert.equal(escalate({ model: 'sonnet', effort: 'medium' }, ['sonnet'], 'medium'), null);
  assert.deepEqual(escalate({ model: 'sonnet', effort: 'high' }, ['sonnet', 'fable'], 'max'), { model: 'fable', effort: 'high', switches: true });
  assert.equal(escalate({ model: 'gpt-5.2-codex', effort: 'high' }, ['opus', 'sonnet'], 'max'), null);
});

test('the user grid: code on Opus high at least, heavy jobs on Fable 1M, research and tests on Sonnet, readings on Haiku', () => {
  const grid = modelGrid(['opus', 'sonnet', 'haiku', 'claude-fable-5-2', 'claude-fable-5-2[1m]', 'fable'], 'xhigh');
  const line = (r: (typeof grid)[number]) => `${r.mission} ${r.model} ${r.effort}${r.alt ? ` | ${r.alt.model} ${r.alt.effort}` : ''}`;
  assert.deepEqual(grid.map(line), [
    'code opus high | opus xhigh',
    'heavy claude-fable-5-2[1m] high',
    'critical opus xhigh | claude-fable-5-2[1m] high',
    'unknown opus xhigh | claude-fable-5-2[1m] high',
    'design opus high',
    'analysis opus high | sonnet high',
    'research sonnet high | haiku medium',
    'tests sonnet high | opus high',
    'writing sonnet high | opus high',
    'mechanical haiku medium | sonnet low',
  ]);
  // Nothing that writes code goes below Opus high, whatever the allowed list puts first.
  for (const r of grid) if (r.mission === 'code') assert.equal(r.model, 'opus');
});

test('the grid without Fable or Haiku: the heavy jobs on Opus xhigh, the mechanical ones on Sonnet low', () => {
  const grid = modelGrid(['sonnet', 'opus'], 'xhigh');
  const of = (m: string) => grid.find((r) => r.mission === m);
  assert.deepEqual([of('heavy')?.model, of('heavy')?.effort], ['opus', 'xhigh']);
  assert.deepEqual([of('mechanical')?.model, of('mechanical')?.effort, of('mechanical')?.alt], ['sonnet', 'low', null]);
  assert.equal(of('critical')?.alt, null);
  assert.deepEqual(modelGrid(['sonnet'], 'low').map((r) => `${r.model} ${r.effort}`), Array(10).fill('sonnet low'));
});

test('the step up takes the next family allowed: Haiku goes to Sonnet before Opus', () => {
  assert.deepEqual(escalate({ model: 'claude-haiku-5-5', effort: 'high' }, ['opus', 'sonnet', 'haiku'], 'xhigh'), { model: 'sonnet', effort: 'high', switches: true });
  assert.deepEqual(escalate({ model: 'haiku', effort: 'high' }, ['opus', 'haiku', 'fable'], 'xhigh'), { model: 'opus', effort: 'high', switches: true });
});
