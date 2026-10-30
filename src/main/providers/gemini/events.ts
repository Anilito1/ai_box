import type { Totals } from '../../../shared/costs';
import { tokensOf } from '../../../shared/pulse';
import type { Block } from '../blocks';
import type { AgentEvent, HistoryMessage, LimitSignal } from '../types';

// The Gemini CLI's Agent Client Protocol updates as the hub's own events and content blocks. No process here: the
// adapter feeds it, tests replay it.

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.map(obj) : []);

const ACTIVITY: AgentEvent[] = [{ type: 'activity' }];

/** The text of an update's content: text blocks, and a diff as a few lines. */
export function contentText(content: unknown): string {
  return list(content)
    .map((c) => {
      if (c.type === 'content') return str(obj(c.content).text);
      if (c.type === 'diff') return `${str(c.path)}\n${diffLines(str(c.oldText), str(c.newText))}`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

const diffLines = (before: string, after: string) => [...before.split('\n').filter(() => before !== '').map((l) => `- ${l}`), ...after.split('\n').map((l) => `+ ${l}`)].join('\n');

/**
 * A tool call as the hub shows tools. The protocol gives a title and a kind, not the tool's name: a tool of an MCP
 * server is titled "name (server MCP Server)" (the hub's own are then `mcp__hub__name`), the others go by their kind.
 */
export function toolUse(update: Json): Block {
  const id = str(update.toolCallId);
  const title = str(update.title);
  const first = str(obj(list(update.locations)[0]).path);
  const mcp = /^(.+?) \((.+?) MCP Server\)$/.exec(title);
  if (mcp) return { type: 'tool_use', id, name: `mcp__${mcp[2].replace(/[^\w-]/g, '_')}__${mcp[1]}`, input: {} };
  switch (str(update.kind)) {
    case 'execute':
      return { type: 'tool_use', id, name: 'Bash', input: { command: title.replace(/\s*\[current working directory[^\]]*\]\s*$/, '') } };
    case 'read':
      return { type: 'tool_use', id, name: 'Read', input: { file_path: first || title } };
    case 'edit': {
      const diff = list(update.content).find((c) => c.type === 'diff');
      return { type: 'tool_use', id, name: 'ApplyPatch', input: { file_path: first || str(diff?.path) || title, changes: diff ? [{ path: str(diff.path), kind: 'update', diff: diffLines(str(diff.oldText), str(diff.newText)) }] : [] } };
    }
    case 'search':
      return { type: 'tool_use', id, name: 'Grep', input: { pattern: title } };
    case 'fetch':
      return { type: 'tool_use', id, name: 'WebFetch', input: { url: title } };
    default:
      return { type: 'tool_use', id, name: title || 'tool', input: {} };
  }
}

// ---------- errors and limits ----------

const WAIT = /(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?!s))?\s*(?:(\d+(?:\.\d+)?)\s*s)?/i;

/** "reset after 1h30m5s", "retry in 34s": how long Google says to wait, in seconds, when it says. */
export function waitSeconds(message: string): number | null {
  const m = /(?:reset|retry|try again)[^0-9]{0,24}((?:\d+\s*[hms]\s*)+)/i.exec(message);
  if (!m) return null;
  const w = WAIT.exec(m[1]);
  const secs = num(Number(w?.[1] ?? 0)) * 3600 + num(Number(w?.[2] ?? 0)) * 60 + num(Number(w?.[3] ?? 0));
  return secs > 0 ? secs : null;
}

/** What a failed request of the CLI means for the account: a limit (rate or quota), a sign-in problem, or nothing. */
export function limitOfError(code: number, message: string, now: number): LimitSignal | null {
  if (code === 429 || /rate.?limit|quota|RESOURCE_EXHAUSTED|exhausted your capacity/i.test(message)) {
    const wait = waitSeconds(message);
    return { kind: /quota|exhaust|per day|daily|billing/i.test(message) ? 'quota' : 'rate', resetsAt: wait ? Math.floor(now / 1000) + wait : null, source: `gemini:${code}` };
  }
  if (code === 401 || code === 403 || /api key|unauthenticated|not logged|log ?in|sign.?in|credentials|auth/i.test(message)) return { kind: 'auth', resetsAt: null, source: `gemini:${code}` };
  return null;
}

/** The code the hub's error wording knows (see errors.ts), for a failed request. */
export function errorCodeOf(code: number, message: string): string {
  const limit = limitOfError(code, message, 0);
  if (limit) return limit.kind === 'auth' ? 'authentication_failed' : 'rate_limit';
  return code >= 400 && code < 500 ? 'invalid_request' : 'server_error';
}

// ---------- the stream ----------

/** Updates of one session, turned into events; it remembers what the next ones need (the text being written, usage). */
export class GeminiStream {
  lastAnswer = '';
  /** The context in use and its size, from the last usage update. */
  contextTokens = 0;
  contextSize = 0;
  usage: Totals = { cost: 0, models: {} };
  private text = '';
  private thought = '';
  private writing = false;
  private n = 0;
  private readonly seen = new Set<string>();

  constructor(private model: () => string) {}

  private id = () => `g-${++this.n}`;

  /** What was being written (thoughts, then text), as items: before a tool, and at the end of the turn. */
  flush(): AgentEvent[] {
    const out: AgentEvent[] = [];
    if (this.thought) out.push({ type: 'assistant', id: this.id(), blocks: [{ type: 'thinking', thinking: this.thought }], error: '', contextTokens: 0 });
    if (this.text) {
      this.lastAnswer = this.text;
      out.push({ type: 'assistant', id: this.id(), blocks: [{ type: 'text', text: this.text }], error: '', contextTokens: 0 });
    }
    this.thought = '';
    this.text = '';
    this.writing = false;
    return out;
  }

  handle(update: Json): AgentEvent[] {
    switch (str(update.sessionUpdate)) {
      case 'agent_thought_chunk': {
        const text = str(obj(update.content).text);
        this.thought += text;
        return [{ type: 'output', tokens: tokensOf(text) }];
      }
      case 'agent_message_chunk': {
        const delta = str(obj(update.content).text);
        const events: AgentEvent[] = [];
        // The thoughts that came first are kept as their own item, before the text.
        if (this.thought && !this.writing) {
          events.push({ type: 'assistant', id: this.id(), blocks: [{ type: 'thinking', thinking: this.thought }], error: '', contextTokens: 0 });
          this.thought = '';
        }
        events.push({ type: 'stream', textStart: !this.writing, delta: this.writing ? delta : '' });
        if (!this.writing && delta) events.push({ type: 'stream', textStart: false, delta });
        this.writing = true;
        this.text += delta;
        return events;
      }
      case 'tool_call': {
        const events = this.flush();
        const id = str(update.toolCallId);
        const status = str(update.status);
        if (!this.seen.has(id)) {
          this.seen.add(id);
          events.push({ type: 'assistant', id: `a-${id}`, blocks: [toolUse(update)], error: '', contextTokens: 0 });
        }
        // A call told when it is already over (a replayed conversation): its result comes with it.
        if (status === 'completed' || status === 'failed') events.push(this.result(update));
        return events.length > 0 ? events : ACTIVITY;
      }
      case 'tool_call_update': {
        const status = str(update.status);
        return status === 'completed' || status === 'failed' ? [this.result(update)] : ACTIVITY;
      }
      case 'usage_update':
        this.contextTokens = num(update.used);
        this.contextSize = num(update.size) || this.contextSize;
        return [{ type: 'context', tokens: this.contextTokens, size: this.contextSize }];
      default:
        // Plans, command lists, mode changes: the session is alive, nothing more.
        return ACTIVITY;
    }
  }

  private result(update: Json): AgentEvent {
    return { type: 'toolResults', blocks: [{ type: 'tool_result', tool_use_id: str(update.toolCallId), content: contentText(update.content), is_error: str(update.status) === 'failed' }] };
  }

  /** The prompt answered: what it cost in tokens (per model when the CLI says), and how it ended. */
  turn(response: Json): AgentEvent[] {
    const events = this.flush();
    const models = list(obj(obj(response._meta).quota).model_usage);
    const add = (model: string, input: number, output: number) => {
      const before = this.usage.models[model] ?? { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      this.usage = { cost: 0, models: { ...this.usage.models, [model]: { ...before, input: before.input + input, output: before.output + output } } };
    };
    if (models.length > 0) for (const m of models) add(str(m.model) || this.model(), num(obj(m.token_count).input_tokens), num(obj(m.token_count).output_tokens));
    else if (response.usage) add(this.model(), num(obj(response.usage).inputTokens), num(obj(response.usage).outputTokens));
    const reason = str(response.stopReason);
    events.push({
      type: 'turn',
      subtype: reason === 'cancelled' ? 'interrupted' : reason === 'refusal' ? 'error_during_execution' : 'success',
      isError: reason === 'refusal',
      result: reason === 'cancelled' || reason === 'refusal' ? '' : this.lastAnswer,
      queued: null,
      contextWindows: this.contextSize > 0 ? [this.contextSize] : [],
      usage: this.usage,
    });
    this.lastAnswer = '';
    return events;
  }
}

/** A conversation the agent replayed on `session/load` (its updates, in order) as the messages of a conversation. */
export function historyOf(updates: Json[]): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  let n = 0;
  let role: 'user' | 'assistant' | null = null;
  let text = '';
  const flush = () => {
    if (role && text) out.push({ role, id: `h-${++n}`, blocks: [{ type: 'text', text }] });
    role = null;
    text = '';
  };
  const into = (r: 'user' | 'assistant', chunk: string) => {
    if (role !== r) flush();
    role = r;
    text += chunk;
  };
  for (const u of updates) {
    switch (str(u.sessionUpdate)) {
      case 'user_message_chunk':
        into('user', str(obj(u.content).text));
        break;
      case 'agent_message_chunk':
        into('assistant', str(obj(u.content).text));
        break;
      case 'agent_thought_chunk':
        break;
      case 'tool_call': {
        flush();
        out.push({ role: 'assistant', id: `h-${++n}`, blocks: [toolUse(u)] });
        const status = str(u.status);
        if (status === 'completed' || status === 'failed') out.push({ role: 'user', id: `h-${++n}`, blocks: [{ type: 'tool_result', tool_use_id: str(u.toolCallId), content: contentText(u.content), is_error: status === 'failed' }] });
        break;
      }
      default:
        break;
    }
  }
  flush();
  return out;
}
