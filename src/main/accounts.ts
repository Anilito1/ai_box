import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { ACCOUNT_ID, isLocalUrl } from '../shared/accounts';
import type { Account, AccountStatus } from '../shared/types';
import { errorCode, httpCode } from './errors';

// The accounts' side of the main process: the Claude Code folder of each Claude account, the environment that puts
// a session on an account, and the checks the settings run. The sign-ins themselves stay inside Claude Code.

/** Switches and settings of the user's own environment that would point a session elsewhere than its account. */
const ACCESS_VARS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
];

/**
 * What a Claude account's folder shares with the user's own Claude Code folder: everything but the sign-in (kept by
 * Claude Code in the keychain under the folder's path) and `.claude.json`. Conversations are shared, so a session
 * moved to another account resumes its own, and the hub reads every transcript where it always does.
 */
const SHARED = ['projects', 'settings.json', 'CLAUDE.md', 'agents', 'commands', 'skills', 'plugins', 'output-styles', 'file-history', 'todos', 'plans', 'keybindings.json'];

/** The user's own Claude Code folder. */
export const baseConfigDir = () => resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'));

/** Folder of a Claude account, under the hub's own data. */
export function accountDir(dataDir: string, id: string): string {
  if (!ACCOUNT_ID.test(id)) throw new Error('bad account id');
  return join(dataDir, 'accounts', id);
}

const isLink = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};
const exists = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * Makes a Claude account's folder, linked to the user's own folder for what they share. Run before every launch: a
 * file the user's folder gained since (a CLAUDE.md, skills) is linked then. What is already there stays.
 */
export function prepareClaudeDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const base = baseConfigDir();
  // Conversations must land in the shared folder from the first one on.
  mkdirSync(join(base, 'projects'), { recursive: true });
  for (const name of SHARED) {
    const target = join(base, name);
    const link = join(dir, name);
    if (!existsSync(target) || exists(link)) continue;
    try {
      // A junction needs no rights on Windows; a file link may fail there (no developer mode): it is then not shared.
      symlinkSync(target, link, process.platform === 'win32' && statSync(target).isDirectory() ? 'junction' : undefined);
    } catch {
      // Not shared; the account still works, with Claude Code's defaults for that item.
    }
  }
}

/**
 * Removes a Claude account's folder. The links go first, one by one, so nothing they point to (the user's own
 * conversations, settings) can be reached by the removal; then the rest, which is the account's own.
 */
export function removeClaudeDir(dataDir: string, id: string): void {
  const dir = accountDir(dataDir, id);
  if (!dir.startsWith(join(dataDir, 'accounts') + sep) || !existsSync(dir)) return;
  for (const name of SHARED) {
    const link = join(dir, name);
    if (!isLink(link)) continue;
    try {
      unlinkSync(link);
    } catch {
      rmSync(link, { force: true }); // A Windows junction.
    }
  }
  // Anything still a link here (made by hand) would be followed by nobody: rmSync removes links, not their targets.
  rmSync(dir, { recursive: true, force: true });
}

export interface AccountEnvContext {
  dataDir: string;
  /** The account's stored key (API key, OpenAI key), else empty. */
  key: string;
  /** The bridge's address for this account and its token. */
  bridge: { url: string; token: string };
}

/** The environment that puts a session on an extra account: what to add, and what of the user's own to remove. */
export function accountEnv(account: Account, ctx: AccountEnvContext): { set: Record<string, string>; unset: string[] } {
  switch (account.kind) {
    case 'claude': {
      const dir = accountDir(ctx.dataDir, account.id);
      prepareClaudeDir(dir);
      return { set: { CLAUDE_CONFIG_DIR: dir }, unset: ACCESS_VARS };
    }
    case 'anthropic-key':
      return { set: ctx.key ? { ANTHROPIC_API_KEY: ctx.key } : {}, unset: ACCESS_VARS };
    case 'codex': {
      // The user's own Codex sign-in unless the account has a folder of its own; an API key in the environment would
      // take the place of the ChatGPT sign-in this account stands for.
      const unset = ['OPENAI_API_KEY', 'CODEX_API_KEY'];
      if (!account.isolated) return { set: {}, unset };
      const dir = accountDir(ctx.dataDir, account.id);
      prepareCodexDir(dir);
      return { set: { CODEX_HOME: dir }, unset };
    }
    case 'openai': {
      // Every Claude model name lands on the account's models (the bridge maps the rest the same way).
      const small = account.smallModel || account.model;
      return {
        set: {
          ANTHROPIC_BASE_URL: ctx.bridge.url,
          ANTHROPIC_AUTH_TOKEN: ctx.bridge.token,
          ANTHROPIC_MODEL: account.model,
          ANTHROPIC_DEFAULT_OPUS_MODEL: account.model,
          ANTHROPIC_DEFAULT_SONNET_MODEL: account.model,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: small,
          ANTHROPIC_SMALL_FAST_MODEL: small,
        },
        unset: ACCESS_VARS,
      };
    }
  }
}

const OPENAI_KEY = /^[\w.:\-/+=]{8,400}$/;
export const isOpenAIKey = (key: string) => OPENAI_KEY.test(key);

/**
 * Checks an OpenAI (or compatible) server with its model list, a free call: ready with the models it lists, or an
 * error code. A local server may need no key.
 */
export async function checkOpenAI(baseUrl: string, key: string): Promise<AccountStatus> {
  const none: AccountStatus = { ready: false, detail: '', error: '', models: [] };
  if (!key && !isLocalUrl(baseUrl)) return { ...none, error: 'no-key' };
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ...none, error: httpCode(res.status) };
    const body = (await res.json().catch(() => ({}))) as { data?: { id?: unknown }[] };
    const models = (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string')
      .sort()
      .slice(0, 500);
    return { ready: true, detail: '', error: '', models };
  } catch (err) {
    return { ...none, error: errorCode(err) };
  }
}

/** Makes the Codex folder of an account of its own: where Codex keeps the sign-in and the conversations of its sessions. */
export function prepareCodexDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const config = join(dir, 'config.toml');
  if (!existsSync(config)) writeFileSync(config, '# Written by Claude Hub. This folder is one Codex account of the hub: its sign-in and its sessions.\n', { mode: 0o600 });
}

/** Removes a Codex account's own folder (its sign-in was ended first). Never the user's own Codex folder. */
export function removeCodexDir(dataDir: string, id: string): void {
  const dir = accountDir(dataDir, id);
  if (!dir.startsWith(join(dataDir, 'accounts') + sep) || !existsSync(dir)) return;
  rmSync(dir, { recursive: true, force: true });
}

/** Claude Code's own sign-out for an account's folder, quietly: the folder goes right after. */
export function claudeLogout(executable: string, env: Record<string, string>): Promise<void> {
  return new Promise((resolve) => {
    if (!executable) return resolve();
    execFile(executable, ['auth', 'logout'], { env, timeout: 20_000, windowsHide: true }, () => resolve());
  });
}
