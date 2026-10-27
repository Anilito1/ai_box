import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionView } from '../shared/types';
import {
  backupBranch,
  cherryEquivalents,
  normalizeRemote,
  decide,
  npmCliCandidates,
  ownCommits,
  parseFull,
  parseJob,
  parseResult,
  parseStatus,
  readyToInstall,
  redact,
  repositoryOf,
  retryable,
  sessionsAtWork,
  sessionsQuiet,
  QUIET_MS,
  AWAY_MS,
  type CommitInfo,
  type Facts,
  type Moment,
} from './updateLogic';

const OFFICIAL = 'github.com/anilito1/ai_box';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

test('normalizeRemote: one repository however it is written', () => {
  for (const url of [
    'https://github.com/Anilito1/claude-hub.git',
    'https://github.com/Anilito1/claude-hub',
    'https://github.com/Anilito1/claude-hub/',
    'https://x-access-token:secret@github.com/Anilito1/claude-hub.git',
    'git@github.com:Anilito1/claude-hub.git',
    'ssh://git@github.com/Anilito1/claude-hub.git',
    'ssh://git@github.com:22/Anilito1/claude-hub',
    'git+https://github.com/Anilito1/claude-hub.git',
    'github:Anilito1/claude-hub',
    'Anilito1/claude-hub',
    'https://github.com/Anilito1/ai_box.git',
    'git@github.com:Anilito1/ai_box.git',
    '  https://GITHUB.com/anilito1/CLAUDE-hub.git  ',
  ]) {
    assert.equal(normalizeRemote(url), OFFICIAL, url);
  }
});

test('normalizeRemote: other repositories and non-URLs differ', () => {
  assert.equal(normalizeRemote('https://github.com/someone/claude-hub.git'), 'github.com/someone/claude-hub');
  assert.equal(normalizeRemote('https://gitlab.com/Anilito1/claude-hub.git'), 'gitlab.com/anilito1/claude-hub');
  assert.equal(normalizeRemote(''), '');
  assert.equal(normalizeRemote('not a url'), '');
  assert.equal(normalizeRemote('https://github.com/a/../b'), '');
  assert.equal(normalizeRemote('relative/path/../x'), '');
});

test('normalizeRemote: a local repository (tests, a mirror) by its path', () => {
  const local = process.platform === 'win32' ? 'C:\\tmp\\origin.git' : '/tmp/origin.git';
  const file = process.platform === 'win32' ? 'file:///C:/tmp/origin.git' : 'file:///tmp/origin.git';
  assert.ok(normalizeRemote(local).startsWith('file:'));
  assert.equal(normalizeRemote(local), normalizeRemote(file));
  assert.notEqual(normalizeRemote(local), OFFICIAL);
});

test('repositoryOf: the package.json field, as npm writes it', () => {
  assert.equal(repositoryOf({ repository: { type: 'git', url: 'https://github.com/Anilito1/claude-hub.git' } }), OFFICIAL);
  assert.equal(repositoryOf({ repository: 'github:Anilito1/claude-hub' }), OFFICIAL);
  assert.equal(repositoryOf({}), '');
  assert.equal(repositoryOf(null), '');
  assert.equal(repositoryOf({ repository: { url: 42 } }), '');
});

const facts = (over: Partial<Facts>): Facts => ({
  official: true,
  branch: 'main',
  head: A,
  target: B,
  dirty: [],
  behind: 3,
  ahead: 0,
  realignSafe: false,
  ...over,
});

test('decide: up to date, ahead, behind', () => {
  assert.deepEqual(decide(facts({ head: B })), { kind: 'current', block: null });
  // The user's own dev folder: unpushed commits, nothing new upstream. Neutral.
  assert.deepEqual(decide(facts({ behind: 0, ahead: 2 })), { kind: 'ahead', block: null });
  assert.deepEqual(decide(facts({})), { kind: 'available', block: null });
});

test('decide: never over local work', () => {
  assert.deepEqual(decide(facts({ dirty: ['README.md'] })), { kind: 'blocked', block: 'changes' });
  assert.deepEqual(decide(facts({ branch: 'feature' })), { kind: 'blocked', block: 'branch' });
  assert.deepEqual(decide(facts({ branch: '' })), { kind: 'blocked', block: 'branch' });
  assert.deepEqual(decide(facts({ ahead: 1 })), { kind: 'blocked', block: 'commits' });
  // Modifications win over a realignment.
  assert.deepEqual(decide(facts({ ahead: 1, realignSafe: true, dirty: ['x'] })), { kind: 'blocked', block: 'changes' });
});

test('decide: a rewritten official history with nothing of the user’s own', () => {
  assert.deepEqual(decide(facts({ ahead: 12, behind: 39, realignSafe: true })), { kind: 'realign', block: null });
});

test('decide: a fork or a changed remote, and nothing fetched', () => {
  assert.deepEqual(decide(facts({ official: false })), { kind: 'unofficial', block: null });
  assert.deepEqual(decide(facts({ target: '' })), { kind: 'none', block: null });
});

test('parseStatus: paths of porcelain -z, renames included', () => {
  assert.deepEqual(parseStatus(''), []);
  assert.deepEqual(parseStatus(' M src/a.ts\0?? notes.txt\0R  new.ts\0old.ts\0 D gone.ts\0'), ['src/a.ts', 'notes.txt', 'new.ts', 'gone.ts']);
});

test('parseFull', () => {
  const full = parseFull(`${A}\x1f${B}\x1fAna\x1fana@x\x1f1700000000 +0100\x1fSubject\x1e\n`);
  assert.deepEqual(full, [{ sha: A, tree: B, author: 'Ana', email: 'ana@x', date: '1700000000 +0100', subject: 'Subject' }]);
});

test('cherryEquivalents: the "-" lines only', () => {
  assert.deepEqual([...cherryEquivalents(`- ${A}\n+ ${B}\n`)], [A]);
});

const commit = (sha: string, over: Partial<CommitInfo> = {}): CommitInfo => ({
  sha,
  tree: `t${sha}`.slice(0, 40),
  author: 'Ana',
  email: 'ana@example.com',
  date: '1700000000 +0100',
  subject: `commit ${sha.slice(0, 3)}`,
  ...over,
});

test('ownCommits: the same files as an official commit hold nothing of their own', () => {
  const local = [commit('1'.repeat(40), { tree: 'T' })];
  assert.deepEqual(ownCommits(local, [commit('9'.repeat(40), { tree: 'T' })], new Set(), 'T'), []);
});

test('ownCommits: a change already upstream (git cherry) is not the user’s own', () => {
  const c = commit('1'.repeat(40));
  assert.deepEqual(ownCommits([c], [commit('9'.repeat(40), { subject: 'other' })], new Set([c.sha]), 'HEADTREE'), []);
});

test('ownCommits: a rewritten copy (same author, date, subject) is not the user’s own', () => {
  const old = commit('1'.repeat(40), { tree: 'old' });
  const rewritten = commit('9'.repeat(40), { tree: 'new', subject: old.subject });
  assert.deepEqual(ownCommits([old], [rewritten], new Set(), 'old'), []);
});

test('ownCommits: a commit of the user’s own is found', () => {
  const mine = commit('2'.repeat(40), { subject: 'my local fix', date: '1800000000 +0200' });
  const upstream = [commit('9'.repeat(40), { subject: 'commit 111' })];
  assert.deepEqual(ownCommits([commit('1'.repeat(40)), mine], upstream, new Set(), 'mine'), [mine]);
  // Same subject, another date: still the user's own.
  const again = commit('3'.repeat(40), { subject: 'commit 111', date: '1700000001 +0100' });
  assert.deepEqual(ownCommits([again], upstream, new Set(), 'x'), [again]);
});

test('backupBranch: dated, a valid branch name', () => {
  assert.equal(backupBranch(new Date(2026, 9, 26, 9, 5)), 'backup/pre-update-2026-10-26-0905');
});

test('redact: credentials and keys never kept', () => {
  const raw = [
    'fatal: unable to access https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/a/b.git',
    'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
    'key sk-ant-api03-abcdefghijklmnop',
    '//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789',
    'Authorization: Bearer abcdef0123456789',
  ].join('\n');
  const out = redact(raw);
  for (const secret of ['ghp_abc', 'github_pat_11', 'sk-ant-api03', 'npm_abcdef', 'abcdef0123456789', 'x-access-token:']) assert.ok(!out.includes(secret), secret);
  assert.ok(out.includes('https://github.com/a/b.git'));
});

const session = (over: Partial<SessionView>): SessionView =>
  ({ status: 'idle', background: [], agents: 0, compacting: false, retrying: false, tree: null, ...over }) as SessionView;

test('sessionsQuiet: any work under way keeps the hub awake', () => {
  assert.equal(sessionsQuiet([]), true);
  assert.equal(sessionsQuiet([session({}), session({ status: 'exited' })]), true);
  for (const busy of [
    session({ status: 'busy' }),
    session({ status: 'attention' }),
    session({ status: 'starting' }),
    session({ background: ['npm test'] }),
    session({ agents: 1 }),
    session({ compacting: true }),
    session({ retrying: true }),
    session({ tree: { branch: 'b', state: 'active', kept: [], install: 'running' } }),
  ]) {
    assert.equal(sessionsQuiet([session({}), busy]), false, JSON.stringify(busy));
    assert.equal(sessionsAtWork([session({}), busy, busy]), 2);
  }
  assert.equal(sessionsAtWork([session({}), session({ status: 'exited' })]), 0);
});

const moment = (over: Partial<Moment>): Moment => ({
  mode: 'auto',
  kind: 'available',
  quietFor: QUIET_MS,
  awayFor: AWAY_MS,
  waiting: false,
  postponed: false,
  ...over,
});

test('readyToInstall: unattended only in auto, quiet for a while, the user away', () => {
  assert.equal(readyToInstall(moment({})), true);
  assert.equal(readyToInstall(moment({ quietFor: null })), false);
  assert.equal(readyToInstall(moment({ quietFor: QUIET_MS - 1 })), false);
  assert.equal(readyToInstall(moment({ awayFor: AWAY_MS - 1 })), false);
  assert.equal(readyToInstall(moment({ postponed: true })), false);
  assert.equal(readyToInstall(moment({ mode: 'ask' })), false);
  assert.equal(readyToInstall(moment({ mode: 'next-start' })), false);
  assert.equal(readyToInstall(moment({ kind: 'blocked' })), false);
  assert.equal(readyToInstall(moment({ kind: 'realign' })), false);
});

test('readyToInstall: asked by the user, as soon as the sessions are quiet', () => {
  assert.equal(readyToInstall(moment({ mode: 'ask', waiting: true, quietFor: 0, awayFor: 0, postponed: true })), true);
  assert.equal(readyToInstall(moment({ mode: 'ask', waiting: true, quietFor: null })), false);
});

const root = process.platform === 'win32' ? 'C:\\hub' : '/hub';
const job = (over: Record<string, unknown> = {}) => ({
  root,
  remote: OFFICIAL,
  appPid: 1234,
  from: A,
  to: B,
  mode: 'ff',
  backup: '',
  lockChanged: false,
  relaunch: { exe: root, args: ['.'], cwd: root },
  restart: true,
  npmCli: '',
  ...over,
});

test('parseJob: every field checked', () => {
  assert.ok(parseJob(job()));
  assert.ok(parseJob(job({ mode: 'realign', backup: 'backup/pre-update-2026-10-26-0905' })));
  assert.equal(parseJob(job({ mode: 'realign', backup: 'main' })), null);
  assert.equal(parseJob(job({ mode: 'realign', backup: 'backup/pre-update-x; rm -rf' })), null);
  assert.equal(parseJob(job({ from: 'HEAD~1' })), null);
  assert.equal(parseJob(job({ to: '--upload-pack=evil' })), null);
  assert.equal(parseJob(job({ root: 'relative' })), null);
  assert.equal(parseJob(job({ mode: 'push' })), null);
  assert.equal(parseJob(job({ relaunch: { exe: root, args: [1], cwd: root } })), null);
  assert.equal(parseJob(null), null);
});

test('parseResult: only a well-formed result', () => {
  const ok = { ok: false, step: 'build', at: 1, restored: true, detail: 'x', to: B };
  assert.deepEqual(parseResult(ok), ok);
  assert.equal(parseResult({ ...ok, step: 'deploy' }), null);
  assert.equal(parseResult({ ...ok, to: 'nope' }), null);
  assert.equal(parseResult('x'), null);
});

test('npmCliCandidates: as npm start ran it, then beside Node', () => {
  assert.deepEqual(npmCliCandidates('C:\\Program Files\\nodejs\\node.exe', 'win32', ''), ['C:\\Program Files\\nodejs/node_modules/npm/bin/npm-cli.js']);
  assert.deepEqual(npmCliCandidates('/usr/local/bin/node', 'darwin', '/opt/npm/bin/npm-cli.js'), ['/opt/npm/bin/npm-cli.js', '/usr/local/bin/../lib/node_modules/npm/bin/npm-cli.js']);
  // Another package manager ran `start`: not used for npm.
  assert.equal(npmCliCandidates('/usr/bin/node', 'linux', '/usr/lib/pnpm/pnpm.cjs').length, 1);
});

test('retryable: a file still held by a closing process', () => {
  assert.equal(retryable('npm error code EBUSY'), true);
  assert.equal(retryable('npm error code ERESOLVE'), false);
});
