import type { Totals } from '../../../shared/costs';
import { EFFORTS, type Effort, type Mode, type RateLimits } from '../../../shared/types';
import type { Block } from '../blocks';
import { EventQueue } from '../queue';
import type { AdapterContext, AgentEvent, AgentInput, AgentModel, AgentProcess, LaunchSpec, ProviderAdapter } from '../types';
import { CodexClient, RpcError, type ServerRequest } from './client';
import { CodexStream, historyOf } from './events';
import { clampEffort, policyOf, sandboxPolicy } from './modes';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.map(obj) : []);

const HUB_VERSION = '0.2';
/** The hub's tools can wait for the user (a folder to allow, a question): no timeout worth the name. */
const TOOL_TIMEOUT_S = 3600;

/** The models Codex lists for an account, with the efforts the hub knows. */
export function modelsOf(response: Json): AgentModel[] {
  return list(response.data)
    .filter((m) => m.hidden !== true)
    .map((m) => ({
      value: str(m.model) || str(m.id),
      displayName: str(m.displayName) || str(m.model),
      description: str(m.description),
      efforts: list(m.supportedReasoningEfforts)
        .map((e) => str(e.reasoningEffort))
        .filter((e): e is Effort => (EFFORTS as string[]).includes(e)),
    }));
}

/**
 * The params of a turn: the effort the session holds goes with each turn, fitted to the levels the model takes (Codex
 * refuses one it does not list), and is left out when the model lists none.
 */
export function turnStartParams(a: {
  threadId: string;
  input: string | Block[];
  cwd: string;
  model: string;
  effort: Effort | null;
  efforts: string[];
  mode: Mode | null;
  readOnly: boolean;
  roots: string[];
}): Json {
  const policy = policyOf(a.mode, a.readOnly);
  const effort = a.effort ? clampEffort(a.effort, a.efforts) : null;
  return {
    threadId: a.threadId,
    input: userInputOf(a.input),
    cwd: a.cwd,
    ...(a.model ? { model: a.model } : {}),
    ...(effort ? { effort } : {}),
    approvalPolicy: policy.approvalPolicy,
    approvalsReviewer: policy.reviewer,
    sandboxPolicy: sandboxPolicy(policy.sandbox, a.roots),
  };
}

/** What the hub shows of an account's limits: Codex's windows by their length (5 hours, 7 days). */
export function rateLimitsOf(snapshot: Json | null): RateLimits | null {
  if (!snapshot) return null;
  let five: Json | null = null;
  let seven: Json | null = null;
  for (const w of [obj(snapshot.primary), obj(snapshot.secondary)]) {
    if (typeof w.usedPercent !== 'number') continue;
    const mins = typeof w.windowDurationMins === 'number' ? w.windowDurationMins : 0;
    if (mins >= 7 * 24 * 60 - 60) seven = w;
    else if (!five) five = w;
    else seven = seven ?? w;
  }
  if (!five && !seven) return null;
  return {
    fiveHourPct: five ? (five.usedPercent as number) : null,
    fiveHourResetsAt: five && typeof five.resetsAt === 'number' ? five.resetsAt : null,
    sevenDayPct: seven ? (seven.usedPercent as number) : null,
    sevenDayResetsAt: seven && typeof seven.resetsAt === 'number' ? seven.resetsAt : null,
  };
}

/** The user input of a turn from the hub's blocks: text, and images as data URLs. */
export function userInputOf(content: string | Block[]): Json[] {
  if (typeof content === 'string') return [{ type: 'text', text: content, text_elements: [] }];
  const out: Json[] = [];
  for (const b of content) {
    if (b.type === 'text' && typeof b.text === 'string') out.push({ type: 'text', text: b.text, text_elements: [] });
    else if (b.type === 'image') {
      const src = obj(b.source);
      if (src.type === 'base64') out.push({ type: 'image', url: `data:${str(src.media_type)};base64,${str(src.data)}` });
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

const tail = (text: string) => text.trim().split('\n').slice(-3).join(' ').slice(0, 400);

class CodexProcess implements AgentProcess {
  private readonly queue = new EventQueue<AgentEvent>();
  readonly events: AsyncIterable<AgentEvent> = this.queue;
  private readonly client: CodexClient;
  private readonly stream: CodexStream;
  private readonly readyP: Promise<{ models: AgentModel[]; commands: [] }>;
  private models: AgentModel[] = [];
  private threadId = '';
  private model = '';
  private effort: Effort | null;
  private mode: Mode | null;
  private turnId: string | null = null;
  private starting = false;
  private pending: AgentInput[] = [];
  private closed = false;
  private readonly asks = new Map<string | number, AbortController>();
  /** The folders a session may write: its own, and the ones its post adds. */
  private readonly roots: string[];

  constructor(private readonly spec: LaunchSpec) {
    this.effort = spec.effort;
    this.mode = spec.mode;
    this.model = spec.model;
    this.roots = [spec.cwd, ...spec.extraDirs];
    this.stream = new CodexStream(() => this.model);
    this.client = new CodexClient({ executable: spec.executable || 'codex', env: { ...spec.env, ...(spec.mcp ? { HUB_MCP_TOKEN: spec.mcp.token } : {}) }, cwd: spec.cwd, version: HUB_VERSION });
    this.readyP = this.run();
    // The failure reaches the manager through the event stream; nobody awaiting ready() must see it unhandled.
    this.readyP.catch(() => undefined);
  }

  ready = () => this.readyP;

  private async run(): Promise<{ models: AgentModel[]; commands: [] }> {
    const { client } = this;
    client.onNotification = (method, params) => this.onNotification(method, params);
    client.onRequest = (req) => this.onRequest(req);
    client.onExit = (info) => {
      if (info.closed) this.queue.close();
      else this.queue.fail(new Error(`codex exited${info.code !== null ? ` (${info.code})` : ''}: ${tail(info.stderr)}`));
    };
    try {
      await client.start();
      const listed = await client.request('model/list', {}).catch(() => ({}));
      this.models = modelsOf(obj(listed));
      const opened = obj(await this.openThread());
      this.threadId = str(obj(opened.thread).id);
      this.model = str(opened.model) || this.model;
      const effort = str(opened.reasoningEffort);
      this.queue.push({
        type: 'conversation',
        id: this.threadId,
        mode: this.mode ?? 'default',
        effort: (EFFORTS as string[]).includes(effort) ? (effort as Effort) : null,
        model: this.model,
      });
      void this.pump();
      return { models: this.models, commands: [] };
    } catch (err) {
      this.queue.fail(err);
      client.close();
      throw err;
    }
  }

  private threadConfig(): Json {
    const { mcp, extraDirs } = this.spec;
    return {
      ...(mcp
        ? {
            'mcp_servers.hub.url': mcp.url,
            'mcp_servers.hub.bearer_token_env_var': 'HUB_MCP_TOKEN',
            // The hub's tools are the hub's own: asked once by the user's settings, not at each call.
            'mcp_servers.hub.default_tools_approval_mode': 'approve',
            'mcp_servers.hub.tool_timeout_sec': TOOL_TIMEOUT_S,
            'mcp_servers.hub.startup_timeout_sec': 30,
          }
        : {}),
      ...(extraDirs.length > 0 ? { 'sandbox_workspace_write.writable_roots': extraDirs } : {}),
    };
  }

  private openThread(): Promise<unknown> {
    const { spec } = this;
    const policy = policyOf(this.mode, spec.readOnly);
    const params: Json = {
      cwd: spec.cwd,
      ...(spec.model ? { model: spec.model } : {}),
      approvalPolicy: policy.approvalPolicy,
      approvalsReviewer: policy.reviewer,
      sandbox: policy.sandbox,
      developerInstructions: spec.instructions,
      config: this.threadConfig(),
    };
    return spec.conversation.resume
      ? this.client.request('thread/resume', { threadId: spec.conversation.id, ...params })
      : this.client.request('thread/start', { ...params, serviceName: 'claude_hub' });
  }

  /** Takes the hub's prompts one by one: into the turn in progress, or as the start of the next one. */
  private async pump(): Promise<void> {
    try {
      for await (const input of this.spec.input) await this.deliver(input);
    } catch (err) {
      this.queue.fail(err);
    }
    this.close();
  }

  private async deliver(input: AgentInput): Promise<void> {
    const text = textOfContent(input.content);
    if (/^\/compact\b/.test(text.trim()) && !this.turnId) {
      this.queue.push({ type: 'promptTaken', text });
      this.queue.push({ type: 'compacting', on: true });
      await this.client.request('thread/compact/start', { threadId: this.threadId }).catch(() => undefined);
      return;
    }
    if (this.turnId) {
      try {
        await this.client.request('turn/steer', { threadId: this.threadId, expectedTurnId: this.turnId, input: userInputOf(input.content) });
        this.queue.push({ type: 'promptTaken', text });
        return;
      } catch (err) {
        // The turn is not open to new input (or just ended): this one waits for the next.
        if (!(err instanceof RpcError)) throw err;
      }
    }
    this.pending.push(input);
    await this.startNext();
  }

  private async startNext(): Promise<void> {
    if (this.starting || this.turnId || this.pending.length === 0) return;
    this.starting = true;
    const input = this.pending.shift() as AgentInput;
    try {
      const res = obj(
        await this.client.request(
          'turn/start',
          turnStartParams({
            threadId: this.threadId,
            input: input.content,
            cwd: this.spec.cwd,
            model: this.model,
            effort: this.effort,
            efforts: this.effortsOf(this.model),
            mode: this.mode,
            readOnly: this.spec.readOnly,
            roots: this.roots,
          }),
        ),
      );
      this.turnId = str(obj(res.turn).id) || 'turn';
      this.queue.push({ type: 'promptTaken', text: textOfContent(input.content) });
    } finally {
      this.starting = false;
    }
  }

  private effortsOf(model: string): string[] {
    return this.models.find((m) => m.value === model)?.efforts ?? [];
  }

  private onNotification(method: string, params: Json): void {
    if (method === 'serverRequest/resolved') {
      this.asks.get(params.requestId as string | number)?.abort();
      return;
    }
    const events = this.stream.handle(method, params);
    if (method === 'turn/completed') {
      this.turnId = null;
      for (const a of this.asks.values()) a.abort();
      for (const e of events) {
        if (e.type === 'turn') e.queued = this.pending.length;
      }
    }
    for (const e of events) this.queue.push(e);
    if (method === 'turn/completed') void this.startNext().catch((err) => this.queue.fail(err));
  }

  // ---------- requests of the server: approvals ----------

  private async onRequest(req: ServerRequest): Promise<unknown> {
    const p = req.params;
    switch (req.method) {
      case 'item/commandExecution/requestApproval': {
        const available = Array.isArray(p.availableDecisions) ? (p.availableDecisions as unknown[]) : [];
        const canAlways = available.length === 0 || available.includes('acceptForSession');
        const answer = await this.ask(req.id, 'Bash', { command: str(p.command), cwd: str(p.cwd) }, str(p.reason), canAlways);
        return { decision: answer.behavior === 'allow' ? (answer.always && canAlways ? 'acceptForSession' : 'accept') : 'decline' };
      }
      case 'item/fileChange/requestApproval': {
        const item = this.stream.changes.get(str(p.itemId));
        const changes = list(item?.changes).map((c) => ({ path: str(c.path), kind: str(obj(c.kind).type) || 'update', diff: str(c.diff) }));
        const answer = await this.ask(req.id, 'ApplyPatch', { file_path: changes[0]?.path ?? '', changes }, str(p.reason), true);
        return { decision: answer.behavior === 'allow' ? (answer.always ? 'acceptForSession' : 'accept') : 'decline' };
      }
      case 'item/permissions/requestApproval': {
        const asked = obj(p.permissions);
        const answer = await this.ask(req.id, 'Permissions', { permissions: asked, cwd: str(p.cwd) }, str(p.reason), false);
        if (answer.behavior !== 'allow') return { permissions: {}, scope: 'turn' };
        const granted: Json = {};
        if (asked.network) granted.network = asked.network;
        if (asked.fileSystem) granted.fileSystem = asked.fileSystem;
        return { permissions: granted, scope: 'turn' };
      }
      case 'item/tool/requestUserInput':
        // Questions to the user go through the master and the hub's tools: nothing is answered here.
        return { answers: {} };
      case 'mcpServer/elicitation/request': {
        const controller = new AbortController();
        this.asks.set(req.id, controller);
        try {
          const mode = str(p.mode);
          const answer = await this.spec.onElicitation(
            {
              serverName: str(p.serverName),
              message: str(p.message) || str(p.title),
              mode: mode === 'url' ? 'url' : 'form',
              requestedSchema: mode === 'form' ? obj(p.requestedSchema) : undefined,
            },
            controller.signal,
          );
          return answer.action === 'accept' ? { action: 'accept', content: answer.content, _meta: null } : { action: 'decline', content: null, _meta: null };
        } finally {
          this.asks.delete(req.id);
        }
      }
      default:
        throw new RpcError(`${req.method} is not handled by the hub`, -32601);
    }
  }

  private async ask(id: string | number, tool: string, input: Json, reason: string, canAlways: boolean) {
    const controller = new AbortController();
    this.asks.set(id, controller);
    try {
      return await this.spec.onPermission({ tool, input, reason, canAlways, signal: controller.signal });
    } finally {
      this.asks.delete(id);
    }
  }

  // ---------- control ----------

  async interrupt(): Promise<void> {
    if (!this.turnId || !this.threadId) return;
    await this.client.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const a of this.asks.values()) a.abort();
    this.client.close();
    this.queue.close();
  }

  async setModel(model: string): Promise<void> {
    this.model = model;
  }

  async setEffort(effort: Effort): Promise<void> {
    this.effort = effort;
  }

  async setMode(mode: Mode): Promise<void> {
    this.mode = mode;
  }

  async context() {
    return { tokens: this.stream.contextTokens, size: this.stream.contextSize, model: this.model };
  }

  async totals(): Promise<Totals> {
    // Until Codex has reported a usage, a resumed thread's earlier turns are unknown: the first result sets the base.
    if (Object.keys(this.stream.usage.models).length === 0) throw new Error('unknown');
    return this.stream.usage;
  }

  async rateLimits(): Promise<RateLimits | null> {
    const res = obj(await this.client.request('account/rateLimits/read', {}));
    return rateLimitsOf(obj(res.rateLimits));
  }
}

/** A short-lived app-server for a question that is not a session's (is a thread stored, what does it say). */
async function withServer<T>(ctx: AdapterContext, fn: (client: CodexClient) => Promise<T>): Promise<T> {
  const client = new CodexClient({ executable: ctx.executable || 'codex', env: ctx.env, version: HUB_VERSION });
  try {
    await client.start();
    return await fn(client);
  } finally {
    client.close();
  }
}

export const codexAdapter: ProviderAdapter = {
  harness: 'codex',

  start: (spec) => new CodexProcess(spec),

  async hasConversation(id, _cwd, ctx) {
    try {
      await withServer(ctx, (c) => c.request('thread/read', { threadId: id }));
      return true;
    } catch (err) {
      // Refused for this thread: it is gone. Any other failure (the program, the network) keeps the link.
      return !(err instanceof RpcError);
    }
  },

  async history(id, _cwd, ctx) {
    const res = obj(await withServer(ctx, (c) => c.request('thread/read', { threadId: id, includeTurns: true })));
    return historyOf(list(obj(res.thread).turns));
  },

  defaultMode: async () => null,
  inheritedEffort: async () => undefined,
  isMissingProgram: (failure) => /ENOENT|command not found|no such file/i.test(failure) && /codex/i.test(failure),
};
