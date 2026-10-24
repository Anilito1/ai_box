import { execFile } from 'node:child_process';

// Git never waits for a terminal prompt, and status never takes the optional index lock: workers run git in
// these folders at the same time.
export const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };

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
  const env = interactive ? GIT_ENV : { ...GIT_ENV, GCM_INTERACTIVE: 'never' };
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { env, timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new GitError('git introuvable dans le PATH', ''));
      if (err.killed) return reject(new GitError(`git ${args[0]} a dépassé le délai de ${Math.round(timeout / 1000)} s`, ''));
      const output = stripCredentials(`${stderr}\n${stdout}`.trim());
      const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
      // Never err.message: it repeats the whole command line, commit message included.
      const line = lines.find((l) => /^(fatal|error):/.test(l)) ?? lines.find((l) => !l.startsWith('hint:')) ?? `git ${args[0]} a échoué (code ${err.code})`;
      reject(new GitError(line, output));
    });
  });
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
