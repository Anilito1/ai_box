import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adminCommand, brewApiVersion, npmPrefix, planUpdate, readFailure, switchCommand, updateChoice, verdict, type PlanInput } from './cliUpdate';
import { brewPackage, installMethod, updateCommand } from './news';

const CASK = '/opt/homebrew/Caskroom/claude-code/2.1.287/claude';
const NVM = '/Users/me/.nvm/versions/node/v24.20.0/lib/node_modules/@openai/codex/bin/codex.js';
const plan = (over: Partial<PlanInput> & Pick<PlanInput, 'update'>) =>
  planUpdate({ provider: 'anthropic', action: 'upgrade', home: '/Users/me', tmp: '/tmp', npmWritable: true, ...over });

test('a Homebrew install is read from its path: cask or formula, its name, its brew', () => {
  assert.deepEqual(brewPackage(CASK), { kind: 'cask', name: 'claude-code', brew: '/opt/homebrew/bin/brew' });
  assert.deepEqual(brewPackage('/opt/homebrew/Caskroom/claude-code@latest/2.1.310/claude'), { kind: 'cask', name: 'claude-code@latest', brew: '/opt/homebrew/bin/brew' });
  assert.deepEqual(brewPackage('/usr/local/Cellar/gemini-cli/0.70.0/libexec/bin/gemini'), { kind: 'formula', name: 'gemini-cli', brew: '/usr/local/bin/brew' });
  assert.equal(brewPackage('/Users/me/.local/share/claude/versions/2.1.311'), null);
  // The copied command names the package the program really came from.
  assert.equal(updateCommand('openai', 'brew', '', '/opt/homebrew/Caskroom/codex/0.163.0/codex'), 'brew upgrade --cask codex');
  assert.equal(updateCommand('anthropic', 'brew', '', '/opt/homebrew/Caskroom/claude-code@latest/2.1.310/claude'), 'brew upgrade --cask claude-code@latest');
});

test('npm under Homebrew’s Node.js is npm; a Homebrew formula built on Node.js is Homebrew', () => {
  assert.equal(installMethod('/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js'), 'npm');
  assert.equal(installMethod('/opt/homebrew/Cellar/gemini-cli/0.70.0/libexec/lib/node_modules/@google/gemini-cli/bundle/gemini.js'), 'brew');
});

test('the npm prefix of a global install, so its own npm updates it', () => {
  assert.equal(npmPrefix(NVM), '/Users/me/.nvm/versions/node/v24.20.0');
  assert.equal(npmPrefix('/usr/local/lib/node_modules/@google/gemini-cli/bundle/gemini.js'), '/usr/local');
  assert.equal(npmPrefix('/opt/homebrew/bin/claude'), '');
});

test('Homebrew behind npm: the official installer is offered, its own upgrade only if it brings something', () => {
  // Homebrew has 2.1.308, npm 2.1.311, installed 2.1.287: both.
  assert.deepEqual(updateChoice('anthropic', 'brew', '2.1.287', '2.1.311', '2.1.308'), { upgrade: true, switchTo: 'native' });
  // Homebrew has nothing newer than what is installed: only the switch.
  assert.deepEqual(updateChoice('anthropic', 'brew', '2.1.308', '2.1.311', '2.1.308'), { upgrade: false, switchTo: 'native' });
  // Homebrew is up to date with npm: its upgrade alone.
  assert.deepEqual(updateChoice('anthropic', 'brew', '2.1.287', '2.1.311', '2.1.311'), { upgrade: true, switchTo: '' });
  // Homebrew could not be asked: its upgrade is tried, the result tells.
  assert.deepEqual(updateChoice('anthropic', 'brew', '2.1.287', '2.1.311', ''), { upgrade: true, switchTo: '' });
  // Codex and the Gemini CLI move to the app's own copy.
  assert.deepEqual(updateChoice('openai', 'brew', '0.160.0', '0.163.0', '0.160.0'), { upgrade: false, switchTo: 'app' });
});

test('every install method has its own update', () => {
  assert.deepEqual(updateChoice('anthropic', 'native', '2.1.300', '2.1.311', ''), { upgrade: true, switchTo: '' });
  assert.deepEqual(updateChoice('gemini', 'npm', '0.65.0', '0.70.0', ''), { upgrade: true, switchTo: '' });
  assert.deepEqual(updateChoice('openai', 'app', '0.160.0', '0.163.0', ''), { upgrade: true, switchTo: '' });
  // Found somewhere unknown: Claude Code updates itself, the others get the app's copy.
  assert.deepEqual(updateChoice('anthropic', 'unknown', '2.1.300', '2.1.311', ''), { upgrade: true, switchTo: '' });
  assert.deepEqual(updateChoice('gemini', 'unknown', '0.65.0', '0.70.0', ''), { upgrade: false, switchTo: 'app' });
});

test('the steps of an upgrade, by install method', () => {
  assert.deepEqual(plan({ update: { method: 'brew', path: CASK, switchTo: '' } }), [{ label: 'brew-upgrade', exe: '/opt/homebrew/bin/brew', args: ['upgrade', '--cask', 'claude-code'] }]);
  assert.deepEqual(plan({ provider: 'gemini', update: { method: 'brew', path: '/opt/homebrew/Cellar/gemini-cli/0.70.0/bin/gemini', switchTo: '' } })[0].args, ['upgrade', 'gemini-cli']);
  const native = '/Users/me/.local/share/claude/versions/2.1.300';
  assert.deepEqual(plan({ update: { method: 'native', path: native, switchTo: '' } }), [{ label: 'self-update', exe: native, args: ['update'] }]);
  const npm = plan({ provider: 'openai', update: { method: 'npm', path: NVM, switchTo: '' } });
  assert.equal(npm[0].exe, '/Users/me/.nvm/versions/node/v24.20.0/bin/npm');
  assert.deepEqual(npm[0].args.slice(0, 3), ['install', '-g', '@openai/codex@latest']);
  assert.equal(npm[0].admin, false);
  assert.equal(npm[0].elevate, true);
  // A global folder owned by root: through the administrator prompt from the start.
  assert.equal(plan({ provider: 'openai', npmWritable: false, update: { method: 'npm', path: NVM, switchTo: '' } })[0].admin, true);
  assert.deepEqual(plan({ provider: 'openai', update: { method: 'app', path: '/x/tools/node_modules/@openai/codex/bin/codex', switchTo: '' } }), [{ label: 'app-install', exe: '', args: [], app: true }]);
  // Nothing one click can do: no steps (the command stays to copy).
  assert.deepEqual(plan({ provider: 'gemini', update: { method: 'unknown', path: '/opt/x/gemini', switchTo: 'app' } }), []);
});

test('Homebrew to the official installer: download, install, then the cask removed once the new one answers', () => {
  const steps = plan({ action: 'switch', update: { method: 'brew', path: CASK, switchTo: 'native' } });
  assert.deepEqual(
    steps.map((s) => s.label),
    ['download', 'install-native', 'remove-old'],
  );
  assert.deepEqual(steps[0].args, ['-fsSL', '--retry', '2', 'https://claude.ai/install.sh', '-o', '/tmp/claude-install.sh']);
  assert.deepEqual([steps[1].exe, ...steps[1].args], ['/bin/bash', '/tmp/claude-install.sh', 'latest']);
  assert.deepEqual([steps[2].exe, ...steps[2].args], ['/opt/homebrew/bin/brew', 'uninstall', '--cask', 'claude-code']);
  assert.equal(steps[2].check, '/Users/me/.local/bin/claude');
  // From npm, the global package goes instead.
  const fromNpm = plan({ action: 'switch', update: { method: 'npm', path: '/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe', switchTo: 'native' } });
  assert.deepEqual(fromNpm[2].args, ['uninstall', '-g', '@anthropic-ai/claude-code']);
  // No switch offered: nothing runs.
  assert.deepEqual(plan({ action: 'switch', update: { method: 'brew', path: CASK, switchTo: '' } }), []);
  assert.equal(switchCommand('anthropic', { method: 'brew', path: CASK }), 'curl -fsSL https://claude.ai/install.sh | bash -s latest && brew uninstall --cask claude-code');
});

test('Codex behind on Homebrew moves to the app copy, the Homebrew one untouched', () => {
  assert.deepEqual(
    plan({ provider: 'openai', action: 'switch', update: { method: 'brew', path: '/opt/homebrew/Caskroom/codex/0.160.0/codex', switchTo: 'app' } }).map((s) => s.label),
    ['app-install'],
  );
});

test('the administrator prompt gets one quoted shell line, its own npm cache, the PATH', () => {
  const [exe, args] = adminCommand('/usr/local/bin/npm', ['install', '-g', "@x/it's@latest"], '/usr/local/bin:/usr/bin', '/tmp');
  assert.equal(exe, '/usr/bin/osascript');
  assert.equal(args[0], '-e');
  assert.equal(
    args[1],
    `do shell script "PATH='/usr/local/bin:/usr/bin' '/usr/local/bin/npm' 'install' '-g' '@x/it'\\\\''s@latest' '--cache' '/tmp/aibox-npm-admin-cache'" with administrator privileges`,
  );
  assert.ok(!adminCommand('/opt/homebrew/bin/brew', ['upgrade'], '/usr/bin', '/tmp')[1][1].includes('--cache'));
});

test('what a failed command says, read from its output', () => {
  assert.equal(readFailure(1, 'execution error: User canceled. (-128)'), 'cancelled');
  assert.equal(readFailure(243, 'npm error code EACCES\nnpm error syscall mkdir'), 'needs-admin');
  assert.equal(readFailure(6, 'curl: (6) Could not resolve host: claude.ai'), 'network');
  assert.equal(readFailure(1, 'Error: Another active Homebrew update process is already in progress.'), 'busy');
  assert.equal(readFailure(1, 'Error: Cask claude-code is not installed.'), 'failed');
});

test('the version after the update: there, forward but not there yet, or the same', () => {
  assert.equal(verdict('2.1.287', '2.1.311', '2.1.311'), 'done');
  assert.equal(verdict('2.1.287', '2.1.312', '2.1.311'), 'done');
  assert.equal(verdict('2.1.287', '2.1.308', '2.1.311'), 'partial');
  assert.equal(verdict('2.1.287', '2.1.287', '2.1.311'), 'unchanged');
  assert.equal(verdict('2.1.287', '', '2.1.311'), 'unchanged');
});

test('the version Homebrew offers, from its API', () => {
  assert.equal(brewApiVersion('cask', { version: '2.1.308' }), '2.1.308');
  assert.equal(brewApiVersion('cask', { version: '2.1.300,abc123' }), '2.1.300');
  assert.equal(brewApiVersion('formula', { versions: { stable: '0.70.0' } }), '0.70.0');
  assert.equal(brewApiVersion('formula', { error: 'not found' }), '');
  assert.equal(brewApiVersion('cask', null), '');
});
