import type { RepoReturn } from '../shared/away';
import { git } from './git';
import { fetchRemote } from './scm';

// What the hub checks of a worker's checkout on this PC when it steps away and comes back. git only, never a shell.

export interface Pushed {
  branch: string;
  head: string;
  /** No change left in the folder, untracked files included. */
  clean: boolean;
  /** The branch is on origin, at this very commit. */
  pushed: boolean;
}

/** Files that make this PC run a program by themselves: Claude Code's settings and hooks, git's, CI, editor tasks. */
export const RUNS_HERE = /(^|\/)(\.claude\/|\.mcp\.json$|CLAUDE\.md$|AGENTS\.md$|\.envrc$)|^(\.husky|\.githooks|\.vscode|\.github)\/|^\.git(attributes|modules)$/;

const out = (cwd: string, args: string[]) => git(cwd, args).then((o) => o.trim(), () => '');

/** Where a worker's checkout stands, after a fetch: a move to the server needs it clean and pushed. */
export async function pushedState(cwd: string, fetch = true): Promise<Pushed> {
  if (fetch) await fetchRemote(cwd, { quiet: true }).catch(() => false);
  const [branch, head, status, upstream] = await Promise.all([
    out(cwd, ['symbolic-ref', '-q', '--short', 'HEAD']),
    out(cwd, ['rev-parse', 'HEAD']),
    git(cwd, ['status', '--porcelain']).catch(() => null),
    out(cwd, ['rev-parse', '--verify', '--quiet', '@{u}']),
  ]);
  return { branch, head, clean: status !== null && status.trim() === '', pushed: !!head && head === upstream };
}

/** The commits of `branch` on origin since `from`, newest first ("abc1234 subject"), after a fetch. */
export async function commitsSince(cwd: string, from: string, branch: string): Promise<string[]> {
  await fetchRemote(cwd, { quiet: true }).catch(() => false);
  const log = await out(cwd, ['log', '--oneline', '--no-decorate', '-n', '200', `${from}..refs/remotes/origin/${branch}`]);
  return log ? log.split('\n') : [];
}

/** Brings the checkout to what the server pushed, if that is a fast-forward of a clean folder on that branch. */
export async function pullBack(cwd: string, branch: string): Promise<RepoReturn> {
  const now = await pushedState(cwd);
  if (now.branch !== branch || !now.clean) return 'not-pulled';
  const remote = await out(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
  if (!remote || remote === now.head) return 'up-to-date';
  // The server's commits follow this one: a fast-forward. Otherwise both sides wrote: never merged by the hub.
  const base = await out(cwd, ['merge-base', now.head, remote]);
  if (base !== now.head) return base === remote ? 'up-to-date' : 'conflict';
  // What the server wrote must not run here unseen: a change to these is fetched only, the user decides.
  const changed = await out(cwd, ['diff', '--name-only', now.head, remote]);
  if (changed.split('\n').some((f) => RUNS_HERE.test(f))) return 'review';
  return git(cwd, ['merge', '--ff-only', remote]).then(
    () => 'pulled' as const,
    () => 'not-pulled' as const,
  );
}
