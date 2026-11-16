import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ClaudeStatus } from '../../../shared/types';
import { versionAtLeast } from '../../../shared/version';
import type { HubConfig } from '../../config';
import { errorCode, httpCode } from '../../errors';
import { localTool } from '../tools';

const require = createRequire(import.meta.url);
const EXE = process.platform === 'win32' ? 'claude.exe' : 'claude';
/** Cloud switches a user may have in their own environment: with an API key chosen, the key must win over them. */
const CLOUD_SWITCHES = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
/** Authentication variables inherited from a shell are not Claude Code's saved CLI sign-in. */
const AUTH_ENV_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN'];

/** The Claude Code binary npm installed with the Agent SDK (absent from a packaged build, which never ships it). */
function bundledExecutable(): string {
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  for (const pkg of process.platform === 'linux' ? [base, `${base}-musl`] : [base]) {
    try {
      const exe = join(dirname(require.resolve(`${pkg}/package.json`)), EXE);
      if (existsSync(exe)) return exe;
    } catch {
      // Not installed for this platform.
    }
  }
  return '';
}

/** Claude Code installed by the user: on the PATH, else in the native installer's folder. */
function installedExecutable(): Promise<string> {
  // The login shell's PATH is merged in at start (shellPath.ts); these are the usual places when it has none.
  const fallback = join(homedir(), '.local', 'bin', EXE);
  return new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'where' : 'which', ['claude'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      const lines = err ? [] : stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      // A .cmd shim (npm install on Windows) cannot be spawned without a shell: run the binary it points to.
      const real = (l: string) =>
        process.platform !== 'win32' || /\.exe$/i.test(l) ? l : join(dirname(l), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      const found = lines.map(real).find((p) => existsSync(p));
      resolve(found ?? [fallback, `/opt/homebrew/bin/${EXE}`, `/usr/local/bin/${EXE}`].find((f) => existsSync(f)) ?? '');
    });
  });
}

/** The version Claude Code reports ("2.1.287"), empty when it cannot be asked. */
export function claudeVersion(executable: string, env: Record<string, string>): Promise<string> {
  return new Promise((resolve) => {
    if (!executable) return resolve('');
    execFile(executable, ['--version'], { env, timeout: 10_000, windowsHide: true }, (err, stdout) => resolve(err ? '' : (/\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? '')));
  });
}

const versions = new Map<string, string>();

/** The version of a binary, asked once per file and modification date: an update of the install changes both. */
async function versionOf(executable: string): Promise<string> {
  let key = executable;
  try {
    key = `${executable}:${statSync(executable).mtimeMs}`;
  } catch {
    return '';
  }
  const known = versions.get(key);
  if (known) return known;
  const version = await claudeVersion(executable, process.env as Record<string, string>);
  if (version) versions.set(key, version);
  return version;
}

/** The newest of the candidates, the earlier one on a tie; one whose version is unknown never beats one that is known. */
export function newestExecutable(candidates: { path: string; version: string }[]): string {
  let best: { path: string; version: string } | undefined;
  for (const c of candidates) if (!best || (c.version && (!best.version || (versionAtLeast(c.version, best.version) && !versionAtLeast(best.version, c.version))))) best = c;
  return best?.path ?? '';
}

/**
 * Executable the sessions run: the configured one, else the newest of the SDK's own binary, the app's own copy and the
 * user's install (which updates itself): a model newer than the SDK's binary would get a window and a behaviour it does not know.
 */
export async function claudeExecutable(cfg: HubConfig, installed?: string): Promise<string> {
  if (cfg.claudePath && existsSync(cfg.claudePath)) return cfg.claudePath;
  const paths = [...new Set([bundledExecutable(), localTool('claude'), installed ?? (await installedExecutable())].filter(Boolean))];
  if (paths.length < 2) return paths[0] ?? '';
  return newestExecutable(await Promise.all(paths.map(async (path) => ({ path, version: await versionOf(path) }))));
}

/**
 * Environment that selects the Claude access chosen in the settings. `claude-code` adds nothing: Claude Code uses its
 * own configuration and sign-in, which the hub never reads.
 */
export function claudeEnv(cfg: HubConfig, apiKey: string): { set: Record<string, string>; unset: string[] } {
  if (cfg.provider !== 'api-key') return { set: {}, unset: [] };
  return { set: apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}, unset: [...CLOUD_SWITCHES, 'ANTHROPIC_AUTH_TOKEN'] };
}

/** Checks an Anthropic API key with a free call (the model list): null when accepted, else an error code. */
export async function checkApiKey(key: string): Promise<string | null> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok ? null : httpCode(res.status);
  } catch (err) {
    return errorCode(err);
  }
}

/**
 * Asks Claude Code for its authentication status, without opening a session or sending a prompt.
 * `loggedIn` is authoritative: an email or plan alone does not prove that credentials remain.
 */
export async function claudeStatus(cfg: HubConfig, env: Record<string, string>): Promise<{ executable: string; status: ClaudeStatus }> {
  const executable = await claudeExecutable(cfg);
  const status: ClaudeStatus = { found: executable !== '', account: null, error: '' };
  if (!executable) return { executable, status };
  // Claude Code set up for a cloud provider in the user's environment checks its credentials on the first request
  // only, and its start can take a minute looking for them: nothing to ask it here.
  if (cfg.provider === 'claude-code' && CLOUD_SWITCHES.some((k) => env[k] || process.env[k])) {
    status.account = { ready: true, provider: 'cloud', email: '', plan: '', source: '' };
    return { executable, status };
  }
  // In Claude Code mode, report the CLI's own sign-in state. A shell-level API key can still
  // authorize requests, but must not keep the CLI sign-out control active after auth logout.
  const probeEnv = { ...env };
  if (cfg.provider === 'claude-code') for (const key of AUTH_ENV_VARS) delete probeEnv[key];
  // User/project settings can inject env credentials or an apiKeyHelper after the environment was cleaned.
  // This probe is about the saved CLI sign-in; loading those settings would reconnect it after logout.
  const args = [...(cfg.provider === 'claude-code' ? ['--setting-sources', ''] : []), 'auth', 'status', '--json'];
  await new Promise<void>((resolve) => {
    execFile(executable, args, { cwd: homedir(), env: probeEnv, timeout: 30_000, windowsHide: true }, (err, stdout) => {
      try {
        // Claude Code exits with 1 when signed out, and still returns a valid status.
        if (err && (err.killed || err.code !== 1)) throw err;
        const info = JSON.parse(stdout);
        if (typeof info.loggedIn !== 'boolean') throw new Error('probe-failed');
        const text = (value: unknown) => typeof value === 'string' ? value : '';
        status.account = {
          ready: info.loggedIn,
          provider: text(info.apiProvider) || 'firstParty',
          email: text(info.email),
          plan: text(info.subscriptionType),
          source: info.apiKeySource === 'none' ? '' : text(info.apiKeySource),
        };
      } catch (error) {
        status.error = err?.killed ? 'timeout' : 'probe-failed';
      }
      resolve();
    });
  });
  return { executable, status };
}
