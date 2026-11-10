import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  allowedRepo,
  cloneMap,
  isAllowEntry,
  onServer,
  ownersOf,
  cleanLoginCode,
  fingerprintOf,
  isBranch,
  LAUNCHER_VERSION,
  leaseConflict,
  loginUrlOf,
  monthCost,
  OVH_HOURLY,
  parseRepos,
  parseRunner,
  parseStatus,
  callOf,
  accessOf,
  parseTarget,
  isPersonalGithubToken,
  isSecretValue,
  personalSecrets,
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


test('"owner/*" lists every repo of that owner, and a refused owner stays refused, even listed by name or by joker', () => {
  const allowed = ['octo/*', 'acme-corp/*', 'acme-corp/site', 'friend/lib'];
  const denied = ['ACME-corp'];
  assert.equal(allowedRepo('github.com/octo/site', allowed, denied), 'octo/site');
  // As the remote writes it: the server's spelling is set by cloneMap.
  assert.equal(allowedRepo('git@github.com:Octo/Shop.git', allowed, denied), 'Octo/Shop');
  assert.equal(allowedRepo('github.com/acme-corp/site', allowed, denied), null);
  assert.equal(allowedRepo('github.com/acme-corp/crm', allowed, denied), null);
  assert.equal(allowedRepo('github.com/friend/lib', allowed, denied), 'friend/lib');
  assert.equal(allowedRepo('github.com/friend/other', allowed, denied), null);
  // "octo/*" is no owner "octo-x", nor a repo named "*".
  assert.equal(allowedRepo('github.com/octo-x/site', allowed, denied), null);
  assert.equal(allowedRepo('github.com/octo/*', allowed, denied), null);
  assert.ok(isAllowEntry('octo/*') && isAllowEntry('octo/site'));
  assert.ok(!isAllowEntry('*/*') && !isAllowEntry('octo/si*') && !isAllowEntry('octo/**') && !isAllowEntry('*'));
  assert.deepEqual(ownersOf(allowed), ['octo', 'acme-corp']);
  // The joker takes what GitHub gives the token, of its owners only; denied wins; one clone per name.
  const available = ['octo/site', 'octo/shop', 'acme-corp/crm', 'friend/other', 'other/site', 'octo/lib'];
  assert.deepEqual(serverList(allowed, denied, available), ['friend/lib', 'octo/site', 'octo/shop']);
  assert.deepEqual(serverList(['octo/site'], [], available), ['octo/site']);
  // A whole owner refused while listed by joker: nothing of it.
  assert.deepEqual(serverList(['acme-corp/*'], ['acme-corp'], ['acme-corp/crm']), []);
});

test("each checkout of the PC goes to its repo's clone on the server, matched by its origin, not its folder", () => {
  const origins: Record<string, string> = {
    '/code/NFC': 'https://github.com/octo/NFC.git',
    '/code/liz-site': 'git@github.com:octo/bleps-site.git',
    '/code/bank': 'https://github.com/OCTO/compte-banque',
    '/code/crm': 'https://github.com/acme-corp/crm.git',
    '/code/notes': '',
    '/code/new': 'https://github.com/octo/not-cloned.git',
  };
  const map = cloneMap(Object.keys(origins), (d) => origins[d], ['octo/*', 'acme-corp/crm'], ['acme-corp'], ['octo/NFC', 'octo/bleps-site', 'octo/compte-banque', 'acme-corp/crm']);
  assert.deepEqual(map, {
    '/code/NFC': '/home/aibox/repos/NFC',
    '/code/liz-site': '/home/aibox/repos/bleps-site',
    '/code/bank': '/home/aibox/repos/compte-banque',
  });
  // A worker steps away only to a repo the server holds: listed by name, or cloned there under "owner/*".
  assert.ok(onServer('octo/NFC', ['octo/*'], map));
  assert.ok(onServer('friend/lib', ['octo/*', 'friend/lib'], map));
  assert.ok(!onServer('octo/not-cloned', ['octo/*'], map));
  // Spelt otherwise on this PC than on the server: refused here, not by the server after the worker pushed.
  assert.ok(!onServer('octo/nfc', ['octo/*'], map));
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

test("a personal repo's remote worker gets the user's fine-grained token from the keychain, or does not start", () => {
  const fine = 'github_pat_' + 'A1_'.repeat(20);
  const keychain = (v: Record<string, string>) => (name: string) => v[name] ?? '';
  assert.deepEqual(personalSecrets(keychain({ GH_TOKEN: fine, NPM_TOKEN: 'npm_' + 'x'.repeat(30) })), { GH_TOKEN: fine, NPM_TOKEN: 'npm_' + 'x'.repeat(30) });
  // Nothing in the keychain: refused, never a token found elsewhere on this PC.
  assert.equal(personalSecrets(keychain({})), 'token');
  // The PC's GitHub CLI token and a classic token reach every repo of the account, organisations included.
  for (const broad of ['gho_' + 'a'.repeat(36), 'ghp_' + 'a'.repeat(36)]) {
    assert.equal(isPersonalGithubToken(broad), false, broad);
    assert.equal(personalSecrets(keychain({ GH_TOKEN: broad })), 'token', broad);
  }
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
    runner: null,
  });
  assert.equal(parseStatus('not json'), null);
  // The runner's sessions: ids and counts only; a malformed one is left out, nothing of a conversation comes through.
  const id = '0f8e2c4a-1111-2222-3333-444455556666';
  const st = parseStatus(
    JSON.stringify({ version: 5, runner: { version: 1, max: 8, live: 1, rssMb: 54.4, sessions: [{ id, live: true, state: 'running', tasks: 1, waiting: 0, outbox: 2, attached: false, text: 'secret' }, { id: '../x', live: true }] } }),
  );
  assert.deepEqual(st?.runner, { version: 1, max: 8, live: 1, rssMb: 54, sessions: [{ id, live: true, state: 'running', tasks: 1, waiting: 0, outbox: 2, attached: false, interrupted: false }] });
  assert.equal(parseRunner({ version: 1, sessions: [{ id, interrupted: true }] })?.sessions[0].interrupted, true);
});

test('a message handed again after a cut is known by its tool call, and is not delivered twice', () => {
  const extra = { _meta: { 'claudecode/toolUseId': 'toolu_01abc', progressToken: 2 } };
  assert.deepEqual(callOf(extra, []), { id: 'toolu_01abc', again: false });
  assert.deepEqual(callOf(extra, ['toolu_01abc']), { id: 'toolu_01abc', again: true });
  // No id (another program, an older Claude Code): delivered as before.
  assert.deepEqual(callOf({}, ['toolu_01abc']), { id: '', again: false });
  assert.deepEqual(callOf({ _meta: { 'claudecode/toolUseId': 'x'.repeat(200) } }, []), { id: '', again: false });
});

test('one GitHub access per server: the user’s own, or one organisation’s', () => {
  assert.equal(accessOf('octo/site', ['acme-corp']), 'personal');
  assert.equal(accessOf('Acme-Corp/crm', ['acme-corp']), 'org:acme-corp');
  assert.notEqual(accessOf('acme-corp/crm', ['acme-corp']), accessOf('octo/site', ['acme-corp']));
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

test('branch names that git and the launcher take', () => {
  for (const ok of ['main', 'ai-box/site-serveur', 'feat/x.y_z']) assert.ok(isBranch(ok), ok);
  for (const bad of ['-x', 'a..b', 'a b', 'x.lock', 'x/', '/x', 'a//b', '']) assert.ok(!isBranch(bad), bad);
});

test('the month of a server switched on by the hour', () => {
  assert.equal(monthCost(0, OVH_HOURLY['d2-8']), 0.55);
  assert.equal(monthCost(60, OVH_HOURLY['d2-8']), 2.9);
  assert.equal(monthCost(730, OVH_HOURLY['d2-8']), 29.13);
});
