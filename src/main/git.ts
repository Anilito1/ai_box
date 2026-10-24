import { execFile } from 'node:child_process';
import { t } from './i18n';

// Git never waits for a terminal prompt, and status never takes the optional index lock: workers run git in
// these folders at the same time.
export const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };

/** Set by the main process: the GitHub sign-in of the hub, as a credential helper in git's environment. */
let signIn: () => Record<string, string> = () => ({});
export const setGitSignIn = (env: () => Record<string, string>) => (signIn = env);

export interface GitOptions {
  timeout?: number;
  /** Started by the user (push, pull…): the credential manager may show its window. Background calls never do. */
  interactive?: boolean;
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

/** The single place where the main process runs git: always an argument list, never a shell. */
export function git(cwd: string, args: string[], { timeout = 15_000, interactive = false }: GitOptions = {}): Promise<string> {
  const env = { ...GIT_ENV, ...signIn(), ...(interactive ? {} : { GCM_INTERACTIVE: 'never' }) };
  return new Promise((resolve, reject) => {
    // fsmonitor would run a program named in the repo's own config, which a session may have written.
    execFile('git', ['-c', 'core.fsmonitor=false', '-C', cwd, ...args], { env, timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new GitError(t('git.notFound'), ''));
      if (err.killed) return reject(new GitError(t('git.timeout', { cmd: args[0], s: Math.round(timeout / 1000) }), ''));
      const output = stripCredentials(`${stderr}\n${stdout}`.trim());
      const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
      // Never err.message: it repeats the whole command line, commit message included.
      const line = lines.find((l) => /^(fatal|error):/.test(l)) ?? lines.find((l) => !l.startsWith('hint:')) ?? t('git.failed', { cmd: args[0], code: String(err.code) });
      reject(new GitError(line, output));
    });
  });
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
