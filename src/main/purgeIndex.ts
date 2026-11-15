import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, win32, posix } from 'node:path';
import { createInterface } from 'node:readline';
import { commandPaths, pathTokens } from '../shared/purge';

// What the agents' own transcripts say they did to files, for the purge (docs/purge-ephemeres.md): one reader per
// transcript format (Claude Code, Codex, Gemini CLI), and the hub's own activity journal for any other program.
// Only paths, times and the path-like words of messages are kept: never a file's content or a whole message.

export type TranscriptFormat = 'claude' | 'codex' | 'gemini' | 'activity';

/** Something an agent did, over a span of time. */
export interface Act {
  /** write: a write tool made or changed `paths`; cmd: a command that names `paths`; turn: the session was at work. */
  kind: 'write' | 'cmd' | 'turn';
  start: number;
  end: number;
  /** Absolute folder it ran in ('' when the format does not say). */
  cwd: string;
  /** Absolute paths (resolved against cwd). */
  paths: string[];
}

export interface TranscriptFacts {
  format: TranscriptFormat;
  /** Name of the session (the hub's name when the transcript gives it), else a short id. */
  session: string;
  /** Every folder the session worked in. */
  cwds: string[];
  acts: Act[];
  /** Path-like words of the messages of the user, the master and the agent (pathTokens). */
  cites: string[];
}

type PathApi = typeof posix;
/** Paths in a transcript are written for the machine that wrote it: a Windows drive path is resolved as one. */
const apiFor = (p: string): PathApi => (/^[a-z]:[\\/]/i.test(p) || p.startsWith('\\\\') ? win32 : posix);

/** `p` as an absolute path, relative ones against `cwd`; '' when it cannot be placed. */
export function placePath(p: string, cwd: string): string {
  const clean = p.trim().replace(/^["']|["']$/g, '');
  if (!clean) return '';
  if (apiFor(clean) === win32 || (clean.startsWith('/') && !/^[a-z]:/i.test(cwd))) return apiFor(clean).resolve(clean);
  if (clean.startsWith('/') && /^[a-z]:/i.test(cwd)) {
    // "/c/Users/…" from Git Bash on Windows.
    const m = /^\/([a-z])\/(.*)$/i.exec(clean);
    return m ? win32.resolve(`${m[1]}:\\${m[2]}`) : '';
  }
  if (!cwd) return '';
  return apiFor(cwd).resolve(cwd, clean);
}

/** The hub's session name, from the mission line it sends first ("…worker "name"…"). */
const HUB_NAME = /\bworker\s+["“«]\s?([\w.-]{1,64})\s?["”»]/i;

const LIMIT_PARSE = 8 * 1024 * 1024;
const GAP_MS = 10 * 60_000;

/** Folds a stream of activity times into spans: two moments closer than GAP_MS are one stretch of work. */
class Spans {
  private spans: { start: number; end: number; cwd: string }[] = [];
  add(at: number, cwd: string): void {
    if (!Number.isFinite(at)) return;
    const last = this.spans[this.spans.length - 1];
    if (last && at - last.end < GAP_MS && at >= last.start) last.end = Math.max(last.end, at);
    else this.spans.push({ start: at, end: at, cwd });
  }
  acts(): Act[] {
    return this.spans.map((s) => ({ kind: 'turn', start: s.start, end: s.end, cwd: s.cwd, paths: [] }));
  }
  /** End of the span that holds `at` (a background command runs until its session stops working). */
  endAt(at: number): number {
    for (const s of this.spans) if (at >= s.start && at <= s.end + GAP_MS) return Math.max(s.end, at);
    return at;
  }
}

class Collector {
  session = '';
  cwds = new Set<string>();
  acts: Act[] = [];
  cites = new Set<string>();
  spans = new Spans();
  /** Background commands: their end is the end of their session's stretch of work. */
  background: Act[] = [];
  cite(text: unknown): void {
    if (typeof text === 'string') {
      if (!this.session) this.session = HUB_NAME.exec(text)?.[1] ?? '';
      for (const t of pathTokens(text)) this.cites.add(t);
    } else if (Array.isArray(text)) for (const v of text) this.cite(v);
    else if (text && typeof text === 'object') for (const v of Object.values(text)) this.cite(v);
  }
  write(paths: string[], start: number, end: number, cwd: string): void {
    const placed = paths.map((p) => placePath(p, cwd)).filter(Boolean);
    if (placed.length) this.acts.push({ kind: 'write', start, end, cwd, paths: placed });
  }
  command(command: string, start: number, end: number, cwd: string, background = false): void {
    const placed = commandPaths(command).map((p) => placePath(p, cwd)).filter(Boolean);
    const act: Act = { kind: 'cmd', start, end, cwd, paths: placed };
    this.acts.push(act);
    if (background) this.background.push(act);
  }
  facts(format: TranscriptFormat, fallback: string): TranscriptFacts {
    for (const a of this.background) a.end = Math.max(a.end, this.spans.endAt(a.start));
    return { format, session: this.session || fallback, cwds: [...this.cwds], acts: [...this.spans.acts(), ...this.acts], cites: [...this.cites] };
  }
}

const time = (v: unknown) => (typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? v : NaN);
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
/** Hub tools whose input is a message to someone: a report, a question, a teammate's request. */
const MESSAGE_TOOL = /(?:^|__)(?:message_master|send_message|SendMessage|message_worker|spawn_worker|notify_user)$/;

// ---------- Claude Code ----------

/** Facts of a Claude Code transcript (`<config>/projects/<project>/<session>.jsonl`), line by line. */
export class ClaudeReader {
  private c = new Collector();
  private pending = new Map<string, { name: string; input: Record<string, unknown>; at: number; cwd: string }>();
  private cwd = '';
  private title = '';

  line(line: string): void {
    if (!line || line.startsWith('{"type":"api-request') || line.startsWith('{"type":"file-history')) return;
    if (line.length > LIMIT_PARSE) return this.huge(line);
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (e.type === 'agent-name' && typeof e.agentName === 'string') this.title ||= e.agentName;
    if (e.type === 'custom-title' && typeof e.customTitle === 'string') this.title ||= e.customTitle;
    const at = time(e.timestamp);
    if (typeof e.cwd === 'string' && e.cwd) {
      this.cwd = e.cwd;
      this.c.cwds.add(e.cwd);
    }
    if (e.type !== 'assistant' && e.type !== 'user') return;
    this.c.spans.add(at, this.cwd);
    const content = (e.message as { content?: unknown } | undefined)?.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
    for (const b of blocks) {
      if (b.type === 'text') this.c.cite(b.text);
      else if (b.type === 'tool_use' && typeof b.id === 'string') {
        const input = (b.input ?? {}) as Record<string, unknown>;
        const name = str(b.name);
        if (MESSAGE_TOOL.test(name)) this.c.cite(input);
        this.pending.set(b.id, { name, input, at, cwd: this.cwd });
      } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') this.result(b.tool_use_id, at);
    }
  }

  /** A line too large to parse (a big image result): only which calls it ends, and when. */
  private huge(line: string): void {
    const at = time(/"timestamp":"([^"]+)"/.exec(line.slice(-4096))?.[1] ?? /"timestamp":"([^"]+)"/.exec(line)?.[1]);
    for (const m of line.matchAll(/"tool_use_id":"([^"]+)"/g)) this.result(m[1], at);
    this.c.spans.add(at, this.cwd);
  }

  private result(id: string, at: number): void {
    const call = this.pending.get(id);
    if (!call) return;
    this.pending.delete(id);
    const end = Number.isFinite(at) ? at : call.at;
    if (WRITE_TOOLS.has(call.name)) {
      const path = str(call.input.file_path) || str(call.input.notebook_path);
      if (path) this.c.write([path], call.at, end, call.cwd);
    } else if (SHELL_TOOLS.has(call.name)) {
      this.c.command(str(call.input.command), call.at, end, call.cwd, call.input.run_in_background === true);
    }
  }

  facts(fallback: string): TranscriptFacts {
    // Calls left without a result (cut): from their start to the end of their stretch.
    for (const [id, call] of this.pending) if (WRITE_TOOLS.has(call.name) || SHELL_TOOLS.has(call.name)) this.result(id, this.c.spans.endAt(call.at));
    if (!this.c.session && this.title) this.c.session = this.title;
    return this.c.facts('claude', fallback);
  }
}

// ---------- Codex ----------

/** The files an apply_patch body adds, changes or moves to. */
export const patchPaths = (patch: string) => [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Move to): (.+)$/gm)].map((m) => m[1].trim());

/** Facts of a Codex rollout (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-….jsonl`). */
export class CodexReader {
  private c = new Collector();
  private pending = new Map<string, { kind: 'write' | 'cmd'; paths: string[]; command: string; at: number; cwd: string }>();
  private cwd = '';
  private id = '';

  line(line: string): void {
    if (!line || line.length > LIMIT_PARSE) return;
    let e: { timestamp?: unknown; type?: unknown; payload?: Record<string, unknown> };
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    const p = e.payload ?? {};
    const at = time(e.timestamp);
    if (e.type === 'session_meta' || e.type === 'turn_context') {
      if (typeof p.cwd === 'string' && p.cwd) {
        this.cwd = p.cwd;
        this.c.cwds.add(p.cwd);
      }
      if (typeof p.id === 'string') this.id ||= p.id;
      return;
    }
    this.c.spans.add(at, this.cwd);
    if (e.type === 'event_msg') {
      if (p.type === 'agent_message' || p.type === 'user_message') this.c.cite(p.message);
      return;
    }
    if (e.type !== 'response_item') return;
    const callId = str(p.call_id) || str(p.id);
    switch (p.type) {
      case 'message':
        for (const part of Array.isArray(p.content) ? (p.content as Record<string, unknown>[]) : []) this.c.cite(part.text);
        break;
      case 'function_call': {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(str(p.arguments) || '{}');
        } catch {
          /* not JSON */
        }
        const name = str(p.name);
        const cwd = str(args.workdir) || str(args.cwd) || this.cwd;
        if (MESSAGE_TOOL.test(name)) this.c.cite(args);
        if (name === 'apply_patch') this.pending.set(callId, { kind: 'write', paths: patchPaths(str(args.input) || str(args.patch)), command: '', at, cwd });
        else if (/shell|exec|command|run/i.test(name)) {
          const raw = args.command ?? args.cmd;
          const command = Array.isArray(raw) ? raw.map(String).join(' ') : str(raw);
          const patched = patchPaths(command);
          this.pending.set(callId, patched.length ? { kind: 'write', paths: patched, command: '', at, cwd } : { kind: 'cmd', paths: [], command, at, cwd });
        }
        break;
      }
      case 'custom_tool_call':
        if (str(p.name) === 'apply_patch') this.pending.set(callId, { kind: 'write', paths: patchPaths(str(p.input)), command: '', at, cwd: this.cwd });
        break;
      case 'local_shell_call': {
        const action = (p.action ?? {}) as Record<string, unknown>;
        const command = Array.isArray(action.command) ? action.command.map(String).join(' ') : str(action.command);
        this.pending.set(callId, { kind: 'cmd', paths: [], command, at, cwd: str(action.working_directory) || this.cwd });
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output':
      case 'local_shell_call_output':
        this.finish(callId, at);
        break;
    }
  }

  private finish(id: string, at: number): void {
    const call = this.pending.get(id);
    if (!call) return;
    this.pending.delete(id);
    const end = Number.isFinite(at) ? at : call.at;
    if (call.kind === 'write') this.c.write(call.paths, call.at, end, call.cwd);
    else this.c.command(call.command, call.at, end, call.cwd);
  }

  facts(fallback: string): TranscriptFacts {
    for (const [id, call] of this.pending) this.finish(id, this.c.spans.endAt(call.at));
    return this.c.facts('codex', this.id ? `codex-${this.id.slice(0, 8)}` : fallback);
  }
}

// ---------- Gemini CLI ----------

/** Facts of a Gemini CLI chat (`<GEMINI_CLI_HOME>/.gemini/tmp/<project hash>/chats/session-….json`). */
export function geminiFacts(json: string, fallback: string, cwdOfHash: (hash: string) => string): TranscriptFacts | null {
  let chat: { sessionId?: unknown; projectHash?: unknown; messages?: unknown };
  try {
    chat = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(chat.messages)) return null;
  const c = new Collector();
  const cwd = cwdOfHash(str(chat.projectHash));
  if (cwd) c.cwds.add(cwd);
  const messages = chat.messages as Record<string, unknown>[];
  messages.forEach((m, i) => {
    const at = time(m.timestamp);
    c.spans.add(at, cwd);
    const content = m.content;
    if (typeof content === 'string') c.cite(content);
    else if (Array.isArray(content)) for (const part of content as Record<string, unknown>[]) c.cite(part?.text);
    const next = time(messages[i + 1]?.timestamp);
    for (const call of Array.isArray(m.toolCalls) ? (m.toolCalls as Record<string, unknown>[]) : []) {
      const args = (call.args ?? {}) as Record<string, unknown>;
      const start = Number.isFinite(time(call.timestamp)) ? time(call.timestamp) : at;
      const end = Number.isFinite(next) ? next : start;
      const name = str(call.name);
      const dir = str(args.directory) || str(args.dir_path) || cwd;
      if (name === 'write_file' || name === 'replace' || name === 'edit') c.write([str(args.file_path) || str(args.absolute_path)], start, end, dir);
      else if (name === 'run_shell_command') c.command(str(args.command), start, end, dir);
      else if (MESSAGE_TOOL.test(name)) c.cite(args);
    }
  });
  return c.facts('gemini', typeof chat.sessionId === 'string' ? `gemini-${chat.sessionId.slice(0, 8)}` : fallback);
}

/** How the Gemini CLI names a project's folder of chats: the SHA-256 of its path. */
export const geminiHash = (dir: string) => createHash('sha256').update(dir).digest('hex');

// ---------- the hub's own journal ----------

/** A stretch of work of a session, as the hub saw it (any program, transcripts or not). */
export interface ActivityRecord {
  name: string;
  cwd: string;
  provider: string;
  start: number;
  end: number;
}

export function activityFacts(records: ActivityRecord[]): TranscriptFacts[] {
  const bySession = new Map<string, TranscriptFacts>();
  for (const r of records) {
    const key = `${r.name}\n${r.cwd}`;
    let f = bySession.get(key);
    if (!f) bySession.set(key, (f = { format: 'activity', session: r.name, cwds: [r.cwd], acts: [], cites: [] }));
    f.acts.push({ kind: 'turn', start: r.start, end: r.end, cwd: r.cwd, paths: [] });
  }
  return [...bySession.values()];
}

// ---------- the index ----------

export interface TranscriptRoot {
  format: Exclude<TranscriptFormat, 'activity'>;
  dir: string;
}

/** Where each program keeps its transcripts, the user's own folders and those of the hub's accounts. */
export function transcriptRoots(claudeConfig: string, accountDirs: string[]): TranscriptRoot[] {
  const home = homedir();
  const roots: TranscriptRoot[] = [
    { format: 'claude', dir: join(claudeConfig, 'projects') },
    { format: 'codex', dir: join(process.env.CODEX_HOME || join(home, '.codex'), 'sessions') },
    { format: 'gemini', dir: join(home, '.gemini', 'tmp') },
  ];
  for (const dir of accountDirs) {
    roots.push({ format: 'claude', dir: join(dir, 'projects') }, { format: 'codex', dir: join(dir, 'sessions') }, { format: 'gemini', dir: join(dir, '.gemini', 'tmp') });
  }
  return roots;
}

const MATCH: Record<TranscriptRoot['format'], { depth: number; file: RegExp }> = {
  // <project>/<session>.jsonl, and <project>/<session>/subagents/agent-<id>.jsonl.
  claude: { depth: 4, file: /\.jsonl$/ },
  // YYYY/MM/DD/rollout-….jsonl
  codex: { depth: 4, file: /^rollout-.*\.jsonl$/ },
  // <hash>/chats/session-….json
  gemini: { depth: 3, file: /^session-.*\.json$/ },
};

async function listFiles(dir: string, depth: number, file: RegExp, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    // A link to another folder (an account sharing the user's own) is read once, from where it points.
    if (e.isDirectory() && depth > 0) await listFiles(p, depth - 1, file, out);
    else if (e.isFile() && file.test(e.name)) out.push(p);
  }
}

const yieldNow = () => new Promise<void>((r) => setImmediate(r));

async function readLines(path: string, each: (line: string) => void): Promise<void> {
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8', highWaterMark: 1 << 20 }), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    each(line);
    if (++n % 2000 === 0) await yieldNow(); // The main process keeps answering the window.
  }
}

/**
 * Every transcript the programs left, read once and kept while its file does not change (size, date): a new scan
 * only reads what grew. Reading streams line by line and lets the main process breathe in between.
 */
export class TranscriptIndex {
  private cache = new Map<string, { size: number; mtime: number; facts: TranscriptFacts | null }>();
  private running: Promise<TranscriptFacts[]> | null = null;

  constructor(
    private readonly roots: () => TranscriptRoot[],
    private readonly activity: () => ActivityRecord[],
    private readonly knownCwds: () => string[],
  ) {}

  /** The facts of every transcript, refreshed; concurrent callers share one refresh. */
  all(): Promise<TranscriptFacts[]> {
    this.running ??= this.refresh().finally(() => (this.running = null));
    return this.running;
  }

  counts(): Record<TranscriptFormat, number> {
    const out: Record<TranscriptFormat, number> = { claude: 0, codex: 0, gemini: 0, activity: 0 };
    for (const v of this.cache.values()) if (v.facts) out[v.facts.format]++;
    return out;
  }

  private async refresh(): Promise<TranscriptFacts[]> {
    const seen = new Set<string>();
    const hashes = new Map<string, string>();
    for (const cwd of this.knownCwds()) for (const v of [cwd, resolve(cwd)]) hashes.set(geminiHash(v), v);
    for (const root of this.roots()) {
      const files: string[] = [];
      await listFiles(root.dir, MATCH[root.format].depth, MATCH[root.format].file, files);
      for (const file of files) {
        let st;
        try {
          st = await stat(file);
        } catch {
          continue;
        }
        const key = `${root.format}:${file}`;
        seen.add(key);
        const cached = this.cache.get(key);
        if (cached && cached.size === st.size && cached.mtime === st.mtimeMs) continue;
        try {
          this.cache.set(key, { size: st.size, mtime: st.mtimeMs, facts: await this.read(root.format, file, (h) => hashes.get(h) ?? '') });
        } catch {
          // Unreadable now (being written, permissions): an older reading stands, and it is tried again next time.
        }
      }
    }
    for (const key of this.cache.keys()) if (!seen.has(key)) this.cache.delete(key);
    const out: TranscriptFacts[] = [];
    for (const v of this.cache.values()) if (v.facts) out.push(v.facts);
    return [...out, ...activityFacts(this.activity())];
  }

  private async read(format: TranscriptRoot['format'], file: string, cwdOfHash: (h: string) => string): Promise<TranscriptFacts | null> {
    const fallback = (file.split(/[\\/]/).pop() ?? '').replace(/\.jsonl?$/, '').replace(/^(?:rollout-|session-)/, '').slice(0, 8);
    if (format === 'gemini') return geminiFacts(await readFile(file, 'utf8'), fallback, cwdOfHash);
    const reader = format === 'claude' ? new ClaudeReader() : new CodexReader();
    await readLines(file, (l) => reader.line(l));
    return reader.facts(fallback);
  }
}

export const isAbsolutePath = (p: string) => isAbsolute(p) || /^[a-z]:[\\/]/i.test(p);
