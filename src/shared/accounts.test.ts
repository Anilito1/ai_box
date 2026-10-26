import assert from 'node:assert/strict';
import { test } from 'node:test';

const { checkAccount, findAccount, firstAccount, hasServer, isLocalUrl, isOpenAIHost, normalizeAccount, OPENAI_URL, pinsModel } = await import('./accounts');
const { PRESETS } = await import('./presets');
type Account = import('./types').Account;

const claude = (id: string, name: string): Account => ({ id, kind: 'claude', name, baseUrl: '', model: '', smallModel: '', isolated: false });
const openai = (over: Partial<Account> = {}): Account => ({ id: '', kind: 'openai', name: 'Work', baseUrl: OPENAI_URL, model: 'gpt-5', smallModel: '', isolated: false, ...over });

test('normalizeAccount: trims, defaults the OpenAI server, drops the OpenAI fields of other kinds', () => {
  assert.deepEqual(normalizeAccount({ kind: 'openai', name: '  My   work ', baseUrl: 'http://localhost:8080/v1/', model: ' gpt-5 ' }), {
    id: '',
    kind: 'openai',
    name: 'My work',
    baseUrl: 'http://localhost:8080/v1',
    model: 'gpt-5',
    smallModel: '',
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
