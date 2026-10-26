import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AccountStatus } from '../../../shared/types';
import { versionAtLeast } from '../../../shared/version';
import { errorCode } from '../../errors';
import { CodexClient } from './client';
import { modelsOf, rateLimitsOf } from './adapter';
import { codexBinary, localTool } from '../tools';
import type { RateLimits } from '../../../shared/types';
import type { AgentModel } from '../types';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});

const EXE = process.platform === 'win32' ? 'codex.exe' : 'codex';

/**
 * Codex: the configured path, else the app's own copy, else the user's install (the PATH, then the usual folders). An
 * npm install on Windows puts shell wrappers on the PATH, which cannot start without a shell: the binary behind them.
 */
export function codexExecutable(configured = ''): Promise<string> {
  if (configured && existsSync(configured)) return Promise.resolve(configured);
  const local = localTool('codex');
  if (local) return Promise.resolve(local);
  const usual = [join(homedir(), '.local', 'bin', EXE), `/opt/homebrew/bin/${EXE}`, `/usr/local/bin/${EXE}`];
  return new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'where' : 'which', ['codex'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      const lines = err ? [] : stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const real = (l: string) => (process.platform !== 'win32' || /\.exe$/i.test(l) ? l : codexBinary(join(dirname(l), 'node_modules')));
      resolve([...lines.map(real), ...usual].find((p) => p && existsSync(p)) ?? '');
    });
  });
}

/** "codex-cli 0.163.0" → "0.163.0"; empty when it cannot be told. */
export function codexVersion(executable: string, env: Record<string, string>): Promise<string> {
  return new Promise((resolve) => {
    if (!executable) return resolve('');
    execFile(executable, ['--version'], { env, timeout: 10_000, windowsHide: true }, (err, stdout) => resolve(err ? '' : (/\d+\.\d+\.\d+\S*/.exec(stdout)?.[0] ?? '')));
  });
}

/** Oldest Codex whose app-server the hub has been written against. */
export const CODEX_MIN_VERSION = '0.163.0';
export { versionAtLeast };

export interface CodexCheck {
  status: AccountStatus;
  limits: RateLimits | null;
  models: AgentModel[];
}

/**
 * Asks Codex which account it is signed in with and which models and limits it has: a short-lived app-server, no
 * model call. The sign-in itself stays inside Codex; the hub only reads this summary.
 */
export async function checkCodex(executable: string, env: Record<string, string>): Promise<CodexCheck> {
  const none: AccountStatus = { ready: false, detail: '', error: '', models: [] };
  if (!executable) return { status: { ...none, error: 'no-codex' }, limits: null, models: [] };
  const client = new CodexClient({ executable, env, version: '0.2' });
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 30_000).unref());
  try {
    const run = async (): Promise<CodexCheck> => {
      await client.start();
      const account = obj(obj(await client.request('account/read', {})).account);
      if (!account.type) return { status: none, limits: null, models: [] };
      const [models, limits] = await Promise.all([
        client.request('model/list', {}).catch(() => ({})),
        client.request('account/rateLimits/read', {}).catch(() => ({})),
      ]);
      const detail = [account.type === 'chatgpt' ? String(account.email ?? '') : 'API key', String(account.planType ?? '')].filter(Boolean).join(' · ');
      const listed = modelsOf(obj(models));
      return { status: { ready: true, detail, error: '', models: listed.map((m) => m.value) }, limits: rateLimitsOf(obj(obj(limits).rateLimits)), models: listed };
    };
    return await Promise.race([run(), timeout]);
  } catch (err) {
    const message = errorCode(err);
    return { status: { ...none, error: message === 'timeout' ? 'timeout' : 'probe-failed' }, limits: null, models: [] };
  } finally {
    client.close();
  }
}

/** Codex's own sign-out for an account's folder, quietly: the folder goes right after. */
export function codexLogout(executable: string, env: Record<string, string>): Promise<void> {
  return new Promise((resolve) => {
    if (!executable) return resolve();
    execFile(executable, ['logout'], { env, timeout: 20_000, windowsHide: true }, () => resolve());
  });
}
