import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { claudeLogout } from '../../accounts';
import { loadConfig } from '../../config';
import { claudeStatus } from './cli';

// A fake CLI with its own authentication store; never touches Claude's real credentials.
test('Claude status and logout use the same folder and ignore inherited authentication', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-claude-auth-'));
  try {
    const script = join(dir, 'cli.cjs');
    const executable = join(dir, 'claude');
    writeFileSync(script, `
const fs = require('node:fs'), path = require('node:path');
const file = path.join(process.env.CLAUDE_CONFIG_DIR, 'signed-in');
fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'probe.json'), JSON.stringify({ args: process.argv.slice(2), key: process.env.ANTHROPIC_API_KEY, token: process.env.CLAUDE_CODE_OAUTH_TOKEN }));
if (process.argv.includes('logout')) { fs.rmSync(file, { force: true }); process.exit(0); }
if (process.env.BROKEN === 'yes') { console.log('not JSON'); process.exit(0); }
const loggedIn = fs.existsSync(file) || !!process.env.ANTHROPIC_API_KEY || !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
console.log(JSON.stringify({ loggedIn, apiProvider: 'firstParty', email: 'saved@example.test', subscriptionType: 'max' }));
process.exit(loggedIn ? 0 : 1);
`);
    const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    writeFileSync(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o700 });
    const cfg = { ...loadConfig(dir, 'en'), claudePath: executable };
    const env = { HOME: dir, CLAUDE_CONFIG_DIR: dir, ANTHROPIC_API_KEY: 'shell-key', CLAUDE_CODE_OAUTH_TOKEN: 'shell-token' };
    writeFileSync(join(dir, 'signed-in'), 'fixture');
    assert.equal((await claudeStatus(cfg, env)).status.account?.ready, true);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'probe.json'), 'utf8')), { args: ['--setting-sources', '', 'auth', 'status', '--json'] });
    assert.equal(await claudeLogout(executable, env), null);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'probe.json'), 'utf8')), { args: ['auth', 'logout'] });
    const signedOut = (await claudeStatus(cfg, env)).status;
    assert.equal(signedOut.error, '', 'exit code 1 with a valid signed-out status is expected');
    assert.equal(signedOut.account?.ready, false, 'saved email and plan do not keep the provider connected');
    const broken = (await claudeStatus(cfg, { ...env, BROKEN: 'yes' })).status;
    assert.equal(broken.account, null);
    assert.equal(broken.error, 'probe-failed', 'a failed status check must not masquerade as a successful sign-out');
    const keyMode = { ...cfg, provider: 'api-key' as const };
    assert.equal((await claudeStatus(keyMode, env)).status.account?.ready, true, 'API-key mode keeps its selected authentication');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Exercise the real native CLI too: a stub cannot reproduce Claude loading settings after startup.
const require = createRequire(import.meta.url);
let native = '';
try {
  native = join(dirname(require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`)), process.platform === 'win32' ? 'claude.exe' : 'claude');
} catch {
  // Optional native SDK package not installed on this platform.
}
test('real Claude logout stays signed out when user settings inject an API key', { skip: !native }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-claude-settings-'));
  try {
    const settings = JSON.stringify({ env: { ANTHROPIC_API_KEY: 'fixture-key-never-sent' } });
    writeFileSync(join(dir, 'settings.json'), settings);
    const env: Record<string, string> = {
      HOME: dir, USERPROFILE: dir, CLAUDE_CONFIG_DIR: dir,
      PATH: process.env.PATH ?? '', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    };
    const rawStatus = async () => JSON.parse((await promisify(execFile)(native, ['auth', 'status', '--json'], { env, timeout: 20_000 })).stdout);
    assert.equal((await rawStatus()).loggedIn, true, 'the settings inject a key even without shell credentials');
    assert.equal(await claudeLogout(native, env), null);
    assert.equal((await rawStatus()).loggedIn, true, 'logout does not remove keys from user settings');
    const cfg = { ...loadConfig(dir, 'en'), claudePath: native };
    const checked = (await claudeStatus(cfg, env)).status;
    assert.equal(checked.error, '');
    assert.equal(checked.account?.ready, false, 'the panel checks saved CLI authentication, without reloading settings credentials');
    assert.equal(readFileSync(join(dir, 'settings.json'), 'utf8'), settings, 'user settings stay intact');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
