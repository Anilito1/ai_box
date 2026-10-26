import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { totalsOf } from '../../../shared/costs';
import type { Effort } from '../../../shared/types';
import { blocksOf } from '../blocks';
import type { AgentCommand, AgentEvent } from '../types';

// Claude Code's stream (the Agent SDK's messages) as the hub's own events. Pure: the adapter feeds it, tests replay it.

const textOf = (blocks: Record<string, unknown>[]) =>
  blocks
    .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n');

export const toCommands = (list: { name: string; description: string; argumentHint: string; aliases?: string[] }[]): AgentCommand[] =>
  list.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint, aliases: c.aliases ?? [] }));

const ACTIVITY: AgentEvent[] = [{ type: 'activity' }];

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
        default:
          return ACTIVITY;
      }
    case 'rate_limit_event':
      // Refused by a plan limit: the CLI waits or gives up; either way the session is stuck until the next frame.
      return msg.rate_limit_info.status === 'rejected'
        ? [{ type: 'limit', signal: { kind: 'rate', resetsAt: msg.rate_limit_info.resetsAt ?? null, source: `rate_limit_event:${msg.rate_limit_info.rateLimitType ?? ''}` } }]
        : ACTIVITY;
    case 'stream_event': {
      if (msg.parent_tool_use_id) return ACTIVITY;
      const e = msg.event;
      const textStart = e.type === 'content_block_start' && e.content_block.type === 'text';
      const delta = e.type === 'content_block_delta' && e.delta.type === 'text_delta' ? e.delta.text : '';
      return [{ type: 'stream', textStart, delta }];
    }
    case 'assistant': {
      if (msg.parent_tool_use_id) return ACTIVITY;
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
