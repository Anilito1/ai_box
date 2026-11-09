import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RemoteWorkers } from '../shared/types';
import { LAUNCHER_VERSION, type ServerStatus, type VpsState } from '../shared/vps';
import { parseRemote } from './remote';
import { newTopic, VpsWizard, type Exec, type Tty } from './vps';

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample';

/**
 * A fake server behind a fake ssh: it accepts the admin key once `keyPasted`, runs setup.sh (installs the launcher),
 * answers the launcher's status, signs Claude Code in when the code is typed, and clones the repos whose deploy key
 * was "pasted" in GitHub.
 */
function fakeServer() {
  const srv = { keyPasted: false, installed: false, signedIn: false, tokenRepos: new Set<string>(), setups: 0, commands: [] as string[], inputs: [] as string[] };
  const exec: Exec = async (cmd, args, o = {}) => {
    const tool = cmd.replace(/\\/g, '/').split('/').pop()?.replace(/\.exe$/, '');
    if (tool === 'ssh' && args[0] === '-V') return { code: 0, out: '', err: 'OpenSSH_9.5' };
    if (tool === 'ssh-keygen' && args.includes('-q')) {
      const file = args[args.indexOf('-f') + 1];
      writeFileSync(file, 'PRIVATE');
      writeFileSync(`${file}.pub`, `${KEY} ${args[args.indexOf('-C') + 1]}\n`);
      return { code: 0, out: '', err: '' };
    }
    if (tool === 'ssh-keygen' && args[0] === '-F') {
      const file = args[args.indexOf('-f') + 1];
      const line = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith(`${args[1]} `));
      return line ? { code: 0, out: `# Host found\n${line}\n`, err: '' } : { code: 1, out: '', err: '' };
    }
    if (tool === 'ssh-keygen' && args[0] === '-lf') return { code: 0, out: '256 SHA256:AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg host (ED25519)\n', err: '' };
    if (tool === 'ssh' && args.includes('StrictHostKeyChecking=accept-new')) {
      // The key exchange records the server's key in the scratch file, then the sign-in is refused (none offered).
      assert.ok(args.includes('PreferredAuthentications=none'));
      writeFileSync(args.find((a) => a.startsWith('UserKnownHostsFile='))?.slice('UserKnownHostsFile='.length) ?? '', `203.0.113.7 ${KEY}\n`);
      return { code: 255, out: '', err: 'Permission denied (publickey).' };
    }
    if (tool === 'icacls') return { code: 0, out: `${args[0]} PC\\me:(R)\n`, err: '' };
    if (tool === 'git') return { code: 0, out: args.includes('user.name') ? 'Me Myself\n' : 'me@example.com\n', err: '' };
    if (tool === 'ssh') {
      const command = args.at(-1) ?? '';
      srv.commands.push(command);
      assert.ok(args.includes('StrictHostKeyChecking=yes') && args.includes('BatchMode=yes'));
      if (!srv.keyPasted) return { code: 255, out: '', err: 'ubuntu@203.0.113.7: Permission denied (publickey).' };
      if (command.startsWith('sudo -n true')) return { code: 0, out: 'os=ubuntu 24.04\n', err: '' };
      // Staged in the administrator's own folder, never in a /tmp another account could have made first.
      if (command.startsWith('install -d -m 700 ~/aibox-setup && test -O ~/aibox-setup && cat >')) return { code: 0, out: '', err: '' };
      if (command.includes('bash ~/aibox-setup/setup.sh')) {
        assert.match(command, /^sudo ADMIN=ubuntu WORKER_KEY='ssh-ed25519 [A-Za-z0-9+/=]+ aibox-worker' bash/);
        srv.setups++;
        srv.installed = true;
        o.onLine?.('== packages');
        return { code: 0, out: '', err: '' };
      }
      if (command === 'true') return { code: 0, out: '', err: '' };
      if (command.includes('/opt/aibox/repos.sh')) {
        // The server's list first (the user's repos, the refused owner left out), then the clones; the token on the input only.
        assert.match(command, /^printf '%s\\n' octo\/site octo\/shop \| sudo tee \/etc\/aibox\/repos >\/dev\/null && sudo -u aibox -H bash \/opt\/aibox\/repos\.sh 'Me Myself' 'me@example\.com' octo\/site octo\/shop$/);
        assert.ok(!command.includes('github_pat'));
        srv.inputs.push(o.input ?? '');
        const out = ['octo/site', 'octo/shop'].map((s) => `REPO ${s} ${srv.tokenRepos.has(s) ? 'ready' : 'refused'}`).join('\n');
        return { code: 0, out, err: '' };
      }
    }
    throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
  };
  const status = async (r: RemoteWorkers): Promise<ServerStatus | null> => {
    assert.equal(r.user, 'aibox');
    assert.ok(r.key.endsWith('aibox_worker'));
    return srv.installed ? { version: LAUNCHER_VERSION, claude: '2.1.311 (Claude Code)', signedIn: srv.signedIn, memory: { total: 7941, available: 7100 }, running: 0 } : null;
  };
  const tty = (_cmd: string, args: string[]): Tty => {
    assert.ok(args.includes('-tt'));
    let data: (t: string) => void = () => {};
    let end: (c: number) => void = () => {};
    const exit = new Promise<number | null>((r) => (end = r));
    setTimeout(() => data('\x1b[2K Browser didn\'t open? Use the url below:\r\nhttps://claude.ai/oauth/authorize?code=true&state=s\r\nPaste code here if prompted > '), 5);
    return {
      write: (t) => {
        assert.equal(t, 'CODE-1234567890#state\r');
        srv.signedIn = true;
        end(0);
      },
      onData: (cb) => (data = cb),
      exit,
      kill: () => end(1),
    };
  };
  return { srv, exec, status, tty };
}

function wizard() {
  const home = mkdtempSync(join(tmpdir(), 'hub-vps-'));
  mkdirSync(join(home, '.ssh'));
  const scripts = mkdtempSync(join(tmpdir(), 'hub-vps-scripts-'));
  for (const f of ['setup.sh', 'launch.mjs', 'repos.sh', 'envsync.mjs', 'tools.sh']) writeFileSync(join(scripts, f), `# ${f}`);
  const fake = fakeServer();
  let saved: RemoteWorkers = parseRemote({ allowed: ['octo/site', 'octo/shop', 'acme-corp/crm'], denied: ['acme-corp'] });
  let token = '';
  const states: VpsState[] = [];
  const w = new VpsWizard({
    exec: fake.exec,
    tty: fake.tty,
    home,
    scripts,
    platform: 'win32',
    user: 'me',
    current: () => saved,
    save: (r) => (saved = parseRemote(r)),
    mainRepos: () => ['C:\\code\\site', 'C:\\code\\other'],
    originOf: (dir) => (dir.endsWith('site') ? 'github.com/octo/site' : 'github.com/acme-corp/crm'),
    token: () => token,
    status: fake.status,
    latency: async () => 31,
    onChange: (s) => states.push(s),
  });
  return { w, fake, home, saved: () => saved, setToken: (v: string) => (token = v) };
}

const target = { host: '203.0.113.7', admin: 'ubuntu', port: 22 };

test('the setup goes from an address to a saved server, stopping where the user has something to do', async () => {
  const { w, fake, home, saved, setToken } = wizard();
  // 1. Keys are made, the server's fingerprint is shown and nothing goes further before it is trusted.
  let s = await w.run(target);
  assert.equal(s.steps.local.state, 'ok');
  assert.match(s.adminKey, /^ssh-ed25519 \S+ aibox-admin$/);
  assert.equal(s.steps.hostkey.state, 'wait');
  assert.match(s.fingerprint, /^SHA256:/);
  assert.equal(fake.srv.commands.length, 0);
  // 2. Trusted: recorded; the admin key is not at OVH's yet.
  assert.equal((await w.trust('SHA256:another')).steps.hostkey.state, 'wait');
  s = await w.trust(s.fingerprint);
  assert.match(readFileSync(join(home, '.ssh', 'aibox_known_hosts'), 'utf8'), /^203\.0\.113\.7 ssh-ed25519 /);
  assert.deepEqual([s.steps.hostkey.state, s.steps.admin.state, s.steps.admin.detail], ['ok', 'wait', 'pasteKey']);
  // 3. Pasted: setup, Claude Code's sign-in through the code, then the GitHub token it waits for.
  fake.srv.keyPasted = true;
  const running = w.run();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(w.state().steps.login.state, 'wait');
  assert.equal(w.state().loginUrl, 'https://claude.ai/oauth/authorize?code=true&state=s');
  w.code('rm -rf / #');
  w.code(' CODE-1234567890#state ');
  s = await running;
  assert.deepEqual([s.steps.setup.state, s.steps.worker.state, s.steps.login.state, s.steps.repos.state], ['ok', 'ok', 'ok', 'wait']);
  assert.equal(s.claude, '2.1.311 (Claude Code)');
  assert.equal(s.latencyMs, 31);
  assert.equal(s.steps.repos.detail, 'token');
  assert.equal(saved().enabled, false);
  // 4. A token that reaches one repo of the two: that one is ready, the other waits.
  setToken('github_pat_example_0123456789');
  fake.srv.tokenRepos.add('octo/site');
  s = await w.run();
  assert.deepEqual([s.steps.repos.state, s.steps.repos.detail], ['wait', 'refused']);
  assert.deepEqual(fake.srv.inputs, ['github_pat_example_0123456789\n']);
  // 5. The token reaches both: saved, on, only the allowed checkout linked, a phone topic made; no second install.
  fake.srv.tokenRepos.add('octo/shop');
  s = await w.run();
  assert.equal(s.steps.save.state, 'ok');
  assert.equal(fake.srv.setups, 1);
  const r = saved();
  assert.equal(r.enabled, true);
  assert.equal(r.host, '203.0.113.7');
  assert.equal(r.user, 'aibox');
  assert.ok(r.key.endsWith('aibox_worker') && r.knownHosts.endsWith('aibox_known_hosts'));
  assert.deepEqual(Object.values(r.repos), ['/home/aibox/repos/site']);
  assert.match(r.ntfy, /^aibox-[a-z0-9]{24}$/);
});

test('a refused address never reaches ssh', async () => {
  const { w, fake } = wizard();
  const s = await w.run({ host: '1.2.3.4 -oProxyCommand=calc', admin: 'ubuntu', port: 22 });
  assert.deepEqual([s.steps.local.state, s.steps.local.detail], ['fail', 'target']);
  assert.equal(fake.srv.commands.length, 0);
});

test('phone topics are long, random and private-looking', () => {
  const a = newTopic();
  assert.match(a, /^aibox-[a-z0-9]{24}$/);
  assert.notEqual(a, newTopic());
});
