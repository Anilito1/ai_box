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
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { WORKER_DENIED_MCP } from '../../../shared/capabilities';
import { totalsOf } from '../../../shared/costs';
import type { Effort, Mode, RateLimits } from '../../../shared/types';
import { blocksOf } from '../blocks';
import type { AgentEvent, AgentModel, AgentProcess, HistoryMessage, LaunchSpec, ProviderAdapter } from '../types';
import { toCommands, translate } from './events';

/** The largest autoCompactWindow the CLI accepts: a worker compacts only at the model's own limit. */
const FULL_WINDOW = 1_000_000;


/** Claude Code, driven through the Agent SDK: streaming input, in-process MCP server for the hub's tools. */
class ClaudeProcess implements AgentProcess {
  readonly events: AsyncIterable<AgentEvent>;
  private conversationId: string;

  constructor(
    private readonly q: Query,
    conversationId: string,
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
  setEffort = (effort: Effort) => this.q.applyFlagSettings({ effortLevel: effort });
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

  async rateLimits(): Promise<RateLimits | null> {
    const limits = (await this.q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })).rate_limits;
    if (!limits) return null;
    const epoch = (iso: string | null | undefined) => (iso ? Date.parse(iso) / 1000 : null);
    return {
      fiveHourPct: limits.five_hour?.utilization ?? null,
      fiveHourResetsAt: epoch(limits.five_hour?.resets_at),
      sevenDayPct: limits.seven_day?.utilization ?? null,
      sevenDayResetsAt: epoch(limits.seven_day?.resets_at),
    };
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
      // A worker gets no Workflow (its subagents would each inherit its whole context) and no self-paced wakeups.
      disallowedTools: master
        ? ['Edit', 'Write', 'NotebookEdit', 'AskUserQuestion', 'SendMessage']
        : spec.readOnly
          ? ['Edit', 'Write', 'NotebookEdit', 'AskUserQuestion', 'Workflow', 'ScheduleWakeup']
          : ['AskUserQuestion', 'Workflow', 'ScheduleWakeup'],
      // Flag-level settings, over the user's own: a worker keeps the model's whole window (the user's own
      // autoCompactWindow would cut it) and loads none of the unneeded connectors.
      ...(master ? {} : { settings: { autoCompactWindow: FULL_WINDOW, deniedMcpServers: WORKER_DENIED_MCP.map((serverName) => ({ serverName })) } }),
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
    proc = new ClaudeProcess(query({ prompt: prompts, options }), spec.conversation.id);
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
