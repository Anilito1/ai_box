import { isAbsolute, resolve } from 'node:path';
import type { SessionView } from '../shared/types';
import type { UpdateBlock, UpdateKind, UpdateMode, UpdateResult } from '../shared/update';

// Pure logic of the updater, shared by the hub (updater.ts) and the helper that installs once the hub has closed
// (updateHelper.ts): no electron, no i18n.

export const SHA = /^[0-9a-f]{40,64}$/;
/** The branch the official version lives on. */
export const MAIN = 'main';
export const TARGET_REF = 'refs/remotes/origin/main';
/** The official repository was renamed: checkouts whose origin still has the old name stay official. */
const RENAMED: Record<string, string> = { 'github.com/anilito1/claude-hub': 'github.com/anilito1/ai_box' };

/**
 * A repository URL as `host/owner/name` (or `file:<path>` for a local one), lower case, without credentials, port
 * or `.git`: the same repository however it is written (https, ssh, scp-like, npm's `github:` shorthand). Empty
 * when it is not a URL.
 */
export function normalizeRemote(raw: string): string {
  const url = raw.trim().replace(/^git\+/, '');
  if (!url || /\s/.test(url)) return '';
  const tidy = (s: string) => {
    const clean = s.replace(/\\/g, '/').replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
    return RENAMED[clean] ?? clean;
  };
  if (/^github:[\w.-]+\/[\w.-]+$/i.test(url)) return tidy(`github.com/${url.slice('github:'.length)}`);
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) return tidy(`github.com/${url}`);
  if (/^file:\/\//i.test(url)) {
    let path = decodeURIComponent(url.replace(/^file:\/\//i, ''));
    if (/^\/[a-z]:/i.test(path)) path = path.slice(1);
    return isAbsolute(path) ? `file:${tidy(resolve(path))}` : '';
  }
  const web = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(url) ?? /^[\w.-]+@([^/:]+):(?!\/)(.+)$/.exec(url);
  if (web) return /^[\w.-]+$/.test(web[1]) && /^[\w./-]+$/.test(web[2]) && !web[2].split('/').includes('..') ? tidy(`${web[1]}/${web[2]}`) : '';
  return isAbsolute(url) ? `file:${tidy(resolve(url))}` : '';
}

/** The official repository a checkout declares in its package.json (`repository`), normalized; empty when none. */
export function repositoryOf(pkg: unknown): string {
  const repo = (pkg as { repository?: unknown } | null)?.repository;
  const url = typeof repo === 'string' ? repo : typeof (repo as { url?: unknown } | null)?.url === 'string' ? (repo as { url: string }).url : '';
  return normalizeRemote(url);
}

export interface Facts {
  official: boolean;
  /** Current branch, empty when detached. */
  branch: string;
  head: string;
  /** The official main as last fetched, empty when never fetched. */
  target: string;
  /** Files with local modifications, untracked ones included (ignored ones never). */
  dirty: string[];
  behind: number;
  ahead: number;
  /** Diverged, and none of the local commits holds anything of its own (see ownCommits). */
  realignSafe: boolean;
}

/** What a checkout can do with the official main. Nothing is ever proposed over local work. */
export function decide(f: Facts): { kind: UpdateKind; block: UpdateBlock | null } {
  if (!f.official) return { kind: 'unofficial', block: null };
  if (!f.target || !f.head) return { kind: 'none', block: null };
  if (f.head === f.target) return { kind: 'current', block: null };
  if (f.behind === 0) return { kind: 'ahead', block: null };
  if (f.branch !== MAIN) return { kind: 'blocked', block: 'branch' };
  if (f.dirty.length > 0) return { kind: 'blocked', block: 'changes' };
  if (f.ahead === 0) return { kind: 'available', block: null };
  return f.realignSafe ? { kind: 'realign', block: null } : { kind: 'blocked', block: 'commits' };
}

/** Paths of `git status --porcelain=v1 -z`: a rename or copy carries its old path as one more entry. */
export function parseStatus(out: string): string[] {
  const entries = out.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    paths.push(e.slice(3));
    if (e[0] === 'R' || e[0] === 'C') i++;
  }
  return paths;
}

/** A commit as the realignment check reads it (`git log` with FULL_FORMAT and `--date=raw`). */
export interface CommitInfo {
  sha: string;
  tree: string;
  author: string;
  email: string;
  date: string;
  subject: string;
}

export const FULL_FORMAT = '--format=%H%x1f%T%x1f%an%x1f%ae%x1f%ad%x1f%s%x1e';
export function parseFull(out: string): CommitInfo[] {
  return out
    .split('\x1e')
    .map((r) => r.replace(/^\s+/, '').split('\x1f'))
    .filter((f) => f.length === 6 && SHA.test(f[0]))
    .map(([sha, tree, author, email, date, subject]) => ({ sha, tree, author, email, date, subject }));
}

/** Commits `git cherry <upstream> HEAD` marks "-": their change is already upstream (same patch-id). */
export function cherryEquivalents(out: string): Set<string> {
  return new Set(
    out
      .split('\n')
      .map((l) => /^- ([0-9a-f]{40,64})$/.exec(l.trim())?.[1])
      .filter((s): s is string => !!s),
  );
}

/**
 * The local commits that hold work of the user's own, absent from the official history. None when the checkout's
 * files are exactly those of an official commit (same tree). Otherwise a local commit is not the user's own when
 * its change is already upstream (same patch-id, `git cherry`), or when it is the rewritten copy of an upstream
 * commit: same author, same author date to the second and time zone, same subject. A rewrite that removed content
 * changes the patch-id and the tree of every commit after it, which only that last test sees through; what the
 * official side removed on purpose stays in the backup branch made before any realignment.
 */
export function ownCommits(local: CommitInfo[], upstream: CommitInfo[], equivalents: Set<string>, headTree: string): CommitInfo[] {
  if (upstream.some((c) => c.tree === headTree)) return [];
  const key = (c: CommitInfo) => [c.author, c.email, c.date, c.subject].join('\x1f');
  const rewritten = new Set(upstream.map(key));
  return local.filter((c) => !equivalents.has(c.sha) && !rewritten.has(key(c)));
}

/** `backup/pre-update-2026-10-26-0930`, in local time. */
export function backupBranch(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `backup/pre-update-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

/** Credentials and keys a git or npm output could carry, removed before anything is kept or shown. */
export function redact(text: string): string {
  return text
    .replace(/\/\/[^/\s@]+@/g, '//')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[token]')
    .replace(/\bsk-ant-[\w-]{10,}/g, '[key]')
    .replace(/\bnpm_[A-Za-z0-9]{30,}/g, '[token]')
    .replace(/\b(Bearer|Basic|token)\s+[\w.~+/=-]{8,}/gi, '$1 [hidden]')
    .replace(/(_authToken|_auth|_password|password|authorization)(["']?\s*[=:]\s*)\S+/gi, '$1$2[hidden]');
}

// ---------- when to install ----------

/** A session with nothing under way: no turn, approval, start, background task, subagent, compaction, retry or install. */
const quietOne = (s: SessionView) =>
  (s.status === 'idle' || s.status === 'exited') && s.background.length === 0 && s.agents === 0 && !s.compacting && !s.retrying && s.tree?.install !== 'running';

export const sessionsQuiet = (sessions: SessionView[]) => sessions.every(quietOne);
/** Sessions an install now would interrupt. */
export const sessionsAtWork = (sessions: SessionView[]) => sessions.filter((s) => !quietOne(s)).length;

/** How long everything must have been quiet, and the user away from the hub, before an unattended install. */
export const QUIET_MS = 2 * 60_000;
export const AWAY_MS = 5 * 60_000;

export interface Moment {
  mode: UpdateMode;
  kind: UpdateKind;
  /** Since when the sessions are quiet (ms), null while one works. */
  quietFor: number | null;
  /** Since when the user has left the hub alone (window in the background or no input on the computer), ms. */
  awayFor: number;
  /** The user asked to install, while sessions were working. */
  waiting: boolean;
  /** The user said "later" to this update. */
  postponed: boolean;
}

/**
 * Whether to start the countdown to an install now. Asked by the user: as soon as the sessions are quiet. Unattended
 * (auto): quiet for a while, the user away, and not put off.
 */
export function readyToInstall(m: Moment): boolean {
  if (m.kind !== 'available' || m.quietFor === null) return false;
  if (m.waiting) return true;
  return m.mode === 'auto' && !m.postponed && m.quietFor >= QUIET_MS && m.awayFor >= AWAY_MS;
}

// ---------- the install job, handed to the helper ----------

export interface UpdateJob {
  /** The checkout (the app's own folder). */
  root: string;
  /** Normalized official repository: the helper checks `origin` again. */
  remote: string;
  appPid: number;
  from: string;
  to: string;
  /** `ff`: fast-forward. `realign`: hard reset onto the official main, `backup` holding the old commits. */
  mode: 'ff' | 'realign';
  backup: string;
  lockChanged: boolean;
  /** How the hub was started, to start it again. */
  relaunch: { exe: string; args: string[]; cwd: string };
  /** Start the hub again when done (an install the user asked for), or only if a start was asked meanwhile. */
  restart: boolean;
  /** npm's CLI script as `npm start` ran it, when known (`npm_execpath`). */
  npmCli: string;
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isAbs = (v: unknown): v is string => isStr(v) && isAbsolute(v) && !v.includes('\0');

/** A job file read back: every field checked, as it decides what runs. */
export function parseJob(raw: unknown): UpdateJob | null {
  const j = (raw ?? {}) as Record<string, unknown>;
  const r = (j.relaunch ?? {}) as Record<string, unknown>;
  const ok =
    isAbs(j.root) &&
    isStr(j.remote) &&
    j.remote !== '' &&
    Number.isInteger(j.appPid) &&
    isStr(j.from) &&
    SHA.test(j.from) &&
    isStr(j.to) &&
    SHA.test(j.to) &&
    (j.mode === 'ff' || (j.mode === 'realign' && isStr(j.backup) && /^backup\/pre-update-[\w-]+$/.test(j.backup))) &&
    typeof j.lockChanged === 'boolean' &&
    isAbs(r.exe) &&
    Array.isArray(r.args) &&
    r.args.every(isStr) &&
    isAbs(r.cwd) &&
    typeof j.restart === 'boolean' &&
    isStr(j.npmCli);
  return ok ? (j as unknown as UpdateJob) : null;
}

const STEPS: UpdateResult['step'][] = ['', 'check', 'git', 'install', 'build'];

/** The helper's result file read back, or null when it is not one. */
export function parseResult(raw: unknown): UpdateResult | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const ok =
    typeof r.ok === 'boolean' &&
    STEPS.includes(r.step as UpdateResult['step']) &&
    typeof r.at === 'number' &&
    typeof r.restored === 'boolean' &&
    isStr(r.detail) &&
    isStr(r.to) &&
    (r.to === '' || SHA.test(r.to));
  return ok ? { ok: r.ok as boolean, step: r.step as UpdateResult['step'], at: r.at as number, restored: r.restored as boolean, detail: (r.detail as string).slice(0, 8000), to: r.to as string } : null;
}

/** Where npm's CLI script may be, for the Node.js running the helper: as `npm start` ran it, then beside Node. */
export function npmCliCandidates(nodePath: string, platform: NodeJS.Platform, execPath: string): string[] {
  const list: string[] = [];
  if (/[\\/]npm-cli\.js$/.test(execPath) && isAbsolute(execPath)) list.push(execPath);
  const dir = nodePath.replace(/[\\/][^\\/]+$/, '');
  list.push(platform === 'win32' ? `${dir}/node_modules/npm/bin/npm-cli.js` : `${dir}/../lib/node_modules/npm/bin/npm-cli.js`);
  return list;
}

/** A failure of npm that another try may not have: a file still held by a process that is closing. */
export const retryable = (output: string) => /\b(EBUSY|EPERM|ENOTEMPTY|EACCES)\b/.test(output);
