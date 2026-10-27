import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// The user's own Claude Code folder, faked: nothing here touches the real ~/.claude.
const root = mkdtempSync(join(tmpdir(), 'hub-accounts-'));
const base = join(root, 'claude');
const data = join(root, 'hub');
mkdirSync(join(base, 'projects', '-repo'), { recursive: true });
writeFileSync(join(base, 'projects', '-repo', 'conv.jsonl'), '{"a":1}\n');
writeFileSync(join(base, 'settings.json'), '{}');
writeFileSync(join(base, 'CLAUDE.md'), '# mine');
mkdirSync(join(base, 'skills'));
process.env.CLAUDE_CONFIG_DIR = base;
after(() => rmSync(root, { recursive: true, force: true }));

const { accountDir, accountEnv, checkAnthropicCompatible, checkCustom, prepareClaudeDir, prepareCodexDir, prepareGeminiDir, removeClaudeDir, removeCodexDir, removeGeminiDir, testChat } = await import('./accounts');
const { createServer } = await import('node:http');
type Account = import('../shared/types').Account;
const claude: Account = { id: 'a-claude01', kind: 'claude', name: 'Work', baseUrl: '', model: '', smallModel: '', slug: '', models: [], isolated: false };

test('a Claude account folder shares everything but its sign-in', () => {
  const dir = accountDir(data, claude.id);
  prepareClaudeDir(dir);
  for (const name of ['projects', 'settings.json', 'CLAUDE.md', 'skills']) assert.ok(lstatSync(join(dir, name)).isSymbolicLink(), name);
  assert.ok(!existsSync(join(dir, 'agents')), 'nothing to link: not made up');
  assert.equal(readFileSync(join(dir, 'projects', '-repo', 'conv.jsonl'), 'utf8'), '{"a":1}\n');
  // Again: what is there stays, nothing fails.
  prepareClaudeDir(dir);
});

test('removing it leaves the shared things where they are', () => {
  const dir = accountDir(data, claude.id);
  prepareClaudeDir(dir);
  writeFileSync(join(dir, '.claude.json'), '{}');
  removeClaudeDir(data, claude.id);
  assert.ok(!existsSync(dir));
  assert.equal(readFileSync(join(base, 'projects', '-repo', 'conv.jsonl'), 'utf8'), '{"a":1}\n');
  assert.ok(existsSync(join(base, 'settings.json')));
  assert.ok(existsSync(join(base, 'CLAUDE.md')));
  assert.ok(existsSync(join(base, 'skills')));
});

test('accountDir only takes an account id', () => {
  assert.throws(() => accountDir(data, '../../etc'));
  assert.throws(() => accountDir(data, 'default'));
});

test('accountEnv: each kind gets its own access, the user’s own switches removed', () => {
  const ctx = { dataDir: data, key: 'k-123', bridge: { url: 'http://127.0.0.1:9/a-x', token: 'tok' } };
  const c = accountEnv(claude, ctx);
  assert.equal(c.set.CLAUDE_CONFIG_DIR, accountDir(data, claude.id));
  assert.ok(c.unset.includes('ANTHROPIC_API_KEY') && c.unset.includes('ANTHROPIC_BASE_URL'));
  const k = accountEnv({ ...claude, id: 'a-key00001', kind: 'anthropic-key' }, ctx);
  assert.deepEqual(k.set, { ANTHROPIC_API_KEY: 'k-123' });
  const o = accountEnv({ ...claude, id: 'a-oai00001', kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', smallModel: '', isolated: false }, ctx);
  assert.equal(o.set.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9/a-x');
  assert.equal(o.set.ANTHROPIC_AUTH_TOKEN, 'tok', 'the bridge token, never the OpenAI key');
  assert.ok(!Object.values(o.set).includes('k-123'));
  assert.equal(o.set.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'gpt-5');
  assert.equal(o.set.ANTHROPIC_DEFAULT_OPUS_MODEL, 'gpt-5');
  assert.equal(o.set.ANTHROPIC_MODEL, 'gpt-5');
  removeClaudeDir(data, claude.id);
});

test('accountEnv: an Anthropic-compatible server is reached by Claude Code itself; no model named leaves Claude’s names to the server', () => {
  const ctx = { dataDir: data, key: 'k-123', bridge: { url: 'http://127.0.0.1:9/a-x', token: 'tok' } };
  const deepseek: Account = { ...claude, id: 'a-ds000001', kind: 'anthropic-compatible', baseUrl: 'https://api.deepseek.com/anthropic' };
  const open = accountEnv(deepseek, ctx);
  assert.deepEqual(open.set, { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_API_KEY: 'k-123' });
  assert.ok(open.unset.includes('ANTHROPIC_MODEL') && open.unset.includes('ANTHROPIC_AUTH_TOKEN'), 'the user’s own switches are removed');
  const named = accountEnv({ ...deepseek, model: 'deepseek-v4-pro', smallModel: 'deepseek-flash' }, ctx);
  assert.equal(named.set.ANTHROPIC_MODEL, 'deepseek-v4-pro');
  assert.equal(named.set.ANTHROPIC_DEFAULT_OPUS_MODEL, 'deepseek-v4-pro');
  assert.equal(named.set.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'deepseek-flash');
  assert.equal(accountEnv(deepseek, { ...ctx, key: '' }).set.ANTHROPIC_API_KEY, undefined);
});

test('accountEnv: a Codex account has the user’s own Codex, or a folder of its own; an API key in the environment is dropped', () => {
  const ctx = { dataDir: data, key: '', bridge: { url: '', token: '' } };
  const own: Account = { ...claude, id: 'a-cdx00001', kind: 'codex', isolated: true };
  const e = accountEnv(own, ctx);
  assert.equal(e.set.CODEX_HOME, accountDir(data, own.id));
  assert.ok(e.unset.includes('OPENAI_API_KEY') && e.unset.includes('CODEX_API_KEY'));
  assert.ok(existsSync(join(accountDir(data, own.id), 'config.toml')));
  assert.deepEqual(accountEnv({ ...own, isolated: false }, ctx).set, {});
  prepareCodexDir(accountDir(data, own.id));
  removeCodexDir(data, own.id);
  assert.ok(!existsSync(accountDir(data, own.id)));
});

test('checkAnthropicCompatible: a refused key is refused; a server without a model list is accepted, unchecked', async () => {
  let status = 200;
  const seen: Record<string, string | string[] | undefined> = {};
  const server = createServer((req, res) => {
    Object.assign(seen, req.headers);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'b-model' }, { id: 'a-model' }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };
  try {
    const url = `http://127.0.0.1:${port}/anthropic`;
    assert.deepEqual(await checkAnthropicCompatible(url, 'k'), { ready: true, detail: '', error: '', models: ['a-model', 'b-model'] });
    assert.equal(seen['x-api-key'], 'k');
    assert.equal(seen['anthropic-version'], '2023-06-01');
    status = 401;
    assert.equal((await checkAnthropicCompatible(url, 'k')).error, 'unauthorized');
    status = 404;
    assert.deepEqual(await checkAnthropicCompatible(url, 'k'), { ready: true, detail: 'unchecked', error: '', models: [] });
    // No key: only a server on this computer may go without.
    assert.equal((await checkAnthropicCompatible('https://example.invalid/anthropic', '')).error, 'no-key');
  } finally {
    server.close();
  }
});

test('a provider the user added: checked with its list, tested with a short chat call, its key masked out of any error', async () => {
  const KEY = 'fake-test-key-0123456789';
  const asked: { path: string; auth: string; body: Record<string, unknown> }[] = [];
  let answer: (body: Record<string, unknown>) => { status: number; body: unknown } = () => ({ status: 200, body: { data: [{ id: 'venice-uncensored' }] } });
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      asked.push({ path: req.url ?? '', auth: String(req.headers.authorization ?? ''), body });
      const a = answer(body);
      res.writeHead(a.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(a.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };
  const url = `http://127.0.0.1:${port}/api/v1`;
  try {
    assert.deepEqual(await checkCustom(url, KEY), { ready: true, detail: '', error: '', models: ['venice-uncensored'] });
    assert.deepEqual(asked[0], { path: '/api/v1/models', auth: `Bearer ${KEY}`, body: {} });
    answer = () => ({ status: 404, body: {} });
    assert.deepEqual(await checkCustom(url, KEY), { ready: true, detail: 'unchecked', error: '', models: [] }, 'no list: accepted, unchecked');
    answer = () => ({ status: 401, body: { error: { message: 'bad key' } } });
    assert.equal((await checkCustom(url, KEY)).error, 'unauthorized');

    // The test: a server that refuses max_tokens is asked again the way it wants, like the bridge does.
    asked.length = 0;
    answer = (body) =>
      'max_tokens' in body
        ? { status: 400, body: { error: { message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead." } } }
        : { status: 200, body: { choices: [{ message: { content: '  OK \n' } }] } };
    assert.deepEqual(await testChat(url, KEY, 'venice-uncensored'), { ok: true, error: '', detail: 'OK' });
    assert.deepEqual(asked.map((a) => a.path), ['/api/v1/chat/completions', '/api/v1/chat/completions']);
    assert.equal(asked[1].body.model, 'venice-uncensored');
    assert.equal(asked[1].body.max_completion_tokens, 64);
    answer = () => ({ status: 401, body: { error: { message: `Invalid key ${KEY}` } } });
    const refused = await testChat(url, KEY, 'venice-uncensored');
    assert.deepEqual([refused.ok, refused.error], [false, 'unauthorized']);
    assert.ok(!refused.detail.includes(KEY) && refused.detail.includes('Invalid key'), 'the key never comes back in the words shown');
    answer = () => ({ status: 200, body: 'not a chat' });
    assert.equal((await testChat(url, KEY, 'x')).error, 'not-chat', 'a 200 that is no chat answer');
    assert.equal((await testChat('http://127.0.0.1:1/v1', KEY, 'x')).error, 'network');
  } finally {
    server.close();
  }
});

test('accountEnv: a Gemini account has a folder of its own for the CLI; the key only for a key account, the user’s own variables dropped', () => {
  const ctx = { dataDir: data, key: 'AIza-key', bridge: { url: '', token: '' } };
  const google: Account = { ...claude, id: 'a-gem00001', kind: 'gemini', isolated: true };
  const g = accountEnv(google, ctx);
  assert.equal(g.set.GEMINI_CLI_HOME, accountDir(data, google.id));
  assert.equal(g.set.GEMINI_API_KEY, undefined, 'a Google sign-in never carries a key');
  assert.ok(g.unset.includes('GEMINI_API_KEY') && g.unset.includes('GOOGLE_GENAI_USE_VERTEXAI'));
  assert.ok(existsSync(join(accountDir(data, google.id), '.gemini')));
  const k = accountEnv({ ...google, id: 'a-gem00002', kind: 'gemini-key' }, ctx);
  assert.equal(k.set.GEMINI_API_KEY, 'AIza-key');
  assert.equal(k.set.GEMINI_CLI_HOME, accountDir(data, 'a-gem00002'));
  assert.equal(accountEnv({ ...google, id: 'a-gem00002', kind: 'gemini-key' }, { ...ctx, key: '' }).set.GEMINI_API_KEY, undefined);
  prepareGeminiDir(accountDir(data, google.id));
  removeGeminiDir(data, google.id);
  removeGeminiDir(data, 'a-gem00002');
  assert.ok(!existsSync(accountDir(data, google.id)));
});
