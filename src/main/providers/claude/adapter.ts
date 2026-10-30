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
import type { AgentEvent, AgentModel, AgentProcess, HistoryMessage, LaunchSpec, ProviderAdapter } from '../types';
import { toCommands, translate } from './events';

/** The largest autoCompactWindow the CLI accepts: a worker compacts only at the model's own limit. */
const FULL_WINDOW = 1_000_000;


/** The tools a session may not use: the master edits nothing; a worker has no Workflow, except in Ultracode. */
export function disallowedTools(spec: Pick<LaunchSpec, 'role' | 'readOnly' | 'ultracode'>): string[] {
  if (spec.role === 'master') return ['Edit', 'Write', 'NotebookEdit', 'AskUserQuestion', 'SendMessage'];
  const workflow = spec.ultracode ? [] : ['Workflow'];
  return spec.readOnly ? ['Edit', 'Write', 'NotebookEdit', 'AskUserQuestion', ...workflow, 'ScheduleWakeup'] : ['AskUserQuestion', ...workflow, 'ScheduleWakeup'];
}

/** The flag-level settings of a launch, over the user's own: a worker's window and connectors, the session's Ultracode. */
export function launchSettings(spec: Pick<LaunchSpec, 'role' | 'ultracode'>): Settings {
  return {
    ...(spec.role === 'master' ? {} : { autoCompactWindow: FULL_WINDOW, deniedMcpServers: WORKER_DENIED_MCP.map((serverName) => ({ serverName })) }),
    ...(spec.ultracode ? { ultracode: true } : {}),
  };
}

/** Claude Code, driven through the Agent SDK: streaming input, in-process MCP server for the hub's tools. */
export class ClaudeProcess implements AgentProcess {
  readonly events: AsyncIterable<AgentEvent>;
  private conversationId: string;

  constructor(
    private readonly q: Query,
    conversationId: string,
    private readonly onSignal: () => void,
  ) {
    this.conversationId = conversationId;
    this.events = this.stream();
  }

  /** The id prompts are sent under: the one the process reported, else the one it was started with. */
  id(): string {
    return this.conversationId;
  }

  private async *stream(): AsyncGenerator<AgentEvent> {
    for await (const msg of this.q) {
      // The CLI's heartbeat ticks every 30 s whatever the tool is doing: it says nothing about the work.
      if (msg.type !== 'tool_progress' || !msg.heartbeat) this.onSignal();
      if (msg.type === 'system' && msg.subtype === 'init') this.conversationId = msg.session_id;
      yield* translate(msg);
    }
  }

  async ready() {
    const init = await this.q.initializationResult();
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
  setModel = (model: string) => this.q.setModel(model);
  // An effortLevel sent alone to a session in Ultracode turns it off: both keys go together.
  setEffort = (effort: Effort, ultracode = false) => this.q.applyFlagSettings({ effortLevel: effort, ...(ultracode ? { ultracode: true } : {}) });
  setUltracode = (on: boolean) => this.q.applyFlagSettings({ ultracode: on });
  setMode = (mode: Mode) => this.q.setPermissionMode(mode);

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
    const master = spec.role === 'master';
    const options: Options = {
      cwd: spec.cwd,
      ...(spec.extraDirs.length > 0 ? { additionalDirectories: spec.extraDirs } : {}),
      // No model/effort = the CLI resolves them from settings.json, exactly like a normal session.
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.effort ? { effort: spec.effort } : {}),
      ...(spec.mode ? { permissionMode: spec.mode } : {}),
      // Lets the composer switch a session to bypass as well: an explicit choice, which the mode menu warns about.
      allowDangerouslySkipPermissions: true,
      ...(spec.executable ? { pathToClaudeCodeExecutable: spec.executable } : {}),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: spec.instructions, ...(spec.stableInstructions ? { snapshot: false } : {}) },
      // Workers talk to the master and to each other through native cross-session messaging (SendMessage). The master
      // writes to workers through the hub (message_worker), which delivers its words as a user turn: a peer message
      // carries no user authority, so a "go" sent that way would not unblock a commit or a push.
      // replay-user-messages surfaces incoming cross-session messages (origin.kind === 'peer') on the stream.
      extraArgs: { name: spec.name, 'replay-user-messages': null },
      includePartialMessages: true,
      // A worker gets no Workflow (its subagents would each inherit its whole context) and no self-paced wakeups,
      // unless it was asked to run in Ultracode: that mode is the Workflow tool, used for every task of weight.
      disallowedTools: disallowedTools(spec),
      // Flag-level settings, over the user's own: a worker keeps the model's whole window (the user's own
      // autoCompactWindow would cut it) and loads none of the unneeded connectors.
      ...(master && !spec.ultracode ? {} : { settings: launchSettings(spec) }),
      mcpServers: {
        hub: createSdkMcpServer({
          name: 'hub',
          version: '0.6.0',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tools: spec.tools.map((def) => tool(def.name, def.description, def.shape, def.handler as any)),
        }),
      },
      // The hub's own tools by exact name: a project .mcp.json declaring another server named "hub" gets nothing.
      allowedTools: spec.tools.map((def) => `mcp__hub__${def.name}`),
      canUseTool: async (name, input, o): Promise<PermissionResult> => {
        const answer = await spec.onPermission({
          tool: name,
          input,
          reason: o.decisionReason ?? '',
          // "Always allow" persists the CLI's suggested rules; without suggestions it would silently be a one-time allow.
          canAlways: (o.suggestions?.length ?? 0) > 0,
          signal: o.signal,
        });
        if (answer.behavior === 'deny') return { behavior: 'deny', message: answer.message };
        return { behavior: 'allow', updatedInput: input, ...(answer.always && o.suggestions ? { updatedPermissions: o.suggestions } : {}) };
      },
      onElicitation: (req, o) => spec.onElicitation({ serverName: req.serverName, message: req.message, mode: req.mode, requestedSchema: req.requestedSchema }, o.signal),
      env: spec.env,
      ...(spec.conversation.resume ? { resume: spec.conversation.id } : { sessionId: spec.conversation.id }),
    };
    proc = new ClaudeProcess(query({ prompt: prompts, options }), spec.conversation.id, spec.onSignal);
    return proc;
  },

  // An unreadable check keeps the id rather than dropping the link to the conversation.
  hasConversation: (id, cwd) => getSessionInfo(id, { dir: cwd }).then(Boolean, () => true),

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
