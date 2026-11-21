import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { builtinRate, deepseekModelOf, deepseekPeak, estimateUsage, listedRates, PriceBook, priceTurn, type Rate } from './pricing';

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

const u = (cost: number, input = 0, output = 0, cacheRead = 0, cacheWrite = 0) => ({ cost, input, output, cacheRead, cacheWrite });
const rates = (table: Record<string, Rate>) => (model: string) => (Object.hasOwn(table, model) ? table[model] : undefined);

test('Anthropic keeps Claude Code’s own figure', () => {
  const models = { 'claude-opus-5-5': u(6, 1_000_000, 100_000) };
  assert.deepEqual(priceTurn('anthropic', 'claude', models, () => undefined), { models, unpriced: [] });
});

test('another provider’s turn run by Claude Code is priced at that provider’s rate, not at Anthropic’s', () => {
  // What Claude Code answered for 1M tokens in and 100k out of a Venice model (measured): Anthropic's default rates.
  const sdk = { 'venice-uncensored': u(7.5, 1_000_000, 100_000, 200_000, 0) };
  const r = priceTurn('venice', 'claude', sdk, rates({ 'venice-uncensored': [0.5, 2, 0.25] }));
  assert.deepEqual(r, { models: { 'venice-uncensored': u(0.5 + 0.2 + 0.05, 1_000_000, 100_000, 200_000, 0) }, unpriced: [] });
  // Without a cache price of its own, a cached token costs the input's.
  assert.equal(+priceTurn('venice', 'claude', sdk, rates({ 'venice-uncensored': [0.5, 2] })).models['venice-uncensored'].cost.toFixed(9), 0.8);
});

test('a model without a known price: its tokens kept, its cost 0 and marked, never Anthropic’s figure', () => {
  const r = priceTurn('venice', 'claude', { 'mystery-model': u(7.5, 1_000_000, 100_000), 'venice-uncensored': u(1, 10, 10) }, rates({ 'venice-uncensored': [1, 1] }));
  assert.deepEqual(r.models['mystery-model'], u(0, 1_000_000, 100_000));
  assert.deepEqual(r.unpriced, ['mystery-model']);
  // Nothing spent in it: nothing to say.
  assert.deepEqual(priceTurn('venice', 'claude', { 'mystery-model': u(0) }, () => undefined).unpriced, []);
});

test('DeepSeek: the Claude names it was asked for become its models, at its peak or off-peak rate', () => {
  assert.deepEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'deepseek-v4-pro'].map(deepseekModelOf), ['deepseek-v4-pro', 'deepseek-flash', 'deepseek-flash', 'deepseek-v4-pro']);
  const peak = Date.UTC(2026, 10, 18, 8); // a Wednesday, 08:00 UTC
  const offPeak = Date.UTC(2026, 10, 18, 12);
  const sunday = Date.UTC(2026, 10, 22, 8);
  assert.deepEqual([deepseekPeak(peak), deepseekPeak(offPeak), deepseekPeak(sunday)], [true, false, false]);
  // Claude Code's turn as it logs it: Opus' name, Anthropic's price.
  const sdk = { 'claude-opus-5-5': u(6, 1_000_000, 100_000, 1_000_000), 'claude-haiku-4-5': u(0.2, 100_000, 1000) };
  const at = (when: number) => priceTurn('deepseek', 'claude', sdk, (m) => builtinRate('deepseek', m, when));
  const p = at(peak);
  assert.deepEqual(Object.keys(p.models), ['deepseek-v4-pro', 'deepseek-flash']);
  assert.equal(+p.models['deepseek-v4-pro'].cost.toFixed(6), +(1.32 + 0.396 + 0.044).toFixed(6));
  assert.equal(+p.models['deepseek-flash'].cost.toFixed(6), +(0.03 + 0.0012).toFixed(6));
  assert.equal(+at(offPeak).models['deepseek-v4-pro'].cost.toFixed(6), +((1.32 + 0.396 + 0.044) / 2).toFixed(6));
  assert.deepEqual(p.unpriced, []);
});

test('Codex and Gemini keep their own estimate; a model they had no rate for is marked', () => {
  const models = { 'gpt-5.3-codex': u(1.5, 1000, 10), 'gpt-9-unknown': u(0, 5000, 50) };
  assert.deepEqual(priceTurn('openai', 'codex', models, (m) => builtinRate('openai', m, 0)), { models, unpriced: ['gpt-9-unknown'] });
  // OpenAI's API through the bridge: its own rates, Claude Code's figure dropped.
  assert.equal(priceTurn('openai', 'claude', { 'gpt-6.1-sol': u(7.5, 1_000_000, 100_000) }, (m) => builtinRate('openai', m, 0)).models['gpt-6.1-sol'].cost, 2 + 1);
});

test('the prices a model list gives: Venice’s per million, OpenRouter’s per token; none is not a price', () => {
  const listed = listedRates([
    { id: 'gemini-4-carbon', model_spec: { pricing: { input: { usd: 2.5, diem: 2.5 }, cache_input: { usd: 0.125 }, output: { usd: 12.5 } } } },
    { id: 'qwen-4-max', model_spec: { pricing: { input: { usd: 1.2 }, output: { usd: 6 }, cache_write: { usd: 1.875 } } } },
    { id: 'qwen/qwen3-coder-next', pricing: { prompt: '0.00000012', completion: '0.0000008', input_cache_read: '0.00000007' } },
    { id: 'meta/free:free', pricing: { prompt: '0', completion: '0' } },
    { id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } },
    { id: 'no-price', model_spec: { name: 'x' } },
    { id: 'half', pricing: { prompt: '0.000001' } },
    { model_spec: { pricing: { input: { usd: 1 }, output: { usd: 1 } } } },
    null,
  ]);
  assert.deepEqual(listed, {
    'gemini-4-carbon': [2.5, 12.5, 0.125],
    'qwen-4-max': [1.2, 6, 1.2, 1.875],
    'qwen/qwen3-coder-next': [0.12, 0.8, 0.07],
    'meta/free:free': [0, 0],
  });
  assert.deepEqual(listedRates({ data: 'nope' }), {});
});

test('the price book keeps the lists read, across a restart, beside the hub’s own rates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-prices-'));
  try {
    const file = join(dir, 'usage', 'prices.json');
    const book = new PriceBook(file);
    assert.equal(book.rate('venice', 'venice-uncensored'), undefined);
    book.set('venice', { 'venice-uncensored': [0.5, 2] });
    book.set('venice', {}); // a list without prices changes nothing
    assert.deepEqual(new PriceBook(file).rate('venice', 'venice-uncensored'), [0.5, 2]);
    assert.equal(new PriceBook(file).rate('venice', 'constructor'), undefined);
    assert.deepEqual(book.rate('openai', 'gpt-6.1-sol'), [2, 10, 0.1], 'OpenAI’s from the hub’s own table');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { venice: { 'venice-uncensored': [0.5, 2] } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
