import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FRESH_START_PCT, FRESH_START_WORK, freshStartDue, needsFreshStart, normalizeRole, STALE_CACHE_MS, workTokens } from './team';
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

test('an ad-hoc worker starts afresh at half its window: 500k of 1M, not before', () => {
  assert.equal(FRESH_START_PCT, 50);
  assert.equal(needsFreshStart(at(499_000)), false);
  assert.equal(needsFreshStart(at(500_000)), true);
  assert.equal(needsFreshStart(null), false);
});

test('a permanent worker at work, or with background tasks, is never renewed', () => {
  assert.equal(freshStartDue({ working: true, worked: 600_000 }), false);
  assert.equal(freshStartDue({ working: true, worked: 600_000, idleMs: 2 * STALE_CACHE_MS }), false);
});

test('a permanent worker woken after its cache expired starts afresh, not before', () => {
  assert.equal(STALE_CACHE_MS, 3_600_000);
  assert.equal(freshStartDue({ working: false, worked: 100_000, idleMs: STALE_CACHE_MS - 1 }), false);
  assert.equal(freshStartDue({ working: false, worked: 100_000, idleMs: STALE_CACHE_MS }), true);
  assert.equal(freshStartDue({ working: false, worked: 5_000, idleMs: 3 * STALE_CACHE_MS }), false);
});
test('a post keeps its Ultracode only when it is exactly true', () => {
  assert.equal(normalizeRole({ name: 'a', ultracode: true }).ultracode, true);
  for (const v of [false, 'true', 1, null, undefined]) assert.equal(normalizeRole({ name: 'a', ultracode: v }).ultracode, false, String(v));
});
