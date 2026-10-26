import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CliRun } from '../shared/cliUpdate';
import type { CliUpdate } from '../shared/news';
import { CliUpdater, type CliUpdateDeps, type Runner } from './cliUpdate';

const CASK = '/opt/homebrew/Caskroom/claude-code/2.1.287/claude';
const update = (over: Partial<CliUpdate> = {}): CliUpdate => ({
  tool: 'claude',
  current: '2.1.287',
  latest: '2.1.311',
  method: 'brew',
  command: 'brew upgrade --cask claude-code',
  path: CASK,
  reach: '2.1.311',
  upgrade: true,
  switchTo: '',
  ...over,
});

/** A runner that answers each command from a script, and remembers what it was asked to run. */
function setup(answers: Record<string, { code: number; out: string }>, over: Partial<CliUpdateDeps> = {}, after = { version: '2.1.311', real: '/opt/homebrew/Caskroom/claude-code/2.1.311/claude' }) {
  const ran: string[] = [];
  const sent: CliRun[] = [];
  const runner: Runner = {
    run: async (exe, args, _env, onData) => {
      const line = [exe, ...args].join(' ');
      ran.push(line);
      const key = Object.keys(answers).find((k) => line.includes(k));
      const a = key ? answers[key] : { code: 0, out: 'ok' };
      onData(a.out);
      return a;
    },
    installApp: async () => {
      ran.push('install-app');
      return '';
    },
    version: async () => after.version,
    writable: () => true,
    exists: () => true,
  };
  let refreshed = 0;
  const deps: CliUpdateDeps = {
    runner,
    env: () => ({ PATH: '/usr/bin' }),
    home: '/Users/me',
    tmp: '/tmp',
    platform: 'darwin',
    toolsDir: '/data/tools',
    update: () => update(),
    refresh: async () => {
      refreshed++;
    },
    program: () => ({ path: '/opt/homebrew/bin/claude', ...after }),
    running: () => 2,
    confirmSwitch: async () => true,
    send: (run) => sent.push(run),
    ...over,
  };
  return { updater: new CliUpdater(deps), runner, ran, sent, refreshes: () => refreshed };
}

test('an upgrade runs its method, asks the version again and offers the restart for the sessions running', async () => {
  const { updater, ran, sent, refreshes } = setup({});
  const run = await updater.start('anthropic', 'upgrade');
  assert.deepEqual(ran, ['/opt/homebrew/bin/brew upgrade --cask claude-code']);
  assert.equal(refreshes(), 1);
  assert.equal(run?.phase, 'done');
  assert.equal(run?.to, '2.1.311');
  assert.equal(run?.restart, 2);
  assert.equal(sent[0].phase, 'running');
  assert.equal(sent.at(-1)?.phase, 'done');
});

test('Homebrew stopping short of the latest: done, with the official installer offered next', async () => {
  const { updater } = setup({}, { update: () => update({ reach: '2.1.308', switchTo: 'native' }) }, { version: '2.1.308', real: '/opt/homebrew/Caskroom/claude-code/2.1.308/claude' });
  const run = await updater.start('anthropic', 'upgrade');
  assert.equal(run?.phase, 'done');
  assert.equal(run?.switchTo, 'native');
});

test('nothing newer after it: a failure that says so', async () => {
  const { updater } = setup({ upgrade: { code: 0, out: 'Warning: Not upgrading claude-code, the latest version is already installed' } }, { update: () => update({ switchTo: 'native' }) }, { version: '2.1.287', real: CASK });
  const run = await updater.start('anthropic', 'upgrade');
  assert.equal(run?.phase, 'failed');
  assert.equal(run?.error, 'unchanged');
  assert.equal(run?.switchTo, 'native');
});

test('the switch asks first: refused, nothing runs', async () => {
  const { updater, ran } = setup({}, { confirmSwitch: async () => false, update: () => update({ switchTo: 'native' }) });
  assert.equal(await updater.start('anthropic', 'switch'), null);
  assert.deepEqual(ran, []);
});

test('the switch to the official installer removes the cask once the new claude answers, and checks it is the one run', async () => {
  const { updater, ran } = setup({}, { update: () => update({ switchTo: 'native' }) }, { version: '2.1.311', real: '/Users/me/.local/share/claude/versions/2.1.311' });
  const run = await updater.start('anthropic', 'switch');
  assert.deepEqual(ran, ['curl -fsSL --retry 2 https://claude.ai/install.sh -o /tmp/claude-install.sh', '/bin/bash /tmp/claude-install.sh latest', '/opt/homebrew/bin/brew uninstall --cask claude-code']);
  assert.equal(run?.phase, 'done');
  assert.equal(run?.shadowed, false);
});

test('the new install does not answer: the old one is kept', async () => {
  const { updater, runner, ran } = setup({}, { update: () => update({ switchTo: 'native' }) });
  runner.version = async () => '';
  const run = await updater.start('anthropic', 'switch');
  assert.equal(run?.error, 'not-installed');
  assert.ok(!ran.some((l) => l.includes('uninstall')));
});

test('after a switch, another claude first in the PATH is told', async () => {
  const { updater } = setup({}, { update: () => update({ switchTo: 'native' }) }, { version: '2.1.287', real: CASK });
  const run = await updater.start('anthropic', 'switch');
  assert.equal(run?.phase, 'done');
  assert.equal(run?.shadowed, true);
});

test('npm without the rights: asked again through the administrator prompt, never sudo', async () => {
  const npmPath = '/usr/local/lib/node_modules/@google/gemini-cli/bundle/gemini.js';
  const { updater, ran } = setup(
    { '/usr/local/bin/npm install': { code: 243, out: 'npm error code EACCES' } },
    { update: () => update({ tool: 'gemini', method: 'npm', path: npmPath, current: '0.65.0', latest: '0.70.0' }) },
    { version: '0.70.0', real: npmPath },
  );
  const run = await updater.start('gemini', 'upgrade');
  assert.equal(ran.length, 2);
  assert.ok(ran[1].startsWith('/usr/bin/osascript -e do shell script'));
  assert.ok(ran[1].includes('with administrator privileges'));
  assert.ok(!ran.some((l) => /\bsudo\b/.test(l)));
  // The fake answers the osascript line with the default "ok": the update went through.
  assert.equal(run?.phase, 'done');
});

test('the administrator prompt cancelled: a failure that says nothing changed', async () => {
  const { updater, runner } = setup(
    { osascript: { code: 1, out: 'execution error: User canceled. (-128)' } },
    { update: () => update({ method: 'npm', path: '/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe' }) },
  );
  runner.writable = () => false;
  const run = await updater.start('anthropic', 'upgrade');
  assert.equal(run?.error, 'cancelled');
});

test('one update at a time; none without an update', async () => {
  let release = () => {};
  const { updater, runner } = setup({});
  runner.run = () => new Promise((r) => (release = () => r({ code: 0, out: '' })));
  const first = updater.start('anthropic', 'upgrade');
  assert.equal(await updater.start('openai', 'upgrade'), null);
  release();
  assert.equal((await first)?.phase, 'done');
  const none = setup({}, { update: () => null });
  assert.equal(await none.updater.start('anthropic', 'upgrade'), null);
});

test('a finished update can be closed, a running one cannot', async () => {
  const { updater } = setup({});
  await updater.start('anthropic', 'upgrade');
  assert.equal(updater.view().length, 1);
  updater.dismiss('anthropic');
  assert.equal(updater.view().length, 0);
});
