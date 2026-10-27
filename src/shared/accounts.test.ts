import assert from 'node:assert/strict';
import { test } from 'node:test';

const { canonAccount, checkAccount, CUSTOM_SLUG, customSlug, findAccount, isAccountRef, isBuiltinAccount, firstAccount, hasServer, isLocalUrl, isOpenAIHost, isServerUrl, normalizeAccount, OPENAI_URL, pinsModel } = await import('./accounts');
const { PRESETS } = await import('./presets');
type Account = import('./types').Account;

const claude = (id: string, name: string): Account => ({ id, kind: 'claude', name, baseUrl: '', model: '', smallModel: '', slug: '', models: [], isolated: false });
const openai = (over: Partial<Account> = {}): Account => ({ id: '', kind: 'openai', name: 'Work', baseUrl: OPENAI_URL, model: 'gpt-5', smallModel: '', slug: '', models: [], isolated: false, ...over });

test('normalizeAccount: trims, defaults the OpenAI server, drops the OpenAI fields of other kinds', () => {
  assert.deepEqual(normalizeAccount({ kind: 'openai', name: '  My   work ', baseUrl: 'http://localhost:8080/v1/', model: ' gpt-5 ' }), {
    id: '',
    kind: 'openai',
    name: 'My work',
    baseUrl: 'http://localhost:8080/v1',
    model: 'gpt-5',
    smallModel: '',
    slug: '',
    models: [],
    isolated: false,
  });
  assert.equal(normalizeAccount({ kind: 'codex', name: 'x', isolated: true, baseUrl: 'http://x', model: 'm' }).isolated, true);
  assert.equal(normalizeAccount({ kind: 'claude', name: 'x', isolated: true }).isolated, false);
  assert.equal(normalizeAccount({ kind: 'openai', name: 'x' }).baseUrl, OPENAI_URL);
  assert.deepEqual(normalizeAccount({ kind: 'claude', name: 'Perso', model: 'gpt-5', baseUrl: 'http://x' }), claude('', 'Perso'));
  assert.equal(normalizeAccount({ kind: 'nope', name: 'x' }).kind, 'claude');
  assert.equal(normalizeAccount(null).name, '');
});

test('checkAccount: names', () => {
  const others = [claude('a-aaaaaaaa', 'Perso')];
  assert.deepEqual(checkAccount(claude('', ''), others), { field: 'name', problem: 'required' });
  assert.deepEqual(checkAccount(claude('', 'x'.repeat(41)), others), { field: 'name', problem: 'tooLong' });
  assert.deepEqual(checkAccount(claude('', 'Default'), others), { field: 'name', problem: 'reserved' });
  assert.deepEqual(checkAccount(claude('', 'perso'), others), { field: 'name', problem: 'taken' });
  // Renaming an account to its own name is fine.
  assert.equal(checkAccount(claude('a-aaaaaaaa', 'PERSO'), others), null);
  const full = Array.from({ length: 20 }, (_, i) => claude(`a-${String(i).padStart(8, '0')}`, `n${i}`));
  assert.deepEqual(checkAccount(claude('', 'new'), full), { field: 'accounts', problem: 'tooMany' });
});

test('checkAccount: an OpenAI account needs a server and a model', () => {
  assert.equal(checkAccount(openai(), []), null);
  assert.equal(checkAccount(openai({ baseUrl: 'http://localhost:8080/v1', model: 'qwen2.5-coder:14b' }), []), null);
  assert.equal(checkAccount(openai({ model: 'openai/gpt-5', smallModel: 'openai/gpt-5-mini' }), []), null);
  assert.deepEqual(checkAccount(openai({ baseUrl: 'ftp://x' }), []), { field: 'baseUrl', problem: 'format' });
  assert.deepEqual(checkAccount(openai({ baseUrl: 'https://user:pw@host/v1' }), []), { field: 'baseUrl', problem: 'format' });
  assert.deepEqual(checkAccount(openai({ model: '' }), []), { field: 'model', problem: 'required' });
  assert.deepEqual(checkAccount(openai({ model: '-rm' }), []), { field: 'model', problem: 'format' });
  assert.deepEqual(checkAccount(openai({ smallModel: 'a b' }), []), { field: 'smallModel', problem: 'format' });
});

test('isServerUrl: https anywhere, plain http to this computer only', () => {
  assert.ok(isServerUrl('https://api.venice.ai/api/v1'));
  assert.ok(isServerUrl('http://localhost:11434/v1'));
  assert.ok(isServerUrl('http://127.0.0.1:1234/v1'));
  assert.ok(isServerUrl('http://[::1]:8080/v1'));
  assert.ok(!isServerUrl('http://api.venice.ai/api/v1'), 'a key never travels in clear');
  assert.ok(!isServerUrl('http://192.168.1.10:8080/v1'));
  assert.ok(!isServerUrl('http://0.0.0.0:8080/v1'));
  assert.ok(!isServerUrl('http://localhost.evil.com/v1'));
  assert.ok(!isServerUrl('https://user:pw@api.venice.ai/v1'));
  assert.ok(!isServerUrl('https://api.venice.ai/v1?x=1'));
  assert.ok(!isServerUrl('ftp://api.venice.ai/v1'));
  assert.ok(!isServerUrl('javascript:alert(1)'));
  assert.ok(!isServerUrl(`https://a.io/${'x'.repeat(300)}`));
});

test('customSlug: readable, stable, never a built-in name nor one taken', () => {
  assert.equal(customSlug('Venice', []), 'venice');
  assert.equal(customSlug('Venice.ai', []), 'venice-ai');
  assert.equal(customSlug('  Élan Vital ', []), 'elan-vital');
  assert.equal(customSlug('Venice', ['venice']), 'venice-2');
  assert.equal(customSlug('Venice', ['venice', 'venice-2']), 'venice-3');
  assert.equal(customSlug('OpenAI', []), 'openai-2');
  assert.equal(customSlug('Claude', []), 'claude-2');
  assert.equal(customSlug('42', []), 'custom');
  assert.equal(customSlug('X', []), 'x-ai');
  for (const name of ['Venice', 'a very long provider name indeed', '!!!', 'Default']) assert.match(customSlug(name, []), CUSTOM_SLUG);
});

test('a provider the user added: its id kept, its models checked, the first one its default', () => {
  const venice = (over: Record<string, unknown> = {}) =>
    normalizeAccount({ kind: 'openai', name: 'Venice', baseUrl: 'https://api.venice.ai/api/v1/', slug: 'Venice', models: [' venice-uncensored ', 'llama-3.3-70b', 'venice-uncensored'], model: 'ignored', smallModel: 'ignored', ...over });
  const a = venice();
  assert.equal(a.slug, 'venice');
  assert.equal(a.baseUrl, 'https://api.venice.ai/api/v1');
  assert.deepEqual(a.models, ['venice-uncensored', 'llama-3.3-70b']);
  assert.equal(a.model, 'venice-uncensored');
  assert.equal(a.smallModel, '');
  assert.equal(checkAccount(a, []), null);
  assert.equal(normalizeAccount({ kind: 'anthropic-compatible', name: 'x', slug: 'x', models: ['m'] }).slug, '', 'only an OpenAI-compatible account stands for one');
  assert.deepEqual(checkAccount(venice({ models: [] }), []), { field: 'models', problem: 'required' });
  assert.deepEqual(checkAccount(venice({ models: ['-rm'] }), []), { field: 'models', problem: 'format' });
  assert.deepEqual(checkAccount(venice({ models: Array.from({ length: 101 }, (_, i) => `m${i}`) }), []), { field: 'models', problem: 'tooMany' });
  assert.deepEqual(checkAccount(venice({ baseUrl: 'http://api.venice.ai/api/v1' }), []), { field: 'baseUrl', problem: 'format' });
  assert.equal(checkAccount(openai({ baseUrl: 'http://192.168.1.20:11434/v1' }), []), null, 'an older account on the local network still loads');
  assert.deepEqual(checkAccount(venice({ slug: 'openai' }), []), { field: 'name', problem: 'reserved' });
  assert.deepEqual(checkAccount(venice({ slug: 'bad slug' }), []), { field: 'name', problem: 'reserved' });
  assert.deepEqual(checkAccount(venice(), [{ ...venice(), id: 'a-other000', name: 'Other' }]), { field: 'name', problem: 'taken' });
});

test('findAccount and firstAccount', () => {
  const list = [claude('a-aaaaaaaa', 'Perso'), openai({ id: 'a-bbbbbbbb' })];
  assert.equal(findAccount(list, ' work '), list[1]);
  assert.equal(findAccount(list, 'a-aaaaaaaa'), list[0]);
  assert.equal(findAccount(list, 'DEFAULT'), 'default');
  assert.equal(findAccount(list, 'nobody'), null);
  assert.equal(findAccount(list, ''), null);
  assert.equal(firstAccount(list, '', 'a-gone0000', 'a-bbbbbbbb'), 'a-bbbbbbbb');
  assert.equal(firstAccount(list, null, undefined), 'default');
  assert.equal(firstAccount(list, 'default', 'a-aaaaaaaa'), 'default');
});

test('hosts', () => {
  assert.ok(isLocalUrl('http://localhost:8080/v1'));
  assert.ok(isLocalUrl('http://127.0.0.1/v1'));
  assert.ok(!isLocalUrl('https://localhost.example.com/v1'));
  assert.ok(isOpenAIHost('https://api.openai.com/v1'));
  assert.ok(!isOpenAIHost('https://openrouter.ai/api/v1'));
});

test('an Anthropic-compatible account needs an address, not a model; a model, once named, pins its sessions', () => {
  const deepseek = normalizeAccount({ kind: 'anthropic-compatible', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic/' });
  assert.equal(deepseek.baseUrl, 'https://api.deepseek.com/anthropic');
  assert.equal(checkAccount(deepseek, []), null);
  assert.deepEqual(checkAccount({ ...deepseek, baseUrl: '' }, []), { field: 'baseUrl', problem: 'format' });
  assert.deepEqual(checkAccount({ ...deepseek, model: '-bad' }, []), { field: 'model', problem: 'format' });
  assert.equal(pinsModel(deepseek), false, 'Claude’s names go out, the server maps them');
  assert.equal(pinsModel({ ...deepseek, model: 'deepseek-v4-pro' }), true);
  assert.equal(pinsModel(openai({ model: 'gpt-5' })), true);
  assert.equal(pinsModel(claude('', 'x')), false);
  assert.equal(hasServer('codex'), false);
  assert.equal(hasServer('anthropic-compatible'), true);
});

test('the presets are valid accounts of their own kind, with distinct ids', () => {
  assert.equal(new Set(PRESETS.map((p) => p.id)).size, PRESETS.length);
  for (const p of PRESETS) {
    const a = normalizeAccount({ kind: p.kind, name: p.label, baseUrl: p.baseUrl, model: p.kind === 'openai' ? 'some-model' : p.model });
    assert.equal(checkAccount(a, []), null, p.id);
  }
});

test('"default" is the active Anthropic account, "own" the user’s own sign-in whichever is active', () => {
  assert.equal(canonAccount('default', ''), 'own');
  assert.equal(canonAccount('default', 'a-claude01'), 'a-claude01');
  assert.equal(canonAccount('own', 'a-claude01'), 'own');
  assert.equal(canonAccount('a-other001', 'a-claude01'), 'a-other001');
  assert.equal(isBuiltinAccount('own') && isBuiltinAccount('default') && !isBuiltinAccount('a-claude01'), true);
  assert.equal(isAccountRef('own') && isAccountRef('default') && isAccountRef('a-claude01') && !isAccountRef('mine'), true);
  assert.equal(findAccount([claude('a-claude01', 'Work')], 'Principal'), 'own');
  assert.equal(findAccount([claude('a-claude01', 'Work')], 'work')?.valueOf() === 'own', false);
  assert.equal(firstAccount([claude('a-claude01', 'Work')], 'own', 'default'), 'own');
  assert.deepEqual(checkAccount(claude('', 'Own'), []), { field: 'name', problem: 'reserved' });
});
