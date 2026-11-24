import {
  createSdkMcpServer,
  getSessionInfo,
  getSessionMessages,
  query,
  resolveSettings,
  tool,
  type Options,
  type PermissionResult,
  type Query,
  type Settings,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { WORKER_DENIED_MCP } from '../../../shared/capabilities';
import { totalsOf } from '../../../shared/costs';
import type { Effort, Mode, RateLimits } from '../../../shared/types';
import { limitsOfUsage } from '../../../shared/usage';
import { blocksOf } from '../blocks';
import { policyOf, PROVIDER_CAPABILITIES, refusedPolicy, type EffectivePolicy, type PolicySpec } from '../capabilities';
import type { AgentEvent, AgentModel, AgentProcess, HistoryMessage, KeepAliveResult, LaunchSpec, ProviderAdapter } from '../types';
import { toCommands, translate } from './events';

/** The largest autoCompactWindow the CLI accepts: a worker compacts only at the model's own limit. */
const FULL_WINDOW = 1_000_000;
/**
 * Characters of skill descriptions a worker's skill list may take. Claude Code's own budget is 1% of the window: with
 * 1M, the list weighs about 8k tokens on every request of every worker. Each skill keeps its name and the start of its
 * description; a value the user set in their own environment wins.
 */
const WORKER_SKILL_LIST_CHARS = '8000';

/**
 * The model as Claude Code is asked for it: a Fable id goes with its 1M variant. A Claude Code older than the model (the
 * SDK's own binary did not know Fable 5.2) otherwise gives it a 200k window and compacts it near 170k; Fable's window
 * is 1M wherever the model is available. Any other model, and a variant already chosen, go as they are.
 */
/**
 * Whether a permission request comes from a permissions.ask rule alone, from the fields the CLI sends (not all in the
 * SDK's types). `rule`: the rule decided. A compound command (a loop, a `$(…)`) the CLI cannot check part by part keeps
 * its own reason (`other`: "A variable in this command can't be checked") and names the rule in `matchedAskRule`; in
 * bypass mode that reason alone never asks. A shell command checked part by part (`subcommandResults`) names no rule;
 * its wrapper has no text of its own, so a reason or a code there is the safety check of one of its parts (sdk.d.ts,
 * SDKControlPermissionRequest.decision_reason), and without either only a rule on one of its parts still asks in
 * bypass mode. A safety check, a hook or a question to the user is never the rule alone.
 */
export function askedByRule(o: { tool?: string; decisionReasonType?: string; decisionReason?: string; decisionReasonCode?: string; matchedAskRule?: unknown; requiresUserInteraction?: boolean }): boolean {
  if (o.requiresUserInteraction) return false;
  if (o.decisionReasonType === 'rule') return true;
  if (o.decisionReasonType === 'subcommandResults') return /^(Bash|PowerShell)$/.test(o.tool ?? '') && !o.decisionReason && !o.decisionReasonCode;
  return o.matchedAskRule != null && (o.decisionReasonType === undefined || o.decisionReasonType === 'other');
}

/**
 * A PreToolUse hook answered that a person must decide. When a permissions.ask rule matches the same call, the request
 * that follows carries the rule's reason and nothing of the hook: only the hook's own output, on the stream, says it.
 */
export const hookAsks = (msg: { hook_event: string; stdout: string; output: string }): boolean =>
  msg.hook_event === 'PreToolUse' && /"permissionDecision"\s*:\s*"ask"/.test(msg.stdout || msg.output);

export const fullWindow = (model: string) => (/^claude-fable-\d/i.test(model) && !model.includes('[') ? `${model}[1m]` : model);


/**
 * The tools a session may not use: the master has no direct edit tools; a worker has no Workflow, except in Ultracode.
 * This is a tool filter, not a read-only sandbox: Bash and MCP can still have side effects.
 */
export function disallowedTools(spec: Pick<LaunchSpec, 'role' | 'readOnly' | 'ultracode' | 'observer'>): string[] {
  if (spec.role === 'master') return ['Edit', 'Write', 'NotebookEdit', 'AskUserQuestion', 'SendMessage'];
  const workflow = spec.ultracode ? [] : ['Workflow'];
  // A diagnosis worker has no SendMessage either: it never writes to the worker it looks into.
  const peers = spec.observer ? ['SendMessage'] : [];
  return spec.readOnly ? ['Edit', 'Write', 'NotebookEdit', 'AskUserQuestion', ...workflow, 'ScheduleWakeup', ...peers] : ['AskUserQuestion', ...workflow, 'ScheduleWakeup', ...peers];
}

/** The flag-level settings of a launch, over the user's own: a worker's window and connectors, the session's Ultracode. */
export function launchSettings(spec: Pick<LaunchSpec, 'role' | 'ultracode'>): Settings {
  return {
    ...(spec.role === 'master' ? {} : { autoCompactWindow: FULL_WINDOW, deniedMcpServers: WORKER_DENIED_MCP.map((serverName) => ({ serverName })) }),
    ...(spec.ultracode ? { ultracode: true } : {}),
  };
}

/**
 * What a launch tells Claude Code about the session itself: its folder, model, prompt, tools and settings. A
 * keep-alive sends the same, or it would read another cache than the conversation's.
 */
function sessionOptions(spec: LaunchSpec): Options {
  const master = spec.role === 'master';
  return {
    cwd: spec.cwd,
    ...(spec.extraDirs.length > 0 ? { additionalDirectories: spec.extraDirs } : {}),
    // No model/effort = the CLI resolves them from settings.json, exactly like a normal session.
    ...(spec.model ? { model: fullWindow(spec.model) } : {}),
    ...(spec.effort ? { effort: spec.effort } : {}),
    ...(spec.executable ? { pathToClaudeCodeExecutable: spec.executable } : {}),
    systemPrompt: { type: 'preset', preset: 'claude_code', append: spec.instructions, ...(spec.stableInstructions ? { snapshot: false } : {}) },
    // A worker gets no Workflow (its subagents would each inherit its whole context) and no self-paced wakeups,
    // unless it was asked to run in Ultracode: that mode is the Workflow tool, used for every task of weight.
    disallowedTools: disallowedTools(spec),
    // Flag-level settings, over the user's own: a worker keeps the model's whole window (the user's own
    // autoCompactWindow would cut it) and loads none of the unneeded connectors.
    ...(master && !spec.ultracode ? {} : { settings: launchSettings(spec) }),
    env: master ? spec.env : { SLASH_COMMAND_TOOL_CHAR_BUDGET: WORKER_SKILL_LIST_CHARS, ...spec.env },
  };
}

/** The prompt of a keep-alive: read by a forked copy of the conversation that is never saved. */
const KEEP_ALIVE_PROMPT = 'Cache keep-alive sent by the hub, not a message from the user: answer with the single word "ok" and call no tool.';
const KEEP_ALIVE_TIMEOUT_MS = 180_000;
const NO_TOOL = 'keep-alive: no tool runs';

/**
 * The options of a keep-alive: the session's own, on a fork of its conversation that leaves no file. The hub's tools
 * keep their names and descriptions (what the model was shown) but answer nothing, and no tool may run at all: the
 * one reply is thrown away.
 */
export function keepAliveOptions(spec: LaunchSpec, abortController: AbortController): Options {
  return {
    ...sessionOptions(spec),
    abortController,
    resume: spec.conversation.id,
    forkSession: true,
    persistSession: false,
    maxTurns: 1,
    mcpServers: {
      hub: createSdkMcpServer({
        name: 'hub',
        version: '0.6.0',
        tools: spec.tools.map((def) => tool(def.name, def.description, def.shape, async () => ({ content: [{ type: 'text' as const, text: NO_TOOL }], isError: true }), def.alwaysLoad ? { alwaysLoad: true } : undefined)),
      }),
    },
    canUseTool: async () => ({ behavior: 'deny', message: NO_TOOL }),
    // Before any permission rule, bypass mode included.
    hooks: { PreToolUse: [{ hooks: [async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: NO_TOOL } })] }] },
  };
}

/** Claude Code, driven through the Agent SDK: streaming input, in-process MCP server for the hub's tools. */
export class ClaudeProcess implements AgentProcess {
  readonly events: AsyncIterable<AgentEvent>;
  readonly capabilities = PROVIDER_CAPABILITIES.claude;
  private policyState: EffectivePolicy;
  private conversationId: string;
  /**
   * A hook asked for a person during this turn. The request it belongs to is not named, so until the turn ends no
   * request is answered for the user.
   */
  hookAsked = false;

  constructor(
    private readonly q: Query,
    conversationId: string,
    private readonly onSignal: () => void,
    private readonly policySpec: PolicySpec = { mode: null, readOnly: false, cwd: '', extraDirs: [], readDirs: [] },
  ) {
    this.conversationId = conversationId;
    this.policyState = policyOf('claude', policySpec);
    this.events = this.stream();
  }

  get policy(): EffectivePolicy { return this.policyState; }

  /** The id prompts are sent under: the one the process reported, else the one it was started with. */
  id(): string {
    return this.conversationId;
  }

  private async *stream(): AsyncGenerator<AgentEvent> {
    for await (const msg of this.q) {
      // The CLI's heartbeat ticks every 30 s whatever the tool is doing: it says nothing about the work.
      if (msg.type !== 'tool_progress' || !msg.heartbeat) this.onSignal();
      if (msg.type === 'system' && msg.subtype === 'hook_response' && hookAsks(msg)) this.hookAsked = true;
      else if (msg.type === 'result') this.hookAsked = false;
      if (msg.type === 'system' && msg.subtype === 'init') {
        this.conversationId = msg.session_id;
        this.policyState = policyOf('claude', this.policySpec, msg.permissionMode);
      }
      yield* translate(msg);
    }
  }

  async ready() {
    const init = await this.q.initializationResult();
    // system/init is emitted at the start of a turn. Use a control acknowledgment before releasing the first prompt.
    if (this.policyState.status === 'pending') await this.setMode(this.policySpec.mode ?? 'default');
    const models: AgentModel[] = init.models.map((m) => ({
      value: m.value,
      displayName: m.displayName,
      description: m.description,
      resolvedModel: m.resolvedModel,
      efforts: m.supportsEffort ? ((m.supportedEffortLevels ?? []) as Effort[]) : [],
    }));
    return { models, commands: toCommands(init.commands) };
  }

  interrupt = async (): Promise<void> => void (await this.q.interrupt());
  close = () => this.q.close();
  setModel = (model: string) => this.q.setModel(fullWindow(model));
  // An effortLevel sent alone to a session in Ultracode turns it off: both keys go together.
  setEffort = (effort: Effort, ultracode = false) => this.q.applyFlagSettings({ effortLevel: effort, ...(ultracode ? { ultracode: true } : {}) });
  setUltracode = (on: boolean) => this.q.applyFlagSettings({ ultracode: on });
  async setMode(mode: Mode): Promise<void> {
    const previous = this.policyState;
    const requested = policyOf('claude', { ...this.policySpec, mode });
    this.policyState = { ...requested, effective: previous.effective };
    try {
      await this.q.setPermissionMode(mode);
      this.policySpec.mode = mode;
      this.policyState = policyOf('claude', this.policySpec, mode);
    } catch (err) {
      this.policyState = refusedPolicy(previous, requested.requested, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async context() {
    const usage = await this.q.getContextUsage({ detail: 'summary' });
    return { tokens: usage.totalTokens, size: usage.maxTokens, model: usage.model };
  }

  async totals() {
    await this.q.initializationResult();
    const u = await this.q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    return totalsOf(u.session.total_cost_usd, u.session.model_usage);
  }

  async reconnectMcp(name: string): Promise<boolean | null> {
    const server = (await this.q.mcpServerStatus()).find((s) => s.name === name);
    if (!server || server.status === 'disabled') return null;
    if (server.status === 'connected') return true;
    try {
      await this.q.reconnectMcpServer(name);
    } catch {
      return false;
    }
    return (await this.q.mcpServerStatus()).some((s) => s.name === name && s.status === 'connected');
  }

  async rateLimits(): Promise<RateLimits | null> {
    const usage = await this.q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    if (!usage.rate_limits_available) return null; // API key, Bedrock, Vertex: no plan limits.
    const limits = limitsOfUsage(usage.rate_limits);
    // Plan limits apply but the answer holds no figure (not signed in to claude.ai, shape changed): a failure, not a zero.
    if (!limits) throw new Error('usage: no plan-limit figure in the answer');
    return limits;
  }
}

export const claudeAdapter: ProviderAdapter = {
  harness: 'claude',

  start(spec: LaunchSpec): AgentProcess {
    let proc = null as ClaudeProcess | null;
    // The prompts the hub queues, as the SDK takes them: under the conversation's id as the process reports it.
    const prompts = (async function* (): AsyncGenerator<SDKUserMessage> {
      for await (const m of spec.input) {
        yield { type: 'user', message: { role: 'user', content: m.content as never }, parent_tool_use_id: null, session_id: proc?.id() ?? spec.conversation.id };
      }
    })();
    const options: Options = {
      ...sessionOptions(spec),
      ...(spec.mode ? { permissionMode: spec.mode } : {}),
      // Lets the composer switch a session to bypass as well: an explicit choice, which the mode menu warns about.
      allowDangerouslySkipPermissions: true,
      // Workers talk to the master and to each other through native cross-session messaging (SendMessage). The master
      // writes to workers through the hub (message_worker), which delivers its words as a user turn: a peer message
      // carries no user authority, so a "go" sent that way would not unblock a commit or a push.
      // replay-user-messages surfaces incoming cross-session messages (origin.kind === 'peer') on the stream.
      extraArgs: { name: spec.name, 'replay-user-messages': null },
      includePartialMessages: true,
      // Hook runs come on the stream: the hub counts the failed ones (hookFailures.ts).
      includeHookEvents: true,
      mcpServers: {
        hub: createSdkMcpServer({
          name: 'hub',
          version: '0.6.0',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tools: spec.tools.map((def) => tool(def.name, def.description, def.shape, def.handler as any, def.alwaysLoad ? { alwaysLoad: true } : undefined)),
        }),
      },
      // The hub's own tools by exact name: a project .mcp.json declaring another server named "hub" gets nothing.
      allowedTools: spec.tools.map((def) => `mcp__hub__${def.name}`),
      canUseTool: async (name, input, o): Promise<PermissionResult> => {
        // The hook's output comes on the stream just before this request: read first, whatever the order they are handled in.
        await new Promise((resolve) => setImmediate(resolve));
        const answer = await spec.onPermission({
          tool: name,
          input,
          reason: o.decisionReason ?? '',
          // "Always allow" persists the CLI's suggested rules; without suggestions it would silently be a one-time allow.
          canAlways: (o.suggestions?.length ?? 0) > 0,
          byRule: !proc?.hookAsked && askedByRule({ tool: name, ...(o as { decisionReasonType?: string; decisionReasonCode?: string; matchedAskRule?: unknown; requiresUserInteraction?: boolean }) }),
          signal: o.signal,
        });
        if (answer.behavior === 'deny') return { behavior: 'deny', message: answer.message };
        return { behavior: 'allow', updatedInput: input, ...(answer.always && o.suggestions ? { updatedPermissions: o.suggestions } : {}) };
      },
      onElicitation: (req, o) => spec.onElicitation({ serverName: req.serverName, message: req.message, mode: req.mode, requestedSchema: req.requestedSchema }, o.signal),
      ...(spec.conversation.resume ? { resume: spec.conversation.id } : { sessionId: spec.conversation.id }),
    };
    // Not in the SDK's types, but read by its own spawn (0.3.x): the PID without taking over how it starts the CLI.
    if (spec.onSpawn) Object.assign(options, { onProcessSpawned: spec.onSpawn });
    proc = new ClaudeProcess(query({ prompt: prompts, options }), spec.conversation.id, spec.onSignal, {
      mode: spec.mode, readOnly: spec.readOnly, cwd: spec.cwd, extraDirs: spec.extraDirs, readDirs: spec.readDirs,
    });
    return proc;
  },

  async keepAlive(spec: LaunchSpec, signal: AbortSignal): Promise<KeepAliveResult> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), KEEP_ALIVE_TIMEOUT_MS);
    signal.addEventListener('abort', () => abort.abort(), { once: true });
    try {
      for await (const msg of query({ prompt: KEEP_ALIVE_PROMPT, options: keepAliveOptions(spec, abort) })) {
        if (msg.type !== 'result') continue;
        return { read: msg.usage.cache_read_input_tokens ?? 0, written: msg.usage.cache_creation_input_tokens ?? 0, totals: totalsOf(msg.total_cost_usd, msg.modelUsage) };
      }
      throw new Error('keep-alive: the process ended without a result');
    } finally {
      clearTimeout(timer);
    }
  },

  // An unreadable check keeps the id rather than dropping the link to the conversation.
  hasConversation: (id, cwd) => getSessionInfo(id, { dir: cwd }).then(Boolean).catch(() => true),

  async history(id, cwd): Promise<HistoryMessage[]> {
    const out: HistoryMessage[] = [];
    for (const m of await getSessionMessages(id, { dir: cwd })) {
      if (m.parent_tool_use_id || (m.type !== 'user' && m.type !== 'assistant')) continue;
      // Claude Code stores an API error as a "<synthetic>" reply with its own wording: not shown again on reload.
      const synthetic = (m.message as { model?: unknown } | null)?.model === '<synthetic>';
      out.push({ role: m.type, id: m.uuid, blocks: blocksOf(m.message).filter((b) => !synthetic || b.type !== 'text') });
    }
    return out;
  },

  async defaultMode(cwd): Promise<Mode | null> {
    try {
      const { effective } = await resolveSettings({ cwd });
      return (effective.permissions?.defaultMode as Mode | undefined) ?? null;
    } catch {
      return null;
    }
  },

  /**
   * The CLI does not report an effort it took from settings (system/init leaves it empty), so resolve it with the
   * CLI's own settings cascade: per-model `modelSettings` first, then the global `effortLevel`.
   */
  async inheritedEffort(cwd, models): Promise<Effort | null | undefined> {
    try {
      const { effective } = await resolveSettings({ cwd });
      for (const m of models) {
        const e = effective.modelSettings?.[m]?.effortLevel;
        if (e) return e as Effort;
      }
      return (effective.effortLevel as Effort | undefined) ?? null;
    } catch {
      return undefined; // Display only: the session keeps running with the CLI's own resolution.
    }
  },

  // The executable the SDK expects is missing: the fix is in the settings, not in the conversation.
  isMissingProgram: (failure) => /Native CLI binary|pathToClaudeCodeExecutable|spawn \S*claude\S* ENOENT/i.test(failure),
};
