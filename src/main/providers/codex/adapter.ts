import type { Totals } from '../../../shared/costs';
import { EFFORTS, type Effort, type Mode, type RateLimits } from '../../../shared/types';
import type { Block } from '../blocks';
import { policyOf as requestedPolicy, PROVIDER_CAPABILITIES, refusedPolicy, type EffectivePolicy } from '../capabilities';
import { OperationLifecycle, type Operation, type OperationTerminal } from '../lifecycle';
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

export class CodexProcess implements AgentProcess {
  readonly capabilities = PROVIDER_CAPABILITIES.codex;
  private policyState: EffectivePolicy;
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
  private readonly lifecycle = new OperationLifecycle();
  private readonly started = new WeakSet<Operation>();
  private readonly interruptSent = new WeakSet<Operation>();
  private readonly abort = new AbortController();
  private compactTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: AgentInput[] = [];
  private closed = false;
  private readonly asks = new Map<string | number, AbortController>();
  /** The folders a session may write: its own, and the ones its post adds. */
  private readonly roots: string[];

  constructor(private readonly spec: LaunchSpec, client?: CodexClient, private readonly compactTimeoutMs = 120_000) {
    this.policyState = requestedPolicy('codex', spec);
    this.effort = spec.effort;
    this.mode = spec.mode;
    this.model = spec.model;
    this.roots = [spec.cwd, ...spec.extraDirs];
    this.stream = new CodexStream(() => this.model);
    this.client = client ?? new CodexClient({ executable: spec.executable || 'codex', env: { ...spec.env, ...(spec.mcp ? { HUB_MCP_TOKEN: spec.mcp.token } : {}) }, cwd: spec.cwd, version: HUB_VERSION, onSpawn: spec.onSpawn });
    this.readyP = this.run();
    // The failure reaches the manager through the event stream; nobody awaiting ready() must see it unhandled.
    this.readyP.catch(() => undefined);
  }

  ready = () => this.readyP;
  get policy(): EffectivePolicy { return this.policyState; }

  private acknowledgePolicy(response: Json): void {
    const expected = policyOf(this.mode, this.spec.readOnly);
    const sandbox = obj(response.sandbox);
    const wanted = sandboxPolicy(expected.sandbox, this.roots);
    const roots = Array.isArray(sandbox.writableRoots) && sandbox.writableRoots.every(root => typeof root === 'string') ? sandbox.writableRoots as string[] : [];
    // The cwd is implicit in Codex's workspace sandbox; explicit roots may not broaden that workspace.
    const sameRoots = expected.sandbox !== 'workspace-write' ||
      (roots.every(root => this.roots.includes(root)) && this.spec.extraDirs.every(root => roots.includes(root)));
    if (response.approvalPolicy !== expected.approvalPolicy || response.approvalsReviewer !== expected.reviewer ||
        sandbox.type !== wanted.type || (expected.sandbox !== 'danger-full-access' && sandbox.networkAccess === true) || !sameRoots) {
      throw new Error('Codex did not acknowledge the requested approval and sandbox policy.');
    }
    this.policyState = {
      requested: requestedPolicy('codex', { ...this.spec, mode: this.mode }).requested,
      effective: {
        mode: this.mode ?? 'default', write: expected.sandbox === 'danger-full-access' ? 'unrestricted' : 'provider-sandbox',
        network: expected.sandbox === 'danger-full-access' ? 'unrestricted' : 'restricted',
        roots: expected.sandbox === 'workspace-write' ? [...new Set([this.spec.cwd, ...roots])] : null,
        approvals: 'provider-controlled', sandbox: expected.sandbox, approvalPolicy: expected.approvalPolicy, reviewer: expected.reviewer,
      },
      status: 'applied',
      limitations: ['Sandbox controls apply to Codex tools; external MCP servers are not isolated by this adapter.',
        ...(expected.sandbox === 'workspace-write' ? ['Codex may also write temporary directories allowed by its sandbox.'] : [])],
    };
  }

  private async run(): Promise<{ models: AgentModel[]; commands: [] }> {
    const { client } = this;
    client.onNotification = (method, params) => this.onNotification(method, params);
    client.onRequest = (req) => this.onRequest(req);
    client.onExit = (info) => {
      if (this.closed) return;
      const message = `codex exited${info.code !== null ? ` (${info.code})` : ''}: ${tail(info.stderr)}`;
      if (this.lifecycle.active) this.failActive(message, true);
      else this.queue.fail(new Error(message));
      this.close();
    };
    try {
      await client.start();
      if (this.closed) throw new Error('codex process closed');
      const listed = await client.request('model/list', {}).catch(() => ({}));
      this.models = modelsOf(obj(listed));
      const opened = obj(await this.openThread());
      if (this.closed) throw new Error('codex process closed');
      this.acknowledgePolicy(opened);
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
      this.policyState = refusedPolicy(this.policyState, this.policyState.requested, err instanceof Error ? err.message : String(err));
      if (!this.closed) this.queue.fail(err);
      this.close();
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
      'sandbox_workspace_write.network_access': false,
    };
  }

  private openThread(resume = this.spec.conversation.resume): Promise<unknown> {
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
    return resume
      ? this.client.request('thread/resume', { threadId: this.threadId || spec.conversation.id, ...params })
      : this.client.request('thread/start', { ...params, serviceName: 'claude_hub' });
  }

  /** Takes the hub's prompts one by one: into the turn in progress, or as the start of the next one. */
  private async pump(): Promise<void> {
    try {
      for await (const input of this.spec.input) await this.deliver(input);
    } catch (err) {
      if (this.lifecycle.active) this.failActive(err instanceof Error ? err.message : String(err), true);
      else this.queue.fail(err);
    }
    this.close();
  }

  private async deliver(input: AgentInput): Promise<void> {
    if (this.closed) return;
    const op = this.lifecycle.active;
    const text = textOfContent(input.content);
    if (op?.kind === 'turn' && op.turnId && !op.interrupted && !/^\/compact\b/.test(text.trim())) {
      try {
        await this.client.request('turn/steer', { threadId: this.threadId, expectedTurnId: op.turnId, input: userInputOf(input.content) }, { signal: this.abort.signal });
        if (!this.closed) this.queue.push({ type: 'promptTaken', text });
        return;
      } catch (err) {
        // A provider refusal means this input can wait for the next turn. Transport failure is not a refusal.
        if (!(err instanceof RpcError)) throw err;
      }
    }
    this.pending.push(input);
    await this.startNext();
  }

  private async startNext(): Promise<void> {
    if (this.closed || this.lifecycle.active || this.pending.length === 0) return;
    const input = this.pending.shift() as AgentInput;
    const text = textOfContent(input.content);
    const op = this.lifecycle.begin(/^\/compact\b/.test(text.trim()) ? 'compact' : 'turn');
    this.stream.beginTurn();
    // Acceptance precedes the first possible server notification, including a terminal one.
    this.queue.push({ type: 'promptTaken', text });
    if (op.kind === 'compact') {
      this.queue.push({ type: 'compacting', on: true });
      this.compactTimer = setTimeout(() => {
        if (this.lifecycle.owns(op)) this.failActive('codex compaction timed out', true);
      }, this.compactTimeoutMs);
    }
    try {
      const res = obj(await this.client.request(
        op.kind === 'compact' ? 'thread/compact/start' : 'turn/start',
        op.kind === 'compact' ? { threadId: this.threadId } : turnStartParams({
          threadId: this.threadId, input: input.content, cwd: this.spec.cwd, model: this.model,
          effort: this.effort, efforts: this.effortsOf(this.model), mode: this.mode,
          readOnly: this.spec.readOnly, roots: this.roots,
        }),
        { signal: this.abort.signal },
      ));
      // A turn can complete before turn/start replies. Never resurrect it from that late response.
      if (!this.lifecycle.owns(op)) return;
      const id = str(obj(res.turn).id);
      if (id) this.lifecycle.bind(op, id);
      if (op.interrupted && op.turnId) await this.interruptOperation(op);
    } catch (err) {
      if (this.lifecycle.owns(op)) this.failActive(err instanceof Error ? err.message : String(err), !(err instanceof RpcError));
    }
  }

  private terminal(op: Operation, terminal: OperationTerminal, event?: AgentEvent, advance = true): void {
    if (!this.lifecycle.finish(op, terminal)) return;
    if (this.compactTimer) clearTimeout(this.compactTimer);
    this.compactTimer = null;
    if (op.kind === 'compact') this.queue.push({ type: 'compacting', on: false });
    for (const a of this.asks.values()) a.abort();
    this.queue.push(event ?? {
      type: 'turn', subtype: terminal === 'failed' ? 'error_during_execution' : terminal, isError: terminal === 'failed',
      result: '', queued: this.pending.length, contextWindows: this.stream.contextSize ? [this.stream.contextSize] : [], usage: this.stream.usage,
    });
    // Keep the old operation's terminal ahead of the next prompt's acceptance.
    if (advance) void this.startNext().catch((err) => this.queue.fail(err));
  }

  private failActive(message: string, stop = false): void {
    const op = this.lifecycle.active;
    if (!op) return;
    this.queue.push({ type: 'assistant', id: `codex-error-${op.generation}-${op.opId}`, blocks: [{ type: 'text', text: message }], error: 'server_error', contextTokens: 0 });
    this.terminal(op, 'failed', undefined, !stop);
    if (stop) this.close();
  }

  private effortsOf(model: string): string[] {
    return this.models.find((m) => m.value === model)?.efforts ?? [];
  }

  private onNotification(method: string, params: Json): void {
    if (this.closed) return;
    const threadId = str(params.threadId);
    if (threadId && this.threadId && threadId !== this.threadId) return;
    const op = this.lifecycle.active;
    const turnId = str(params.turnId) || str(obj(params.turn).id);
    // Ignore replayed/stale turns before touching the stream's answer or usage state.
    if (turnId && !this.lifecycle.matches(turnId)) return;
    if ((method.startsWith('turn/') || method.startsWith('item/') || method === 'thread/compacted') && !op) return;
    if (method === 'turn/completed' && !turnId) return;
    if (method === 'turn/started' && op) {
      if (this.started.has(op)) return;
      this.started.add(op);
      if (op.interrupted) void this.interruptOperation(op);
    }
    this.spec.onSignal();
    if (method === 'serverRequest/resolved') {
      this.asks.get(params.requestId as string | number)?.abort();
      return;
    }
    const events = this.stream.handle(method, params);
    if (method === 'turn/completed' && op) {
      const turn = events.find((e) => e.type === 'turn');
      if (turn?.type !== 'turn') return;
      turn.queued = this.pending.length;
      const status = str(obj(params.turn).status);
      this.terminal(op, status === 'completed' ? 'success' : status === 'interrupted' ? 'interrupted' : 'failed', turn);
      return;
    }
    for (const e of events) this.queue.push(e);
    if (op?.kind === 'compact' && (method === 'thread/compacted' || (method === 'item/completed' && obj(params.item).type === 'contextCompaction'))) {
      this.terminal(op, 'success');
    } else if (op && method === 'error' && params.willRetry !== true) {
      this.terminal(op, 'failed');
    }
  }

  // ---------- requests of the server: approvals ----------

  private async onRequest(req: ServerRequest): Promise<unknown> {
    if (this.closed) throw new RpcError('codex process is closed', -32600);
    const p = req.params;
    const turnId = str(p.turnId);
    if (turnId && !this.lifecycle.matches(turnId)) throw new RpcError('stale turn request', -32600);
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
    const op = this.lifecycle.active;
    if (!op || this.closed) return;
    op.interrupted = true;
    // Compaction has no cancellable turn id on some server versions; ending this process cancels it.
    if (op.kind === 'compact' && !op.turnId) { this.close(); return; }
    // turn/started or the start response will carry the id if start is still in flight.
    if (op.turnId) await this.interruptOperation(op);
  }

  private async interruptOperation(op: Operation): Promise<void> {
    if (!this.lifecycle.owns(op) || !op.turnId || this.interruptSent.has(op)) return;
    this.interruptSent.add(op);
    try {
      await this.client.request('turn/interrupt', { threadId: this.threadId, turnId: op.turnId }, { signal: this.abort.signal });
      // The acknowledgement is not the terminal: turn/completed decides success versus interruption.
    } catch (err) {
      if (this.lifecycle.owns(op)) this.failActive(err instanceof Error ? err.message : String(err), true);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const op = this.lifecycle.active;
    if (op) this.terminal(op, 'interrupted');
    this.lifecycle.invalidate();
    if (this.compactTimer) clearTimeout(this.compactTimer);
    this.compactTimer = null;
    this.pending = [];
    for (const a of this.asks.values()) a.abort();
    this.abort.abort();
    this.client.close();
    this.queue.close();
  }

  async setModel(model: string): Promise<void> {
    this.model = model;
  }

  async setEffort(effort: Effort): Promise<void> {
    this.effort = effort;
  }

  /** Ultracode is Claude Code's. */
  async setUltracode(): Promise<void> {
    throw new Error('Ultracode is a Claude Code mode');
  }

  async setMode(mode: Mode): Promise<void> {
    await this.readyP;
    const previous = this.policyState;
    const oldMode = this.mode;
    const requested = requestedPolicy('codex', { ...this.spec, mode });
    this.policyState = { ...requested, effective: previous.effective };
    try {
      if (this.lifecycle.active) throw new Error('Codex permission mode can only change between turns.');
      this.mode = mode;
      this.acknowledgePolicy(obj(await this.openThread(true)));
    } catch (err) {
      this.mode = oldMode;
      this.policyState = refusedPolicy(previous, requested.requested, err instanceof Error ? err.message : String(err));
      throw err;
    }
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

/** Generic invalid-request/auth/transport failures must preserve the stored conversation link. */
export function isMissingThread(error: unknown): boolean {
  return error instanceof RpcError && /\b(?:thread|conversation)(?:\s+(?:with\s+)?id)?(?:\s+["']?[\w-]+["']?)?\s+(?:not found|does not exist|was not found)\b|\bno rollout found for thread\b|\bthread_not_found\b/i.test(error.message);
}

export const codexAdapter: ProviderAdapter = {
  harness: 'codex',

  start: (spec) => new CodexProcess(spec),

  async hasConversation(id, _cwd, ctx) {
    try {
      await withServer(ctx, (c) => c.request('thread/read', { threadId: id }));
      return true;
    } catch (err) {
      // Only explicit absence means it is gone. Permission, protocol and transport errors keep the link.
      return !isMissingThread(err);
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
