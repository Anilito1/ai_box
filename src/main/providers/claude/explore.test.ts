import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXPLORE_MODEL, exploreOptions, explorePrompt, outlineFrom } from './explore';

const host = { cwd: 'C:/repo', dirs: ['C:/scratch'], executable: 'C:/claude.exe', env: { CLAUDE_CONFIG_DIR: 'C:/acct' } };

test('the explorer reads only, with the session settings files but none of its hooks, servers or saved conversation', async () => {
  const o = exploreOptions(host, { question: 'Where is the retry set?', paths: [], thorough: false }, new AbortController());
  assert.equal(o.model, EXPLORE_MODEL);
  assert.deepEqual(o.tools, ['Read', 'Grep', 'Glob']);
  // The same settings files as the session: its deny rules refuse the helper what they refuse the session.
  assert.deepEqual(o.settingSources, ['user', 'project', 'local']);
  assert.deepEqual(o.settings, { disableAllHooks: true });
  assert.deepEqual([o.mcpServers, o.strictMcpConfig, o.persistSession, o.permissionMode], [{}, true, false, 'default']);
  // The session's account, program and folders.
  assert.deepEqual([o.cwd, o.additionalDirectories, o.pathToClaudeCodeExecutable, o.env], ['C:/repo', ['C:/scratch'], 'C:/claude.exe', { CLAUDE_CONFIG_DIR: 'C:/acct' }]);
  // What would need a person (a read outside the folders) is refused.
  const asked = await o.canUseTool!('Read', { file_path: 'D:/secret.txt' }, { signal: new AbortController().signal } as never);
  assert.equal(asked?.behavior, 'deny');
  assert.equal(o.maxTurns, 16);
  assert.equal(exploreOptions(host, { question: 'q', paths: [], thorough: true }, new AbortController()).maxTurns, 22);
});

test('the question comes with the repo outline and the places to look first', () => {
  const outline = outlineFrom(['README.md', 'src/main/a.ts', 'src/main/b.ts', 'src/shared/c.ts', '']);
  assert.equal(outline, './ (1)\nsrc/main/ (2)\nsrc/shared/ (1)');
  const prompt = explorePrompt({ question: 'How is a turn resumed?', paths: ['src/main'], thorough: false }, outline);
  assert.match(prompt, /^Look first under: src\/main\n\nRepo outline/);
  assert.match(prompt, /Question:\nHow is a turn resumed\?$/);
  assert.equal(explorePrompt({ question: 'q?', paths: [], thorough: false }, ''), 'Question:\nq?');
});
