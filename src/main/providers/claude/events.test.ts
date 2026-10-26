import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { translate } from './events';

// Claude Code's messages as the SDK sends them (trimmed to what the hub reads), through the translation.
const msg = (m: Record<string, unknown>) => m as unknown as SDKMessage;

test('system/init becomes the conversation the process runs', () => {
  const [ev] = translate(msg({ type: 'system', subtype: 'init', session_id: 'abc', permissionMode: 'plan', effort: 'high', model: 'claude-opus-5' }));
  assert.deepEqual(ev, { type: 'conversation', id: 'abc', mode: 'plan', effort: 'high', model: 'claude-opus-5' });
  const [bare] = translate(msg({ type: 'system', subtype: 'init', session_id: 'abc', permissionMode: 'default', model: 'm' }));
  assert.equal(bare.type === 'conversation' && bare.effort, null);
});

test('compaction, retries and status levels', () => {
  assert.deepEqual(translate(msg({ type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 900, post_tokens: 100 } })), [{ type: 'compacted', before: 900, after: 100 }]);
  assert.deepEqual(translate(msg({ type: 'system', subtype: 'status', status: 'compacting' })), [{ type: 'compacting', on: true }]);
  assert.deepEqual(translate(msg({ type: 'system', subtype: 'status', status: null })), [{ type: 'compacting', on: false }]);
  assert.deepEqual(translate(msg({ type: 'system', subtype: 'api_retry' })), [{ type: 'retry' }]);
});

test('ambient background tasks are not activity; only local agents are tracked as agent tasks', () => {
  const tasks = [{ description: 'dev server', ambient: false }, { description: 'watcher', ambient: true }];
  assert.deepEqual(translate(msg({ type: 'system', subtype: 'background_tasks_changed', tasks })), [{ type: 'background', tasks: ['dev server'] }]);
  assert.deepEqual(translate(msg({ type: 'system', subtype: 'task_started', task_type: 'local_agent', task_id: 't1', ambient: false })), [{ type: 'agentTask', id: 't1', state: 'start' }]);
  assert.deepEqual(translate(msg({ type: 'system', subtype: 'task_started', task_type: 'shell', task_id: 't2' })), [{ type: 'activity' }]);
  assert.deepEqual(translate(msg({ type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: 'failed' } })), [{ type: 'agentTask', id: 't1', state: 'failed' }]);
  assert.deepEqual(translate(msg({ type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: 'running' } })), [{ type: 'activity' }]);
  assert.deepEqual(translate(msg({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed' })), [{ type: 'agentTask', id: 't1', state: 'done' }]);
});

test('a refused rate limit is a limit signal with its reset; a warning is only activity', () => {
  const rejected = translate(msg({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1790000000, rateLimitType: 'five_hour' } }));
  assert.deepEqual(rejected, [{ type: 'limit', signal: { kind: 'rate', resetsAt: 1790000000, source: 'rate_limit_event:five_hour' } }]);
  assert.deepEqual(translate(msg({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } })), [{ type: 'activity' }]);
});

test('stream events carry the start of a text block and its deltas; a subagent’s are only activity', () => {
  const start = translate(msg({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', content_block: { type: 'text' } } }));
  assert.deepEqual(start, [{ type: 'stream', textStart: true, delta: '' }]);
  const delta = translate(msg({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Bon' } } }));
  assert.deepEqual(delta, [{ type: 'stream', textStart: false, delta: 'Bon' }]);
  const other = translate(msg({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'input_json_delta' } } }));
  assert.deepEqual(other, [{ type: 'stream', textStart: false, delta: '' }]);
  assert.deepEqual(translate(msg({ type: 'stream_event', parent_tool_use_id: 'toolu_1', event: { type: 'message_start' } })), [{ type: 'activity' }]);
});

test('an assistant frame keeps its blocks, its error, and the context it filled', () => {
  const [ev] = translate(
    msg({
      type: 'assistant',
      uuid: 'u1',
      parent_tool_use_id: null,
      error: 'rate_limit',
      message: { content: [{ type: 'text', text: 'Limit' }], usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 85 } },
    }),
  );
  assert.deepEqual(ev, { type: 'assistant', id: 'u1', blocks: [{ type: 'text', text: 'Limit' }], error: 'rate_limit', contextTokens: 100 });
  assert.deepEqual(translate(msg({ type: 'assistant', uuid: 'u2', parent_tool_use_id: 'toolu_9', message: { content: [] } })), [{ type: 'activity' }]);
});

test('user frames: a replayed prompt, a message from a peer, tool results', () => {
  const replay = translate(msg({ type: 'user', isReplay: true, parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Fais ça' }, { type: 'text', text: 'vite' }] } }));
  assert.deepEqual(replay, [{ type: 'promptTaken', text: 'Fais ça\nvite' }]);
  const peer = translate(msg({ type: 'user', uuid: 'p1', isReplay: true, parent_tool_use_id: null, origin: { kind: 'peer', name: 'hub-api', from: 'x', body: 'Prêt' }, message: { content: 'Prêt' } }));
  assert.deepEqual(peer, [{ type: 'peer', id: 'p1', from: 'hub-api', body: 'Prêt', blocks: [{ type: 'text', text: 'Prêt' }] }]);
  const results = translate(msg({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }, { type: 'text', text: 'x' }] } }));
  assert.deepEqual(results, [{ type: 'toolResults', blocks: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] }]);
});

test('a result becomes a turn: its outcome, the prompts left in the queue, the context windows, the running totals', () => {
  const [ev] = translate(
    msg({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Fait.',
      queued_turn_count: 2,
      total_cost_usd: 0.5,
      modelUsage: { 'claude-opus-5': { costUSD: 0.5, inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow: 200000 } },
    }),
  );
  assert.equal(ev.type, 'turn');
  if (ev.type !== 'turn') return;
  assert.equal(ev.subtype, 'success');
  assert.equal(ev.isError, false);
  assert.equal(ev.result, 'Fait.');
  assert.equal(ev.queued, 2);
  assert.deepEqual(ev.contextWindows, [200000]);
  assert.equal(ev.usage.cost, 0.5);
  assert.equal(ev.usage.models['claude-opus-5'].output, 20);
  const [cut] = translate(msg({ type: 'result', subtype: 'error_during_execution', is_error: true, total_cost_usd: 0 }));
  assert.equal(cut.type === 'turn' && cut.result, '');
  assert.equal(cut.type === 'turn' && cut.queued, null);
});

test('what the hub does not read is activity, so the idle timer still sees the session alive', () => {
  assert.deepEqual(translate(msg({ type: 'tool_progress' })), [{ type: 'activity' }]);
  assert.deepEqual(translate(msg({ type: 'system', subtype: 'hook_started' })), [{ type: 'activity' }]);
});
