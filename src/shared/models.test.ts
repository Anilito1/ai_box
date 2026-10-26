import assert from 'node:assert/strict';
import { test } from 'node:test';
import { effortsFor, modelIdentity, splitRecent } from './models';
import { EFFORTS } from './types';

const m = (value: string, label = value) => ({ value, label });
const split = (models: { value: string; label: string }[], keep = '') => {
  const { recent, older } = splitRecent(models, keep);
  return { recent: recent.map((x) => x.value), older: older.map((x) => x.value) };
};

test('a model is read as a family and a version', () => {
  assert.deepEqual(modelIdentity(m('opus', 'Opus 5.5')), { family: 'opus', version: [5, 5] });
  assert.deepEqual(modelIdentity(m('gpt-5.4-mini')), { family: 'gpt mini', version: [5, 4] });
  assert.deepEqual(modelIdentity(m('gemini-3-pro-preview')), { family: 'gemini pro', version: [3] });
  assert.deepEqual(modelIdentity(m('sonnet[1m]', 'Sonnet 5.5 (1M context)')), { family: 'sonnet', version: [5, 5] });
});

test("Anthropic: the newest of each family first, the default and a model with no version always", () => {
  const out = split([m('default', 'Default'), m('fable', 'Fable 5.1'), m('opus', 'Opus 5.5'), m('opus-4-1', 'Opus 4.1'), m('sonnet', 'Sonnet 5.5'), m('sonnet-4', 'Sonnet 4'), m('haiku', 'Haiku 4.5'), m('haiku-3-5', 'Haiku 3.5')]);
  assert.deepEqual(out.recent, ['default', 'fable', 'opus', 'sonnet', 'haiku']);
  assert.deepEqual(out.older, ['opus-4-1', 'sonnet-4', 'haiku-3-5']);
});

test('the 1M variant of the newest model is as recent as the model', () => {
  const out = split([m('opus', 'Opus 5.5'), m('opus[1m]', 'Opus 5.5 (1M context)'), m('opus-4', 'Opus 4')]);
  assert.deepEqual(out, { recent: ['opus', 'opus[1m]'], older: ['opus-4'] });
});

test('OpenAI and Gemini: by family, whatever the provider', () => {
  const gpt = split([m('gpt-5.5'), m('gpt-5.4'), m('gpt-5.4-mini'), m('gpt-5.3-codex'), m('gpt-5.2-codex'), m('gpt-5.1')]);
  assert.deepEqual(gpt, { recent: ['gpt-5.5', 'gpt-5.4-mini', 'gpt-5.3-codex'], older: ['gpt-5.4', 'gpt-5.2-codex', 'gpt-5.1'] });
  const gem = split([m('gemini-3-pro-preview'), m('gemini-2.5-pro'), m('gemini-2.5-flash'), m('gemini-3-flash-preview')]);
  assert.deepEqual(gem, { recent: ['gemini-3-pro-preview', 'gemini-3-flash-preview'], older: ['gemini-2.5-pro', 'gemini-2.5-flash'] });
});

test('the model in use stays among the first, even an old one', () => {
  const out = split([m('opus', 'Opus 5.5'), m('opus-4', 'Opus 4')], 'opus-4');
  assert.deepEqual(out, { recent: ['opus', 'opus-4'], older: [] });
});

test('a list that is all recent has nothing behind "See more"', () => {
  assert.equal(split([m('deepseek-v4-pro', 'DeepSeek V4 Pro'), m('deepseek-v4-flash', 'DeepSeek V4 Flash')]).older.length, 0);
});

test('the efforts offered: the model\'s own, none for a model without the setting, all when they are not known', () => {
  const models = [
    { value: 'gpt-6-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] as const },
    { value: 'gpt-6-luna', efforts: ['low', 'medium'] as const },
    { value: 'gemini-3-pro', efforts: [] as const, noEffort: true },
    { value: 'opus', efforts: [] as const },
  ].map((x) => ({ ...x, efforts: [...x.efforts] }));
  assert.deepEqual(effortsFor(models, 'gpt-6-luna'), ['low', 'medium']);
  assert.deepEqual(effortsFor(models, 'gpt-6-sol'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(effortsFor(models, 'gemini-3-pro'), []);
  assert.deepEqual(effortsFor(models, 'opus'), EFFORTS);
  assert.deepEqual(effortsFor(models, 'unlisted'), EFFORTS);
});
