import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatModels, DEEPSEEK_MODELS, deepseekAlias, isProviderId, methodOfAccount, pickOpenAIModel, providerOfAccount, resolveProvider } from './providers';

const acct = (kind: string, baseUrl = '') => ({ kind, baseUrl }) as Parameters<typeof providerOfAccount>[0];

test('which provider an account belongs to: by kind, and by address for the servers', () => {
  assert.equal(providerOfAccount('default'), 'anthropic');
  assert.equal(providerOfAccount(acct('claude')), 'anthropic');
  assert.equal(providerOfAccount(acct('anthropic-key')), 'anthropic');
  assert.equal(providerOfAccount(acct('codex')), 'openai');
  assert.equal(providerOfAccount(acct('openai', 'https://api.openai.com/v1')), 'openai');
  assert.equal(providerOfAccount(acct('openai', 'https://openrouter.ai/api/v1')), null, 'a hand-made one stands for no block');
  assert.equal(providerOfAccount(acct('anthropic-compatible', 'https://api.deepseek.com/anthropic')), 'deepseek');
  assert.equal(providerOfAccount(acct('anthropic-compatible', 'https://elsewhere.example/anthropic')), null);
  assert.equal(providerOfAccount(acct('gemini')), 'gemini');
  assert.equal(providerOfAccount(acct('gemini-key')), 'gemini');
  assert.equal(methodOfAccount(acct('gemini')), 'google');
  assert.equal(methodOfAccount(acct('gemini-key')), 'apikey');
  assert.equal(methodOfAccount(acct('codex')), 'chatgpt');
  assert.equal(methodOfAccount(acct('openai')), 'apikey');
  assert.equal(methodOfAccount('default'), 'cli');
});

test('a provider is asked for by its id or the name of its program; only a connected one has an account', () => {
  const states = { openai: { connected: true, accountId: 'a-oai00001', method: 'chatgpt' as const }, deepseek: { connected: false, accountId: '', method: '' as const } };
  assert.deepEqual(resolveProvider(states, 'openai'), { account: 'a-oai00001' });
  assert.deepEqual(resolveProvider(states, ' Codex '), { account: 'a-oai00001' });
  assert.deepEqual(resolveProvider({ gemini: { connected: true, accountId: 'a-gem00001', method: 'google' } }, 'Google'), { account: 'a-gem00001' });
  assert.deepEqual(resolveProvider(states, 'deepseek'), { error: 'disconnected' });
  assert.deepEqual(resolveProvider(states, 'mistral'), { error: 'unknown' });
  assert.deepEqual(resolveProvider(states, undefined), { error: 'unknown' });
  assert.deepEqual(resolveProvider({}, 'anthropic'), { account: 'default' }, 'the usual Claude access is there before any check');
  assert.deepEqual(resolveProvider({}, 'openai'), { error: 'disconnected' });
  assert.equal(isProviderId('anthropic') && !isProviderId('claude'), true);
});

test('DeepSeek’s models are asked for through the names its endpoint maps', () => {
  assert.equal(deepseekAlias('deepseek-v4-pro'), 'opus');
  assert.equal(deepseekAlias('deepseek-v4-flash'), 'sonnet');
  assert.equal(deepseekAlias('whatever'), 'whatever');
  assert.equal(new Set(DEEPSEEK_MODELS.map((m) => m.alias)).size, DEEPSEEK_MODELS.length);
});

test('OpenAI’s list: only chat models, the default a recent general one', () => {
  const ids = ['text-embedding-3-small', 'gpt-4o-mini', 'gpt-5-mini', 'gpt-5', 'gpt-image-1', 'whisper-1', 'o3', 'gpt-4o-2024-08-06', 'gpt-4o-audio-preview', 'omni-moderation-latest'];
  assert.deepEqual(chatModels(ids), ['gpt-4o-mini', 'gpt-5-mini', 'gpt-5', 'o3']);
  assert.equal(pickOpenAIModel(ids), 'gpt-5');
  assert.equal(pickOpenAIModel(['gpt-5-mini', 'gpt-7-mini', 'o3']), 'gpt-5-mini', 'no plain general model: the first chat model');
  assert.equal(pickOpenAIModel(['gpt-7', 'gpt-5-mini']), 'gpt-7');
  assert.equal(pickOpenAIModel(['whisper-1']), '');
});
