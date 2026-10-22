import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { RepoCommit, RepoFile, RepoStatus } from '../shared/types';

const POLL_MS = 5_000;
const FETCH_MS = 60_000;
const COMMITS_MAX = 10;
const FILES_MAX = 20;
// A background fetch must fail instead of waiting for credentials, and status must never take the optional
// index lock: workers run git in this repo at the same time.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_OPTIONAL_LOCKS: '0' };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function git(cwd: string, args: string[], timeout = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { env: GIT_ENV, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new Error('git introuvable dans le PATH'));
      const line = stderr.split('\n').find((l) => l.trim()) ?? err.message;
      // Remote URLs in git errors may carry credentials.
      reject(new Error(line.trim().replace(/\/\/[^/@\s]+@/g, '//')));
    });
  });
}

async function log(cwd: string, args: string[]): Promise<RepoCommit[]> {
  const out = await git(cwd, ['log', '--format=%h%x1f%s%x1f%an%x1f%ct', ...args]);
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

/** Polls a repo's local state every few seconds and fetches its remote every minute. */
export class RepoWatcher extends EventEmitter {
  status: RepoStatus;
  private timers: NodeJS.Timeout[] = [];
  private reading = false;
  private rereadQueued = false;

  constructor(private readonly path: string) {
    super();
    this.status = {
      name: basename(path),
      path,
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
      fetching: false,
      fetchedAt: null,
      fetchError: '',
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

  /** Fetches the branch's remote, then re-reads the state. No-op while a fetch is in flight. */
  async fetch(): Promise<void> {
    if (this.status.fetching) return;
    if (!existsSync(this.path)) return this.refresh();
    this.update({ fetching: true });
    try {
      await git(this.path, ['fetch', '--quiet', '--no-tags'], 45_000);
      this.update({ fetching: false, fetchedAt: Date.now(), fetchError: '' });
    } catch (err) {
      this.update({ fetching: false, fetchError: message(err) });
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
    const st = parseStatus(await git(this.path, ['status', '--porcelain=v2', '--branch']));
    let base = st.upstream;
    let ab = st.ab;
    if (!base || !ab) {
      // No upstream (or it is gone): measure against the remote's default branch instead.
      base = (await git(this.path, ['rev-parse', '--abbrev-ref', 'origin/HEAD']).catch(() => '')).trim();
      if (base) {
        const [left, right] = (await git(this.path, ['rev-list', '--left-right', '--count', `HEAD...${base}`])).trim().split(/\s+/);
        ab = [Number(left), Number(right)];
      }
    }
    const [ahead, behind] = ab ?? [0, 0];
    const [head, incoming, outgoing] = await Promise.all([
      st.oid && st.oid !== '(initial)' ? log(this.path, ['-1', 'HEAD']).then((c) => c[0] ?? null) : null,
      behind ? log(this.path, [`-${COMMITS_MAX}`, `HEAD..${base}`]) : [],
      ahead ? log(this.path, [`-${COMMITS_MAX}`, `${base}..HEAD`]) : [],
    ]);
    return {
      error: '',
      branch: st.branch === '(detached)' ? `détachée ${st.oid.slice(0, 7)}` : st.branch,
      base,
      ahead,
      behind,
      changes: st.files.length,
      conflicts: st.conflicts,
      files: st.files.slice(0, FILES_MAX),
      head,
      incoming,
      outgoing,
    };
  }

  private update(patch: Partial<RepoStatus>): void {
    const next = { ...this.status, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.status)) return;
    this.status = next;
    this.emit('changed', next);
  }
}
