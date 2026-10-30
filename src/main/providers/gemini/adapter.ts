import type { Totals } from '../../../shared/costs';
import type { Effort, Mode, RateLimits } from '../../../shared/types';
import type { Block } from '../blocks';
import { EventQueue } from '../queue';
import type { AgentEvent, AgentInput, AgentModel, AgentProcess, LaunchSpec, ProviderAdapter } from '../types';
import { AcpClient, AcpError, type AcpRequest } from './acp';
import { googleSignIn, modelsOfSession } from './cli';
import { errorCodeOf, GeminiStream, historyOf, limitOfError, toolUse } from './events';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.map(obj) : []);

const HUB_VERSION = '0.2';
const tail = (text: string) => text.trim().split('\n').slice(-3).join(' ').slice(0, 400);

/** The hub's permission modes as the Gemini CLI's: what it asks about, and what it lets through. */
export function acpMode(mode: Mode | null, readOnly: boolean): string {
  if (readOnly) return 'plan';
  switch (mode ?? 'default') {
    case 'plan':
      return 'plan';
    case 'acceptEdits':
    case 'auto':
      return 'autoEdit';
    case 'dontAsk':
    case 'bypassPermissions':
      return 'yolo';
    default:
      return 'default';
  }
}

/** The way an account signs in to the CLI: an API key in the environment, else the Google sign-in. */
export const authMethodOf = (env: Record<string, string>) => (env.GEMINI_API_KEY ? 'gemini-api-key' : 'oauth-personal');

/** The prompt of a turn from the hub's blocks: text, and images the way the protocol wants them. */
export function promptOf(content: string | Block[]): Json[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  const out: Json[] = [];
  for (const b of content) {
    if (b.type === 'text' && typeof b.text === 'string') out.push({ type: 'text', text: b.text });
    else if (b.type === 'image') {
      const src = obj(b.source);
      if (src.type === 'base64') out.push({ type: 'image', data: str(src.data), mimeType: str(src.media_type) });
    }
  }
  return out;
}

const textOfContent = (content: string | Block[]): string =>
  typeof content === 'string'
    ? content
    : content
        .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
        .filter(Boolean)
        .join('\n');

/** The option of a permission request that says yes (once, or for good) or no. */
export function pickOption(options: Json[], allow: boolean, always: boolean): string | null {
  const by = (kind: string) => options.find((o) => o.kind === kind);
  const chosen = allow ? ((always ? by('allow_always') : null) ?? by('allow_once') ?? by('allow_always')) : (by('reject_once') ?? by('reject_always'));
  return chosen ? str(chosen.optionId) : null;
}

class GeminiProcess implements AgentProcess {
  private readonly queue = new EventQueue<AgentEvent>();
  readonly events: AsyncIterable<AgentEvent> = this.queue;
  private readonly client: AcpClient;
  private readonly stream: GeminiStream;
  private readonly readyP: Promise<{ models: AgentModel[]; commands: [] }>;
  private sessionId = '';
  private model = '';
  private mode: Mode | null;
  private modelsList: AgentModel[] = [];
  private pending: AgentInput[] = [];
  private prompting = false;
  private replaying = false;
  private fresh = true;
  private closed = false;
  private readonly asks = new Set<AbortController>();

  constructor(private readonly spec: LaunchSpec) {
    this.mode = spec.mode;
    this.model = spec.model;
    this.stream = new GeminiStream(() => this.model);
    this.client = new AcpClient({ executable: spec.executable || 'gemini', env: { ...spec.env, GEMINI_CLI_TRUST_WORKSPACE: 'true' }, cwd: spec.cwd, version: HUB_VERSION });
    this.readyP = this.run();
    this.readyP.catch(() => undefined);
  }

  ready = () => this.readyP;

  private mcpServers(): Json[] {
    const { mcp } = this.spec;
    return mcp ? [{ type: 'http', name: 'hub', url: mcp.url, headers: [{ name: 'Authorization', value: `Bearer ${mcp.token}` }] }] : [];
  }

  private async run(): Promise<{ models: AgentModel[]; commands: [] }> {
    const { client, spec } = this;
    client.onNotification = (method, params) => this.onNotification(method, params);
    client.onRequest = (req) => this.onRequest(req);
    client.onExit = (info) => {
      if (info.closed) this.queue.close();
      else this.queue.fail(new Error(`gemini exited${info.code !== null ? ` (${info.code})` : ''}: ${tail(info.stderr)}`));
    };
    try {
      await client.start();
      const method = authMethodOf(spec.env);
      // A Google sign-in that is not there would open a browser from a session nobody is watching: refused here.
      if (method === 'oauth-personal' && !googleSignIn(spec.env.GEMINI_CLI_HOME ?? '').signedIn) {
        this.queue.push({ type: 'limit', signal: { kind: 'auth', resetsAt: null, source: 'gemini:not-signed-in' } });
        throw new Error('Gemini is not signed in: connect it in Settings › Accounts.');
      }
      await client.request('authenticate', { methodId: method });
      let session: Json | null = null;
      if (spec.conversation.resume) {
        this.replaying = true;
        try {
          session = obj(await client.request('session/load', { sessionId: spec.conversation.id, cwd: spec.cwd, mcpServers: this.mcpServers() }));
          this.sessionId = spec.conversation.id;
          this.fresh = false;
        } catch (err) {
          // The CLI no longer has the conversation: a new one starts in its place (the hub says so by its new id).
          if (!(err instanceof AcpError)) throw err;
        } finally {
          this.replaying = false;
        }
      }
      if (!session) {
        session = obj(await client.request('session/new', { cwd: spec.cwd, mcpServers: this.mcpServers() }));
        this.sessionId = str(session.sessionId);
      }
      this.modelsList = modelsOfSession(session);
      const current = str(obj(session.models).currentModelId);
      if (spec.model && this.modelsList.some((m) => m.value === spec.model)) await client.request('session/set_model', { sessionId: this.sessionId, modelId: spec.model }).catch(() => undefined);
      this.model = spec.model && this.modelsList.some((m) => m.value === spec.model) ? spec.model : current || this.model;
      const wanted = acpMode(this.mode, spec.readOnly);
      if (wanted !== 'default') await client.request('session/set_mode', { sessionId: this.sessionId, modeId: wanted }).catch(() => undefined);
      this.queue.push({ type: 'conversation', id: this.sessionId, mode: this.mode ?? 'default', effort: null, model: this.model });
      void this.pump();
      return { models: this.modelsList, commands: [] };
    } catch (err) {
      this.queue.fail(err);
      client.close();
      throw err;
    }
  }

  /** Takes the hub's prompts one by one: the protocol has no way to add to a turn, so each waits for the one before. */
  private async pump(): Promise<void> {
    try {
      for await (const input of this.spec.input) {
        this.pending.push(input);
        void this.drain();
      }
    } catch (err) {
      this.queue.fail(err);
    }
    this.close();
  }

  private async drain(): Promise<void> {
    if (this.prompting || this.closed) return;
    const input = this.pending.shift();
    if (!input) return;
    this.prompting = true;
    this.queue.push({ type: 'promptTaken', text: textOfContent(input.content) });
    const parts = promptOf(input.content);
    // The hub's instructions have no place of their own in the protocol: they open a new conversation's first message.
    if (this.fresh && this.spec.instructions) {
      parts.unshift({ type: 'text', text: `${this.spec.instructions}\n\n---\n` });
      this.fresh = false;
    }
    try {
      const response = obj(await this.client.request('session/prompt', { sessionId: this.sessionId, prompt: parts }));
      for (const e of this.stream.turn(response)) this.queue.push(e);
    } catch (err) {
      if (this.closed) return;
      for (const e of this.failure(err)) this.queue.push(e);
    } finally {
      this.prompting = false;
      for (const a of this.asks) a.abort();
      if (this.pending.length > 0 && !this.closed) void this.drain();
    }
  }

  /** A prompt the agent refused: the limit it says, the error as the conversation shows it, the turn over. */
  private failure(err: unknown): AgentEvent[] {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof AcpError ? err.code : 0;
    const events: AgentEvent[] = this.stream.flush();
    const limit = limitOfError(code, message, Date.now());
    if (limit) events.push({ type: 'limit', signal: limit });
    events.push({ type: 'assistant', id: `error-${Date.now()}`, blocks: [], error: errorCodeOf(code, message), contextTokens: 0 });
    events.push({ type: 'turn', subtype: 'error_during_execution', isError: true, result: '', queued: null, contextWindows: [], usage: this.stream.usage });
    return events;
  }

  private onNotification(method: string, params: Json): void {
    // The conversation the agent tells again on a load is already in the hub's items.
    if (method !== 'session/update' || this.replaying) return;
    this.spec.onSignal();
    for (const e of this.stream.handle(obj(params.update))) this.queue.push(e);
  }

  private async onRequest(req: AcpRequest): Promise<unknown> {
    if (req.method !== 'session/request_permission') throw new AcpError(`${req.method} is not handled by the hub`, -32601);
    const options = list(req.params.options);
    const call = obj(req.params.toolCall);
    const use = toolUse(call);
    const controller = new AbortController();
    this.asks.add(controller);
    try {
      const answer = await this.spec.onPermission({
        tool: str(use.name),
        input: obj(use.input),
        reason: '',
        canAlways: options.some((o) => o.kind === 'allow_always'),
        signal: controller.signal,
      });
      const optionId = pickOption(options, answer.behavior === 'allow', answer.behavior === 'allow' && answer.always);
      return optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } };
    } finally {
      this.asks.delete(controller);
    }
  }

  async interrupt(): Promise<void> {
    if (this.sessionId && this.prompting) this.client.notify('session/cancel', { sessionId: this.sessionId });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const a of this.asks) a.abort();
    this.client.close();
    this.queue.close();
  }

  async setModel(model: string): Promise<void> {
    this.model = model;
    if (this.sessionId) await this.client.request('session/set_model', { sessionId: this.sessionId, modelId: model });
  }

  /** Gemini takes no effort setting. */
  async setEffort(_effort: Effort): Promise<void> {}

  /** Ultracode is Claude Code's. */
  async setUltracode(): Promise<void> {
    throw new Error('Ultracode is a Claude Code mode');
  }

  async setMode(mode: Mode): Promise<void> {
    this.mode = mode;
    if (this.sessionId) await this.client.request('session/set_mode', { sessionId: this.sessionId, modeId: acpMode(mode, this.spec.readOnly) });
  }

  async context() {
    return { tokens: this.stream.contextTokens, size: this.stream.contextSize, model: this.model };
  }

  /** Tokens spent by this process: a resumed conversation counts from zero (the CLI gives no running total). */
  async totals(): Promise<Totals> {
    return this.stream.usage;
  }

  async rateLimits(): Promise<RateLimits | null> {
    return null;
  }
}

export const geminiAdapter: ProviderAdapter = {
  harness: 'gemini',

  start: (spec) => new GeminiProcess(spec),

  // The CLI is asked when the conversation is loaded; a conversation it no longer has starts a new one in its place.
  hasConversation: async () => true,

  async history(id, cwd, ctx) {
    const client = new AcpClient({ executable: ctx.executable || 'gemini', env: { ...ctx.env, GEMINI_CLI_TRUST_WORKSPACE: 'true' }, cwd, version: HUB_VERSION });
    const updates: Json[] = [];
    client.onNotification = (method, params) => {
      if (method === 'session/update') updates.push(obj(params.update));
    };
    try {
      await client.start();
      const method = authMethodOf(ctx.env);
      if (method === 'oauth-personal' && !googleSignIn(ctx.env.GEMINI_CLI_HOME ?? '').signedIn) return [];
      await client.request('authenticate', { methodId: method });
      await client.request('session/load', { sessionId: id, cwd, mcpServers: [] });
      return historyOf(updates);
    } finally {
      client.close();
    }
  },

  defaultMode: async () => null,
  inheritedEffort: async () => undefined,
  isMissingProgram: (failure) => /ENOENT|command not found|no such file/i.test(failure) && /gemini/i.test(failure),
};
