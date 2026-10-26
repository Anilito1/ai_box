import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acknowledge, advance, diffModels, emptyMemory, installMethod, isNewer, modelKey, parseVersion, updateCommand, type CliUpdate, type NewsInput } from './news';

const m = (value: string, label = value) => ({ value, label });
const update = (latest: string): CliUpdate => ({ tool: 'claude', current: '2.1.287', latest, method: 'brew', command: 'brew upgrade --cask claude-code', path: '/opt/homebrew/Caskroom/claude-code/2.1.287/claude', reach: '', upgrade: true, switchTo: '' });
const input = (over: Partial<NewsInput>): NewsInput => ({ connected: { anthropic: true, openai: true }, offered: {}, cli: {}, ...over });

test('versions are compared by their numbers, not as text', () => {
  assert.equal(isNewer('2.1.311', '2.1.287'), true);
  assert.equal(isNewer('0.170.0', '0.99.9'), true);
  assert.equal(isNewer('2.1.287', '2.1.287'), false);
  assert.equal(isNewer('2.1.9', '2.1.10'), false);
  assert.equal(isNewer('3.0.0', '2.9.9'), true);
});

test('an unreadable version or a pre-release is never an update', () => {
  assert.equal(isNewer('', '1.0.0'), false);
  assert.equal(isNewer('1.0.1', ''), false);
  assert.equal(isNewer('1.0.1-beta.2', '1.0.0'), false);
});

test('the version is read from what the program prints', () => {
  assert.equal(parseVersion('2.1.287 (Claude Code)'), '2.1.287');
  assert.equal(parseVersion('codex-cli 0.163.0'), '0.163.0');
  assert.equal(parseVersion('nothing'), '');
});

test('the install method comes from where the program lives', () => {
  assert.equal(installMethod('/opt/homebrew/Caskroom/claude-code/2.1.287/claude'), 'brew');
  assert.equal(installMethod('/opt/homebrew/Cellar/codex/0.163.0/bin/codex'), 'brew');
  assert.equal(installMethod('/Users/me/.local/share/claude/versions/2.1.311'), 'native');
  assert.equal(installMethod('/Users/me/.nvm/versions/node/v22/lib/node_modules/@google/gemini-cli/bundle/gemini.js'), 'npm');
  assert.equal(installMethod('/Users/me/Library/Application Support/AI Box/tools/node_modules/@openai/codex/bin/codex', '/Users/me/Library/Application Support/AI Box/tools'), 'app');
  assert.equal(installMethod('/usr/bin/whatever'), 'unknown');
  assert.equal(installMethod(''), 'unknown');
});

test('the update command follows the install method', () => {
  assert.equal(updateCommand('anthropic', 'brew'), 'brew upgrade --cask claude-code');
  assert.equal(updateCommand('openai', 'brew'), 'brew upgrade codex');
  assert.equal(updateCommand('anthropic', 'native'), 'claude update');
  assert.equal(updateCommand('gemini', 'npm'), 'npm install -g @google/gemini-cli@latest');
  assert.equal(updateCommand('openai', 'unknown'), 'npm install -g @openai/codex@latest');
  assert.equal(updateCommand('openai', 'app', '/tools'), 'npm install --prefix "/tools" @openai/codex@latest');
  assert.equal(updateCommand('deepseek', 'npm'), '');
});

test('an alias is named by what it stands for, a concrete id by itself', () => {
  assert.equal(modelKey(m('opus', 'Opus 5.5')), 'Opus 5.5');
  assert.equal(modelKey(m('gpt-5.5', 'GPT-5.5')), 'gpt-5.5');
});

test('the first launch records the models without telling anything', () => {
  const { seen, fresh } = diffModels({}, { anthropic: ['a', 'b'] }, { anthropic: true });
  assert.deepEqual(seen, { anthropic: ['a', 'b'] });
  assert.deepEqual(fresh, {});
});

test('a model never seen is new, once', () => {
  const first = diffModels({ openai: ['gpt-5.4'] }, { openai: ['gpt-5.4', 'gpt-5.5'] }, { openai: true });
  assert.deepEqual(first.fresh, { openai: ['gpt-5.5'] });
  const again = diffModels(first.seen, { openai: ['gpt-5.4', 'gpt-5.5'] }, { openai: true });
  assert.deepEqual(again.fresh, {});
});

test('a provider that is not connected is ignored, an empty list changes nothing', () => {
  const off = diffModels({ gemini: ['x'] }, { gemini: ['x', 'y'] }, { gemini: false });
  assert.deepEqual(off, { seen: { gemini: ['x'] }, fresh: {} });
  const empty = diffModels({ gemini: ['x'] }, { gemini: [] }, { gemini: true });
  assert.deepEqual(empty, { seen: { gemini: ['x'] }, fresh: {} });
  const unknown = diffModels({}, { gemini: ['x'] }, { gemini: false });
  assert.deepEqual(unknown.seen, {});
});

test('a model that goes and comes back is not new', () => {
  const gone = diffModels({ openai: ['a', 'b'] }, { openai: ['a'] }, { openai: true });
  const back = diffModels(gone.seen, { openai: ['a', 'b'] }, { openai: true });
  assert.deepEqual(back.fresh, {});
});

test('no toast and no dot at the first check, whatever the models', () => {
  const step = advance(emptyMemory(), input({ offered: { anthropic: [m('opus', 'Opus 5.5')], openai: [m('gpt-5.5')] } }));
  assert.deepEqual(step.toasts, []);
  assert.equal(step.news.anthropic?.unseen, false);
  assert.equal(step.news.openai?.unseen, false);
});

test('a new model gives one toast and a dot until the menu is opened', () => {
  const first = advance(emptyMemory(), input({ offered: { openai: [m('gpt-5.4')] } }));
  const second = advance(first.memory, input({ offered: { openai: [m('gpt-5.4'), m('gpt-5.5', 'GPT-5.5')] } }));
  assert.deepEqual(second.toasts, [{ provider: 'openai', models: ['GPT-5.5'], cli: null }]);
  assert.deepEqual(second.news.openai, { models: ['gpt-5.5'], cli: null, unseen: true });
  const third = advance(second.memory, input({ offered: { openai: [m('gpt-5.4'), m('gpt-5.5', 'GPT-5.5')] } }));
  assert.deepEqual(third.toasts, []);
  assert.equal(third.news.openai?.unseen, true);
  const read = advance(acknowledge(third.memory, 'openai', null), input({ offered: { openai: [m('gpt-5.4'), m('gpt-5.5', 'GPT-5.5')] } }));
  assert.deepEqual(read.news.openai, { models: [], cli: null, unseen: false });
});

test('an unconnected provider has no news and no toast', () => {
  const first = advance(emptyMemory(), input({ connected: { gemini: false }, offered: { gemini: [m('a')] } }));
  const second = advance(first.memory, input({ connected: { gemini: false }, offered: { gemini: [m('a'), m('b')] }, cli: { gemini: update('0.99.0') } }));
  assert.deepEqual(second.toasts, []);
  assert.equal(second.news.gemini, undefined);
});

test('a program update is told once per version, and its dot goes when the menu is read', () => {
  const up = update('2.1.311');
  const first = advance(emptyMemory(), input({ cli: { anthropic: up } }));
  assert.equal(first.toasts.length, 1);
  assert.equal(first.news.anthropic?.unseen, true);
  const again = advance(first.memory, input({ cli: { anthropic: up } }));
  assert.deepEqual(again.toasts, []);
  const read = advance(acknowledge(again.memory, 'anthropic', up), input({ cli: { anthropic: up } }));
  assert.equal(read.news.anthropic?.unseen, false);
  assert.equal(read.news.anthropic?.cli?.latest, '2.1.311');
  const newer = advance(read.memory, input({ cli: { anthropic: update('2.1.320') } }));
  assert.equal(newer.toasts.length, 1);
  assert.equal(newer.news.anthropic?.unseen, true);
});
