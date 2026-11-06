import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { baseConfigDir } from './accounts';
import { blocksOf, type Block } from './providers/blocks';
import { stepItems, type StepItem, type Subagents } from './subagents';

// A subagent launched in the background sends its frames to no stream: Claude Code writes its activity to a transcript,
// <config>/projects/<project>/<session id>/subagents/agent-<agent id>.jsonl (with an agent-<id>.meta.json that names
// the tool call that launched it). This reads that file as it grows and feeds the tracker (main/subagents.ts), which
// merges it with what the stream said. Only files under <config>/projects are read.

/** Poll period: a stat per running subagent, nothing read until the file grows. */
const POLL_MS = 1000;
/** Read at once, at most; a file larger than FIRST is read from its end (only the latest steps are kept anyway). */
const CHUNK = 2 * 1024 * 1024;
const FIRST = 4 * 1024 * 1024;
/** A line without its end beyond this is dropped (a request blob, never a step). */
const CARRY_MAX = 32 * 1024 * 1024;
/** A subagent found at startup is only taken if its file moved within this... */
const ADOPT_FRESH_MS = 3 * 60_000;
/** ...and stops being running when its file has not moved for this long (nothing else tells it ended). */
const STALE_MS = 10 * 60_000;
/** Looking for the session's folder in every project, at most this often. */
const SCAN_GAP_MS = 3000;

const SAFE = /^[A-Za-z0-9_-]+$/;
const META = /^agent-([A-Za-z0-9_-]+)\.meta\.json$/;

export const projectsRoot = () => join(baseConfigDir(), 'projects');

/** How Claude Code names a project's folder: its path, every character but letters and digits turned into "-". */
export const projectDirName = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-');

const isDir = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** A transcript line: what its entry adds to the subagent's activity, and its final answer if it is one. */
export interface TranscriptLine {
  items: StepItem[];
  /** The text of an assistant reply that ended its turn without a tool call: the subagent is over. */
  end?: string;
}

/** Null for what is not a message of the subagent (request shapes and blobs, attachments), or a line that is not JSON. */
export function parseTranscriptLine(line: string): TranscriptLine | null {
  if (line.startsWith('{"type":"api-request')) return null; // The big ones, skipped before parsing.
  let entry: { type?: unknown; timestamp?: unknown; message?: { stop_reason?: unknown; content?: unknown } };
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (entry.type !== 'assistant' && entry.type !== 'user') return null;
  const blocks: Block[] = blocksOf(entry.message);
  const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
  const items = stepItems(blocks, Number.isFinite(at) ? at : undefined);
  const ended = entry.type === 'assistant' && entry.message?.stop_reason === 'end_turn' && !blocks.some((b) => b.type === 'tool_use');
  const text = blocks.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('\n').trim();
  return { items, ...(ended ? { end: text } : {}) };
}

/** The complete lines a file gets, from where it was last read; a line still being written waits for its end. */
export class LineTail {
  private offset = 0;
  private begun = false;
  private skipFirst = false;
  private carry: Buffer = Buffer.alloc(0);

  constructor(readonly path: string) {}

  /** `exists` is false while the file is not there yet; `grew` says more may be waiting (one chunk is read per call). */
  poll(): { lines: string[]; exists: boolean; grew: boolean } {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return { lines: [], exists: false, grew: false };
    }
    if (!this.begun) {
      this.begun = true;
      if (size > FIRST) {
        this.offset = size - FIRST;
        this.skipFirst = true; // It starts in the middle of a line.
      }
    }
    if (size < this.offset) {
      // Rewritten from the start.
      Object.assign(this, { offset: 0, skipFirst: false, carry: Buffer.alloc(0) });
    }
    if (size === this.offset) return { lines: [], exists: true, grew: false };
    const len = Math.min(size - this.offset, CHUNK);
    const buf = Buffer.alloc(len);
    let fd: number | null = null;
    try {
      fd = openSync(this.path, 'r');
      readSync(fd, buf, 0, len, this.offset);
    } catch {
      return { lines: [], exists: existsSync(this.path), grew: false };
    } finally {
      if (fd !== null) closeSync(fd);
    }
    this.offset += len;
    const all = Buffer.concat([this.carry, buf]);
    const end = all.lastIndexOf(0x0a);
    if (end < 0) {
      this.carry = all.length > CARRY_MAX ? Buffer.alloc(0) : all;
      return { lines: [], exists: true, grew: this.offset < size };
    }
    this.carry = all.subarray(end + 1);
    const lines = all.subarray(0, end).toString('utf8').split('\n');
    if (this.skipFirst) {
      this.skipFirst = false;
      lines.shift();
    }
    return { lines: lines.filter((l) => l.trim()), exists: true, grew: this.offset < size };
  }
}

/** What a subagent's meta file says: the call that launched it, and what it is. */
interface Meta {
  file: string;
  toolUseId: string;
  description: string;
  agentType: string;
  model: string;
  background: boolean;
}

/** Finds the transcript of a subagent: the folder of the parent session, then the file by agent id or by launching call. */
export class TranscriptFinder {
  private dir: string | null = null;
  private scannedAt = 0;
  private readonly metas = new Map<string, Meta>();
  private readonly read = new Set<string>();

  constructor(
    private readonly root: string,
    private readonly where: () => { sessionId: string; cwd: string },
    private readonly now: () => number = Date.now,
  ) {}

  /** `<root>/<project>/<session>/subagents`, if it exists. Never outside the root: names are checked. */
  folder(): string | null {
    const { sessionId, cwd } = this.where();
    if (this.dir && existsSync(this.dir)) return this.dir;
    this.dir = null;
    if (!SAFE.test(sessionId)) return null;
    const inside = (path: string) => resolve(path).startsWith(resolve(this.root) + sep);
    const direct = join(this.root, projectDirName(cwd), sessionId, 'subagents');
    if (inside(direct) && isDir(direct)) return (this.dir = direct);
    // The folder name of a long or odd path differs: look in every project, not too often.
    if (this.now() - this.scannedAt < SCAN_GAP_MS) return null;
    this.scannedAt = this.now();
    try {
      for (const e of readdirSync(this.root, { withFileTypes: true })) {
        const candidate = join(this.root, e.name, sessionId, 'subagents');
        if (e.isDirectory() && inside(candidate) && isDir(candidate)) return (this.dir = candidate);
      }
    } catch {
      /* no projects folder yet */
    }
    return null;
  }

  /** Reads the meta files not read yet; a file that cannot be read yet is tried again next time. */
  private scan(dir: string): void {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const m = META.exec(name);
      if (!m || this.read.has(name)) continue;
      try {
        const path = join(dir, name);
        if (statSync(path).size > 64 * 1024) {
          this.read.add(name);
          continue;
        }
        const o = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        this.read.add(name);
        const s = (v: unknown) => (typeof v === 'string' ? v : '');
        const meta: Meta = {
          file: join(dir, `agent-${m[1]}.jsonl`),
          toolUseId: s(o.toolUseId),
          description: s(o.description),
          agentType: s(o.agentType),
          model: s(o.model),
          background: o.requestShape === 'background',
        };
        this.metas.set(meta.toolUseId || m[1], meta);
      } catch {
        /* being written */
      }
    }
  }

  /** The transcript of the subagent launched by this call (or having this agent id), once it exists. */
  find(toolUseId: string, agentId = ''): string | null {
    const dir = this.folder();
    if (!dir) return null;
    if (agentId && SAFE.test(agentId)) {
      const file = join(dir, `agent-${agentId}.jsonl`);
      if (existsSync(file)) return file;
    }
    this.scan(dir);
    const meta = this.metas.get(toolUseId);
    return meta && existsSync(meta.file) ? meta.file : null;
  }

  /** The subagents of the session whose file moved within `fresh` ms: those a new process may find still going. */
  recent(fresh: number): (Meta & { startedAt: number })[] {
    const dir = this.folder();
    if (!dir) return [];
    this.scan(dir);
    const out: (Meta & { startedAt: number })[] = [];
    for (const meta of this.metas.values()) {
      try {
        const st = statSync(meta.file);
        if (this.now() - st.mtimeMs <= fresh) out.push({ ...meta, startedAt: st.birthtimeMs || st.mtimeMs });
      } catch {
        /* no transcript */
      }
    }
    return out;
  }
}

interface Tail {
  line: LineTail | null;
  /** Found at startup: nothing else will say it ended, its file does. */
  adopted: boolean;
  grewAt: number;
}

export interface TailHost {
  subagents: Subagents;
  where(): { sessionId: string; cwd: string };
  /** Something changed in what the session shows. */
  changed(): void;
}

/**
 * Follows the transcript of each running background subagent of a session: a timer runs only while there is one,
 * a tail is dropped (after a last read) as its subagent ends, and stop() leaves nothing behind.
 */
export class SubagentTails {
  private readonly tails = new Map<string, Tail>();
  private readonly finder: TranscriptFinder;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly host: TailHost,
    root: string = projectsRoot(),
    private readonly now: () => number = Date.now,
    private readonly period: number = POLL_MS,
  ) {
    this.finder = new TranscriptFinder(root, () => host.where(), now);
  }

  /** How many are followed now. */
  get size(): number {
    return this.tails.size;
  }

  /** Follows the running background subagents not followed yet. Cheap to call at every event. */
  sync(): void {
    for (const id of this.host.subagents.background()) {
      if (this.tails.has(id)) continue;
      const tail: Tail = { line: null, adopted: false, grewAt: this.now() };
      this.tails.set(id, tail);
      this.pollOne(id, tail);
    }
    this.arm();
  }

  /** A process launched on a conversation: the subagents its files show still at work come back in the list. */
  adopt(): number {
    let n = 0;
    for (const meta of this.finder.recent(ADOPT_FRESH_MS)) {
      if (!meta.background || !meta.toolUseId || this.tails.has(meta.toolUseId)) continue;
      if (!this.host.subagents.adopt(meta.toolUseId, meta, meta.startedAt)) continue;
      this.tails.set(meta.toolUseId, { line: null, adopted: true, grewAt: this.now() });
      this.pollOne(meta.toolUseId, this.tails.get(meta.toolUseId) as Tail);
      n++;
    }
    if (n > 0) this.host.changed();
    this.arm();
    return n;
  }

  /** Every followed file read now; what ended is let go. Called by the timer. */
  tick(): void {
    for (const [id, tail] of [...this.tails]) this.pollOne(id, tail);
    this.arm();
  }

  /** Nothing is followed any more (process gone, session closed). */
  stop(): void {
    this.tails.clear();
    this.arm();
  }

  private pollOne(id: string, tail: Tail): void {
    const { subagents } = this.host;
    const alive = subagents.isRunning(id);
    let changed = false;
    if (!tail.line) {
      const path = this.finder.find(id, subagents.taskOf(id));
      if (path) tail.line = new LineTail(path);
    }
    if (tail.line) {
      // A burst is read in a few chunks at most; the rest waits for the next tick.
      for (let i = 0; i < 4; i++) {
        const { lines, grew } = tail.line.poll();
        if (lines.length > 0) tail.grewAt = this.now();
        for (const line of lines) {
          const parsed = parseTranscriptLine(line);
          if (!parsed) continue;
          changed = subagents.transcript(id, parsed.items) || changed;
          if (parsed.end !== undefined && tail.adopted) changed = subagents.endFromFile(id, 'done', parsed.end) || changed;
        }
        if (!grew) break;
      }
    }
    if (alive && tail.adopted && this.now() - tail.grewAt > STALE_MS) changed = subagents.endFromFile(id, 'stopped') || changed;
    if (!subagents.isRunning(id)) this.tails.delete(id); // Read one last time above.
    if (changed) this.host.changed();
  }

  private arm(): void {
    if (this.tails.size > 0 && !this.timer) {
      this.timer = setInterval(() => this.tick(), this.period);
      this.timer.unref?.();
    } else if (this.tails.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
