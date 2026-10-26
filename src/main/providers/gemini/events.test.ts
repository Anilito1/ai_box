import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acpMode, authMethodOf, pickOption, promptOf } from './adapter';
import { errorCodeOf, GeminiStream, historyOf, limitOfError, toolUse, waitSeconds } from './events';
import { modelsOfSession } from './cli';

// Updates of the Gemini CLI's Agent Client Protocol (the shapes its bundle writes), through the translation.
const stream = () => new GeminiStream(() => 'gemini-2.5-pro');
const text = (t: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } });

test('message chunks stream, then arrive as one item that is the turn’s answer', () => {
  const s = stream();
  assert.deepEqual(s.handle(text('Bon')), [
    { type: 'stream', textStart: true, delta: '' },
    { type: 'stream', textStart: false, delta: 'Bon' },
  ]);
  assert.deepEqual(s.handle(text('jour')), [{ type: 'stream', textStart: false, delta: 'jour' }]);
  const events = s.turn({ stopReason: 'end_turn' });
  assert.deepEqual(events[0], { type: 'assistant', id: 'g-1', blocks: [{ type: 'text', text: 'Bonjour' }], error: '', contextTokens: 0 });
  const turn = events.at(-1);
  assert.equal(turn?.type === 'turn' && turn.subtype, 'success');
  assert.equal(turn?.type === 'turn' && turn.result, 'Bonjour');
});

test('thoughts come before the text as their own item; a tool call flushes what was written so the order holds', () => {
  const s = stream();
  s.handle({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '**Plan**\nregarder' } });
  const first = s.handle(text('Je regarde.'));
  assert.deepEqual(first[0], { type: 'assistant', id: 'g-1', blocks: [{ type: 'thinking', thinking: '**Plan**\nregarder' }], error: '', contextTokens: 0 });
  const call = s.handle({ sessionUpdate: 'tool_call', toolCallId: 't1', status: 'in_progress', title: 'ls -la [current working directory /p]', kind: 'execute' });
  assert.equal(call[0].type === 'assistant' && call[0].blocks[0].type, 'text');
  assert.deepEqual(call[1], { type: 'assistant', id: 'a-t1', blocks: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } }], error: '', contextTokens: 0 });
  assert.deepEqual(s.handle({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'a b' } }] }), [
    { type: 'toolResults', blocks: [{ type: 'tool_result', tool_use_id: 't1', content: 'a b', is_error: false }] },
  ]);
  // A call that is not over yet is only activity.
  assert.deepEqual(s.handle({ sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'in_progress' }), [{ type: 'activity' }]);
});

test('a call told when it is already over (a replayed conversation) brings its result with it, and only once', () => {
  const s = stream();
  const events = s.handle({ sessionUpdate: 'tool_call', toolCallId: 't9', status: 'failed', title: 'cat x', kind: 'read', locations: [{ path: '/p/x' }], content: [] });
  assert.deepEqual(events.map((e) => e.type), ['assistant', 'toolResults']);
  assert.deepEqual(events[0].type === 'assistant' && events[0].blocks[0], { type: 'tool_use', id: 't9', name: 'Read', input: { file_path: '/p/x' } });
  assert.equal(events[1].type === 'toolResults' && events[1].blocks[0].is_error, true);
  assert.deepEqual(s.handle({ sessionUpdate: 'tool_call', toolCallId: 't9', status: 'failed', kind: 'read' }).map((e) => e.type), ['toolResults']);
});

test('tools: the hub’s own are named as Claude Code names them; the others go by their kind', () => {
  assert.equal(toolUse({ toolCallId: 'a', title: 'message_master (hub MCP Server)', kind: 'other' }).name, 'mcp__hub__message_master');
  assert.equal(toolUse({ toolCallId: 'a', title: 'spawn_worker (my-server MCP Server)' }).name, 'mcp__my-server__spawn_worker');
  assert.equal(toolUse({ toolCallId: 'a', title: 'grep foo', kind: 'search' }).name, 'Grep');
  const edit = toolUse({ toolCallId: 'a', title: 'Edit a.ts', kind: 'edit', content: [{ type: 'diff', path: '/p/a.ts', oldText: 'x', newText: 'y' }] });
  assert.deepEqual(edit.input, { file_path: '/p/a.ts', changes: [{ path: '/p/a.ts', kind: 'update', diff: '- x\n+ y' }] });
  assert.equal(toolUse({ toolCallId: 'a', title: 'Something', kind: 'think' }).name, 'Something');
});

test('usage: the context is the last update, the tokens are summed per model across turns', () => {
  const s = stream();
  s.handle({ sessionUpdate: 'usage_update', used: 1200, size: 1_000_000 });
  assert.equal(s.contextTokens, 1200);
  s.turn({ stopReason: 'end_turn', _meta: { quota: { model_usage: [{ model: 'gemini-2.5-pro', token_count: { input_tokens: 100, output_tokens: 20 } }, { model: 'gemini-3.8-flash', token_count: { input_tokens: 5, output_tokens: 1 } }] } } });
  const events = s.turn({ stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2 } });
  const turn = events.at(-1);
  assert.deepEqual(turn?.type === 'turn' && turn.usage.models['gemini-2.5-pro'], { cost: 0, input: 110, output: 22, cacheRead: 0, cacheWrite: 0 });
  assert.equal(turn?.type === 'turn' && turn.usage.models['gemini-3.8-flash'].input, 5);
  assert.deepEqual(turn?.type === 'turn' && turn.contextWindows, [1_000_000]);
});

test('how a turn ends: cancelled is an interruption, a refusal an error, running out of tokens still a turn', () => {
  const end = (reason: string) => stream().turn({ stopReason: reason }).at(-1);
  assert.equal(end('cancelled')?.type === 'turn' && (end('cancelled') as { subtype: string }).subtype, 'interrupted');
  const refusal = end('refusal');
  assert.equal(refusal?.type === 'turn' && refusal.isError, true);
  const max = end('max_tokens');
  assert.equal(max?.type === 'turn' && max.subtype, 'success');
});

test('limits: a 429 or a quota message is a limit with the wait Google gives; a sign-in problem is not a limit of the plan', () => {
  const now = 1_800_000_000_000;
  assert.deepEqual(limitOfError(429, 'Rate limit exceeded. Try again later.', now), { kind: 'rate', resetsAt: null, source: 'gemini:429' });
  assert.deepEqual(limitOfError(429, 'You have exhausted your daily quota. Your quota will reset after 2h30m0s.', now), { kind: 'quota', resetsAt: 1_800_000_000 + 9000, source: 'gemini:429' });
  assert.equal(limitOfError(500, 'RESOURCE_EXHAUSTED: quota', now)?.kind, 'quota');
  assert.equal(limitOfError(401, 'API key not valid', now)?.kind, 'auth');
  assert.equal(limitOfError(500, 'Unknown stream execution error.', now), null);
  assert.equal(waitSeconds('please retry in 34s'), 34);
  assert.equal(waitSeconds('reset after 1h5m'), 3900);
  assert.equal(waitSeconds('nothing to wait'), null);
  assert.equal(errorCodeOf(429, 'x'), 'rate_limit');
  assert.equal(errorCodeOf(403, 'x'), 'authentication_failed');
  assert.equal(errorCodeOf(400, 'bad'), 'invalid_request');
  assert.equal(errorCodeOf(500, 'boom'), 'server_error');
});

test('a replayed conversation: user and agent chunks join into messages, tools come with their results', () => {
  const h = historyOf([
    { sessionUpdate: 'user_message_chunk', content: { text: 'Fais' } },
    { sessionUpdate: 'user_message_chunk', content: { text: ' ça' } },
    { sessionUpdate: 'agent_thought_chunk', content: { text: 'secret' } },
    { sessionUpdate: 'agent_message_chunk', content: { text: 'Je' } },
    { sessionUpdate: 'agent_message_chunk', content: { text: ' fais.' } },
    { sessionUpdate: 'tool_call', toolCallId: 't1', status: 'completed', title: 'ls', kind: 'execute', content: [{ type: 'content', content: { text: 'ok' } }] },
    { sessionUpdate: 'agent_message_chunk', content: { text: 'Fait' } },
  ]);
  assert.deepEqual(h.map((m) => `${m.role}:${m.blocks[0].type}`), ['user:text', 'assistant:text', 'assistant:tool_use', 'user:tool_result', 'assistant:text']);
  assert.deepEqual(h[0].blocks, [{ type: 'text', text: 'Fais ça' }]);
  assert.deepEqual(h[1].blocks, [{ type: 'text', text: 'Je fais.' }]);
});

test('modes, the sign-in method, the prompt and the permission answer', () => {
  assert.deepEqual(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'].map((m) => acpMode(m as never, false)), ['default', 'autoEdit', 'plan', 'autoEdit', 'yolo', 'yolo']);
  assert.equal(acpMode('bypassPermissions', true), 'plan', 'a read-only session never writes');
  assert.equal(acpMode(null, false), 'default');
  assert.equal(authMethodOf({ GEMINI_API_KEY: 'k' }), 'gemini-api-key');
  assert.equal(authMethodOf({}), 'oauth-personal');
  assert.deepEqual(promptOf([{ type: 'text', text: 'vois' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }]), [{ type: 'text', text: 'vois' }, { type: 'image', data: 'AAA', mimeType: 'image/png' }]);
  const options = [{ optionId: 'proceed_once', kind: 'allow_once' }, { optionId: 'proceed_always', kind: 'allow_always' }, { optionId: 'cancel', kind: 'reject_once' }];
  assert.equal(pickOption(options, true, false), 'proceed_once');
  assert.equal(pickOption(options, true, true), 'proceed_always');
  assert.equal(pickOption(options, false, false), 'cancel');
  assert.equal(pickOption([{ optionId: 'proceed_once', kind: 'allow_once' }], true, true), 'proceed_once');
  assert.equal(pickOption([], false, false), null);
});

test('the models of a session: its list, with no effort setting', () => {
  const list = modelsOfSession({ models: { availableModels: [{ modelId: 'auto', name: 'Auto', description: 'Let it decide' }, { modelId: 'gemini-2.5-pro', name: 'gemini-2.5-pro' }, { name: 'no id' }], currentModelId: 'auto' } });
  assert.deepEqual(list.map((m) => m.value), ['auto', 'gemini-2.5-pro']);
  assert.equal(list[0].noEffort, true);
  assert.deepEqual(modelsOfSession({}), []);
});
