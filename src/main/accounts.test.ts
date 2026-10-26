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

const { accountDir, accountEnv, prepareClaudeDir, removeClaudeDir } = await import('./accounts');
type Account = import('../shared/types').Account;
const claude: Account = { id: 'a-claude01', kind: 'claude', name: 'Work', baseUrl: '', model: '', smallModel: '', isolated: false };

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
