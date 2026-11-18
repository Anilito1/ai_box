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

test('a failed delivery moves one step up: the effort first, then the strong model, never Fable', () => {
  const allowed = ['opus', 'claude-fable-5-2', 'sonnet', 'fable'];
  assert.deepEqual(escalate({ model: 'claude-sonnet-5-5', effort: 'medium' }, allowed, 'xhigh'), { model: 'claude-sonnet-5-5', effort: 'high', switches: false });
  assert.deepEqual(escalate({ model: 'sonnet', effort: '' }, allowed, 'xhigh'), { model: 'sonnet', effort: 'high', switches: false });
  assert.deepEqual(escalate({ model: 'claude-sonnet-5-5', effort: 'high' }, allowed, 'xhigh'), { model: 'opus', effort: 'high', switches: true });
  // At the top, or on a model the user asked for: nothing by rule.
  assert.equal(escalate({ model: 'claude-opus-5-5', effort: 'high' }, allowed, 'xhigh'), null);
  assert.equal(escalate({ model: 'claude-opus-5-5', effort: 'xhigh' }, allowed, 'xhigh'), null);
  assert.equal(escalate({ model: 'claude-fable-5-2', effort: 'high' }, allowed, 'xhigh'), null);
  // The step to the strong model never lowers an effort already above high.
  assert.deepEqual(escalate({ model: 'sonnet', effort: 'xhigh' }, allowed, 'xhigh'), { model: 'opus', effort: 'xhigh', switches: true });
  assert.equal(escalate({ model: '', effort: 'high' }, allowed, 'xhigh'), null);
  assert.deepEqual(escalate({ model: 'claude-fable-5-2', effort: 'medium' }, allowed, 'xhigh'), { model: 'claude-fable-5-2', effort: 'high', switches: false });
});

test('the step up respects the effort ceiling and the allowed models', () => {
  assert.deepEqual(escalate({ model: 'sonnet', effort: 'low' }, ['sonnet'], 'medium'), { model: 'sonnet', effort: 'medium', switches: false });
  assert.equal(escalate({ model: 'sonnet', effort: 'medium' }, ['sonnet'], 'medium'), null);
  assert.equal(escalate({ model: 'sonnet', effort: 'high' }, ['sonnet', 'fable'], 'max'), null);
  assert.equal(escalate({ model: 'gpt-5.2-codex', effort: 'high' }, ['opus', 'sonnet'], 'max'), null);
});

test('the grid: routine code on the fast model at medium, risk on the strong one, Fable never when Opus is allowed', () => {
  const grid = modelGrid(['opus', 'claude-fable-5-2', 'sonnet', 'fable'], 'xhigh');
  assert.deepEqual(grid.map((r) => `${r.tier} ${r.model} ${r.effort}`), ['simple sonnet medium', 'standard sonnet medium', 'hard opus high', 'critical opus high']);
  assert.deepEqual(grid[1].alt, { model: 'opus', effort: 'medium' });
  assert.deepEqual(modelGrid(['sonnet'], 'low').map((r) => `${r.model} ${r.effort}`), ['sonnet low', 'sonnet low', 'sonnet low', 'sonnet low']);
});
