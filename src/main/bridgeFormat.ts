import { randomBytes } from 'node:crypto';

// Translation between Anthropic's Messages API, which Claude Code speaks, and OpenAI's Chat Completions, which OpenAI
// and every OpenAI-compatible server speak (OpenRouter, DeepSeek, LM Studio, llama.cpp, Ollama…). Pure functions: the
// bridge (bridge.ts) moves the bytes. Thinking blocks are left out: their signatures only mean something to Anthropic.

type Json = Record<string, unknown>;

export interface Target {
  /** Model the work runs on, and the one for Claude Code's small background calls (titles, summaries). */
  model: string;
  smallModel: string;
  /** OpenAI's own API takes max_completion_tokens; most other servers, max_tokens. */
  maxTokensField: 'max_completion_tokens' | 'max_tokens';
}

const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.map(obj) : []);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Anthropic's ids allow letters, digits, _ and - only. */
export const toolId = (id: unknown) => str(id).replace(/[^\w-]/g, '_') || `toolu_${randomBytes(12).toString('hex')}`;
export const messageId = () => `msg_${randomBytes(12).toString('hex')}`;

/**
 * Tool names OpenAI accepts (letters, digits, _ and -, 64 at most): a longer or odder one (an MCP tool) gets a stable
 * alias, and the replies give it back its own name.
 */
export class ToolNames {
  private readonly toOriginal = new Map<string, string>();

  safe(name: string): string {
    if (/^[\w-]{1,64}$/.test(name)) return name;
    let h = 0x811c9dc5;
    for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193) >>> 0;
    const alias = `${name.replace(/[^\w-]/g, '_').slice(0, 55)}_${h.toString(16).padStart(8, '0')}`;
    this.toOriginal.set(alias, name);
    return alias;
  }

  original(name: string): string {
    return this.toOriginal.get(name) ?? name;
  }
}

/** The model a request runs on: one of the account's own names as asked, Claude Code's small calls on the small one. */
export function pickModel(requested: unknown, target: Pick<Target, 'model' | 'smallModel'>): string {
  const r = str(requested);
  if (r && (r === target.model || r === target.smallModel)) return r;
  if (/haiku/i.test(r) && target.smallModel) return target.smallModel;
  return target.model;
}

const EFFORT: Record<string, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' };

/** Claude Code's effort or thinking budget, as OpenAI's reasoning_effort; null when it asks for no reasoning. */
export function reasoningOf(body: Json): string | null {
  const effort = str(obj(body.output_config).effort);
  if (EFFORT[effort]) return EFFORT[effort];
  const thinking = obj(body.thinking);
  if (thinking.type === 'enabled') {
    const budget = Number(thinking.budget_tokens) || 0;
    return budget >= 16_000 ? 'high' : budget >= 4_000 ? 'medium' : 'low';
  }
  return thinking.type === 'adaptive' ? 'medium' : null;
}

/** The text of a system prompt or a tool result: a string, or the text of its blocks. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  return list(content)
    .filter((b) => b.type === 'text')
    .map((b) => str(b.text))
    .filter(Boolean)
    .join('\n\n');
}

function imagePart(block: Json): Json | null {
  const source = obj(block.source);
  if (source.type === 'base64' && str(source.media_type) && str(source.data)) return { type: 'image_url', image_url: { url: `data:${str(source.media_type)};base64,${str(source.data)}` } };
  if (source.type === 'url' && str(source.url)) return { type: 'image_url', image_url: { url: str(source.url) } };
  return null;
}

/** A document block (a PDF Claude Code read, a text file): a file part, or its text. */
function documentPart(block: Json): Json | null {
  const source = obj(block.source);
  if (source.type === 'text' && str(source.data)) return { type: 'text', text: str(source.data) };
  if (source.type === 'base64' && str(source.data)) {
    const media = str(source.media_type) || 'application/pdf';
    return { type: 'file', file: { filename: str(block.title) || 'document.pdf', file_data: `data:${media};base64,${str(source.data)}` } };
  }
  return null;
}

/**
 * One Anthropic user turn: its tool results first, as OpenAI's tool messages (they must follow the assistant's calls),
 * then its own text, images and documents, with the images a tool returned (a tool message only carries text).
 */
function userMessages(content: unknown): Json[] {
  if (typeof content === 'string') return [{ role: 'user', content }];
  const tools: Json[] = [];
  const parts: Json[] = [];
  for (const b of list(content)) {
    if (b.type === 'text' && str(b.text)) parts.push({ type: 'text', text: str(b.text) });
    else if (b.type === 'image') {
      const part = imagePart(b);
      if (part) parts.push(part);
    } else if (b.type === 'document') {
      const part = documentPart(b);
      if (part) parts.push(part);
    } else if (b.type === 'tool_result') {
      const inner = typeof b.content === 'string' ? [{ type: 'text', text: b.content }] : list(b.content);
      const images = inner.filter((i) => i.type === 'image').map(imagePart).filter((p): p is Json => p !== null);
      const text = textOf(inner) || (images.length > 0 ? '(image below)' : '(no output)');
      const id = toolId(b.tool_use_id);
      tools.push({ role: 'tool', tool_call_id: id, content: b.is_error === true ? `[error] ${text}` : text });
      if (images.length > 0) parts.push({ type: 'text', text: `Image returned by tool call ${id}:` }, ...images);
    }
  }
  if (parts.length === 0) return tools;
  const onlyText = parts.every((p) => p.type === 'text');
  return [...tools, { role: 'user', content: onlyText ? parts.map((p) => str(p.text)).join('\n\n') : parts }];
}

/** One Anthropic assistant turn: its text and its tool calls; null when nothing is left (thinking only). */
function assistantMessage(content: unknown, names: ToolNames): Json | null {
  if (typeof content === 'string') return content ? { role: 'assistant', content } : null;
  const text: string[] = [];
  const calls: Json[] = [];
  for (const b of list(content)) {
    if (b.type === 'text' && str(b.text)) text.push(str(b.text));
    else if (b.type === 'tool_use') {
      calls.push({ id: toolId(b.id), type: 'function', function: { name: names.safe(str(b.name)), arguments: JSON.stringify(b.input ?? {}) } });
    }
  }
  if (text.length === 0 && calls.length === 0) return null;
  return { role: 'assistant', content: text.length > 0 ? text.join('\n\n') : null, ...(calls.length > 0 ? { tool_calls: calls } : {}) };
}

/** Claude Code's own tools (a JSON schema each); Anthropic's server tools (web search…) have no OpenAI equivalent. */
function toolsOf(tools: unknown, names: ToolNames): Json[] {
  return list(tools)
    .filter((t) => str(t.name) && t.input_schema && (t.type === undefined || t.type === 'custom'))
    .map((t) => ({ type: 'function', function: { name: names.safe(str(t.name)), description: str(t.description), parameters: t.input_schema } }));
}

function toolChoice(choice: unknown, names: ToolNames): unknown {
  const c = obj(choice);
  if (c.type === 'any') return 'required';
  if (c.type === 'none') return 'none';
  if (c.type === 'tool' && str(c.name)) return { type: 'function', function: { name: names.safe(str(c.name)) } };
  return c.type === 'auto' ? 'auto' : undefined;
}

/** A Messages request as a Chat Completions one. `names` keeps the tool aliases for the reply. */
export function toChatRequest(body: Json, target: Target, names: ToolNames): Json {
  const messages: Json[] = [];
  const system = textOf(body.system);
  if (system) messages.push({ role: 'system', content: system });
  for (const m of list(body.messages)) {
    if (m.role === 'user') messages.push(...userMessages(m.content));
    else if (m.role === 'assistant') {
      const a = assistantMessage(m.content, names);
      if (a) messages.push(a);
    }
  }
  const req: Json = { model: pickModel(body.model, target), messages, stream: body.stream === true };
  if (req.stream) req.stream_options = { include_usage: true };
  if (typeof body.max_tokens === 'number' && body.max_tokens > 0) req[target.maxTokensField] = body.max_tokens;
  if (typeof body.temperature === 'number') req.temperature = body.temperature;
  if (typeof body.top_p === 'number') req.top_p = body.top_p;
  const stops = Array.isArray(body.stop_sequences) ? body.stop_sequences.filter((s): s is string => typeof s === 'string') : [];
  if (stops.length > 0) req.stop = stops.slice(0, 4);
  const tools = toolsOf(body.tools, names);
  if (tools.length > 0) {
    req.tools = tools;
    const choice = toolChoice(body.tool_choice, names);
    if (choice !== undefined) req.tool_choice = choice;
    if (obj(body.tool_choice).disable_parallel_tool_use === true) req.parallel_tool_calls = false;
  }
  const effort = reasoningOf(body);
  if (effort) req.reasoning_effort = effort;
  return req;
}

/** A tool call's arguments as an object: what a model wrote that is not JSON reaches the tool as is, and fails there. */
export function parseArgs(raw: unknown): Json {
  const text = str(raw).trim();
  if (!text) return {};
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : { value: v };
  } catch {
    return { _unparsed_arguments: text };
  }
}

/** OpenAI's usage as Anthropic's: cached input tokens are counted apart, as cache reads. */
export function usageOf(usage: unknown): Json {
  const u = obj(usage);
  const prompt = Number(u.prompt_tokens) || 0;
  const cached = Number(obj(u.prompt_tokens_details).cached_tokens) || 0;
  return { input_tokens: Math.max(0, prompt - cached), output_tokens: Number(u.completion_tokens) || 0, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 };
}

const stopReason = (finish: unknown, tools: boolean) => (tools || finish === 'tool_calls' || finish === 'function_call' ? 'tool_use' : finish === 'length' ? 'max_tokens' : 'end_turn');

/** A Chat Completions reply (no stream) as a Messages one. */
export function fromChatResponse(res: Json, fallbackModel: string, names: ToolNames): Json {
  const choice = obj(list(res.choices)[0]);
  const msg = obj(choice.message);
  const content: Json[] = [];
  if (str(msg.content)) content.push({ type: 'text', text: str(msg.content) });
  for (const c of list(msg.tool_calls)) {
    const f = obj(c.function);
    content.push({ type: 'tool_use', id: toolId(c.id), name: names.original(str(f.name)), input: parseArgs(f.arguments) });
  }
  const tools = content.some((b) => b.type === 'tool_use');
  if (content.length === 0) content.push({ type: 'text', text: '' });
  return {
    id: messageId(),
    type: 'message',
    role: 'assistant',
    model: str(res.model) || fallbackModel,
    content,
    stop_reason: stopReason(choice.finish_reason, tools),
    stop_sequence: null,
    usage: usageOf(res.usage),
  };
}

export const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * A Chat Completions stream as a Messages one. Text streams as it comes; tool calls are gathered and sent whole at
 * the end, since OpenAI may interleave the fragments of parallel calls and Anthropic's blocks come one at a time.
 */
export class StreamTranslator {
  private started = false;
  private index = -1;
  private textOpen = false;
  private readonly calls = new Map<number, { id: string; name: string; args: string }>();
  private finish: unknown = null;
  private usage: Json = usageOf(null);

  constructor(
    private model: string,
    private readonly names: ToolNames,
    private readonly id = messageId(),
  ) {}

  /** message_start, once: sent as soon as the server answers, so a long think before the first word shows as alive. */
  start(): string[] {
    if (this.started) return [];
    this.started = true;
    const message = { id: this.id, type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
    return [sse('message_start', { type: 'message_start', message })];
  }

  /** The events for one chunk of the OpenAI stream. */
  push(chunk: Json): string[] {
    if (!this.started && str(chunk.model)) this.model = str(chunk.model);
    const out = this.start();
    if (chunk.usage) this.usage = usageOf(chunk.usage);
    const choice = obj(list(chunk.choices)[0]);
    const delta = obj(choice.delta);
    const text = str(delta.content);
    if (text) {
      if (!this.textOpen) {
        this.index++;
        this.textOpen = true;
        out.push(sse('content_block_start', { type: 'content_block_start', index: this.index, content_block: { type: 'text', text: '' } }));
      }
      out.push(sse('content_block_delta', { type: 'content_block_delta', index: this.index, delta: { type: 'text_delta', text } }));
    }
    for (const tc of list(delta.tool_calls)) {
      const k = typeof tc.index === 'number' ? tc.index : this.calls.size;
      const call = this.calls.get(k) ?? { id: '', name: '', args: '' };
      const f = obj(tc.function);
      if (str(tc.id)) call.id = str(tc.id);
      // OpenAI sends the name once; some servers repeat it whole, or split it.
      const n = str(f.name);
      if (n) call.name = !call.name || n.startsWith(call.name) ? n : call.name.endsWith(n) ? call.name : call.name + n;
      call.args += str(f.arguments);
      this.calls.set(k, call);
    }
    if (choice.finish_reason) this.finish = choice.finish_reason;
    return out;
  }

  /** The closing events: the text block, the tool calls, then the stop reason and the usage. */
  end(): string[] {
    const out = this.start();
    if (this.textOpen) out.push(sse('content_block_stop', { type: 'content_block_stop', index: this.index }));
    this.textOpen = false;
    const calls = [...this.calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
    for (const c of calls) {
      this.index++;
      const block = { type: 'tool_use', id: toolId(c.id), name: this.names.original(c.name), input: {} };
      out.push(
        sse('content_block_start', { type: 'content_block_start', index: this.index, content_block: block }),
        sse('content_block_delta', { type: 'content_block_delta', index: this.index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(parseArgs(c.args)) } }),
        sse('content_block_stop', { type: 'content_block_stop', index: this.index }),
      );
    }
    if (this.index < 0) {
      // An empty reply still holds one block.
      this.index = 0;
      out.push(
        sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
      );
    }
    out.push(
      sse('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason(this.finish, calls.length > 0), stop_sequence: null }, usage: this.usage }),
      sse('message_stop', { type: 'message_stop' }),
    );
    return out;
  }
}

/** An error as Anthropic's API writes it: Claude Code retries the rate limits and overloads, and shows the rest. */
export function anthropicError(status: number, message: string): { status: number; body: Json } {
  const type =
    status === 401
      ? 'authentication_error'
      : status === 403
        ? 'permission_error'
        : status === 404
          ? 'not_found_error'
          : status === 413
            ? 'request_too_large'
            : status === 429
              ? 'rate_limit_error'
              : status >= 500
                ? 'api_error'
                : 'invalid_request_error';
  return { status: status >= 400 && status < 600 ? status : 500, body: { type: 'error', error: { type, message } } };
}

/** The message of an OpenAI-style error body, else the raw text (cut). */
export function errorMessage(text: string): { message: string; code: string } {
  try {
    const e = obj(obj(JSON.parse(text)).error);
    const message = str(e.message);
    if (message) return { message, code: str(e.code) || str(e.type) };
  } catch {
    // Not JSON: a proxy's page, a plain message.
  }
  return { message: text.trim().slice(0, 500) || 'no message', code: '' };
}

/** Parameters a server may refuse (a reasoning model and temperature, an old one and reasoning_effort…). */
const DROPPABLE = ['reasoning_effort', 'temperature', 'top_p', 'parallel_tool_calls', 'stream_options', 'stop', 'max_completion_tokens', 'max_tokens'];

/**
 * What to change in a request a server refused with this message, or null when nothing would help: a parameter it
 * does not take is left out, max_tokens becomes max_completion_tokens where it asks for that. Changes `req`.
 */
export function adjustRequest(req: Json, status: number, message: string): string | null {
  if (status !== 400 && status !== 422) return null;
  if ('max_tokens' in req && /max_completion_tokens/.test(message) && /max_tokens/.test(message.replace(/max_completion_tokens/g, ''))) {
    req.max_completion_tokens = req.max_tokens;
    delete req.max_tokens;
    return 'rename:max_tokens';
  }
  for (const p of DROPPABLE) {
    if (p in req && message.includes(p)) {
      delete req[p];
      return `drop:${p}`;
    }
  }
  // "max_tokens is too large", whichever field carried it.
  if (/max_tokens|maximum.*tokens|output tokens/i.test(message)) {
    for (const p of ['max_completion_tokens', 'max_tokens']) {
      if (p in req) {
        delete req[p];
        return `drop:${p}`;
      }
    }
  }
  return null;
}

/** Applies the changes an earlier refusal taught (same account and model) before sending. */
export function applyAdjustments(req: Json, changes: Iterable<string>): void {
  for (const c of changes) {
    if (c === 'rename:max_tokens' && 'max_tokens' in req) {
      req.max_completion_tokens = req.max_tokens;
      delete req.max_tokens;
    } else if (c.startsWith('drop:')) delete req[c.slice(5)];
  }
}
