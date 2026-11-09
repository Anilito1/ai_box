import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  allowedRepo,
  cleanLoginCode,
  fingerprintOf,
  isBranch,
  LAUNCHER_VERSION,
  leaseConflict,
  loginUrlOf,
  monthCost,
  OVH_HOURLY,
  parseRepos,
  parseStatus,
  parseTarget,
  pendingReports,
  isSecretValue,
  remoteClone,
  scopeOf,
  serverList,
  type Lease,
} from './vps';

test('only the repos the user listed may go on the server, never one of an owner they refused', () => {
  const allowed = ['octo/site', 'octo/shop', 'octo/bank', 'acme-corp/site'];
  const denied = ['acme-corp'];
  assert.equal(allowedRepo('github.com/octo/site', allowed, denied), 'octo/site');
  assert.equal(allowedRepo('git@github.com:OCTO/shop.git', allowed, denied), 'octo/shop');
  assert.equal(allowedRepo('https://github.com/octo/bank.git', allowed, denied), 'octo/bank');
  assert.equal(allowedRepo('github.com/acme-corp/crm', allowed, denied), null);
  // Refused owner wins over a listed repo.
  assert.equal(allowedRepo('github.com/acme-corp/site', allowed, denied), null);
  assert.equal(allowedRepo('github.com/octo/other', allowed, denied), null);
  assert.equal(allowedRepo('gitlab.com/octo/site', allowed, denied), null);
  assert.equal(allowedRepo('github.com.evil.io/octo/site', allowed, denied), null);
  assert.equal(allowedRepo('github.com/octo/site', []), null);
  assert.deepEqual(serverList([...allowed, 'octo/site', 'bad slug', '../x/y'], denied), ['octo/site', 'octo/shop', 'octo/bank']);
  // One clone per name on the server: the same name under another owner is left out, never mixed up.
  assert.deepEqual(serverList(['octo/app', 'other/APP'], []), ['octo/app']);
  assert.equal(remoteClone('octo/site'), '/home/aibox/repos/site');
  assert.equal(scopeOf('ACME-corp/x', ['acme-corp']), 'org');
  assert.equal(scopeOf('octo/x', ['acme-corp']), 'personal');
});

test('no list of repos in the code: the server reads root’s file, and the app and the launcher speak one version', () => {
  const launcher = readFileSync('scripts/vps/launch.mjs', 'utf8');
  const repos = readFileSync('scripts/vps/repos.sh', 'utf8');
  assert.equal(Number(/const VERSION = (\d+);/.exec(launcher)?.[1]), LAUNCHER_VERSION);
  assert.ok(launcher.includes("readFileSync('/etc/aibox/repos'"));
  assert.ok(repos.includes('grep -qxF -- "$slug" /etc/aibox/repos'));
});

test('tokens a remote worker gets: known names, one printable line, nothing a shell would read', () => {
  assert.ok(isSecretValue('github_pat_' + 'a'.repeat(40)));
  for (const bad of ['short', 'with space'.repeat(2), "quote'xxxxxxxx", 'dollar$xxxxxxx', 'line\nbreakxxxx']) assert.equal(isSecretValue(bad), false, bad);
});

test('a server is an address, an administrator and a port; nothing that a shell would read', () => {
  assert.deepEqual(parseTarget({ host: ' 51.75.1.2 ', admin: 'ubuntu', port: 22 }), { host: '51.75.1.2', admin: 'ubuntu', port: 22 });
  assert.deepEqual(parseTarget({ host: 'vps-1.example.net', admin: 'ubuntu', port: '2222' }), { host: 'vps-1.example.net', admin: 'ubuntu', port: 2222 });
  for (const bad of [
    { host: '1.2.3.4;id', admin: 'ubuntu' },
    { host: '-oProxyCommand=x', admin: 'ubuntu' },
    { host: '999.1.1.1', admin: 'ubuntu' },
    { host: '1.2.3.4', admin: 'root' },
    { host: '1.2.3.4', admin: 'aibox' },
    { host: '1.2.3.4', admin: 'ub untu' },
    { host: '1.2.3.4', admin: 'ubuntu', port: 0 },
  ])
    assert.equal(parseTarget(bad), null, JSON.stringify(bad));
});

test("the server's answers are read for what the hub needs only", () => {
  assert.equal(fingerprintOf('256 SHA256:F43S34UKv6Q72FdfoE4o+Bh28XiiozyLQlkh9vFLfJg 1.2.3.4 (ED25519)'), 'SHA256:F43S34UKv6Q72FdfoE4o+Bh28XiiozyLQlkh9vFLfJg');
  const tty = '\x1b[2K\x1b[1G Browser didn\'t open? Use the url below:\r\n\x1b]8;;https://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz\x07https://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz\x1b]8;;\x07\r\n Paste code here if prompted >';
  assert.equal(loginUrlOf(tty), 'https://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz');
  assert.equal(loginUrlOf('see https://evil.example/oauth/authorize'), '');
  assert.equal(cleanLoginCode('  AbC123-def_456#state789 '), 'AbC123-def_456#state789');
  assert.equal(cleanLoginCode('abc; rm -rf ~'), null);
  assert.equal(cleanLoginCode('short'), null);
  assert.deepEqual(parseRepos('fetch x: refused\nREPO octo/site ready\nREPO octo/shop refused\nREPO evil/x ready\n', ['octo/site', 'octo/shop']), [
    { slug: 'octo/site', ready: true },
    { slug: 'octo/shop', ready: false },
  ]);
  assert.deepEqual(parseStatus('{"version":2,"claude":"2.1.311 (Claude Code)","signedIn":true,"memory":{"total":7941,"available":7012},"running":1}'), {
    version: 2,
    claude: '2.1.311 (Claude Code)',
    signedIn: true,
    memory: { total: 7941, available: 7012 },
    running: 1,
  });
  assert.equal(parseStatus('not json'), null);
});

test('a branch is written from one side at a time, and by one worker on the server', () => {
  const held: Lease[] = [{ slug: 'octo/site', branch: 'ai-box/site', side: 'server', session: 'a', worker: 'site', since: 1 }];
  assert.equal(leaseConflict(held, { slug: 'OCTO/site', branch: 'ai-box/site', side: 'pc', session: 'b' })?.worker, 'site');
  assert.equal(leaseConflict(held, { slug: 'octo/site', branch: 'ai-box/site', side: 'server', session: 'b' })?.worker, 'site');
  assert.equal(leaseConflict(held, { slug: 'octo/site', branch: 'ai-box/site', side: 'server', session: 'a' }), null);
  assert.equal(leaseConflict(held, { slug: 'octo/site', branch: 'main', side: 'pc', session: 'b' }), null);
  // Two sessions of this PC in one checkout stay as they are today.
  const local: Lease[] = [{ ...held[0], side: 'pc' }];
  assert.equal(leaseConflict(local, { slug: 'octo/site', branch: 'ai-box/site', side: 'pc', session: 'b' }), null);
});

test('the reports a worker wrote while the hub was gone are found in its transcript, once each', () => {
  const lines = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__hub__message_master', input: { message: 'first report' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'delivered' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'work' }, { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'git push' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't3', name: 'mcp__hub__message_master', input: { message: 'done: pushed ai-box/site at abc123' } }] } },
  ];
  assert.deepEqual(pendingReports(lines), [{ id: 't3', text: 'done: pushed ai-box/site at abc123' }]);
  assert.deepEqual(pendingReports([{ type: 'summary' }, { message: { content: 'x' } }]), []);
});

test('branch names that git and the launcher take', () => {
  for (const ok of ['main', 'ai-box/site-serveur', 'feat/x.y_z']) assert.ok(isBranch(ok), ok);
  for (const bad of ['-x', 'a..b', 'a b', 'x.lock', 'x/', '/x', 'a//b', '']) assert.ok(!isBranch(bad), bad);
});

test('the month of a server switched on by the hour', () => {
  assert.equal(monthCost(0, OVH_HOURLY['d2-8']), 0.55);
  assert.equal(monthCost(60, OVH_HOURLY['d2-8']), 2.9);
  assert.equal(monthCost(730, OVH_HOURLY['d2-8']), 29.13);
});
