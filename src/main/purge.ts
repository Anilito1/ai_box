import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { cp, lstat, mkdir, readdir, realpath, rename, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  classify,
  citationKeys,
  globTest,
  outputPattern,
  PURGE_CATEGORIES,
  QUARANTINE_DAYS,
  SCRATCH_PARENT,
  type PurgeCategory,
  type PurgeEntry,
  type PurgeLogEntry,
  type PurgeLogItem,
  type PurgeProject,
  type PurgeProjectSource,
  type PurgeReport,
  type PurgeRestoreResult,
  type PurgeSettingsView,
  type PurgeSkip,
  type PurgeTrashResult,
} from '../shared/purge';
import type { ActivityRecord, TranscriptFacts, TranscriptFormat } from './purgeIndex';

// The purge of ephemeral files, project by project (docs/purge-ephemeres.md). Scans propose; only what the user
// ticks moves, after every check is made again, to the system's trash or the app's quarantine. Nothing is deleted.

const MAX_FILES = 250_000;
const RECENT_MS = 10 * 60_000;
/** Clock slack between a transcript's times and a file's dates. */
const SLACK_MS = 5_000;
const ACTIVITY_DAYS = 120;
const LOG_MAX = 300;
const DAY = 86_400_000;

/** Folders never walked into. Hidden folders are skipped too, but for the hub's own and the tool caches named here. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn', '.venv', 'venv', '.tox', 'bower_components', 'site-packages', '__pypackages__']);
const HIDDEN_OK = new Set([SCRATCH_PARENT, '.nyc_output', '.pytest_cache', '.mypy_cache', '.ruff_cache']);

export interface PurgeOptions {
  dataDir: string;
  index: { all(): Promise<TranscriptFacts[]>; counts(): Record<TranscriptFormat, number> };
  /** The system trash (Electron's shell.trashItem). */
  trash(path: string): Promise<void>;
  /** Folders the hub knows: followed repos, the folders of its sessions. */
  known(): { root: string; source: PurgeProjectSource }[];
  /** Folders too wide to be a project: the workspaces that hold the repos, the standard folders of the user. */
  broad(): string[];
  /** Scratch folders of the sessions at work right now. */
  busyScratch(): string[];
  /** `git -C cwd …`, its output. */
  git(cwd: string, args: string[]): Promise<string>;
  now?(): number;
  platform?: NodeJS.Platform;
  /** System folders a project may never be in (tests replace them). */
  systemDirs?: string[];
}

/** A file as the walk saw it. */
interface Seen {
  abs: string;
  rel: string;
  key: string;
  size: number;
  mtime: number;
  birth: number;
  /** The system gave the file's creation date (some Linux file systems do not: birth is then its last change). */
  birthKnown: boolean;
}

interface Scan {
  id: string;
  root: string;
  appScratch: boolean;
  repos: string[];
  /** Every file seen, by key. */
  files: Map<string, Seen>;
  /** Folders (relative keys) that held something not listed: a link, a skipped folder, an unreadable part. */
  dirty: Set<string>;
  entries: Map<number, { seen: Seen; category: PurgeCategory }>;
}

/** A purge as the journal keeps it: the view only gets its PurgeLogEntry side. */
interface LogItem extends PurgeLogItem {
  abs: string;
  /** Where the quarantine keeps it. */
  q?: string;
  expired?: boolean;
}
interface LogEntry extends Omit<PurgeLogEntry, 'items'> {
  items: LogItem[];
}

interface Settings {
  added: string[];
  exclude: Record<string, string[]>;
}

export type RootProblem = 'relative' | 'network' | 'missing' | 'wide' | 'system' | 'appData';

export class PurgeService {
  private readonly dir: string;
  private readonly caseBlind: boolean;
  private readonly now: () => number;
  private scans = new Map<string, Scan>();
  /** Roots the view may scan: those the last listing gave it. */
  private allowed = new Map<string, PurgeProject>();
  private activity: ActivityRecord[] = [];
  private log: LogEntry[] = [];
  private settings: Settings = { added: [], exclude: {} };

  constructor(private readonly opts: PurgeOptions) {
    this.dir = join(opts.dataDir, 'purge');
    this.caseBlind = (opts.platform ?? process.platform) !== 'linux';
    this.now = opts.now ?? Date.now;
    this.load();
  }

  // ---------- paths ----------

  /**
   * A path as a comparison key: absolute, "/" separators, no trailing "/", one Unicode form (git lists names in NFC,
   * a Mac disk may hold them in NFD), lowercase where the system ignores case.
   */
  key(p: string): string {
    const k = resolve(p).replace(/\\/g, '/').replace(/(.)\/+$/, '$1').normalize('NFC');
    return this.caseBlind ? k.toLowerCase() : k;
  }

  private within(parentKey: string, k: string): boolean {
    return k === parentKey || k.startsWith(parentKey.endsWith('/') ? parentKey : `${parentKey}/`);
  }

  /** Why `root` cannot be a project, or null. */
  rootProblem(root: string): RootProblem | null {
    if (!isAbsolute(root)) return 'relative';
    if (/^[\\/]{2}/.test(root)) return 'network';
    const k = this.key(root);
    const home = this.key(homedir());
    if (dirname(resolve(root)) === resolve(root) || this.within(k, home)) return 'wide';
    if (this.opts.broad().some((b) => this.key(b) === k)) return 'wide';
    const data = this.key(this.opts.dataDir);
    // Inside the app's data, or holding it (a portable install): its quarantine would be scanned.
    if (this.within(data, k) || this.within(k, data)) return 'appData';
    if (this.systemDirs().some((s) => this.within(this.key(s), k))) return 'system';
    // The programs' own folders in the home folder (.claude, .codex, .config…).
    if (this.within(home, k) && k.slice(home.length + 1).startsWith('.')) return 'system';
    return null;
  }

  private systemDirs(): string[] {
    if (this.opts.systemDirs) return this.opts.systemDirs;
    const home = homedir();
    const platform = this.opts.platform ?? process.platform;
    if (platform === 'win32') {
      const env = process.env;
      return [env.SystemRoot || 'C:\\Windows', env.ProgramFiles || 'C:\\Program Files', env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', env.ProgramData || 'C:\\ProgramData', join(home, 'AppData')];
    }
    const common = ['/usr', '/bin', '/sbin', '/etc', '/var', '/opt', '/dev', '/private', tmpdir()];
    return platform === 'darwin' ? [...common, '/System', '/Library', '/Applications', '/cores', join(home, 'Library')] : [...common, '/lib', '/lib64', '/proc', '/sys', '/boot', '/run', '/snap'];
  }

  // ---------- projects ----------

  /** The projects the view lists: known folders, added ones, the app's own scratch area. */
  projects(): PurgeProject[] {
    const out = new Map<string, PurgeProject>();
    const add = (root: string, source: PurgeProjectSource) => {
      const k = this.key(root);
      if (out.has(k) || this.rootProblem(root) || !isDirSync(root)) return;
      out.set(k, { root: resolve(root), name: basename(resolve(root)), source });
    };
    for (const p of this.opts.known()) add(p.root, p.source);
    for (const r of this.activity) add(r.cwd, 'session');
    for (const r of this.settings.added) add(r, 'added');
    const scratch = this.appScratchDir();
    if (isDirSync(scratch)) out.set(this.key(scratch), { root: scratch, name: basename(scratch), source: 'appScratch' });
    for (const [k, p] of out) this.allowed.set(k, p);
    return [...out.values()];
  }

  /** The folders right under a wide one (the Desktop) where agents wrote, not listed yet: the projects of before. */
  async suggestions(): Promise<PurgeProject[]> {
    const listed = new Set(this.projects().map((p) => this.key(p.root)));
    const broad = this.opts.broad().map((b) => ({ abs: resolve(b), key: this.key(b) }));
    const found = new Map<string, { abs: string; at: number }>();
    for (const f of await this.opts.index.all()) {
      for (const a of f.acts) {
        for (const p of a.paths) {
          const k = this.key(p);
          for (const b of broad) {
            if (!this.within(b.key, k) || k === b.key) continue;
            const first = k.slice(b.key.length + 1).split('/')[0];
            const top = join(b.abs, relative(b.abs, resolve(p)).split(/[\\/]/)[0]);
            const tk = `${b.key}/${first}`;
            if (listed.has(tk) || [...listed].some((l) => this.within(l, tk))) continue;
            const prev = found.get(tk);
            if (!prev || prev.at < a.end) found.set(tk, { abs: top, at: a.end });
          }
        }
      }
    }
    const out: PurgeProject[] = [];
    for (const [k, v] of [...found.entries()].sort((x, y) => y[1].at - x[1].at).slice(0, 40)) {
      if (this.rootProblem(v.abs) || !isDirSync(v.abs)) continue;
      const p: PurgeProject = { root: v.abs, name: basename(v.abs), source: 'suggested' };
      this.allowed.set(k, p);
      out.push(p);
    }
    return out;
  }

  /** Adds a folder the user picked; why not, else null. */
  addProject(root: string): RootProblem | null {
    const problem = this.rootProblem(root) ?? (isDirSync(root) ? null : 'missing');
    if (problem) return problem;
    if (!this.settings.added.some((r) => this.key(r) === this.key(root))) this.settings.added.push(resolve(root));
    this.saveSettings();
    return null;
  }

  removeProject(root: string): void {
    this.settings.added = this.settings.added.filter((r) => this.key(r) !== this.key(root));
    this.saveSettings();
  }

  /** A root the last listing gave the view. */
  isAllowed(root: unknown): root is string {
    return typeof root === 'string' && isAbsolute(root) && this.allowed.has(this.key(root));
  }

  /** The file of an entry of a scan still current, to show it in the file manager. */
  pathOf(scanId: unknown, id: unknown): string | null {
    const scan = typeof scanId === 'string' ? this.scans.get(scanId) : undefined;
    return (typeof id === 'number' && scan?.entries.get(id)?.seen.abs) || null;
  }

  appScratchDir(): string {
    return join(this.opts.dataDir, 'scratch');
  }

  // ---------- settings ----------

  projectSettings(root: string): PurgeSettingsView {
    return { exclude: [...(this.settings.exclude[this.key(root)] ?? [])] };
  }

  saveProjectSettings(root: string, exclude: unknown): PurgeSettingsView {
    const list = Array.isArray(exclude) ? exclude.filter((p): p is string => typeof p === 'string').map((p) => p.trim()).filter(Boolean).slice(0, 200) : [];
    this.settings.exclude[this.key(root)] = [...new Set(list.map((p) => p.slice(0, 300)))];
    this.saveSettings();
    return this.projectSettings(root);
  }

  // ---------- the hub's journal of activity ----------

  recordActivity(r: ActivityRecord): void {
    if (!r.cwd || !(r.end >= r.start)) return;
    this.activity.push(r);
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(join(this.dir, 'activity.jsonl'), `${JSON.stringify(r)}\n`);
    } catch {
      /* the scan falls back on the transcripts */
    }
  }

  activityRecords(): ActivityRecord[] {
    return this.activity;
  }

  // ---------- scan ----------

  async scan(root: string): Promise<PurgeReport> {
    const project = this.allowed.get(this.key(root));
    if (!project) throw new Error('unknown project');
    const started = this.now();
    const appScratch = project.source === 'appScratch';
    const realRoot = await realpath(project.root);
    if (!appScratch && this.rootProblem(realRoot)) throw new Error('unsafe project');
    // The app's scratch area must really be the app's: a link from there to another folder would make it all scratch.
    if (appScratch && !this.within(this.key(join(await realpath(this.opts.dataDir), 'scratch')), this.key(realRoot))) throw new Error('unsafe project');
    const walk = await this.walk(realRoot);
    const tracked = await this.trackedSets(realRoot, walk.repos);
    const facts = await this.opts.index.all();
    const prov = this.provenance(realRoot, facts);
    const tests = (this.settings.exclude[this.key(project.root)] ?? []).map((p) => globTest(p, this.caseBlind)).filter((t): t is (rel: string) => boolean => !!t);
    const busy = this.opts.busyScratch().map((d) => this.key(d));
    const now = this.now();

    const scan: Scan = { id: randomUUID(), root: realRoot, appScratch, repos: walk.repos, files: new Map(), dirty: walk.dirty, entries: new Map() };
    const entries: PurgeEntry[] = [];
    const totals = Object.fromEntries(PURGE_CATEGORIES.map((c) => [c, { count: 0, bytes: 0 }])) as PurgeReport['totals'];
    let bytes = 0;
    for (const f of walk.files) {
      scan.files.set(f.key, f);
      bytes += f.size;
      const relKey = this.caseBlind ? f.rel.toLowerCase() : f.rel;
      const p = prov.of(f);
      // Changed after its birth while no agent worked: someone else touched it (provenance or not, scratch included).
      const touchedOutside = f.mtime > f.birth + 2000 && !prov.active(f.mtime) && !(p.kind === 'write' && f.mtime <= p.last + SLACK_MS * 2);
      const classed = classify({
        rel: f.rel,
        appScratch,
        tracked: trackedState(tracked, f.key, (a, b) => this.within(a, b)),
        cited: prov.cited(f.key.toLowerCase(), relKey.toLowerCase()),
        provenance: p.kind,
        touchedOutside,
        excluded: tests.some((t) => t(f.rel)),
        recent: now - f.mtime < RECENT_MS,
        running: busy.some((b) => this.within(b, f.key)),
      });
      if (!classed) continue;
      const id = entries.length;
      entries.push({ id, rel: f.rel, size: f.size, mtime: f.mtime, ...classed, sessions: p.sessions });
      scan.entries.set(id, { seen: f, category: classed.category });
      totals[classed.category].count++;
      totals[classed.category].bytes += f.size;
    }
    // One scan per project: an older one's ids would mean nothing now.
    for (const [id, s] of this.scans) if (this.key(s.root) === this.key(realRoot)) this.scans.delete(id);
    this.scans.set(scan.id, scan);
    const counts = this.opts.index.counts();
    return {
      root: project.root,
      name: project.name,
      scanId: scan.id,
      scannedAt: now,
      durationMs: this.now() - started,
      files: walk.files.length,
      bytes,
      entries,
      totals,
      partial: walk.partial,
      sources: { claude: counts.claude, codex: counts.codex, gemini: counts.gemini, activity: this.activity.length },
    };
  }

  /** Every file under `root`, links never followed, skipped folders never entered. */
  private async walk(root: string): Promise<{ files: Seen[]; repos: string[]; dirty: Set<string>; partial: PurgeReport['partial'] }> {
    const files: Seen[] = [];
    const repos: string[] = [];
    const dirty = new Set<string>();
    let partial: PurgeReport['partial'] = '';
    const stack: string[] = [root];
    let n = 0;
    const markDirty = (dir: string) => {
      // The folder and each one above it hold something the scan did not list.
      for (let rel = relative(root, dir).replace(/\\/g, '/'); ; rel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '') {
        dirty.add(this.caseBlind ? rel.toLowerCase() : rel);
        if (!rel) break;
      }
    };
    while (stack.length) {
      const dir = stack.pop() as string;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        partial ||= 'unreadable';
        markDirty(dir);
        continue;
      }
      const inAibox = basename(dir) === SCRATCH_PARENT;
      if (entries.some((e) => e.name === '.git')) repos.push(dir);
      const batch: string[] = [];
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isSymbolicLink()) {
          markDirty(dir);
        } else if (e.isDirectory()) {
          const skip = SKIP_DIRS.has(e.name) || (e.name.startsWith('.') && !HIDDEN_OK.has(e.name)) || (inAibox && e.name !== 'scratch');
          if (skip) markDirty(dir);
          else stack.push(p);
        } else if (e.isFile()) {
          if (inAibox) markDirty(dir); // .aibox/.gitignore and the like: the hub's, never proposed.
          else batch.push(p);
        } else markDirty(dir);
      }
      for (let i = 0; i < batch.length; i += 64) {
        const part = await Promise.all(
          batch.slice(i, i + 64).map(async (p) => {
            try {
              const st = await lstat(p);
              return st.isFile() ? { p, st } : null;
            } catch {
              return null;
            }
          }),
        );
        for (const r of part) {
          if (!r) {
            markDirty(dir);
            continue;
          }
          const known = r.st.birthtimeMs > 0 && r.st.birthtimeMs <= r.st.mtimeMs + SLACK_MS;
          const birth = known ? r.st.birthtimeMs : r.st.mtimeMs;
          files.push({ abs: r.p, rel: relative(root, r.p).replace(/\\/g, '/'), key: this.key(r.p), size: r.st.size, mtime: r.st.mtimeMs, birth, birthKnown: known });
        }
      }
      n += entries.length;
      if (files.length >= MAX_FILES) {
        partial = 'tooMany';
        markDirty(root);
        break;
      }
      if (n > 2000) {
        n = 0;
        await new Promise<void>((r) => setImmediate(r));
      }
    }
    return { files, repos, dirty, partial };
  }

  /** Tracked files of each repo under (or around) the root; null for a repo git could not read. */
  private async trackedSets(root: string, repos: string[]): Promise<Map<string, Set<string> | null>> {
    const dirs = [...repos];
    if (!repos.some((r) => this.key(r) === this.key(root)) && repoAbove(root)) dirs.push(root);
    const out = new Map<string, Set<string> | null>();
    await Promise.all(
      dirs.map(async (dir) => {
        try {
          const list = await this.opts.git(dir, ['ls-files', '-z', '--cached']);
          out.set(this.key(dir), new Set(list.split('\0').filter(Boolean).map((p) => this.key(join(dir, p)))));
        } catch {
          out.set(this.key(dir), null);
        }
      }),
    );
    return out;
  }

  /** What the transcripts and the journal say about the files of this root. */
  private provenance(root: string, facts: TranscriptFacts[]) {
    const rootKey = this.key(root);
    const writes = new Map<string, { first: number; last: number; session: string }>();
    const targets = new Map<string, { start: number; end: number; session: string }[]>();
    const patterns: { dir: string; rx: RegExp; start: number; end: number; session: string }[] = [];
    const windows: { start: number; end: number; session: string }[] = [];
    const cites = new Set<string>();
    const lowerRoot = rootKey.toLowerCase();
    for (const f of facts) {
      const cwdKeys = f.cwds.map((c) => this.key(c));
      const inside = cwdKeys.some((c) => this.within(rootKey, c));
      const around = cwdKeys.some((c) => this.within(c, rootKey));
      const touches = f.acts.some((a) => a.paths.some((p) => this.within(rootKey, this.key(p))));
      if (inside || around) for (const c of f.cites) cites.add(c);
      else for (const c of f.cites) if (c.startsWith(lowerRoot)) cites.add(c); // A full path into this project, from anywhere.
      if (!inside && !touches) continue;
      for (const a of f.acts) {
        windows.push({ start: a.start, end: a.end, session: f.session });
        for (const p of a.paths) {
          const k = this.key(p);
          if (!this.within(rootKey, k) || k === rootKey) continue;
          if (a.kind === 'write') {
            const w = writes.get(k);
            writes.set(k, { first: Math.min(w?.first ?? Infinity, a.start), last: Math.max(w?.last ?? -Infinity, a.end), session: w && w.last > a.end ? w.session : f.session });
            continue;
          }
          const rx = outputPattern(k);
          if (rx) patterns.push({ dir: k.slice(0, k.lastIndexOf('/')), rx, start: a.start, end: a.end, session: f.session });
          else {
            const list = targets.get(k) ?? [];
            list.push({ start: a.start, end: a.end, session: f.session });
            targets.set(k, list);
          }
        }
      }
    }
    const merged = mergeWindows(windows);
    const born = (t: number, w: { start: number; end: number }) => t >= w.start - SLACK_MS && t <= w.end + SLACK_MS;
    const active = (t: number) => findWindow(merged, t) !== null;
    return {
      active,
      cited: (absKey: string, relKey: string) => citationKeys(absKey, relKey).some((k) => cites.has(k)),
      of: (f: Seen): { kind: 'write' | 'command' | 'session' | null; last: number; sessions: string[] } => {
        const explicit = (kind: 'write' | 'command', last: number, sessions: string[]) =>
          // Without a creation date, nothing proves the agent made the file rather than changed it: weak only.
          f.birthKnown ? { kind, last, sessions } : { kind: 'session' as const, last, sessions };
        const w = writes.get(f.key);
        // Made by the agent's write, not a file of before that it only edited (or one made again since).
        if (w && f.birth >= w.first - SLACK_MS && f.birth <= w.last + SLACK_MS) return explicit('write', w.last, [w.session]);
        // The file, a folder above it, or a frame pattern, named by a command that ran while the file was born.
        const hits: string[] = [];
        for (let k = f.key; k.length > rootKey.length; k = k.slice(0, k.lastIndexOf('/'))) {
          for (const t of targets.get(k) ?? []) if (born(f.birth, t)) hits.push(t.session);
          if (hits.length) break;
        }
        for (const p of patterns) if (hits.length === 0 && f.key.startsWith(`${p.dir}/`) && p.rx.test(f.key) && born(f.birth, p)) hits.push(p.session);
        if (hits.length) return explicit('command', 0, [...new Set(hits)]);
        const win = findWindow(merged, f.birth);
        return win ? { kind: 'session', last: 0, sessions: [...win.sessions] } : { kind: null, last: 0, sessions: [] };
      },
    };
  }

  // ---------- trash ----------

  async trash(scanId: string, ids: unknown): Promise<PurgeTrashResult> {
    const scan = this.scans.get(scanId);
    const result: PurgeTrashResult = { trashed: 0, quarantined: 0, bytes: 0, skipped: [], logId: '' };
    if (!scan || !Array.isArray(ids)) return { ...result, stale: true };
    // A scan is used once: what it saw changes with what moves now.
    this.scans.delete(scanId);
    const chosen = new Map<string, Seen>();
    for (const id of ids) {
      const e = typeof id === 'number' ? scan.entries.get(id) : undefined;
      if (e && e.category !== 'protected') chosen.set(e.seen.key, e.seen);
    }
    if (!chosen.size) return result;
    const tracked = await this.trackedSets(scan.root, scan.repos);
    const rootKey = this.key(scan.root);
    const entry: LogEntry = { id: randomUUID(), at: this.now(), root: scan.root, bytes: 0, items: [] };
    // A worker that started since the scan: its scratch is in use again.
    const busy = this.opts.busyScratch().map((d) => this.key(d));
    const inUse = (k: string) => busy.some((b) => this.within(b, k) || this.within(k, b));

    const keep = (rel: string, why: PurgeSkip) => result.skipped.push({ rel, why });
    const send = async (abs: string, rel: string, size: number, files?: number) => {
      const how = await this.move(abs, entry.id, entry.items.length);
      if (!how) return false;
      entry.items.push({ rel, abs, size, ...(files ? { files } : {}), how: how.how, ...(how.q ? { q: how.q } : {}) });
      entry.bytes += size;
      if (how.how === 'trash') result.trashed += files ?? 1;
      else result.quarantined += files ?? 1;
      result.bytes += size;
      return true;
    };

    // Whole folders first: every file the scan saw under them is chosen, and nothing else is there.
    for (const dir of this.wholeDirs(scan, chosen)) {
      const dirAbs = join(scan.root, dir);
      const under = [...chosen.values()].filter((s) => this.within(this.key(dirAbs), s.key));
      if (inUse(this.key(dirAbs)) || !(await this.sameDir(dirAbs, under, rootKey, tracked))) continue; // Checked file by file below.
      const size = under.reduce((n, s) => n + s.size, 0);
      if (await send(dirAbs, dir, size, under.length)) for (const s of under) chosen.delete(s.key);
    }
    for (const s of chosen.values()) {
      const why = inUse(s.key) ? 'running' : await this.check(s, rootKey, tracked);
      if (why) keep(s.rel, why);
      else if (!(await send(s.abs, s.rel, s.size))) keep(s.rel, 'failed');
    }
    if (entry.items.length) {
      this.log.push(entry);
      this.saveLog();
      result.logId = entry.id;
    }
    return result;
  }

  /** Folders (relative to the root) whose every file is chosen and that held nothing the scan did not list; the widest ones. */
  private wholeDirs(scan: Scan, chosen: Map<string, Seen>): string[] {
    const count = new Map<string, number>();
    const picked = new Map<string, number>();
    const original = new Map<string, string>();
    const bump = (m: Map<string, number>, s: Seen) => {
      const parts = s.rel.split('/');
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/');
        const k = this.caseBlind ? dir.toLowerCase() : dir;
        original.set(k, dir);
        m.set(k, (m.get(k) ?? 0) + 1);
      }
    };
    for (const s of scan.files.values()) bump(count, s);
    for (const s of chosen.values()) bump(picked, s);
    // `.aibox` and `.aibox/scratch` stay, and so does every folder that holds them.
    const frames = [...count.keys()].filter((k) => isScratchFrame(k, scan.appScratch));
    if (scan.appScratch) frames.push('');
    const holdsFrame = (k: string) => frames.some((f) => f === k || f.startsWith(`${k}/`));
    const full = [...picked.entries()]
      .filter(([k, n]) => n === count.get(k) && !scan.dirty.has(k) && !holdsFrame(k))
      .map(([k]) => k)
      .sort((a, b) => a.length - b.length);
    const out: string[] = [];
    for (const k of full) if (!out.some((o) => k.startsWith(`${o}/`))) out.push(k);
    return out.map((k) => original.get(k) ?? k);
  }

  /** The folder holds exactly the chosen files, unchanged: no link, nothing new, nothing tracked. */
  private async sameDir(dirAbs: string, under: Seen[], rootKey: string, tracked: Map<string, Set<string> | null>): Promise<boolean> {
    try {
      // The folder itself, not a link put in its place since: its real path is the one the scan walked.
      if ((await lstat(dirAbs)).isSymbolicLink()) return false;
      const real = this.key(await realpath(dirAbs));
      if (real !== this.key(dirAbs) || !this.within(rootKey, real)) return false;
      const want = new Map(under.map((s) => [s.key, s]));
      let seen = 0;
      const stack = [dirAbs];
      while (stack.length) {
        const d = stack.pop() as string;
        for (const e of await readdir(d, { withFileTypes: true })) {
          const p = join(d, e.name);
          if (e.isSymbolicLink()) return false;
          if (e.isDirectory()) {
            stack.push(p);
            continue;
          }
          const s = want.get(this.key(p));
          if (!e.isFile() || !s) return false;
          const st = await lstat(p);
          if (st.size !== s.size || st.mtimeMs !== s.mtime) return false;
          if (trackedState(tracked, s.key, (a, b) => this.within(a, b)) !== false) return false;
          seen++;
        }
      }
      return seen === under.length;
    } catch {
      return false;
    }
  }

  /** Why a chosen file must stay after all, or null. */
  private async check(s: Seen, rootKey: string, tracked: Map<string, Set<string> | null>): Promise<PurgeSkip | null> {
    let st;
    try {
      st = await lstat(s.abs);
    } catch {
      return 'missing';
    }
    if (st.isSymbolicLink()) return 'link';
    if (!st.isFile()) return 'changed';
    if (st.size !== s.size || st.mtimeMs !== s.mtime) return 'changed';
    try {
      // Its real path is still the one the scan saw: no folder above it was swapped for a link since.
      const real = this.key(await realpath(s.abs));
      if (!this.within(rootKey, real)) return 'outside';
      if (real !== s.key) return 'link';
    } catch {
      return 'missing';
    }
    const t = trackedState(tracked, s.key, (a, b) => this.within(a, b));
    return t === false ? null : t === true ? 'tracked' : 'unknown';
  }

  /** To the system trash; failing that, to the quarantine. Null when neither worked (the file stays). */
  private async move(abs: string, logId: string, n: number): Promise<{ how: 'trash' | 'quarantine'; q?: string } | null> {
    try {
      await this.opts.trash(abs);
      if (!(await exists(abs))) return { how: 'trash' };
    } catch {
      /* a network volume, no trash, permissions: the quarantine */
    }
    const q = join(this.dir, 'quarantine', logId, String(n), basename(abs));
    try {
      await mkdir(dirname(q), { recursive: true });
      await relocate(abs, q);
      return { how: 'quarantine', q };
    } catch {
      return null;
    }
  }

  // ---------- history ----------

  history(root?: string): PurgeLogEntry[] {
    this.expire();
    const k = root ? this.key(root) : '';
    return this.log
      .filter((e) => !k || this.key(e.root) === k)
      .slice(-50)
      .reverse()
      .map((e) => ({ id: e.id, at: e.at, root: e.root, bytes: e.bytes, items: e.items.map(({ rel, size, files, how, restored }) => ({ rel, size, ...(files ? { files } : {}), how, ...(restored ? { restored } : {}) })) }));
  }

  /** Puts back what a purge sent to the quarantine, where nothing else took its place since. */
  async restore(logId: string): Promise<PurgeRestoreResult> {
    const entry = this.log.find((e) => e.id === logId);
    const out: PurgeRestoreResult = { restored: 0, kept: [] };
    if (!entry) return out;
    for (const item of entry.items) {
      if (item.how !== 'quarantine' || item.restored || !item.q) continue;
      // The journal is a file on disk: only from the quarantine, only back into the project it came from.
      if (!this.inQuarantine(item.q) || !this.within(this.key(entry.root), this.key(item.abs)) || this.key(item.abs) === this.key(entry.root)) {
        out.kept.push({ rel: item.rel, why: 'failed' });
        continue;
      }
      if (await exists(item.abs)) {
        out.kept.push({ rel: item.rel, why: 'occupied' });
        continue;
      }
      if (!(await exists(item.q))) {
        out.kept.push({ rel: item.rel, why: 'missing' });
        continue;
      }
      try {
        await mkdir(dirname(item.abs), { recursive: true });
        await relocate(item.q, item.abs);
        item.restored = true;
        out.restored += item.files ?? 1;
      } catch {
        out.kept.push({ rel: item.rel, why: 'failed' });
      }
    }
    this.saveLog();
    return out;
  }

  private inQuarantine(p: string): boolean {
    const q = this.key(join(this.dir, 'quarantine'));
    const k = this.key(p);
    return k !== q && this.within(q, k);
  }

  /** Quarantined for longer than QUARANTINE_DAYS: on to the system trash (still not deleted). */
  private expire(): void {
    const limit = this.now() - QUARANTINE_DAYS * DAY;
    const due = this.log.flatMap((e) => (e.at < limit ? e.items.filter((i) => i.how === 'quarantine' && !i.restored && !i.expired && i.q && this.inQuarantine(i.q)) : []));
    if (!due.length) return;
    void (async () => {
      for (const item of due) {
        try {
          await this.opts.trash(item.q as string);
          item.expired = true;
        } catch {
          /* tried again later */
        }
      }
      this.saveLog();
    })();
  }

  // ---------- storage ----------

  private load(): void {
    const read = <T>(name: string, fallback: T): T => {
      try {
        return JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as T;
      } catch {
        return fallback;
      }
    };
    const s = read<Partial<Settings>>('settings.json', {});
    this.settings = { added: Array.isArray(s.added) ? s.added.filter((x): x is string => typeof x === 'string') : [], exclude: s.exclude && typeof s.exclude === 'object' ? s.exclude : {} };
    const log = read<unknown>('log.json', []);
    this.log = Array.isArray(log) ? (log as LogEntry[]).filter((e) => e && typeof e.id === 'string' && Array.isArray(e.items)) : [];
    const limit = this.now() - ACTIVITY_DAYS * DAY;
    try {
      const lines = readFileSync(join(this.dir, 'activity.jsonl'), 'utf8').split('\n');
      for (const l of lines) {
        try {
          const r = JSON.parse(l) as ActivityRecord;
          if (typeof r.cwd === 'string' && typeof r.name === 'string' && r.end >= limit && r.end >= r.start) this.activity.push(r);
        } catch {
          /* a cut line */
        }
      }
      if (this.activity.length < lines.length - 1) this.write('activity.jsonl', this.activity.map((r) => `${JSON.stringify(r)}\n`).join(''));
    } catch {
      /* none yet */
    }
  }

  private write(name: string, text: string): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const file = join(this.dir, name);
      writeFileSync(`${file}.tmp`, text);
      renameSync(`${file}.tmp`, file);
    } catch {
      /* kept in memory for this run */
    }
  }

  private saveSettings(): void {
    this.write('settings.json', JSON.stringify(this.settings, null, 2));
  }

  private saveLog(): void {
    this.log = this.log.slice(-LOG_MAX);
    this.write('log.json', JSON.stringify(this.log));
  }
}

// ---------- helpers ----------

function isDirSync(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** A repository holds this folder from above (the root is a subfolder of a checkout). */
function repoAbove(dir: string): boolean {
  for (let d = dirname(resolve(dir)); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return true;
    if (dirname(d) === d) return false;
  }
}

/** Tracked by the nearest repo holding it: true, false, or null when that repo could not be read. */
function trackedState(sets: Map<string, Set<string> | null>, key: string, within: (parent: string, k: string) => boolean): boolean | null {
  let best = '';
  for (const repo of sets.keys()) if (within(repo, key) && repo.length > best.length) best = repo;
  if (!best) return false;
  const set = sets.get(best);
  return set === null || set === undefined ? null : set.has(key);
}

/** `.aibox`, `.aibox/scratch` (and the app's scratch root): frames of the hub, never sent whole. */
function isScratchFrame(relKey: string, appScratch: boolean): boolean {
  if (appScratch) return relKey === '';
  return /(?:^|\/)\.aibox(?:\/scratch)?$/i.test(relKey);
}

interface Window {
  start: number;
  end: number;
  sessions: Set<string>;
}

function mergeWindows(list: { start: number; end: number; session: string }[]): Window[] {
  const sorted = list.filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end)).sort((a, b) => a.start - b.start);
  const out: Window[] = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && w.start <= last.end + SLACK_MS) {
      last.end = Math.max(last.end, w.end);
      if (last.sessions.size < 4) last.sessions.add(w.session);
    } else out.push({ start: w.start, end: Math.max(w.start, w.end), sessions: new Set([w.session]) });
  }
  return out;
}

function findWindow(list: Window[], t: number): Window | null {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].start - SLACK_MS > t) hi = mid - 1;
    else if (list[mid].end + SLACK_MS < t) lo = mid + 1;
    else return list[mid];
  }
  return null;
}

/** Moves a file or folder; across volumes, a copy checked for size before the original goes. */
async function relocate(from: string, to: string): Promise<void> {
  if (await exists(to)) throw new Error('target exists');
  try {
    await rename(from, to);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
  }
  await cp(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  if ((await sizeOf(from)) !== (await sizeOf(to))) {
    await rm(to, { recursive: true, force: true });
    throw new Error('copy differs');
  }
  await rm(from, { recursive: true });
}

async function sizeOf(p: string): Promise<number> {
  const st = await lstat(p);
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const e of await readdir(p)) n += await sizeOf(join(p, e));
  return n;
}

