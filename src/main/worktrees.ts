import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { cleanupVerdict, firstFree, isSafeBranch, treeNames, type KeepReason } from '../shared/parallel';
import { git } from './git';
import { realPath, repoOf, samePath } from './repos';
import { parseStatus, repoState, STATUS_ARGS } from './scm';

// Worktrees the hub makes for workers that would otherwise write in a folder another worker writes in: next to the
// repo's main folder, on a new branch from origin's default branch, removed when the worker closes if nothing is lost.

/** A worktree the hub made, as state.json keeps it. */
export interface WorkTree {
  /** Main folder of the repo. */
  repo: string;
  /** Checkout it was made for (the post's folder or the worker's), where the user installs the dependencies. */
  source: string;
  path: string;
  branch: string;
  /** Commit it was made from, and the ref that pointed there ("origin/main"; empty: the source's HEAD). */
  base: string;
  baseRef: string;
  state: 'active' | 'kept' | 'removed';
  /** Why it was kept at the last close. */
  kept: KeepReason[];
}

const NETWORK_MS = 60_000;
const CHECKOUT_MS = 180_000;
const INSTALL_MS = 15 * 60_000;
const ok = () => true;
const no = () => false;

const originUrl = async (repo: string) => (await git(repo, ['remote', 'get-url', 'origin']).catch(() => '')).trim();

const fetches = new Map<string, { at: number; run: Promise<boolean>; settled: boolean }>();

/**
 * origin, fetched with the hub's sign-in and none of the repo's hooks; false offline (the last known refs serve).
 * A fetch in flight is shared (two at once would fight over the same refs), a finished one younger than `maxAge` too.
 */
function fetchOrigin(repo: string, url: string, maxAge: number): Promise<boolean> {
  const key = repo.toLowerCase();
  const last = fetches.get(key);
  if (last && (!last.settled || Date.now() - last.at < maxAge)) return last.run;
  const entry = { at: Date.now(), settled: false, run: Promise.resolve(false) };
  entry.run = git(repo, ['fetch', '--quiet', '--no-tags', 'origin'], { timeout: NETWORK_MS, auth: url, hooks: false })
    .then(ok, no)
    .finally(() => (entry.settled = true));
  fetches.set(key, entry);
  return entry.run;
}

/** origin's default branch ("origin/main"), else origin/main or origin/master when one exists. */
async function defaultBase(repo: string): Promise<{ ref: string; oid: string } | null> {
  const head = (await git(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')).trim();
  for (const ref of [...new Set([head, 'origin/main', 'origin/master'])]) {
    if (!/^origin\/[\w.-]+(?:\/[\w.-]+)*$/.test(ref)) continue;
    const oid = (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/${ref}^{commit}`]).catch(() => '')).trim();
    if (oid) return { ref, oid };
  }
  return null;
}

/** Refs a new branch would collide with: the same name, or a name that is a folder of it or holds it ("a" and "a/b"). */
const collides = (refs: string[], name: string) =>
  ['refs/heads/', 'refs/remotes/origin/'].some((prefix) => {
    const ref = `${prefix}${name}`;
    return refs.some((r) => r === ref || r.startsWith(`${ref}/`) || ref.startsWith(`${r}/`));
  });

export interface NewTree {
  tree: WorkTree;
  /** The worker's folder: the worktree, or the same subfolder its source folder is in. */
  cwd: string;
  /** origin could not be fetched: the worktree starts from the last known state. */
  stale: boolean;
}

/**
 * A worktree of the repo holding `folder` for `post` (empty for an ad-hoc worker) and `topic`, from a fresh origin
 * default branch, else from the folder's HEAD when the repo has no origin. Names are slugs, checked again here: no
 * argument git receives can read as an option.
 */
export async function makeTree(folder: string, post: string, topic: string): Promise<NewTree> {
  const where = repoOf(folder);
  if (!where) throw new Error('no-repo');
  const repo = where.main;
  const url = await originUrl(repo);
  const fetched = url ? await fetchOrigin(repo, url, 30_000) : true;
  const base = url ? await defaultBase(repo) : null;
  const baseOid = base?.oid ?? (await git(where.checkout, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])).trim();
  const refs = (await git(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin'])).split('\n').filter(Boolean);
  const names = treeNames(basename(repo), post, topic);
  // A branch named like the prefix ("brain", "hub") makes "<prefix>/…" impossible: a flat "hub-…" name instead.
  const prefix = names.branch.split('/')[0];
  const flat = refs.some((r) => r === `refs/heads/${prefix}` || r === `refs/remotes/origin/${prefix}`);
  const branch = firstFree(flat ? `hub-${post ? `${post}-` : ''}${topic || 'work'}` : names.branch, (b) => collides(refs, b));
  // A folder git still lists (deleted by hand, never pruned) is refused by `worktree add` too.
  const listed = (await listTrees(repo)).map((w) => w.path.toLowerCase());
  const taken = (f: string) => existsSync(join(dirname(repo), f)) || listed.includes(resolve(dirname(repo), f).toLowerCase());
  const path = join(dirname(repo), firstFree(names.folder, taken));
  if (!isSafeBranch(branch) || !/^[0-9a-f]{40,64}$/.test(baseOid)) throw new Error('bad-name');
  // --no-track: a plain `git push` cannot land on main; the worker pushes its own branch with -u.
  await git(repo, ['worktree', 'add', '--no-track', '-b', branch, path, baseOid], { timeout: CHECKOUT_MS, hooks: false });
  const sub = relative(where.checkout, realPath(folder));
  return {
    tree: { repo, source: where.checkout, path, branch, base: baseOid, baseRef: base?.ref ?? '', state: 'active', kept: [] },
    cwd: sub && !sub.startsWith('..') ? join(path, sub) : path,
    stale: !fetched,
  };
}

/** `git worktree list --porcelain -z`: each worktree's folder, branch and lock. */
async function listTrees(repo: string): Promise<{ path: string; branch: string; locked: boolean; prunable: boolean }[]> {
  const out: { path: string; branch: string; locked: boolean; prunable: boolean }[] = [];
  for (const line of (await git(repo, ['worktree', 'list', '--porcelain', '-z'])).split('\0')) {
    if (line.startsWith('worktree ')) out.push({ path: resolve(line.slice(9)), branch: '', locked: false, prunable: false });
    else if (line.startsWith('branch ') && out.length) out[out.length - 1].branch = line.slice(7);
    else if ((line === 'locked' || line.startsWith('locked ')) && out.length) out[out.length - 1].locked = true;
    else if ((line === 'prunable' || line.startsWith('prunable ')) && out.length) out[out.length - 1].prunable = true;
  }
  return out;
}

/**
 * Removes the worktree of a closed worker when nothing would be lost (shared/parallel.ts decides), after a fetch so
 * a branch merged upstream counts as merged; `canRemove` is asked last (the worker may have started again). Git
 * removes it without --force: a file changed meanwhile still keeps it.
 */
export async function retireTree(t: WorkTree, canRemove: () => boolean): Promise<{ removed: boolean; why: KeepReason[] }> {
  try {
    return await retire(t, canRemove);
  } catch {
    // The repo moved, or git refused to answer: nothing is touched.
    return { removed: false, why: ['unknown'] };
  }
}

async function retire(t: WorkTree, canRemove: () => boolean): Promise<{ removed: boolean; why: KeepReason[] }> {
  const url = await originUrl(t.repo);
  if (url) await fetchOrigin(t.repo, url, 0);
  const exists = existsSync(t.path);
  const trees = await listTrees(t.repo);
  const mine = trees.find((w) => samePath(w.path, t.path));
  const branchRef = `refs/heads/${t.branch}`;
  const branchExists = await git(t.repo, ['rev-parse', '--verify', '--quiet', branchRef]).then(ok, no);
  let changes = 0;
  let operation = false;
  let head = '';
  if (exists) {
    // New files count whatever the user's status.showUntrackedFiles says: they would be lost with the folder.
    changes = parseStatus(await git(t.path, [...STATUS_ARGS, '--untracked-files=normal']), 0).total;
    operation = repoState((await git(t.path, ['rev-parse', '--absolute-git-dir'])).trim()) !== '';
    head = (await git(t.path, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).catch(() => '')).trim();
  }
  // Commits of HEAD and of the branch that no remote branch, no other local branch and not the base holds.
  const tips = [head, branchExists ? branchRef : ''].filter(Boolean);
  const unpushed = tips.length
    ? Number((await git(t.repo, ['rev-list', '--count', ...tips, '--not', '--remotes', `--exclude=${t.branch}`, '--branches', t.base])).trim()) || 0
    : 0;
  const verdict = cleanupVerdict({
    exists,
    changes,
    operation,
    locked: !!mine?.locked,
    unpushed,
    branchExists,
    branchElsewhere: trees.some((w) => w.branch === branchRef && !samePath(w.path, t.path)),
  });
  if (!verdict.removeTree || !canRemove()) return { removed: false, why: verdict.why };
  // Only a folder git lists as a worktree of this repo is ever deleted: anything else at that path is left alone.
  if (exists && !mine) return { removed: false, why: ['unknown'] };
  let leftover = false;
  if (exists) {
    try {
      leftover = await removeTree(t);
    } catch {
      // Git refused before touching anything (a file changed meanwhile): kept, nothing lost.
      return { removed: false, why: ['inUse'] };
    }
  } else if (!trees.some((w) => w.prunable && !samePath(w.path, t.path))) {
    // Prune forgets every worktree whose folder is gone: only when this one is the only such worktree (another one may
    // sit on a disk that is not plugged in).
    await git(t.repo, ['worktree', 'prune']);
  }
  // Only the branch the hub made for this worktree, still the one it holds.
  if (verdict.deleteBranch && (!mine || mine.branch === branchRef)) await git(t.repo, ['branch', '-D', t.branch]).catch(() => undefined);
  // Forgotten by git, its work safe, but part of its folder still there: `inUse` says so.
  return { removed: true, why: leftover ? ['inUse'] : verdict.why };
}

/**
 * `git worktree remove`, which refuses a worktree with changes. Once it started deleting, git forgets the worktree
 * even when a file or the folder itself is still open (the worker's processes take a few seconds to let go): what is
 * left is committed or ignored, so the hub finishes the job, retrying for a while. True when part of it stays.
 * Git may also succeed and leave what it could not delete (a junction in node_modules): finished the same way; a link
 * is removed, never followed.
 */
async function removeTree(t: WorkTree): Promise<boolean> {
  try {
    await git(t.repo, ['worktree', 'remove', t.path], { timeout: CHECKOUT_MS });
    if (!existsSync(t.path)) return false;
  } catch (err) {
    if ((await listTrees(t.repo)).some((w) => samePath(w.path, t.path))) throw err;
  }
  return rm(t.path, { recursive: true, force: true, maxRetries: 6, retryDelay: 1000 }).then(no, ok);
}

// ---------- dependencies ----------

export interface InstallPlan {
  tool: 'npm' | 'pnpm' | 'yarn' | 'bun';
  args: string[];
}

/**
 * How to install a new worktree's dependencies, when its repo installs them (the checkout it came from has a
 * node_modules) and pins them (a lockfile: an install never rewrites it). Null when there is nothing to do.
 */
export function installPlan(t: WorkTree): InstallPlan | null {
  const has = (name: string) => existsSync(join(t.path, name));
  if (!has('package.json') || has('node_modules') || !existsSync(join(t.source, 'node_modules'))) return null;
  if (has('pnpm-lock.yaml')) return { tool: 'pnpm', args: ['install', '--frozen-lockfile', '--prefer-offline'] };
  if (has('bun.lock') || has('bun.lockb')) return { tool: 'bun', args: ['install', '--frozen-lockfile'] };
  if (has('yarn.lock')) return { tool: 'yarn', args: has('.yarnrc.yml') ? ['install', '--immutable'] : ['install', '--frozen-lockfile', '--prefer-offline'] };
  if (has('package-lock.json')) return { tool: 'npm', args: ['ci', '--prefer-offline', '--no-audit', '--no-fund'] };
  return null;
}

export const planText = (p: InstallPlan) => `${p.tool} ${p.args.join(' ')}`;

/**
 * Runs an install plan in the worktree, its output kept to the last lines. On Windows the package managers are .cmd
 * scripts, which only run through the shell: the command line is the plan's own constant words, never a path or a name.
 */
export function runInstall(t: WorkTree, plan: InstallPlan, env: Record<string, string>): { done: Promise<{ ok: boolean; ms: number; output: string }>; kill: () => void } {
  const started = Date.now();
  const win = process.platform === 'win32';
  // cmd.exe would run an npm.cmd sitting in the worktree itself before the real one: never from the current folder.
  const child = win
    ? spawn(planText(plan), { cwd: t.path, env: { ...env, NoDefaultCurrentDirectoryInExePath: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: true })
    : spawn(plan.tool, plan.args, { cwd: t.path, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let output = '';
  const keep = (chunk: Buffer) => (output = (output + chunk.toString()).slice(-4000));
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  const kill = () => {
    if (child.exitCode !== null || !child.pid) return;
    // The whole tree: npm starts node, which starts the packages' scripts.
    if (win) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => undefined);
    else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
    }
  };
  const timer = setTimeout(kill, INSTALL_MS);
  const done = new Promise<{ ok: boolean; ms: number; output: string }>((resolveDone) => {
    const finish = (code: number | null) => {
      clearTimeout(timer);
      resolveDone({ ok: code === 0, ms: Date.now() - started, output: output.trim() });
    };
    // A tool that cannot start may report only its error, without a close.
    child.on('error', (err) => {
      output += `\n${err.message}`;
      finish(null);
    });
    child.on('close', finish);
  });
  return { done, kill };
}
