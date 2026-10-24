import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t } from './i18n';

// Git never waits for a terminal prompt, and status never takes the optional index lock: workers run git in
// these folders at the same time.
export const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };

/**
 * The hub's sign-in for its own git commands, offered only to URLs under `prefix` ("https://github.com"): a token,
 * or a credential helper that keeps its own (the GitHub CLI).
 */
export type GitSignIn = { prefix: string; token: string } | { prefix: string; helper: string } | null;
let signIn: () => GitSignIn = () => null;
export const setGitSignIn = (fn: () => GitSignIn) => (signIn = fn);

export interface GitOptions {
  timeout?: number;
  /** Started by the user (push, pull…): the credential manager may show its window. Background calls never do. */
  interactive?: boolean;
  /** URL the command contacts, as `git remote get-url` resolves it: the hub's sign-in goes to it alone. */
  auth?: string;
  /** False: none of the repo's hooks runs (a fetch or a clone has no reason to run code from the repo). */
  hooks?: boolean;
}

/** A failed git command: `message` is its most telling line, `stderr` the whole output (credentials removed). */
export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

// Remote URLs in git output may carry credentials.
const stripCredentials = (text: string) => text.replace(/\/\/[^/\s]*@/g, '//');

// No hook can exist under a regular file: a hooks path pointing at the hub's own executable switches every hook
// off, and nothing a session can write turns that file into a folder.
const NO_HOOKS = ['-c', `core.hooksPath=${process.execPath}`];

let tokenDir = '';

/**
 * Config handing the sign-in to git for this one command. A token never enters the environment, which hooks and
 * every program git starts inherit: it waits in a file the helper reads once and deletes, removed anyway when the
 * command ends. The empty helper first drops the helpers configured elsewhere for that URL.
 */
function credential(sign: NonNullable<GitSignIn>): { args: string[]; cleanup: () => void } | null {
  const key = `credential.${sign.prefix}.helper`;
  if ('helper' in sign) return { args: ['-c', `${key}=`, '-c', `${key}=${sign.helper}`], cleanup: () => {} };
  tokenDir ||= mkdtempSync(join(tmpdir(), 'claude-hub-git-'));
  // Forward slashes: git runs the helper with its POSIX shell, on Windows too.
  const file = join(tokenDir, randomBytes(16).toString('hex')).replace(/\\/g, '/');
  if (file.includes("'")) return null;
  writeFileSync(file, sign.token, { mode: 0o600 });
  const helper = `!f() { test "$1" = get || exit 0; t=$(cat '${file}' 2>/dev/null); rm -f '${file}'; test -n "$t" || exit 0; echo username=x-access-token; echo "password=$t"; }; f`;
  return { args: ['-c', `${key}=`, '-c', `${key}=${helper}`], cleanup: () => rmSync(file, { force: true }) };
}

/** The single place where the main process runs git: always an argument list, never a shell. */
export function git(cwd: string, args: string[], { timeout = 15_000, interactive = false, auth, hooks = true }: GitOptions = {}): Promise<string> {
  const sign = auth ? signIn() : null;
  const cred = sign && auth?.startsWith(`${sign.prefix}/`) ? credential(sign) : null;
  const env = interactive ? GIT_ENV : { ...GIT_ENV, GCM_INTERACTIVE: 'never' };
  // fsmonitor would run a program named in the repo's own config, which a session may have written.
  const config = ['-c', 'core.fsmonitor=false', ...(hooks ? [] : NO_HOOKS), ...(cred?.args ?? [])];
  return new Promise<string>((resolve, reject) => {
    execFile('git', [...config, '-C', cwd, ...args], { env, timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new GitError(t('git.notFound'), ''));
      if (err.killed) return reject(new GitError(t('git.timeout', { cmd: args[0], s: Math.round(timeout / 1000) }), ''));
      const output = stripCredentials(`${stderr}\n${stdout}`.trim());
      const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
      // Never err.message: it repeats the whole command line, commit message included.
      const line = lines.find((l) => /^(fatal|error):/.test(l)) ?? lines.find((l) => !l.startsWith('hint:')) ?? t('git.failed', { cmd: args[0], code: String(err.code) });
      reject(new GitError(line, output));
    });
  }).finally(() => cred?.cleanup());
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
