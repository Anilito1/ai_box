import type { Totals } from '../../../shared/costs';
import type { Block } from '../blocks';
import type { AgentEvent, HistoryMessage, LimitSignal } from '../types';

// Codex app-server's notifications and items as the hub's own events and content blocks. No process here: the adapter
// feeds it, tests replay it.

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.map(obj) : []);

const ACTIVITY: AgentEvent[] = [{ type: 'activity' }];

// ---------- items as content blocks ----------

/** A tool's input as the hub shows tools: a command is a Bash call, a patch an ApplyPatch, an MCP tool `mcp__<server>__<tool>`. */
function toolUse(item: Json): Block | null {
  const id = str(item.id);
  switch (item.type) {
    case 'commandExecution':
      return { type: 'tool_use', id, name: 'Bash', input: { command: str(item.command) } };
    case 'fileChange': {
      const changes = list(item.changes).map((c) => ({ path: str(c.path), kind: str(obj(c.kind).type) || 'update', diff: str(c.diff) }));
      return { type: 'tool_use', id, name: 'ApplyPatch', input: { file_path: changes[0]?.path ?? '', changes } };
    }
    case 'mcpToolCall':
      return { type: 'tool_use', id, name: `mcp__${str(item.server)}__${str(item.tool)}`, input: obj(item.arguments) };
    case 'dynamicToolCall':
      return { type: 'tool_use', id, name: str(item.tool), input: obj(item.arguments) };
    case 'webSearch':
      return { type: 'tool_use', id, name: 'WebSearch', input: { query: str(item.query) || str(obj(item.action).query) } };
    default:
      return null;
  }
}

/** The text an MCP tool answered. */
function mcpText(item: Json): string {
  const error = str(obj(item.error).message);
  if (error) return error;
  const parts = list(obj(item.result).content)
    .map((c) => (c.type === 'text' ? str(c.text) : ''))
    .filter(Boolean);
  return parts.join('\n');
}

function toolResult(item: Json): Block | null {
  const id = str(item.id);
  const status = str(item.status);
  const failed = status === 'failed' || status === 'declined';
  switch (item.type) {
    case 'commandExecution': {
      const code = item.exitCode;
      return { type: 'tool_result', tool_use_id: id, content: str(item.aggregatedOutput), is_error: failed || (typeof code === 'number' && code !== 0) };
    }
    case 'fileChange':
      return { type: 'tool_result', tool_use_id: id, content: status === 'completed' ? '' : status, is_error: failed };
    case 'mcpToolCall':
      return { type: 'tool_result', tool_use_id: id, content: mcpText(item), is_error: failed || !!obj(item.error).message };
    case 'dynamicToolCall':
      return { type: 'tool_result', tool_use_id: id, content: list(item.contentItems).map((c) => str(c.text)).join('\n'), is_error: item.success === false };
    case 'webSearch':
      return { type: 'tool_result', tool_use_id: id, content: '', is_error: false };
    default:
      return null;
  }
}

/** What a user message of Codex holds, as blocks. */
function userBlocks(item: Json): Block[] {
  return list(item.content).flatMap((c): Block[] => {
    if (c.type === 'text') return [{ type: 'text', text: str(c.text) }];
    if (c.type === 'image' && str(c.url).startsWith('data:')) {
      const m = /^data:([^;]+);base64,(.*)$/s.exec(str(c.url));
      return m ? [{ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }] : [];
    }
    return [];
  });
}

/** A stored thread (its turns, items in full) as the messages of a conversation, oldest first. */
export function historyOf(turns: Json[]): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (const turn of turns) {
    for (const item of list(turn.items)) {
      const id = str(item.id);
      if (item.type === 'userMessage') {
        const blocks = userBlocks(item);
        if (blocks.length > 0) out.push({ role: 'user', id, blocks });
      } else if (item.type === 'agentMessage') {
        if (str(item.text)) out.push({ role: 'assistant', id, blocks: [{ type: 'text', text: str(item.text) }] });
      } else if (item.type === 'reasoning') {
        const text = (Array.isArray(item.summary) ? item.summary : []).map(str).filter(Boolean).join('\n');
        if (text) out.push({ role: 'assistant', id, blocks: [{ type: 'thinking', thinking: text }] });
      } else {
        const use = toolUse(item);
        const result = toolResult(item);
        if (use) out.push({ role: 'assistant', id, blocks: [use] });
        if (result) out.push({ role: 'user', id: `${id}-result`, blocks: [result] });
      }
    }
  }
  return out;
}

// ---------- errors and limits ----------

/** Codex's `codexErrorInfo` (a name, or an object with the name as its key) as a short code. */
export function errorName(info: unknown): string {
  if (typeof info === 'string') return info;
  return Object.keys(obj(info))[0] ?? '';
}

/** The code the hub's error wording knows (see errors.ts), for an error of Codex. */
export function errorCodeOf(name: string): string {
  switch (name) {
    case 'usageLimitExceeded':
    case 'rateLimitExceeded':
    case 'serverOverloaded':
    case 'sessionBudgetExceeded':
      return 'rate_limit';
    case 'unauthorized':
      return 'authentication_failed';
    case 'contextWindowExceeded':
      return 'context_exceeded';
    case 'badRequest':
      return 'invalid_request';
    case 'internalServerError':
    case 'httpConnectionFailed':
    case 'responseStreamConnectionFailed':
    case 'responseStreamDisconnected':
    case 'responseTooManyFailedAttempts':
      return 'server_error';
    default:
      return 'unknown';
  }
}

/** One window of a plan's limits, or the spending cap of a workspace plan. */
export interface LimitWindow {
  usedPercent: number;
  windowMins: number | null;
  resetsAt: number | null;
}

/** The earliest moment a limit that is reached lets work go on, from a rate-limit snapshot of Codex. */
export function resetOf(snapshot: Json | null): number | null {
  if (!snapshot) return null;
  const windows = [obj(snapshot.primary), obj(snapshot.secondary)].filter((w) => num(w.usedPercent) >= 100 && num(w.resetsAt) > 0).map((w) => num(w.resetsAt));
  // Both windows full: work goes on when the last one opens.
  if (windows.length > 0) return Math.max(...windows);
  const cap = obj(snapshot.individualLimit);
  return num(cap.resetsAt) > 0 ? num(cap.resetsAt) : null;
}

export function limitOf(name: string, snapshot: Json | null): LimitSignal | null {
  if (name === 'usageLimitExceeded') return { kind: 'quota', resetsAt: resetOf(snapshot), source: 'codex:usageLimitExceeded' };
  if (name === 'rateLimitExceeded') return { kind: 'rate', resetsAt: resetOf(snapshot), source: 'codex:rateLimitExceeded' };
  if (name === 'unauthorized') return { kind: 'auth', resetsAt: null, source: 'codex:unauthorized' };
  return null;
}

// ---------- the stream ----------

/** Notifications of one thread, turned into events; it remembers what the next ones need (the turn's answer, usage). */
export class CodexStream {
  /** The last thing the agent said in this turn: a turn's result. */
  lastAnswer = '';
  /** Running totals of the thread, and the size of the context now. */
  usage: Totals = { cost: 0, models: {} };
  contextTokens = 0;
  contextSize = 0;
  /** The last snapshot of the account's limits. */
  limits: Json | null = null;
  private readonly started = new Set<string>();
  /** The file changes of the items in progress: an approval shows them. */
  readonly changes = new Map<string, Json>();

  constructor(private model: () => string) {}

  handle(method: string, p: Json): AgentEvent[] {
    switch (method) {
      case 'turn/started':
        this.lastAnswer = '';
        return [{ type: 'stream', textStart: false, delta: '' }];
      case 'item/started':
        return this.itemStarted(obj(p.item));
      case 'item/agentMessage/delta':
        return [{ type: 'stream', textStart: false, delta: str(p.delta) }];
      case 'item/completed':
        return this.itemCompleted(obj(p.item));
      case 'thread/tokenUsage/updated': {
        const usage = obj(p.tokenUsage);
        const total = obj(usage.total);
        const last = obj(usage.last);
        const cached = num(total.cachedInputTokens);
        this.usage = {
          cost: 0,
          models: {
            [this.model()]: {
              cost: 0,
              // OpenAI counts cached tokens inside the input: the hub counts them apart.
              input: Math.max(0, num(total.inputTokens) - cached),
              output: num(total.outputTokens),
              cacheRead: cached,
              cacheWrite: num(total.cacheWriteInputTokens),
            },
          },
        };
        this.contextTokens = num(last.inputTokens);
        this.contextSize = num(usage.modelContextWindow) || this.contextSize;
        return ACTIVITY;
      }
      case 'thread/compacted':
        return [{ type: 'compacted', before: this.contextTokens }];
      case 'account/rateLimits/updated': {
        this.limits = obj(p.rateLimits);
        return ACTIVITY;
      }
      case 'error': {
        const error = obj(p.error);
        if (p.willRetry === true) return [{ type: 'retry' }];
        const name = errorName(error.codexErrorInfo);
        const events: AgentEvent[] = [];
        const limit = limitOf(name, this.limits);
        if (limit) events.push({ type: 'limit', signal: limit });
        events.push({ type: 'assistant', id: `error-${str(p.turnId) || Date.now()}`, blocks: [], error: errorCodeOf(name), contextTokens: 0 });
        return events;
      }
      case 'turn/completed': {
        const turn = obj(p.turn);
        const status = str(turn.status);
        const failed = status === 'failed';
        return [
          {
            type: 'turn',
            subtype: status === 'completed' ? 'success' : status === 'interrupted' ? 'interrupted' : 'error_during_execution',
            isError: failed,
            result: status === 'completed' ? this.lastAnswer : '',
            queued: null,
            contextWindows: this.contextSize > 0 ? [this.contextSize] : [],
            usage: this.usage,
          },
        ];
      }
      default:
        // Output deltas, reasoning, status changes: the session is alive, nothing more.
        return method.startsWith('item/') ? ACTIVITY : [];
    }
  }

  private itemStarted(item: Json): AgentEvent[] {
    const id = str(item.id);
    if (item.type === 'agentMessage') return [{ type: 'stream', textStart: true, delta: '' }];
    const use = toolUse(item);
    if (!use || this.started.has(id)) return ACTIVITY;
    this.started.add(id);
    if (item.type === 'fileChange') this.changes.set(id, item);
    return [{ type: 'assistant', id: `a-${id}`, blocks: [use], error: '', contextTokens: 0 }];
  }

  private itemCompleted(item: Json): AgentEvent[] {
    const id = str(item.id);
    switch (item.type) {
      case 'agentMessage': {
        const text = str(item.text);
        if (text) this.lastAnswer = text;
        return text ? [{ type: 'assistant', id: `a-${id}`, blocks: [{ type: 'text', text }], error: '', contextTokens: 0 }] : ACTIVITY;
      }
      case 'reasoning': {
        const text = (Array.isArray(item.summary) ? item.summary : []).map(str).filter(Boolean).join('\n');
        return text ? [{ type: 'assistant', id: `a-${id}`, blocks: [{ type: 'thinking', thinking: text }], error: '', contextTokens: 0 }] : ACTIVITY;
      }
      case 'contextCompaction':
        return [{ type: 'compacted', before: this.contextTokens }];
      default: {
        const result = toolResult(item);
        if (!result) return ACTIVITY;
        const events: AgentEvent[] = [];
        // An item that finished without our seeing it start (a resumed turn): its call first, so the result has a card.
        if (!this.started.has(id)) events.push(...this.itemStarted(item));
        this.changes.delete(id);
        events.push({ type: 'toolResults', blocks: [result] });
        return events;
      }
    }
  }
}
