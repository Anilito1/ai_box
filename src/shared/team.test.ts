import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FRESH_START_PCT, needsFreshStart } from './team';
import type { Metrics } from './types';

const at = (tokens: number, size: number): Metrics => ({ contextTokens: tokens, contextSize: size, contextPct: (tokens / size) * 100, costUsd: 0 });

test('a worker starts afresh at half its real window: 500k of 1M, not before', () => {
  assert.equal(FRESH_START_PCT, 50);
  assert.equal(needsFreshStart(at(499_000, 1_000_000)), false);
  assert.equal(needsFreshStart(at(500_000, 1_000_000)), true);
  assert.equal(needsFreshStart(at(100_000, 200_000)), true);
  assert.equal(needsFreshStart(null), false);
  assert.equal(needsFreshStart({ contextTokens: 0, contextSize: 0, contextPct: null, costUsd: 0 }), false);
});
