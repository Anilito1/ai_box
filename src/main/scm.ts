import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ownUpstream,
  type CommitDetails,
  type CommitFile,
  type GitRef,
  type GraphCommit,
  type GraphFilter,
  type GraphRef,
  type RepoAction,
  type RepoActionResult,
  type RepoBranch,
  type RepoErrorKind,
  type RepoFile,
  type RepoGraph,
  type RepoState,
} from '../shared/types';
import { git, GitError } from './git';
import { t } from './i18n';

const NETWORK_MS = 120_000;
const COMMIT_MS = 120_000;
const MAX_LIMIT = 2000;
const MAX_COMMIT_FILES = 2000;
const MAX_MESSAGE = 20_000;
const HASH = /^[0-9a-f]{7,64}$/i;

interface LocalRef {
  id: string;
  revision: string;
  upstream: string;
  current: boolean;
  worktree: string;
}

const shortRef = (id: string) => id.replace(/^refs\/(heads|remotes|tags)\//, '');
const isRemoteHead = (id: string) => /^refs\/remotes\/[^/]+\/HEAD$/.test(id);

/** Branches and remote branches with what the graph needs; `%00` keeps any character of a path intact. */
async function readRefs(path: string): Promise<LocalRef[]> {
  const out = await git(path, [
    'for-each-ref',
    '--format=%(refname)%00%(objectname)%00%(upstream)%00%(HEAD)%00%(worktreepath)',
    'refs/heads',
    'refs/remotes',
  ]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, revision, upstream, head, worktree] = line.split('\0');
      return { id, revision, upstream, current: head === '*', worktree };
    })
    .filter((r) => !isRemoteHead(r.id));
}

const ref = (id: string, revision: string): GraphRef => ({ id, name: shortRef(id), revision });

/** HEAD, its upstream and the base branch it is meant to land on, like VS Code's history provider. */
async function currentRefs(path: string, refs: LocalRef[]) {
  const branch = refs.find((r) => r.current);
  const oid = branch?.revision ?? (await git(path, ['rev-parse', '-q', '--verify', 'HEAD^{commit}']).catch(() => '')).trim();
  const head = branch ? ref(branch.id, branch.revision) : oid ? { id: 'HEAD', name: oid.slice(0, 7), revision: oid } : null;
  const up = branch?.upstream ? refs.find((r) => r.id === branch.upstream) : undefined;
  const upstream = up ? ref(up.id, up.revision) : null;
  // The remote's default branch, unless it already is the upstream.
  const remote = /^refs\/remotes\/([^/]+)\//.exec(up?.id ?? '')?.[1] ?? 'origin';
  const baseId = (await git(path, ['symbolic-ref', '-q', `refs/remotes/${remote}/HEAD`]).catch(() => '')).trim();
  const baseRef = baseId && baseId !== up?.id && baseId !== branch?.id ? refs.find((r) => r.id === baseId) : undefined;
  return { head, upstream, base: baseRef ? ref(baseRef.id, baseRef.revision) : null };
}

/** `%D` with --decorate=full: "HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1". */
function parseDecorations(text: string): GitRef[] {
  const refs: GitRef[] = [];
  for (const raw of text.split(',').map((s) => s.trim())) {
    if (raw.startsWith('HEAD -> refs/heads/')) {
      const id = raw.slice('HEAD -> '.length);
      refs.push({ id, name: shortRef(id), kind: 'head' });
    } else if (raw.startsWith('refs/heads/')) refs.push({ id: raw, name: shortRef(raw), kind: 'branch' });
    else if (raw.startsWith('refs/remotes/') && !isRemoteHead(raw)) refs.push({ id: raw, name: shortRef(raw), kind: 'remote' });
    else if (raw.startsWith('tag: refs/tags/')) {
      const id = raw.slice('tag: '.length);
      refs.push({ id, name: shortRef(id), kind: 'tag' });
    }
  }
  return refs;
}

function parseLog(out: string): GraphCommit[] {
  return out
    .split('\0')
    .filter((r) => r.trim())
    .map((record) => {
      const [id, parents, author, email, at, decorations, ...message] = record.replace(/^\n/, '').split('\x1f');
      const text = message.join('\x1f').replace(/\s+$/, '');
      return {
        id,
        parents: parents ? parents.split(' ') : [],
        author,
        email,
        at: Number(at) * 1000,
        subject: text.split('\n')[0],
        message: text,
        refs: parseDecorations(decorations),
      };
    });
}

/** Commits of the graph, newest first in topological order, up to `limit`. */
export async function readGraph(path: string, filter: GraphFilter, limit: number): Promise<RepoGraph> {
  const refs = await readRefs(path);
  const { head, upstream, base } = await currentRefs(path, refs);
  const empty: RepoGraph = { commits: [], more: false, head, upstream, base, mergeBase: '', refs: [] };
  if (!head && refs.length === 0) return empty;

  let revs: string[];
  let shown: string[];
  if (filter === 'all') {
    revs = [...(head ? ['HEAD'] : []), '--branches', '--remotes', '--tags'];
    shown = [];
  } else {
    // The branches checked out in the repo's other folders: the work of the workers, forking from the base.
    const worktrees = refs.filter((r) => r.worktree && !r.current && r.id.startsWith('refs/heads/')).map((r) => r.id);
    shown = [...new Set([head?.id, upstream?.id, base?.id, ...worktrees].filter((id): id is string => !!id))];
    revs = shown;
    if (revs.length === 0) return empty;
  }
  const n = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
  const out = await git(
    path,
    [
      '-c',
      'i18n.logOutputEncoding=UTF-8',
      'log',
      '--format=%H%x1f%P%x1f%aN%x1f%aE%x1f%at%x1f%D%x1f%B',
      '-z',
      '--topo-order',
      '--decorate=full',
      `-n${n + 1}`,
      ...revs,
      '--',
    ],
    { timeout: 30_000 },
  );
  const commits = parseLog(out);
  const mergeBase =
    head && upstream ? (await git(path, ['merge-base', head.revision, upstream.revision]).catch(() => '')).trim() : '';
  // At the cap there is no next page: the panel stops asking.
  return { commits: commits.slice(0, n), more: n < MAX_LIMIT && commits.length > n, head, upstream, base, mergeBase, refs: shown };
}

/** `-z` output of --numstat and --name-status, where a rename spends two NUL-separated paths. */
function parseNumstat(out: string): Map<string, [number, number]> {
  const stats = new Map<string, [number, number]>();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i]);
    if (!m) continue;
    let path = m[3];
    if (path === '') {
      path = parts[i + 2] ?? '';
      i += 2;
    }
    stats.set(path, [m[1] === '-' ? -1 : Number(m[1]), m[2] === '-' ? -1 : Number(m[2])]);
  }
  return stats;
}

function parseNameStatus(out: string, stats: Map<string, [number, number]>): CommitFile[] {
  const files: CommitFile[] = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length - 1; i++) {
    const code = parts[i];
    if (!/^[A-Z]\d*$/.test(code)) continue;
    const status = code[0];
    const two = status === 'R' || status === 'C';
    const from = two ? parts[i + 1] : '';
    const path = two ? parts[i + 2] : parts[i + 1];
    i += two ? 2 : 1;
    const [added, deleted] = stats.get(path) ?? [0, 0];
    files.push({ status, path, from, added, deleted });
  }
  return files;
}

/** Files changed by a commit against its first parent, or by the incoming / outgoing changes since the merge base. */
export async function readDetails(path: string, id: string): Promise<CommitDetails> {
  let range: string[];
  if (id === 'incoming' || id === 'outgoing') {
    const mergeBase = (await git(path, ['merge-base', 'HEAD', '@{upstream}'])).trim();
    range = [mergeBase, id === 'incoming' ? '@{upstream}' : 'HEAD'];
  } else {
    if (!HASH.test(id)) throw new Error(t('scm.badCommit'));
    const parents = (await git(path, ['rev-list', '--parents', '-n1', id, '--'])).trim().split(' ').slice(1);
    range = parents.length ? [parents[0], id] : ['--root', id];
  }
  const base = ['diff-tree', '-r', '-z', '-M', '--no-commit-id'];
  const [numstat, names] = await Promise.all([git(path, [...base, '--numstat', ...range]), git(path, [...base, '--name-status', ...range])]);
  const files = parseNameStatus(names, parseNumstat(numstat));
  const sum = (key: 'added' | 'deleted') => files.reduce((s, f) => s + Math.max(0, f[key]), 0);
  return { files: files.slice(0, MAX_COMMIT_FILES), added: sum('added'), deleted: sum('deleted') };
}

/** Local branches then remote branches, most recently committed first. */
export async function readBranches(path: string): Promise<RepoBranch[]> {
  const out = await git(path, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname)%00%(HEAD)%00%(upstream:short)%00%(worktreepath)%00%(committerdate:unix)',
    'refs/heads',
    'refs/remotes',
  ]);
  const branches = out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, head, upstream, worktree, at] = line.split('\0');
      return { ref: id, name: shortRef(id), remote: id.startsWith('refs/remotes/'), current: head === '*', upstream, worktree, at: Number(at) * 1000 };
    })
    .filter((b) => !isRemoteHead(b.ref));
  return [...branches.filter((b) => !b.remote), ...branches.filter((b) => b.remote)];
}

/** Operation a conflict left in progress, read from the git dir of a checkout. */
export function repoState(gitDir: string): RepoState {
  const has = (name: string) => existsSync(join(gitDir, name));
  if (has('MERGE_HEAD')) return 'merge';
  if (has('rebase-merge') || has('rebase-apply')) return 'rebase';
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (has('REVERT_HEAD')) return 'revert';
  return '';
}

// ---------- actions ----------

class ActionError extends Error {
  constructor(
    readonly kind: RepoErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/** The panel shows the kind's sentence (or an ActionError's own one); git's words only go to its "Details" fold. */
function classify(err: unknown): RepoActionResult {
  if (err instanceof ActionError) return { ok: false, kind: err.kind, message: err.message, detail: '' };
  const raw = err instanceof Error ? err.message : String(err);
  const stderr = err instanceof GitError ? err.stderr : '';
  const text = `${raw}\n${stderr}`;
  const kind: RepoErrorKind = /has no upstream branch|no tracking information|no upstream configured/i.test(text)
    ? 'no-upstream'
    : /\[rejected\]|non-fast-forward|fetch first|Updates were rejected/i.test(text)
      ? 'rejected'
      : /divergent branches|Not possible to fast-forward/i.test(text)
        ? 'diverged'
        : /CONFLICT|Automatic merge failed|unmerged files|fix conflicts|you need to resolve|could not apply|Resolve all conflicts/i.test(text)
          ? 'conflict'
          : /would be overwritten|commit your changes or stash them|You have unstaged changes|cannot rebase/i.test(text)
            ? 'local-changes'
            : /nothing to commit|no changes added to commit|nothing added to commit/i.test(text)
              ? 'nothing-to-commit'
              : /Authentication failed|could not read Username|Permission denied|terminal prompts disabled|returned error: 403/i.test(text)
                ? 'auth'
                : 'other';
  // A GitError without output carries the hub's own sentence (git not installed, too slow): that one is shown.
  if (err instanceof GitError && !stderr) return { ok: false, kind, message: raw, detail: '' };
  const detail = stderr.includes(raw.trim()) ? stderr : `${stderr}\n${raw}`;
  return { ok: false, kind, message: '', detail: detail.trim().slice(0, 4000) };
}

// Untracked folders count as one entry (like `git status`): listing every file in them would cost each poll.
export const STATUS_ARGS = ['-c', 'core.quotePath=false', 'status', '--porcelain=v2', '--branch', '-z'];
const MAX_STATUS_FILES = 1000;

interface Porcelain {
  oid: string;
  branch: string;
  upstream: string;
  ab: [number, number] | null;
  files: RepoFile[];
  total: number;
  conflicts: number;
}

/**
 * `git status --porcelain=v2 --branch -z`: entries end with NUL, so paths are never quoted; a rename entry is
 * followed by its former path. A path is everything after the fixed fields of its entry type.
 */
export function parseStatus(out: string, maxFiles = MAX_STATUS_FILES): Porcelain {
  const st: Porcelain = { oid: '', branch: '', upstream: '', ab: null, files: [], total: 0, conflicts: 0 };
  const add = (file: RepoFile) => {
    st.total++;
    if (st.files.length < maxFiles) st.files.push(file);
  };
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    const rest = (fields: number) => line.split(' ').slice(fields).join(' ');
    if (line.startsWith('# branch.oid ')) st.oid = line.slice(13);
    else if (line.startsWith('# branch.head ')) st.branch = line.slice(14);
    else if (line.startsWith('# branch.upstream ')) st.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) st.ab = [Number(m[1]), Number(m[2])];
    } else if (line.startsWith('1 ')) add({ code: line.slice(2, 4), path: rest(8), from: '' });
    else if (line.startsWith('2 ')) add({ code: line.slice(2, 4), path: rest(9), from: parts[++i] ?? '' });
    else if (line.startsWith('u ')) {
      st.conflicts++;
      add({ code: line.slice(2, 4), path: rest(10), from: '' });
    } else if (line.startsWith('? ')) add({ code: '??', path: line.slice(2), from: '' });
  }
  return st;
}

/** Branch, upstream and distance of a checkout, read fresh before acting. */
async function tracking(path: string) {
  const branch = (await git(path, ['symbolic-ref', '-q', '--short', 'HEAD']).catch(() => '')).trim();
  const upstream = branch ? (await git(path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).catch(() => '')).trim() : '';
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const [a, b] = (await git(path, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}', '--'])).trim().split(/\s+/);
    ahead = Number(a);
    behind = Number(b);
  }
  return { branch, upstream, ahead, behind };
}

/** Paths git reports as changed in this checkout: only those may be staged or unstaged. */
async function changedPaths(path: string): Promise<Map<string, string>> {
  const st = parseStatus(await git(path, STATUS_ARGS), Infinity);
  return new Map(st.files.map((f) => [f.path, f.from]));
}

async function checkedPaths(path: string, requested: string[]): Promise<string[]> {
  const known = await changedPaths(path);
  const paths = requested.filter((p) => known.has(p));
  if (paths.length === 0) throw new ActionError('invalid', t('scm.notChanged'));
  // A rename is staged and unstaged with its former path.
  return [...new Set(paths.flatMap((p) => [p, known.get(p) ?? ''].filter(Boolean)))];
}

const config = async (path: string, key: string) => (await git(path, ['config', '--get', key]).catch(() => '')).trim();

/** Remote a command of this checkout talks to: its branch's, else origin, else the only one. */
async function remoteFor(path: string, branch: string): Promise<string> {
  const remotes = (await git(path, ['remote'])).split('\n').map((r) => r.trim()).filter((r) => r && !r.startsWith('-'));
  const tracked = branch ? await config(path, `branch.${branch}.remote`) : '';
  return remotes.includes(tracked) ? tracked : remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : '';
}

/** URL git will contact for a remote, insteadOf applied: the hub's sign-in is offered to it alone. */
const urlOf = async (path: string, remote: string, push: boolean) =>
  (await git(path, ['remote', 'get-url', ...(push ? ['--push'] : []), remote]).catch(() => '')).trim();

/** `git fetch` of the checkout's remote, with the hub's sign-in and none of the repo's hooks; false when it has no remote. */
export async function fetchRemote(path: string, { interactive = false, quiet = false, timeout = NETWORK_MS } = {}): Promise<boolean> {
  const branch = (await git(path, ['symbolic-ref', '-q', '--short', 'HEAD']).catch(() => '')).trim();
  const remote = await remoteFor(path, branch);
  if (!remote) return false;
  const auth = await urlOf(path, remote, false);
  await git(path, ['fetch', ...(quiet ? ['--quiet', '--no-tags'] : []), remote], { timeout, interactive, auth, hooks: false });
  return true;
}

/** Fetched first, with the sign-in and no hook; then merged (or rebased, when configured) locally, hooks included. */
async function pull(path: string): Promise<void> {
  const tr = await tracking(path);
  if (!tr.upstream) throw new ActionError('no-upstream', t('scm.noUpstream', { branch: tr.branch || 'HEAD' }));
  if ((await config(path, `branch.${tr.branch}.remote`)) !== '.') await fetchRemote(path, { interactive: true });
  const rebase = (await config(path, `branch.${tr.branch}.rebase`)) || (await config(path, 'pull.rebase'));
  if (/^(true|yes|on|1|merges|m|interactive|i|preserve|p)$/i.test(rebase)) {
    // No upstream argument: git then finds the fork point, like `git pull --rebase`.
    await git(path, ['rebase', ...(/^(merges|m)$/i.test(rebase) ? ['--rebase-merges'] : [])], { timeout: COMMIT_MS });
    return;
  }
  const ff = await config(path, 'pull.ff');
  await git(path, ['merge', '--no-edit', ...(ff === 'only' ? ['--ff-only'] : ff === 'false' ? ['--no-ff'] : []), '@{upstream}'], { timeout: COMMIT_MS });
}

/** Push and Sync need the branch's own remote branch: a worktree branch created from origin/main tracks it instead. */
function noOwnUpstream(tr: { branch: string; upstream: string }): void {
  if (!tr.branch) throw new ActionError('invalid', t('scm.detachedPush'));
  if (!ownUpstream(tr.branch, tr.upstream)) {
    throw new ActionError('no-upstream', tr.upstream ? t('scm.tracksOther', { branch: tr.branch, upstream: tr.upstream }) : t('scm.noUpstream', { branch: tr.branch }));
  }
}

/** Remote a push goes to, as git picks it: the branch's pushRemote, the repo's pushDefault, then its fetch remote. */
async function pushRemoteFor(path: string, branch: string): Promise<string> {
  const remotes = (await git(path, ['remote'])).split('\n').map((r) => r.trim());
  const named = (await config(path, `branch.${branch}.pushRemote`)) || (await config(path, 'remote.pushDefault'));
  return named && !named.startsWith('-') && remotes.includes(named) ? named : remoteFor(path, branch);
}

async function push(path: string): Promise<void> {
  const tr = await tracking(path);
  noOwnUpstream(tr);
  const remote = await pushRemoteFor(path, tr.branch);
  if (!remote) throw new ActionError('invalid', t('scm.noRemote'));
  // Named here, so the sign-in goes to the very remote git pushes to.
  await git(path, ['push', remote], { timeout: NETWORK_MS, interactive: true, auth: await urlOf(path, remote, true) });
}

async function publish(path: string): Promise<void> {
  const tr = await tracking(path);
  if (!tr.branch) throw new ActionError('invalid', t('scm.detachedPublish'));
  const remote = await remoteFor(path, tr.branch);
  if (!remote) throw new ActionError('invalid', t('scm.noRemote'));
  await git(path, ['push', '-u', remote, `HEAD:refs/heads/${tr.branch}`], { timeout: NETWORK_MS, interactive: true, auth: await urlOf(path, remote, true) });
}

/** VS Code's smart commit: the index as it is, or every change when nothing is staged (read here, never from the panel). */
async function commit(path: string, message: string): Promise<void> {
  const text = message.trim();
  if (!text) throw new ActionError('invalid', t('scm.emptyMessage'));
  if (text.length > MAX_MESSAGE) throw new ActionError('invalid', t('scm.longMessage'));
  const staged = await git(path, ['diff', '--cached', '--quiet']).then(
    () => false,
    () => true,
  );
  if (!staged) await git(path, ['add', '-A']);
  // The message is one argument of -m: never parsed by a shell, never taken for an option.
  await git(path, ['commit', '-m', text], { timeout: COMMIT_MS });
}

async function checkout(path: string, id: string): Promise<void> {
  const refs = await readRefs(path);
  const target = refs.find((r) => r.id === id);
  if (!target) throw new ActionError('invalid', t('scm.branchNotFound'));
  // A ref can be named like an option ("refs/heads/--orphan=x" via update-ref or a fetched remote branch):
  // `git switch` would run it as one.
  const local = target.id.startsWith('refs/heads/') ? shortRef(target.id) : shortRef(target.id).replace(/^[^/]+\//, '');
  if (local.startsWith('-')) throw new ActionError('invalid', t('scm.branchRefused', { name: local }));
  if (target.id.startsWith('refs/heads/')) return void (await git(path, ['switch', local]));
  // A remote branch: switch to the local branch of the same name, created to track it when missing.
  if (refs.some((r) => r.id === `refs/heads/${local}`)) return void (await git(path, ['switch', local]));
  await git(path, ['switch', '--track', shortRef(target.id)]);
}

async function createBranch(path: string, name: string): Promise<void> {
  const clean = name.trim();
  // check-ref-format rejects spaces, "..", "~", "^", ":", a leading dash and the rest of git's rules.
  if (!clean || clean.startsWith('-')) throw new ActionError('invalid', t('scm.badBranch'));
  await git(path, ['check-ref-format', '--branch', clean]).catch(() => {
    throw new ActionError('invalid', t('scm.badBranchNamed', { name: clean }));
  });
  await git(path, ['switch', '-c', clean]);
}

async function abort(path: string): Promise<void> {
  const op = repoState((await git(path, ['rev-parse', '--absolute-git-dir'])).trim());
  if (!op) throw new ActionError('invalid', t('scm.nothingToAbort'));
  await git(path, [op, '--abort']);
}

async function perform(path: string, action: RepoAction): Promise<void> {
  switch (action.kind) {
    case 'fetch':
      if (!(await fetchRemote(path, { interactive: true }))) throw new ActionError('invalid', t('scm.noRemote'));
      return;
    case 'pull':
      return pull(path);
    case 'push':
      return push(path);
    case 'publish':
      return publish(path);
    case 'sync': {
      // VS Code's Sync: pull what is behind, then push what is ahead. Checked first: a branch that tracks
      // another branch (a worktree made from origin/main) must not get main merged in, then fail to push.
      const tr = await tracking(path);
      noOwnUpstream(tr);
      if (tr.behind > 0) await pull(path);
      if ((await tracking(path)).ahead > 0) await push(path);
      return;
    }
    case 'commit':
      return commit(path, action.message);
    case 'stage':
      return void (await git(path, ['--literal-pathspecs', 'add', '-A', '--', ...(await checkedPaths(path, action.paths))]));
    case 'unstage': {
      const paths = await checkedPaths(path, action.paths);
      const born = await git(path, ['rev-parse', '-q', '--verify', 'HEAD']).then(
        () => true,
        () => false,
      );
      return void (await git(path, born ? ['--literal-pathspecs', 'restore', '--staged', '--', ...paths] : ['--literal-pathspecs', 'rm', '--cached', '-r', '-q', '--', ...paths]));
    }
    case 'stage-all':
      return void (await git(path, ['add', '-A']));
    case 'unstage-all':
      return void (await git(path, ['reset', '-q']));
    case 'checkout':
      return checkout(path, action.ref);
    case 'branch':
      return createBranch(path, action.name);
    case 'abort':
      return abort(path);
  }
}

/** Runs an action of the panel; git's refusals come back classified, never thrown. */
export async function runAction(path: string, action: RepoAction): Promise<RepoActionResult> {
  try {
    await perform(path, action);
    return { ok: true };
  } catch (err) {
    return classify(err);
  }
}

const isStrList = (v: unknown, max: number): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.length <= max && v.every((p) => typeof p === 'string' && p.length > 0 && p.length < 4096 && !p.includes('\0'));

/** An action from the renderer, or null when its shape is wrong. */
export function parseAction(value: unknown): RepoAction | null {
  const a = (value ?? {}) as Record<string, unknown>;
  switch (a.kind) {
    case 'fetch':
    case 'pull':
    case 'push':
    case 'sync':
    case 'publish':
    case 'stage-all':
    case 'unstage-all':
    case 'abort':
      return { kind: a.kind };
    case 'commit':
      return typeof a.message === 'string' ? { kind: 'commit', message: a.message } : null;
    case 'stage':
    case 'unstage':
      return isStrList(a.paths, 1000) ? { kind: a.kind, paths: a.paths } : null;
    case 'checkout':
      return typeof a.ref === 'string' && a.ref.startsWith('refs/') ? { kind: 'checkout', ref: a.ref } : null;
    case 'branch':
      return typeof a.name === 'string' && a.name.length < 256 ? { kind: 'branch', name: a.name } : null;
    default:
      return null;
  }
}
