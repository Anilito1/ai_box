import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateUsage } from './pricing';

const tokens = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 };
test('API estimates keep uncached input, cached input and output separate', () => {
  assert.equal(estimateUsage('gpt-5.3-codex', tokens).cost, 15.925);
  assert.equal(estimateUsage('gemini-2.5-pro', tokens, 200_000).cost, 11.375);
  assert.equal(estimateUsage('gemini-2.5-pro', tokens, 200_001).cost, 17.75);
  assert.equal(estimateUsage('gemini-3.1-pro-preview', tokens, 200_001).cost, 22.4);
  assert.deepEqual(estimateUsage('unknown-future-model', tokens), { ...tokens, cost: 0 });
});


test('inherited property names and unknown model versions remain unpriced at every context length', () => {
  for (const model of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'gemini-3.1-pro-preview-unknown', 'gemini-3.1-pro-preview-customtools-unknown']) {
    for (const promptTokens of [200_000, 200_001]) {
      const usage = estimateUsage(model, tokens, promptTokens);
      assert.deepEqual(usage, { ...tokens, cost: 0 }, `${model} at ${promptTokens}`);
      assert.ok(Number.isFinite(usage.cost));
    }
  }
  assert.equal(estimateUsage('gemini-3.1-pro-preview-customtools', tokens, 200_001).cost, 22.4);
});
