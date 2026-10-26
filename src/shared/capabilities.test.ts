import assert from 'node:assert/strict';
import { test } from 'node:test';

import { capabilitiesText, draftError, draftJson, maskArgs, maskTarget, maskUrl, mcpReach, parseMcpGet, parseMcpList, type Capabilities, type McpDraft, type McpEntry } from './capabilities';

const draft = (over: Partial<McpDraft> = {}): McpDraft => ({
  name: 'my-server',
  scope: 'user',
  project: '',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'pkg'],
  url: '',
  env: {},
  headers: {},
  ...over,
});

test('parseMcpList reads plugin names, claude.ai names, dashes in targets and transport suffixes', () => {
  const out = [
    'Checking MCP server health…',
    '',
    'plugin:context7:context7: npx -y @upstash/context7-mcp - ✓ Connected',
    'claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ! Needs authentication',
    'tool: node a - b.js - ✗ Failed to connect',
    'hub: https://example.com/mcp (HTTP) - ⏸ Pending approval',
  ].join('\r\n');
  assert.deepEqual(parseMcpList(out), [
    { name: 'plugin:context7:context7', target: 'npx -y @upstash/context7-mcp', state: 'connected' },
    { name: 'claude.ai Google Drive', target: 'https://drivemcp.googleapis.com/mcp/v1', state: 'needs-auth' },
    { name: 'tool', target: 'node a - b.js', state: 'failed' },
    { name: 'hub', target: 'https://example.com/mcp', state: 'pending' },
  ]);
});

test('parseMcpGet reads the Status line', () => {
  assert.equal(parseMcpGet('x:\n  Scope: Project\n  Status: ✓ Connected\n  Type: stdio'), 'connected');
  assert.equal(parseMcpGet('no status here'), 'unknown');
});

test('maskUrl hides credentials, secret query values and token-like path parts', () => {
  assert.equal(maskUrl('https://u:p@host.com/mcp'), 'https://•••@host.com/mcp');
  assert.equal(maskUrl('https://host.com/mcp?api_key=abc&mode=x'), 'https://host.com/mcp?api_key=•••&mode=x');
  assert.equal(maskUrl('https://host.com/s/8f3a9c2e7b1d4f6a9e0c3b5d7a1f2e4c/mcp'), 'https://host.com/s/•••/mcp');
  assert.equal(maskUrl('https://mcp.notion.com/mcp'), 'https://mcp.notion.com/mcp');
});

test('maskArgs hides secret flags, KEY=value pairs and tokens, and keeps the rest', () => {
  assert.deepEqual(maskArgs(['-y', 'pkg', '--api-key', 'abc', 'TOKEN=xyz', 'MODE=dev', 'ghp_abcdef123456', '--port', '3000']), [
    '-y',
    'pkg',
    '--api-key',
    '•••',
    'TOKEN=•••',
    'MODE=dev',
    '•••',
    '--port',
    '3000',
  ]);
});

test('maskArgs hides headers, bearer values and credentials of any URL; maskTarget masks a printed command line', () => {
  assert.deepEqual(maskArgs(['mcp-remote', 'https://x.com/mcp', '--header', 'X-Api: 123']), ['mcp-remote', 'https://x.com/mcp', '--header', '•••']);
  assert.deepEqual(maskArgs(['Authorization: Bearer abc']), ['•••']);
  assert.deepEqual(maskArgs(['postgresql://user:pass@db.host/app']), ['postgresql://•••@db.host/app']);
  assert.equal(maskTarget('npx -y server --token abc'), 'npx -y server --token •••');
  assert.equal(maskUrl('https://x.com/a%zz'), 'https://x.com/a%zz');
});

test('draftError checks the name, the repo, the command, the URL and the pairs', () => {
  assert.equal(draftError(draft(), []), '');
  assert.equal(draftError(draft({ name: '-rm' }), []), 'name');
  assert.equal(draftError(draft({ name: 'a b' }), []), 'name');
  assert.equal(draftError(draft({ scope: 'project', project: 'C:/x' }), ['C:/y']), 'project');
  assert.equal(draftError(draft({ scope: 'project', project: 'C:/y' }), ['C:/y']), '');
  assert.equal(draftError(draft({ command: ' ' }), []), 'command');
  assert.equal(draftError(draft({ env: { 'BAD-KEY': 'v' } }), []), 'env');
  assert.equal(draftError(draft({ transport: 'http', url: 'ftp://x' }), []), 'url');
  assert.equal(draftError(draft({ transport: 'http', url: 'https://x.com/mcp', headers: { 'X Bad': 'v' } }), []), 'headers');
  assert.equal(draftError(draft({ transport: 'http', url: 'https://x.com/mcp' }), []), '');
});

test('draftJson writes what claude mcp add-json takes', () => {
  assert.deepEqual(JSON.parse(draftJson(draft({ env: { A: '1' } }))), { type: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { A: '1' } });
  assert.deepEqual(JSON.parse(draftJson(draft({ transport: 'http', url: ' https://x.com/mcp ' }))), { type: 'http', url: 'https://x.com/mcp' });
});

test('mcpReach: off plugin nowhere, repo servers per repo, denied connectors master only', () => {
  assert.equal(mcpReach('plugin', 'plugin:a:b', false), 'nowhere');
  assert.equal(mcpReach('project', 'x', true), 'repo');
  assert.equal(mcpReach('claude.ai', 'claude.ai Notion', true), 'master-only');
  assert.equal(mcpReach('user', 'x', true), 'everywhere');
});

test('capabilitiesText lists what can be used and only counts what is off', () => {
  const base: McpEntry = { name: '', source: 'user', transport: 'stdio', target: '', project: '', plugin: '', state: 'connected', reach: 'everywhere' };
  const skill = { name: '', dir: '', description: '', source: 'user', project: '', plugin: '', reach: 'everywhere' } as const;
  const c: Capabilities = {
    mcp: [
      { ...base, name: 'hub-db' },
      { ...base, name: 'repo-db', source: 'project', project: 'C:/r/app', reach: 'repo' },
      { ...base, name: 'plugin:x:y', source: 'plugin', reach: 'nowhere' },
      { ...base, name: 'claude.ai Gmail', source: 'claude.ai', state: 'needs-auth', reach: 'master-only' },
      { ...base, name: 'broken', state: 'failed' },
    ],
    skills: [
      { ...skill, name: 'deploy', description: 'Deploy  the\nbackend' },
      { ...skill, name: 'old', source: 'disabled', reach: 'nowhere' },
    ],
    plugins: [],
    repos: [],
    checkedAt: Date.UTC(2026, 9, 26, 8, 30),
    checkError: '',
  };
  const text = capabilitiesText(c);
  assert.match(text, /state checked 2026-10-26 08:30 UTC/);
  assert.match(text, /- hub-db \[personal, connected\] master\+workers/);
  assert.match(text, /- repo-db \[project, connected\] sessions in C:\/r\/app only/);
  assert.match(text, /- claude.ai Gmail \[claude.ai, needs sign-in\] master only/);
  assert.match(text, /- deploy \[personal\] master\+workers: Deploy the backend/);
  assert.ok(text.indexOf('repo-db') < text.indexOf('Gmail') && text.indexOf('Gmail') < text.indexOf('broken'));
  assert.doesNotMatch(text, /plugin:x:y|old/);
  assert.match(text, /2 more installed but off/);
});
