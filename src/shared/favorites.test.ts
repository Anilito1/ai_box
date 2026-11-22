import assert from 'node:assert/strict';
import { test } from 'node:test';
import { favoriteGroups, filterFavorites, FAVORITES_MAX, isFavoriteMap, modelsText, toggleFavorite } from './favorites';
import type { ProviderBadge } from './types';

const NO_NEWS = { models: [], cli: null, unseen: false } as unknown as ProviderBadge['news'];
const option = (value: string, label = value) => ({ value, label, description: '', efforts: [] });
const badge = (id: string, label: string, connected: boolean, models: string[], favorites: string[]): ProviderBadge => ({
  id,
  label,
  connected,
  accountId: connected ? `a-${id}` : '',
  models: models.map((m) => option(m, m === 'opus' ? 'Opus 4.7' : m)),
  news: NO_NEWS,
  favorites,
});

test('the settings keep favourites of built-in providers only, as model ids, once each', () => {
  assert.equal(isFavoriteMap({ anthropic: ['opus', 'opus[1m]'], gemini: [], openai: ['gpt-5.5'] }), true);
  assert.equal(isFavoriteMap({}), true);
  assert.equal(isFavoriteMap({ venice: ['llama'] }), false, 'a provider the user added keeps its own (its models)');
  assert.equal(isFavoriteMap({ anthropic: ['opus', 'opus'] }), false);
  assert.equal(isFavoriteMap({ anthropic: ['-rf'] }), false);
  assert.equal(isFavoriteMap({ anthropic: ['two words'] }), false);
  assert.equal(isFavoriteMap({ anthropic: 'opus' }), false);
  assert.equal(isFavoriteMap({ anthropic: Array.from({ length: FAVORITES_MAX + 1 }, (_, i) => `m${i}`) }), false);
  assert.equal(isFavoriteMap(['anthropic']), false);
  assert.equal(isFavoriteMap(null), false);
});

test('a star adds the model at the end, once; taking it off removes it; the list never grows past its limit', () => {
  assert.deepEqual(toggleFavorite(['opus'], 'haiku', true), ['opus', 'haiku']);
  assert.deepEqual(toggleFavorite(['opus', 'haiku'], 'opus', true), ['haiku', 'opus']);
  assert.deepEqual(toggleFavorite(['opus', 'haiku'], 'opus', false), ['haiku']);
  assert.deepEqual(toggleFavorite([], 'opus', false), []);
  const full = Array.from({ length: FAVORITES_MAX }, (_, i) => `m${i}`);
  assert.deepEqual(toggleFavorite(full, 'one-more', true), full.slice(0), 'full: nothing added, nothing lost');
});

test('the Favourites tab: connected providers only, in their own model order, without a model they no longer offer', () => {
  const groups = favoriteGroups([
    badge('anthropic', 'Anthropic', true, ['default', 'opus', 'sonnet', 'haiku'], ['haiku', 'opus', 'retired-model']),
    badge('openai', 'OpenAI', false, [], ['gpt-5.5']),
    badge('gemini', 'Gemini', true, ['gemini-3-pro'], []),
    // Its models not said yet: the favourites go by their ids.
    badge('venice', 'Venice', true, [], ['llama-3.3-70b']),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.id, g.models.map((m) => m.value)]),
    [
      ['anthropic', ['opus', 'haiku']],
      ['venice', ['llama-3.3-70b']],
    ],
  );
  assert.equal(groups[0].models[0].label, 'Opus 4.7');
  assert.deepEqual(favoriteGroups([badge('anthropic', 'Anthropic', true, ['default', 'opus'], ['default'])]), [], "Claude Code's default is no model to star");
});

test('the filter keeps the favourites every typed word is found in: provider, model name or id, accents aside', () => {
  const groups = favoriteGroups([badge('anthropic', 'Anthropic', true, ['opus', 'haiku'], ['opus', 'haiku']), badge('venice', 'Venice', true, ['llama-3.3-70b', 'qwen-coder'], ['llama-3.3-70b', 'qwen-coder'])]);
  const ids = (q: string) => filterFavorites(groups, q).flatMap((g) => g.models.map((m) => `${g.id}:${m.value}`));
  assert.deepEqual(ids(''), ['anthropic:opus', 'anthropic:haiku', 'venice:llama-3.3-70b', 'venice:qwen-coder']);
  assert.deepEqual(ids('  '), ids(''));
  assert.deepEqual(ids('opus'), ['anthropic:opus']);
  assert.deepEqual(ids('4.7'), ['anthropic:opus'], 'by the name the menu shows');
  assert.deepEqual(ids('VÉNICE llama'), ['venice:llama-3.3-70b']);
  assert.deepEqual(ids('venice opus'), []);
});

test('list_capabilities: each provider with its models, the favourites starred, the ones not connected said so', () => {
  const text = modelsText([
    { id: 'anthropic', label: 'Anthropic', connected: true, models: ['opus', 'sonnet', 'haiku'], favorites: ['haiku'] },
    { id: 'venice', label: 'Venice', connected: true, models: ['llama-3.3-70b'], favorites: ['llama-3.3-70b'] },
    { id: 'deepseek', label: 'DeepSeek', connected: true, models: [], favorites: [] },
    { id: 'gemini', label: 'Gemini', connected: false, models: [], favorites: ['gemini-3-pro'] },
  ]);
  assert.match(text, /^Models by provider \(★ = a favourite of the user\)/);
  assert.match(text, /- anthropic \(Anthropic\): opus, sonnet, haiku★$/m);
  assert.match(text, /- venice \(Venice\): llama-3\.3-70b★$/m);
  assert.match(text, /- deepseek \(DeepSeek\): its default model$/m);
  assert.match(text, /- gemini \(Gemini\): not connected$/m);
  assert.equal(modelsText([]), '');
});
