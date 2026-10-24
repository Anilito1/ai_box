import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { RepoAction, RepoActionResult, RepoStatus, RepoTree } from '../shared/types';
import { errorMessage, git } from './git';
import { parseStatus, repoState, runAction, STATUS_ARGS } from './scm';

const POLL_MS = 8_000;
const FETCH_MS = 60_000;

const samePath = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();

/** Folders of `git worktree list --porcelain -z` (NUL-separated, so no path is ever quoted), main folder included. */
const parseWorktrees = (out: string) =>
  out
    .split('\0')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => resolve(l.slice('worktree '.length)));

/** Web page of a remote URL (https, ssh or scp-like), credentials dropped; empty when it is not a web host. */
function webUrl(remote: string): string {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/\s]+@)([^/:\s]+)(?::\d+)?[/:](.+?)(?:\.git)?\/?$/.exec(remote.trim());
  return m && /^[\w.-]+$/.test(m[1]) && /^[\w./-]+$/.test(m[2]) ? `https://${m[1]}/${m[2]}` : '';
}

/** Polls a repo's main folder and worktrees every few seconds, fetches its remote every minute, runs the panel's actions. */
export class RepoWatcher extends EventEmitter {
  status: RepoStatus;
  private timers: NodeJS.Timeout[] = [];
  private reading = false;
  private rereadQueued = false;
  private fetchRun: Promise<void> | null = null;
  private gitDirs = new Map<string, string>();

  constructor(readonly path: string) {
    super();
    this.status = {
      name: basename(path),
      path,
      trees: [],
      refsKey: '',
      webUrl: '',
      fetching: false,
      fetchedAt: null,
      fetchError: '',
      busy: null,
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

  /** Checkout of this repo at exactly `path` (as listed in the status), else undefined. */
  tree(path: unknown): RepoTree | undefined {
    return this.status.trees.find((t) => t.path === path);
  }

  /** Background fetch of the remote, then a re-read. Skipped while one runs or an action holds the repo. */
  fetch(): Promise<void> {
    if (this.fetchRun || this.status.busy) return this.fetchRun ?? Promise.resolve();
    this.fetchRun = (async () => {
      if (!existsSync(this.path)) return;
      this.update({ fetching: true });
      try {
        await git(this.path, ['fetch', '--quiet', '--no-tags'], { timeout: 45_000 });
        this.update({ fetching: false, fetchedAt: Date.now(), fetchError: '' });
      } catch (err) {
        this.update({ fetching: false, fetchError: errorMessage(err) });
      }
    })().finally(() => {
      this.fetchRun = null;
    });
    return this.fetchRun.then(() => this.refresh());
  }

  /** Runs one action of the panel in a checkout; one at a time per repo, never during a background fetch. */
  async act(path: string, action: RepoAction): Promise<RepoActionResult> {
    if (this.status.busy) return { ok: false, kind: 'busy', message: 'Une autre action git est en cours sur ce dépôt', detail: '' };
    this.update({ busy: { path, action: action.kind } });
    try {
      await this.fetchRun;
      const result = await runAction(path, action);
      if (result.ok && (action.kind === 'fetch' || action.kind === 'pull' || action.kind === 'sync')) {
        this.update({ fetchedAt: Date.now(), fetchError: '' });
      }
      return result;
    } finally {
      this.update({ busy: null });
      await this.refresh();
    }
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
      this.update({ error: errorMessage(err) });
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
    const refs = await git(this.path, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/remotes', 'refs/tags']);
    const remote = this.status.webUrl || webUrl(await git(this.path, ['remote', 'get-url', 'origin']).catch(() => ''));
    const trees: RepoTree[] = [];
    // One folder at a time: a burst of parallel git processes would compete with the workers' own.
    for (const p of [this.path, ...others]) trees.push(await this.readTree(p, p === this.path));
    return { error: '', trees, refsKey: createHash('sha1').update(refs).digest('hex').slice(0, 16), webUrl: remote };
  }

  /** A checkout: its changes, and where it stands against its upstream. */
  private async readTree(path: string, main: boolean): Promise<RepoTree> {
    const folder = basename(path);
    const prefix = this.status.name.toLowerCase();
    const label = main ? '' : (folder.toLowerCase().startsWith(prefix) && folder.slice(prefix.length).replace(/^[-_.]+/, '')) || folder;
    const tree: RepoTree = {
      path,
      label,
      branch: '',
      oid: '',
      upstream: '',
      ahead: 0,
      behind: 0,
      state: '',
      files: [],
      changes: 0,
      conflicts: 0,
      error: '',
    };
    try {
      const st = parseStatus(
        await git(path, STATUS_ARGS),
      );
      // No ahead/behind line: the upstream is gone.
      const upstream = st.ab ? st.upstream : '';
      const [ahead, behind] = st.ab ?? [0, 0];
      const oid = st.oid === '(initial)' ? '' : st.oid;
      let gitDir = this.gitDirs.get(path);
      if (!gitDir) {
        gitDir = (await git(path, ['rev-parse', '--absolute-git-dir'])).trim();
        this.gitDirs.set(path, gitDir);
      }
      return {
        ...tree,
        branch: st.branch === '(detached)' ? '' : st.branch,
        oid,
        upstream,
        ahead,
        behind,
        state: repoState(gitDir),
        files: st.files,
        changes: st.total,
        conflicts: st.conflicts,
      };
    } catch (err) {
      return { ...tree, error: errorMessage(err) };
    }
  }

  private update(patch: Partial<RepoStatus>): void {
    const next = { ...this.status, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.status)) return;
    this.status = next;
    this.emit('changed', next);
  }
}
