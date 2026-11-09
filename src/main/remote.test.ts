import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { applyPatch, loadConfig, prepareRole } from './config';
import { forwardedEnv, parseJsonl, parseRemote, remoteCwdOf, sshArgs } from './remote';

const server = { enabled: true, host: '203.0.113.7', user: 'aibox', port: 22, key: 'C:\\Users\\me\\.ssh\\aibox_worker', knownHosts: 'C:\\Users\\me\\.ssh\\aibox_known_hosts', repos: { 'C:\\repos\\site': '/home/aibox/repos/site' } };

test('remote workers are off unless the settings name a server and a key', () => {
  assert.equal(parseRemote(undefined).enabled, false);
  assert.equal(parseRemote({ ...server, key: '' }).enabled, false);
  assert.equal(parseRemote({ ...server, host: 'bad host; rm -rf /' }).enabled, false);
  assert.equal(parseRemote(server).enabled, true);
  assert.equal(parseRemote({ ...server, user: 'root;x' }).user, 'aibox');
  assert.equal(parseRemote({ ...server, port: 70000 }).port, 22);
});

test('settings a hand edit broke fall back to safe values: off, four workers, no phone, always-on power', () => {
  const r = parseRemote({ ...server, max: 99, ntfy: 'public', autoAway: 'yes', admin: 'root', power: { kind: 'ovh', project: '../x', instance: 'y' } });
  assert.deepEqual([r.max, r.ntfy, r.autoAway, r.admin, r.power.kind], [4, '', false, 'ubuntu', 'always']);
  // A clone outside the workers' repos folder is dropped.
  assert.deepEqual(parseRemote({ ...server, repos: { 'C:\\x': '/root/x', 'C:\\y': '/home/aibox/.ssh/x' } }).repos, {});
});

test("only the listed checkouts run on the server, in a clone given by an absolute path that stays where it is", () => {
  const r = parseRemote({ ...server, repos: { ...server.repos, 'C:\\repos\\up': '/home/aibox/repos/../.ssh', 'C:\\repos\\rel': 'repos/x', 'C:\\repos\\sh': '/home/aibox/repos/x;id' } });
  assert.deepEqual(Object.values(r.repos), ['/home/aibox/repos/site']);
  assert.equal(remoteCwdOf(r, 'C:\\repos\\site'), '/home/aibox/repos/site');
  if (process.platform === 'win32') assert.equal(remoteCwdOf(r, 'c:\\REPOS\\site\\'), '/home/aibox/repos/site');
  // An instance's worktree is another folder: it has no clone there.
  assert.equal(remoteCwdOf(r, 'C:\\repos\\site-hub-x'), null);
});

test("the server gets the SDK's own variables, never this PC's paths, keys or account", () => {
  const env = forwardedEnv({
    CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
    CLAUDE_AGENT_SDK_VERSION: '0.3.308',
    CLAUDE_CODE_OAUTH_TOKEN: 'secret',
    CLAUDE_CONFIG_DIR: 'C:\\Users\\me\\.claude',
    CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bin\\bash.exe',
    ANTHROPIC_API_KEY: 'secret',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:5000',
    PATH: 'C:\\Windows',
    GITHUB_TOKEN: 'secret',
    CLAUDE_CODE_EMPTY: undefined,
  });
  assert.deepEqual(env, { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_VERSION: '0.3.308' });
});

test('ssh never asks, never trusts an unknown server and notices a dead connection', () => {
  const args = sshArgs(parseRemote(server));
  assert.ok(args.includes(`UserKnownHostsFile=${server.knownHosts}`));
  // None of the user's ~/.ssh/config, no agent, no forwarding.
  assert.deepEqual(args.slice(args.indexOf('-F'), args.indexOf('-F') + 2), ['-F', 'none']);
  for (const o of ['ForwardAgent=no', 'ClearAllForwardings=yes', 'PermitLocalCommand=no']) assert.ok(args.includes(o), o);
  const opts = args.filter((_, i) => args[i - 1] === '-o');
  for (const o of ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'IdentitiesOnly=yes', 'ServerAliveInterval=15']) assert.ok(opts.includes(o), o);
  assert.equal(args.at(-1), 'aibox@203.0.113.7');
  assert.equal(args[args.indexOf('-i') + 1], server.key);
});

test('a transcript keeps its whole lines and drops a line cut by a write in progress', () => {
  const text = '{"type":"user","uuid":"a"}\n\n{"type":"assistant","uuid":"b"}\n{"type":"assis';
  assert.deepEqual(parseJsonl(text).map((e) => e.uuid), ['a', 'b']);
});

test('the remote server is set in config.json only: a patch of the renderer cannot point it elsewhere', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-remote-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ version: 2, remoteWorkers: server }));
  const cfg = loadConfig(dir, 'fr');
  assert.equal(cfg.remoteWorkers.enabled, true);
  assert.equal(applyPatch(cfg, { remoteWorkers: { ...server, host: '198.51.100.1' } } as never), null);
  assert.equal(cfg.remoteWorkers.host, '203.0.113.7');
});

test('a post that drives a program of this PC cannot be saved as remote, any other can', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-place-'));
  const unity = join(dir, 'unity');
  const site = join(dir, 'site');
  mkdirSync(unity);
  mkdirSync(site);
  writeFileSync(join(unity, '.mcp.json'), JSON.stringify({ mcpServers: { unityMCP: { command: 'uvx', args: ['mcp-for-unity'] } } }));
  const cfg = loadConfig(mkdtempSync(join(tmpdir(), 'hub-cfg-')), 'fr');
  const role = (name: string, folder: string, placement: string) => ({ name, description: 'x', instructions: '', folders: [folder], placement });
  assert.deepEqual(prepareRole(cfg, role('jeux', unity, 'remote')), { error: { field: 'placement', problem: 'localTool' } });
  assert.deepEqual(prepareRole(cfg, role('blender-3d', site, 'remote')), { error: { field: 'placement', problem: 'localTool' } });
  const ok = prepareRole(cfg, role('site', site, 'remote'));
  assert.ok('role' in ok && ok.role.placement === 'remote' && ok.role.folders[0] === resolve(site));
  // Auto is the default (it moves only when the user steps away, unless it drives a program of this PC), always allowed.
  const plain = prepareRole(cfg, { name: 'jeux', description: 'x', instructions: '', folders: [unity] });
  assert.ok('role' in plain && plain.role.placement === 'auto');
  const here = prepareRole(cfg, role('jeux', unity, 'local'));
  assert.ok('role' in here && here.role.placement === 'local');
});
