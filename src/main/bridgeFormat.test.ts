import assert from 'node:assert/strict';
import { test } from 'node:test';

const { adjustRequest, anthropicError, applyAdjustments, errorMessage, fromChatResponse, parseArgs, pickModel, reasoningOf, StreamTranslator, toChatRequest, ToolNames } =
  await import('./bridgeFormat');

const target = { model: 'gpt-5', smallModel: 'gpt-5-mini', maxTokensField: 'max_completion_tokens' as const };

/** The events of an SSE string, parsed. */
const events = (lines: string[]) =>
  lines.map((l) => {
    const [event, data] = l.trim().split('\n');
    return { event: event.slice('event: '.length), data: JSON.parse(data.slice('data: '.length)) as Record<string, unknown> };
  });

test('pickModel: the account decides, Claude Code small calls go to the small model', () => {
  assert.equal(pickModel('claude-opus-5-5', target), 'gpt-5');
  assert.equal(pickModel('gpt-5-mini', target), 'gpt-5-mini');
  assert.equal(pickModel('claude-haiku-4-5-20251001', target), 'gpt-5-mini');
  assert.equal(pickModel('claude-haiku-4-5', { model: 'gpt-5', smallModel: '' }), 'gpt-5');
  assert.equal(pickModel(undefined, target), 'gpt-5');
  assert.equal(pickModel('gpt-4.1', target), 'gpt-4.1', 'a model of the server picked for the session goes as asked');
  assert.equal(pickModel('default', target), 'gpt-5');
  assert.equal(pickModel('claude-sonnet-5', target), 'gpt-5');
});

test('reasoningOf: effort and thinking budget', () => {
  assert.equal(reasoningOf({ output_config: { effort: 'xhigh' } }), 'high');
  assert.equal(reasoningOf({ output_config: { effort: 'low' } }), 'low');
  assert.equal(reasoningOf({ thinking: { type: 'enabled', budget_tokens: 31999 } }), 'high');
  assert.equal(reasoningOf({ thinking: { type: 'enabled', budget_tokens: 5000 } }), 'medium');
  assert.equal(reasoningOf({ thinking: { type: 'enabled', budget_tokens: 1024 } }), 'low');
  assert.equal(reasoningOf({ thinking: { type: 'adaptive' } }), 'medium');
  assert.equal(reasoningOf({ thinking: { type: 'disabled' } }), null);
  assert.equal(reasoningOf({}), null);
});

test('toChatRequest: system, turns, tool calls and results, images', () => {
  const names = new ToolNames();
  const req = toChatRequest(
    {
      model: 'claude-opus-5-5',
      max_tokens: 32000,
      stream: true,
      temperature: 1,
      system: [{ type: 'text', text: 'You are Claude Code.', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'Be brief.' }],
      tools: [
        { name: 'Read', description: 'Reads a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } },
        { type: 'web_search_20250305', name: 'web_search' },
        { name: 'mcp__claude.ai_Gmail__search threads', description: 'odd name', input_schema: { type: 'object' } },
      ],
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      thinking: { type: 'enabled', budget_tokens: 20000 },
      messages: [
        { role: 'user', content: 'Read a.txt' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hmm', signature: 'sig' },
            { type: 'text', text: 'Reading.' },
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.txt' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'hello' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
            { type: 'text', text: 'And now?' },
          ],
        },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'only thinking', signature: 's' }] },
      ],
    },
    target,
    names,
  );
  assert.equal(req.model, 'gpt-5');
  assert.equal(req.max_completion_tokens, 32000);
  assert.equal(req.max_tokens, undefined);
  assert.deepEqual(req.stream_options, { include_usage: true });
  assert.equal(req.reasoning_effort, 'high');
  assert.equal(req.parallel_tool_calls, false);
  assert.equal(req.tool_choice, 'auto');
  const tools = req.tools as { function: { name: string } }[];
  assert.equal(tools.length, 2, 'the server tool is left out');
  assert.equal(tools[0].function.name, 'Read');
  assert.match(tools[1].function.name, /^mcp__claude_ai_Gmail__search_threads_[0-9a-f]{8}$/);
  assert.equal(names.original(tools[1].function.name), 'mcp__claude.ai_Gmail__search threads');
  assert.deepEqual(req.messages, [
    { role: 'system', content: 'You are Claude Code.\n\nBe brief.' },
    { role: 'user', content: 'Read a.txt' },
    { role: 'assistant', content: 'Reading.', tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"a.txt"}' } }] },
    { role: 'tool', tool_call_id: 'toolu_1', content: 'hello' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Image returned by tool call toolu_1:' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        { type: 'text', text: 'And now?' },
      ],
    },
  ]);
});

test('toChatRequest: errors, empty results, other servers', () => {
  const req = toChatRequest(
    {
      max_tokens: 100,
      tool_choice: { type: 'tool', name: 'Bash' },
      tools: [{ name: 'Bash', input_schema: { type: 'object' } }],
      stop_sequences: ['a', 'b', 'c', 'd', 'e'],
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x.1', is_error: true, content: 'boom' }, { type: 'tool_result', tool_use_id: 'y' }] }],
    },
    { model: 'qwen', smallModel: '', maxTokensField: 'max_tokens' },
    new ToolNames(),
  );
  assert.equal(req.max_tokens, 100);
  assert.equal(req.stream, false);
  assert.equal(req.stream_options, undefined);
  assert.equal(req.reasoning_effort, undefined);
  assert.deepEqual(req.stop, ['a', 'b', 'c', 'd']);
  assert.deepEqual(req.tool_choice, { type: 'function', function: { name: 'Bash' } });
  assert.deepEqual(req.messages, [
    { role: 'tool', tool_call_id: 'x_1', content: '[error] boom' },
    { role: 'tool', tool_call_id: 'y', content: '(no output)' },
  ]);
});

test('fromChatResponse: text, tool calls, stop reason, usage', () => {
  const names = new ToolNames();
  const alias = names.safe('mcp__a.b__c');
  const r = fromChatResponse(
    {
      model: 'gpt-5-2026',
      choices: [{ finish_reason: 'tool_calls', message: { content: 'Sure.', tool_calls: [{ id: 'call_9', function: { name: alias, arguments: '{"x":1}' } }] } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 } },
    },
    'gpt-5',
    names,
  );
  assert.equal(r.model, 'gpt-5-2026');
  assert.equal(r.stop_reason, 'tool_use');
  assert.deepEqual(r.content, [
    { type: 'text', text: 'Sure.' },
    { type: 'tool_use', id: 'call_9', name: 'mcp__a.b__c', input: { x: 1 } },
  ]);
  assert.deepEqual(r.usage, { input_tokens: 40, output_tokens: 20, cache_read_input_tokens: 60, cache_creation_input_tokens: 0 });
  const empty = fromChatResponse({ choices: [{ finish_reason: 'length', message: {} }] }, 'gpt-5', names);
  assert.equal(empty.stop_reason, 'max_tokens');
  assert.equal(empty.model, 'gpt-5');
  assert.deepEqual(empty.content, [{ type: 'text', text: '' }]);
});

test('parseArgs', () => {
  assert.deepEqual(parseArgs('{"a":1}'), { a: 1 });
  assert.deepEqual(parseArgs(''), {});
  assert.deepEqual(parseArgs('[1]'), { value: [1] });
  assert.deepEqual(parseArgs('{"a":'), { _unparsed_arguments: '{"a":' });
});

test('StreamTranslator: text streams, tool calls come whole at the end', () => {
  const names = new ToolNames();
  const s = new StreamTranslator('gpt-5', names, 'msg_test');
  const out = [
    ...s.push({ model: 'gpt-5-2026', choices: [{ delta: { role: 'assistant', content: '' } }] }),
    ...s.push({ choices: [{ delta: { content: 'Hel' } }] }),
    ...s.push({ choices: [{ delta: { content: 'lo' } }] }),
    ...s.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'Read', arguments: '{"file_' } }] } }] }),
    ...s.push({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'Bash', arguments: '{"command":"ls"}' } }] } }] }),
    ...s.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'path":"a"}' } }] } }] }),
    ...s.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ...s.push({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    ...s.end(),
  ];
  const ev = events(out);
  assert.deepEqual(
    ev.map((e) => e.event),
    [
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ],
  );
  assert.equal((ev[0].data.message as { model: string }).model, 'gpt-5-2026');
  assert.equal((ev[0].data.message as { id: string }).id, 'msg_test');
  assert.deepEqual(ev[2].data.delta, { type: 'text_delta', text: 'Hel' });
  assert.deepEqual(ev[5].data.content_block, { type: 'tool_use', id: 'call_a', name: 'Read', input: {} });
  assert.equal(ev[5].data.index, 1);
  assert.deepEqual(ev[6].data.delta, { type: 'input_json_delta', partial_json: '{"file_path":"a"}' });
  assert.deepEqual(ev[8].data.content_block, { type: 'tool_use', id: 'call_b', name: 'Bash', input: {} });
  assert.deepEqual(ev[11].data.delta, { stop_reason: 'tool_use', stop_sequence: null });
  assert.deepEqual(ev[11].data.usage, { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
});

test('StreamTranslator: an empty reply still has one block, a started stream does not start twice', () => {
  const s = new StreamTranslator('m', new ToolNames());
  const ev = events([...s.start(), ...s.start(), ...s.end()]);
  assert.deepEqual(
    ev.map((e) => e.event),
    ['message_start', 'content_block_start', 'content_block_stop', 'message_delta', 'message_stop'],
  );
  assert.deepEqual(ev[3].data.delta, { stop_reason: 'end_turn', stop_sequence: null });
});

test('StreamTranslator: a name sent whole in every fragment is not doubled', () => {
  const s = new StreamTranslator('m', new ToolNames());
  s.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'Read', arguments: '{' } }] } }] });
  s.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'Read', arguments: '}' } }] } }] });
  const block = events(s.end()).find((e) => e.event === 'content_block_start')?.data.content_block as { name: string };
  assert.equal(block.name, 'Read');
});

test('errors: Anthropic types and OpenAI messages', () => {
  assert.deepEqual(anthropicError(429, 'slow down'), { status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } } });
  assert.equal(anthropicError(401, '').body.error && (anthropicError(401, '').body.error as { type: string }).type, 'authentication_error');
  assert.equal(anthropicError(503, '').status, 503);
  assert.equal(anthropicError(0, '').status, 500);
  assert.deepEqual(errorMessage('{"error":{"message":"bad key","code":"invalid_api_key"}}'), { message: 'bad key', code: 'invalid_api_key' });
  assert.deepEqual(errorMessage('<html>oops</html>'), { message: '<html>oops</html>', code: '' });
});

test('adjustRequest: what a server refuses is changed or left out', () => {
  const req: Record<string, unknown> = { model: 'o', max_tokens: 10, temperature: 0.5, reasoning_effort: 'high' };
  assert.equal(adjustRequest(req, 400, "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."), 'rename:max_tokens');
  assert.equal(req.max_completion_tokens, 10);
  assert.equal(adjustRequest(req, 400, "Unsupported value: 'temperature' does not support 0.5 with this model."), 'drop:temperature');
  assert.equal(adjustRequest(req, 400, 'Unrecognized request argument supplied: reasoning_effort'), 'drop:reasoning_effort');
  assert.equal(adjustRequest(req, 400, 'max_tokens is too large: 32000. This model supports at most 16384 completion tokens'), 'drop:max_completion_tokens');
  assert.deepEqual(req, { model: 'o' });
  assert.equal(adjustRequest(req, 400, 'Invalid model'), null);
  assert.equal(adjustRequest({ temperature: 1 }, 401, 'temperature'), null);
  const next: Record<string, unknown> = { max_tokens: 5, temperature: 1, top_p: 1 };
  applyAdjustments(next, ['rename:max_tokens', 'drop:temperature']);
  assert.deepEqual(next, { max_completion_tokens: 5, top_p: 1 });
});
