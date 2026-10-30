import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { totalsOf } from '../../../shared/costs';
import { tokensOf } from '../../../shared/pulse';
import type { Effort } from '../../../shared/types';
import { blocksOf } from '../blocks';
import type { AgentCommand, AgentEvent, LimitSignal } from '../types';

// Claude Code's stream (the Agent SDK's messages) as the hub's own events. Pure: the adapter feeds it, tests replay it.

const textOf = (blocks: Record<string, unknown>[]) =>
  blocks
    .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n');

export const toCommands = (list: { name: string; description: string; argumentHint: string; aliases?: string[] }[]): AgentCommand[] =>
  list.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint, aliases: c.aliases ?? [] }));

const ACTIVITY: AgentEvent[] = [{ type: 'activity' }];
const SUBAGENT: AgentEvent[] = [{ type: 'subagent' }];

export function translate(msg: SDKMessage): AgentEvent[] {
  switch (msg.type) {
    case 'system':
      switch (msg.subtype) {
        case 'init':
          return [{ type: 'conversation', id: msg.session_id, mode: msg.permissionMode, effort: (msg.effort as Effort | undefined) || null, model: msg.model }];
        case 'compact_boundary':
          return [{ type: 'compacted', before: msg.compact_metadata.pre_tokens, after: msg.compact_metadata.post_tokens }];
        case 'commands_changed':
          return [{ type: 'commands', commands: toCommands(msg.commands) }];
        case 'status':
          return [{ type: 'compacting', on: msg.status === 'compacting' }];
        case 'api_retry':
          return [{ type: 'retry' }];
        case 'background_tasks_changed':
          // Level signal with replace semantics; ambient tasks (watchers) are not activity.
          return [{ type: 'background', tasks: msg.tasks.filter((t) => !t.ambient).map((t) => t.description) }];
        case 'task_started':
          return msg.task_type === 'local_agent' && !msg.ambient ? [{ type: 'agentTask', id: msg.task_id, state: 'start' }] : ACTIVITY;
        case 'task_updated': {
          const { status } = msg.patch;
          return status === 'completed' || status === 'failed' || status === 'killed'
            ? [{ type: 'agentTask', id: msg.task_id, state: status === 'failed' ? 'failed' : 'done' }]
            : ACTIVITY;
        }
        case 'task_notification':
          return [{ type: 'agentTask', id: msg.task_id, state: msg.status === 'failed' ? 'failed' : 'done' }];
        case 'thinking_tokens':
          // Hidden thinking (empty deltas, on Opus): this count of the CLI is all there is of it.
          return [{ type: 'output', tokens: msg.estimated_tokens_delta, unattributed: true }];
        default:
          return ACTIVITY;
      }
    case 'rate_limit_event':
      // Refused by a plan limit: the CLI waits or gives up; either way the session is stuck until the next frame.
      return msg.rate_limit_info.status === 'rejected'
        ? [{ type: 'limit', signal: { kind: 'rate', resetsAt: msg.rate_limit_info.resetsAt ?? null, source: `rate_limit_event:${msg.rate_limit_info.rateLimitType ?? ''}` } }]
        : ACTIVITY;
    case 'stream_event': {
      if (msg.parent_tool_use_id) return SUBAGENT;
      const e = msg.event;
      const textStart = e.type === 'content_block_start' && e.content_block.type === 'text';
      const delta = e.type === 'content_block_delta' && e.delta.type === 'text_delta' ? e.delta.text : '';
      const stream: AgentEvent = { type: 'stream', textStart, delta };
      if (e.type === 'message_start') return [stream, { type: 'reply' }];
      // The API's own count of the reply, cumulative: it comes when the reply ends.
      if (e.type === 'message_delta') return [stream, { type: 'outputTokens', of: 'reply', tokens: e.usage.output_tokens }];
      if (e.type === 'content_block_delta' && e.delta.type === 'input_json_delta') return [stream, { type: 'output', tokens: tokensOf(e.delta.partial_json) }];
      // Empty when the model hides its thinking: thinking_tokens says it then.
      if (e.type === 'content_block_delta' && e.delta.type === 'thinking_delta' && e.delta.thinking) return [stream, { type: 'output', tokens: tokensOf(e.delta.thinking) }];
      return [stream];
    }
    case 'assistant': {
      // An error frame is how a limit goes on being said, not a reply.
      if (msg.parent_tool_use_id) return msg.error ? ACTIVITY : SUBAGENT;
      const u = msg.message.usage;
      return [
        {
          type: 'assistant',
          id: msg.uuid,
          blocks: blocksOf(msg.message),
          error: msg.error ?? '',
          contextTokens: (u?.input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0),
        },
      ];
    }
    case 'user': {
      if (msg.parent_tool_use_id) return ACTIVITY;
      const blocks = blocksOf(msg.message);
      if ('isReplay' in msg && msg.isReplay && msg.origin?.kind !== 'peer') return [{ type: 'promptTaken', text: textOf(blocks) }];
      if (msg.origin?.kind === 'peer') {
        // `body` (the sender's raw text) is sent by the CLI but not yet in the SDK typings.
        const origin = msg.origin as typeof msg.origin & { body?: string };
        return [{ type: 'peer', id: msg.uuid ?? null, from: origin.name || origin.from, body: origin.body ?? null, blocks }];
      }
      const results = blocks.filter((b) => b.type === 'tool_result');
      return results.length > 0 ? [{ type: 'toolResults', blocks: results }] : ACTIVITY;
    }
    case 'result':
      return [
        {
          type: 'turn',
          subtype: msg.subtype,
          isError: msg.is_error === true,
          result: msg.subtype === 'success' ? msg.result : '',
          queued: typeof msg.queued_turn_count === 'number' ? msg.queued_turn_count : null,
          contextWindows: Object.values(msg.modelUsage ?? {}).map((m) => m.contextWindow),
          usage: totalsOf(msg.total_cost_usd, msg.modelUsage),
        },
      ];
    default:
      return ACTIVITY;
  }
}

/** What a Claude Code reply error means for the account: its limit, its money, or its sign-in. Anything else is no limit. */
export function claudeLimit(error: string): LimitSignal | null {
  if (error === 'rate_limit') return { kind: 'rate', resetsAt: null, source: `assistant:${error}` };
  if (error === 'billing_error') return { kind: 'quota', resetsAt: null, source: `assistant:${error}` };
  if (error === 'authentication_failed' || error === 'oauth_org_not_allowed' || error === 'account_on_hold') return { kind: 'auth', resetsAt: null, source: `assistant:${error}` };
  return null;
}
