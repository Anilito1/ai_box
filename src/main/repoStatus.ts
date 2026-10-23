import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { RepoCommit, RepoFile, RepoStatus, RepoTree } from '../shared/types';

const POLL_MS = 8_000;
const FETCH_MS = 60_000;
// A worktree only needs a glimpse in the sidebar; the main folder gets the full detail.
const LIMITS = { main: { commits: 10, files: 20 }, worktree: { commits: 5, files: 10 } };
// A background fetch must fail instead of waiting for credentials, and status must never take the optional
// index lock: workers run git in these folders at the same time.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_OPTIONAL_LOCKS: '0' };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const samePath = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();

function git(cwd: string, args: string[], timeout = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { env: GIT_ENV, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new Error('git introuvable dans le PATH'));
      const line = stderr.split('\n').find((l) => l.trim()) ?? err.message;
      // Remote URLs in git errors may carry credentials.
      reject(new Error(line.trim().replace(/\/\/[^/\s]*@/g, '//')));
    });
  });
}

async function log(cwd: string, args: string[]): Promise<RepoCommit[]> {
  // `--` ends the revisions: a file named like a ref can never make git read it as a path.
  const out = await git(cwd, ['log', '--format=%h%x1f%s%x1f%an%x1f%ct', ...args, '--']);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, subject, author, ct] = line.split('\x1f');
      return { hash, subject, author, at: Number(ct) * 1000 };
    });
}

interface Porcelain {
  oid: string;
  branch: string;
  upstream: string;
  ab: [number, number] | null;
  files: RepoFile[];
  conflicts: number;
}

/** `git status --porcelain=v2 --branch`; a path is everything after the fixed fields of its entry type. */
function parseStatus(out: string): Porcelain {
  const st: Porcelain = { oid: '', branch: '', upstream: '', ab: null, files: [], conflicts: 0 };
  const rest = (line: string, fields: number) => line.split(' ').slice(fields).join(' ');
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('# branch.oid ')) st.oid = line.slice(13);
    else if (line.startsWith('# branch.head ')) st.branch = line.slice(14);
    else if (line.startsWith('# branch.upstream ')) st.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) st.ab = [Number(m[1]), Number(m[2])];
    } else if (line.startsWith('1 ')) st.files.push({ code: line.slice(2, 4).replace(/\./g, ' '), path: rest(line, 8) });
    else if (line.startsWith('2 ')) st.files.push({ code: line.slice(2, 4).replace(/\./g, ' '), path: rest(line, 9).split('\t')[0] });
    else if (line.startsWith('u ')) {
      st.conflicts++;
      st.files.push({ code: 'UU', path: rest(line, 10) });
    } else if (line.startsWith('? ')) st.files.push({ code: '??', path: line.slice(2) });
  }
  return st;
}

/** Folders of `git worktree list --porcelain -z` (NUL-separated, so no path is ever quoted), main folder included. */
const parseWorktrees = (out: string) =>
  out
    .split('\0')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => resolve(l.slice('worktree '.length)));

/** Polls a repo's main folder and worktrees every few seconds and fetches its remote every minute. */
export class RepoWatcher extends EventEmitter {
  status: RepoStatus;
  private timers: NodeJS.Timeout[] = [];
  private reading = false;
  private rereadQueued = false;
  private pullQueued = false;

  constructor(readonly path: string) {
    super();
    this.status = {
      name: basename(path),
      path,
      trees: [],
      fetching: false,
      fetchedAt: null,
      fetchError: '',
      pulling: false,
      pullError: '',
      error: '',
    };
  }

  start(): void {
    void this.fetch();
    this.timers.push(
      setInterval(() => void this.refresh(), POLL_MS),
      setInterval(() => void this.fetch(), FETCH_MS),
    );
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
  }

  /** Fetches the remote, then re-reads the state. No-op while a fetch or pull is in flight. */
  async fetch(): Promise<void> {
    if (this.status.fetching || this.status.pulling) return;
    if (!existsSync(this.path)) return this.refresh();
    this.update({ fetching: true });
    try {
      await git(this.path, ['fetch', '--quiet', '--no-tags'], 45_000);
      this.update({ fetching: false, fetchedAt: Date.now(), fetchError: '', pullError: '' });
    } catch (err) {
      this.update({ fetching: false, fetchError: message(err) });
    }
    await this.refresh();
    if (this.pullQueued) {
      this.pullQueued = false;
      await this.pull();
    }
  }

  /** Fast-forwards the main folder onto its upstream; git refuses when it diverged or would overwrite local changes. */
  async pull(): Promise<void> {
    if (this.status.pulling) return;
    if (this.status.fetching) {
      this.pullQueued = true; // Runs as soon as the fetch in flight ends.
      return;
    }
    this.update({ pulling: true, pullError: '' });
    try {
      await git(this.path, ['pull', '--no-rebase', '--ff-only', '--quiet'], 60_000);
      this.update({ pulling: false, fetchedAt: Date.now(), fetchError: '' });
    } catch (err) {
      this.update({ pulling: false, pullError: message(err) });
    }
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.reading) {
      this.rereadQueued = true;
      return;
    }
    this.reading = true;
    try {
      this.update(await this.read());
    } catch (err) {
      this.update({ error: message(err) });
    } finally {
      this.reading = false;
    }
    if (this.rereadQueued) {
      this.rereadQueued = false;
      void this.refresh();
    }
  }

  private async read(): Promise<Partial<RepoStatus>> {
    if (!existsSync(this.path)) throw new Error(`Dossier introuvable : ${this.path}`);
    const listed = parseWorktrees(await git(this.path, ['worktree', 'list', '--porcelain', '-z']));
    // A worktree whose folder was deleted without `git worktree remove` stays listed until pruned.
    const others = listed.filter((p) => !samePath(p, this.path) && existsSync(p));
    const defaultBranch = (await git(this.path, ['rev-parse', '--abbrev-ref', 'origin/HEAD']).catch(() => '')).trim();
    const trees: RepoTree[] = [];
    // One folder at a time: a burst of parallel git processes would compete with the workers' own.
    for (const p of [this.path, ...others]) trees.push(await this.readTree(p, p === this.path, defaultBranch));
    return { error: '', trees };
  }

  /** The main folder is measured against its upstream; a worktree against the default branch it is meant to land on. */
  private async readTree(path: string, main: boolean, defaultBranch: string): Promise<RepoTree> {
    const limits = main ? LIMITS.main : LIMITS.worktree;
    const folder = basename(path);
    const prefix = this.status.name.toLowerCase();
    const label = main ? '' : (folder.toLowerCase().startsWith(prefix) && folder.slice(prefix.length).replace(/^[-_.]+/, '')) || folder;
    const tree: RepoTree = {
      path,
      label,
      branch: '',
      base: '',
      ahead: 0,
      behind: 0,
      changes: 0,
      conflicts: 0,
      files: [],
      head: null,
      incoming: [],
      outgoing: [],
      error: '',
    };
    try {
      const st = parseStatus(await git(path, ['-c', 'core.quotePath=false', 'status', '--porcelain=v2', '--branch']));
      let base = main ? st.upstream : '';
      let ab = main ? st.ab : null;
      if (!base || !ab) {
        // No upstream (or it is gone): measure against the remote's default branch instead.
        base = defaultBranch;
        if (base) {
          const [left, right] = (await git(path, ['rev-list', '--left-right', '--count', `HEAD...${base}`, '--'])).trim().split(/\s+/);
          ab = [Number(left), Number(right)];
        }
      }
      const [ahead, behind] = ab ?? [0, 0];
      const [head, incoming, outgoing] = await Promise.all([
        st.oid && st.oid !== '(initial)' ? log(path, ['-1', 'HEAD']).then((c) => c[0] ?? null) : null,
        behind ? log(path, [`-${limits.commits}`, `HEAD..${base}`]) : [],
        ahead ? log(path, [`-${limits.commits}`, `${base}..HEAD`]) : [],
      ]);
      return {
        ...tree,
        branch: st.branch === '(detached)' ? `détachée ${st.oid.slice(0, 7)}` : st.branch,
        base,
        ahead,
        behind,
        changes: st.files.length,
        conflicts: st.conflicts,
        files: st.files.slice(0, limits.files),
        head,
        incoming,
        outgoing,
      };
    } catch (err) {
      return { ...tree, error: message(err) };
    }
  }

  private update(patch: Partial<RepoStatus>): void {
    const next = { ...this.status, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.status)) return;
    this.status = next;
    this.emit('changed', next);
  }
}
