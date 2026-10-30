import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorCodeOf, errorName, errorStatus, historyOf, limitOf, resetOf, CodexStream } from './events';
import { clampEffort, policyOf, sandboxPolicy } from './modes';
import { modelsOf, rateLimitsOf, userInputOf } from './adapter';
import { versionAtLeast } from './cli';

// Codex app-server's notifications and items (trimmed to what the hub reads), through the translation.
const stream = () => new CodexStream(() => 'gpt-5.6-luna');

test('an agent message streams, then arrives whole and becomes the turn’s answer', () => {
  const s = stream();
  assert.deepEqual(s.handle('item/started', { item: { type: 'agentMessage', id: 'm1' } }), [{ type: 'stream', textStart: true, delta: '' }]);
  assert.deepEqual(s.handle('item/agentMessage/delta', { delta: 'Bon' }), [{ type: 'stream', textStart: false, delta: 'Bon' }]);
  const done = s.handle('item/completed', { item: { type: 'agentMessage', id: 'm1', text: 'Bonjour' } });
  assert.deepEqual(done, [{ type: 'assistant', id: 'a-m1', blocks: [{ type: 'text', text: 'Bonjour' }], error: '', contextTokens: 0 }]);
  const [turn] = s.handle('turn/completed', { turn: { status: 'completed' } });
  assert.equal(turn.type === 'turn' && turn.result, 'Bonjour');
  assert.equal(turn.type === 'turn' && turn.subtype, 'success');
});

test('a command is a Bash call with its result; a failing exit code is an error', () => {
  const s = stream();
  const started = s.handle('item/started', { item: { type: 'commandExecution', id: 'c1', command: "/bin/zsh -lc 'npm test'" } });
  assert.deepEqual(started, [{ type: 'assistant', id: 'a-c1', blocks: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: "/bin/zsh -lc 'npm test'" } }], error: '', contextTokens: 0 }]);
  // A repeated start does not draw the call twice.
  assert.deepEqual(s.handle('item/started', { item: { type: 'commandExecution', id: 'c1', command: 'x' } }), [{ type: 'activity' }]);
  const done = s.handle('item/completed', { item: { type: 'commandExecution', id: 'c1', command: 'x', status: 'failed', exitCode: 1, aggregatedOutput: 'boom' } });
  assert.deepEqual(done, [{ type: 'toolResults', blocks: [{ type: 'tool_result', tool_use_id: 'c1', content: 'boom', is_error: true }] }]);
});

test('a tool that finished without being seen starting gets its call first', () => {
  const s = stream();
  const done = s.handle('item/completed', { item: { type: 'mcpToolCall', id: 't1', server: 'hub', tool: 'list_workers', arguments: {}, status: 'completed', result: { content: [{ type: 'text', text: 'none' }] } } });
  assert.equal(done.length, 2);
  assert.deepEqual(done[0].type === 'assistant' && done[0].blocks[0].name, 'mcp__hub__list_workers');
  assert.deepEqual(done[1], { type: 'toolResults', blocks: [{ type: 'tool_result', tool_use_id: 't1', content: 'none', is_error: false }] });
});

test('a file change becomes an ApplyPatch call carrying its diff', () => {
  const s = stream();
  const [ev] = s.handle('item/started', { item: { type: 'fileChange', id: 'f1', changes: [{ path: '/p/a.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@' }] } });
  assert.deepEqual(ev.type === 'assistant' && ev.blocks[0], { type: 'tool_use', id: 'f1', name: 'ApplyPatch', input: { file_path: '/p/a.ts', changes: [{ path: '/p/a.ts', kind: 'update', diff: '@@ -1 +1 @@' }] } });
  assert.equal(s.changes.has('f1'), true);
});

test('reasoning summaries are thinking blocks; empty ones are only activity', () => {
  const s = stream();
  assert.deepEqual(s.handle('item/completed', { item: { type: 'reasoning', id: 'r1', summary: ['Je regarde', 'le test'] } }), [
    { type: 'assistant', id: 'a-r1', blocks: [{ type: 'thinking', thinking: 'Je regarde\nle test' }], error: '', contextTokens: 0 },
  ]);
  assert.deepEqual(s.handle('item/completed', { item: { type: 'reasoning', id: 'r2', summary: [] } }), [{ type: 'activity' }]);
});

test('token usage: cached tokens are counted apart from the input, the context is the last request', () => {
  const s = stream();
  const usage = s.handle('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 1000, cachedInputTokens: 600, outputTokens: 50, cacheWriteInputTokens: 0 }, last: { inputTokens: 400 }, modelContextWindow: 258400 } });
  // Said at once: a long turn moves the meter before it ends.
  assert.deepEqual(usage, [{ type: 'context', tokens: 400, size: 258400 }, { type: 'outputTokens', of: 'turn', tokens: 0 }]);
  assert.deepEqual(s.usage.models['gpt-5.6-luna'], { cost: 0, input: 400, output: 50, cacheRead: 600, cacheWrite: 0 });
  assert.equal(s.contextTokens, 400);
  assert.equal(s.contextSize, 258400);
  const [turn] = s.handle('turn/completed', { turn: { status: 'interrupted' } });
  assert.equal(turn.type === 'turn' && turn.subtype, 'interrupted');
  assert.deepEqual(turn.type === 'turn' && turn.contextWindows, [258400]);
});

test('an error that will be retried is a retry; a usage limit is a limit signal with its reset, then an error frame', () => {
  const s = stream();
  assert.deepEqual(s.handle('error', { error: { message: 'x', codexErrorInfo: 'serverOverloaded' }, willRetry: true }), [{ type: 'retry' }]);
  s.handle('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1790000000 }, secondary: { usedPercent: 40, resetsAt: 1790500000 } } });
  const events = s.handle('error', { error: { message: 'limit', codexErrorInfo: 'usageLimitExceeded' }, willRetry: false, turnId: 't1' });
  assert.deepEqual(events[0], { type: 'limit', signal: { kind: 'quota', resetsAt: 1790000000, source: 'codex:usageLimitExceeded' } });
  assert.deepEqual(events[1], { type: 'assistant', id: 'error-t1', blocks: [], error: 'rate_limit', contextTokens: 0 });
});

test('error names: a bare name, or an object keyed by it', () => {
  assert.equal(errorName('unauthorized'), 'unauthorized');
  assert.equal(errorName({ httpConnectionFailed: { httpStatusCode: 502 } }), 'httpConnectionFailed');
  assert.equal(errorName(null), '');
  assert.equal(errorCodeOf('contextWindowExceeded'), 'context_exceeded');
  assert.equal(errorCodeOf('httpConnectionFailed'), 'server_error');
  assert.equal(errorCodeOf('who knows'), 'unknown');
});

test('limits: both windows full wait for the later reset; a spending cap gives its own; a sign-in problem has none', () => {
  const both = { primary: { usedPercent: 100, resetsAt: 100 }, secondary: { usedPercent: 100, resetsAt: 900 } };
  assert.equal(resetOf(both), 900);
  assert.equal(resetOf({ primary: { usedPercent: 20, resetsAt: 100 }, individualLimit: { resetsAt: 5000 } }), 5000);
  assert.equal(resetOf(null), null);
  assert.deepEqual(limitOf('rateLimitExceeded', both), { kind: 'rate', resetsAt: 900, source: 'codex:rateLimitExceeded' });
  assert.deepEqual(limitOf('unauthorized', null), { kind: 'auth', resetsAt: null, source: 'codex:unauthorized' });
  assert.equal(limitOf('badRequest', null), null);
});

test('a stored thread comes back as the messages of a conversation, tools with their results', () => {
  const turns = [
    {
      items: [
        { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'Fais ça' }] },
        { type: 'reasoning', id: 'r1', summary: ['Réfléchit'] },
        { type: 'commandExecution', id: 'c1', command: 'ls', status: 'completed', exitCode: 0, aggregatedOutput: 'a b' },
        { type: 'agentMessage', id: 'm1', text: 'Fait' },
      ],
    },
  ];
  const h = historyOf(turns);
  assert.deepEqual(h.map((m) => `${m.role}:${m.id}`), ['user:u1', 'assistant:r1', 'assistant:c1', 'user:c1-result', 'assistant:m1']);
  assert.deepEqual(h[3].blocks, [{ type: 'tool_result', tool_use_id: 'c1', content: 'a b', is_error: false }]);
});

test('permission modes map to approval policy and sandbox; a read-only session never writes', () => {
  assert.deepEqual(policyOf(null, false), { approvalPolicy: 'untrusted', sandbox: 'workspace-write', reviewer: 'user' });
  assert.deepEqual(policyOf('plan', false), { approvalPolicy: 'untrusted', sandbox: 'read-only', reviewer: 'user' });
  assert.equal(policyOf('auto', false).reviewer, 'auto_review');
  assert.deepEqual(policyOf('bypassPermissions', false), { approvalPolicy: 'never', sandbox: 'danger-full-access', reviewer: 'user' });
  assert.equal(policyOf('bypassPermissions', true).sandbox, 'read-only');
  assert.deepEqual(sandboxPolicy('read-only', []), { type: 'readOnly', networkAccess: false });
  assert.deepEqual(sandboxPolicy('workspace-write', ['/a', '/b']).writableRoots, ['/a', '/b']);
  assert.deepEqual(sandboxPolicy('danger-full-access', []), { type: 'dangerFullAccess' });
});

test('an effort the model does not take falls to the highest below it, else the lowest above', () => {
  assert.equal(clampEffort('xhigh', ['low', 'medium', 'high']), 'high');
  assert.equal(clampEffort('low', ['medium', 'high']), 'medium');
  assert.equal(clampEffort('high', ['low', 'high']), 'high');
  assert.equal(clampEffort('high', []), null);
});

test('the models Codex lists keep the efforts the hub knows and drop hidden ones', () => {
  const list = modelsOf({ data: [{ model: 'gpt-6-sol', displayName: 'GPT-6 Sol', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }, { reasoningEffort: 'max' }] }, { model: 'old', hidden: true }] });
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].efforts, ['low', 'max']);
});

test('the plan limits are told by the length of their window', () => {
  assert.deepEqual(rateLimitsOf({ primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 10 }, secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: 20 } }), {
    fiveHourPct: 30,
    fiveHourResetsAt: 10,
    sevenDayPct: 60,
    sevenDayResetsAt: 20,
  });
  assert.equal(rateLimitsOf({ primary: null, secondary: null, individualLimit: { limit: '4000' } }), null);
});

test('user input: text and images as Codex takes them', () => {
  assert.deepEqual(userInputOf('salut'), [{ type: 'text', text: 'salut', text_elements: [] }]);
  const out = userInputOf([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }, { type: 'text', text: 'vois' }]);
  assert.deepEqual(out, [{ type: 'image', url: 'data:image/png;base64,AAA' }, { type: 'text', text: 'vois', text_elements: [] }]);
});

test('versionAtLeast compares numbers, not strings', () => {
  assert.equal(versionAtLeast('0.163.0', '0.163.0'), true);
  assert.equal(versionAtLeast('0.170.2', '0.163.0'), true);
  assert.equal(versionAtLeast('0.9.0', '0.163.0'), false);
  assert.equal(versionAtLeast('1.0.0-beta', '0.163.0'), true);
});

test('a stream cut with 401 (no sign-in) is an authentication problem, not a server one; a 429 a rate limit', () => {
  const info = { responseStreamDisconnected: { httpStatusCode: 401 } };
  assert.equal(errorStatus(info), 401);
  assert.equal(errorStatus('unauthorized'), 0);
  assert.equal(errorCodeOf(errorName(info), errorStatus(info)), 'authentication_failed');
  assert.equal(errorCodeOf('responseStreamDisconnected', 429), 'rate_limit');
  assert.deepEqual(limitOf('responseStreamDisconnected', null, 401), { kind: 'auth', resetsAt: null, source: 'codex:401' });
  const s = new CodexStream(() => 'm');
  const events = s.handle('error', { error: { message: 'x', codexErrorInfo: info }, willRetry: false, turnId: 't' });
  assert.equal(events[0].type === 'limit' && events[0].signal.kind, 'auth');
  assert.equal(events[1].type === 'assistant' && events[1].error, 'authentication_failed');
});

test("the turn's tokens: its share of the thread's totals, read twice the same when Codex repeats itself", () => {
  const s = new CodexStream(() => 'gpt');
  const usage = (total: number, last: number) => s.handle('thread/tokenUsage/updated', { tokenUsage: { total: { outputTokens: total }, last: { outputTokens: last } } })[1];
  s.handle('turn/started', {});
  assert.deepEqual(usage(5000, 300), { type: 'outputTokens', of: 'turn', tokens: 300 });
  assert.deepEqual(usage(5000, 300), { type: 'outputTokens', of: 'turn', tokens: 300 });
  assert.deepEqual(usage(5200, 200), { type: 'outputTokens', of: 'turn', tokens: 500 });
  s.handle('turn/started', {});
  assert.deepEqual(usage(5300, 100), { type: 'outputTokens', of: 'turn', tokens: 100 });
});

test("a new turn starts from the thread's last total, even when its first reading repeats the one before", () => {
  const s = new CodexStream(() => 'gpt');
  const usage = (total: number, last: number) => s.handle('thread/tokenUsage/updated', { tokenUsage: { total: { outputTokens: total }, last: { outputTokens: last } } })[1];
  s.handle('turn/started', {});
  usage(5000, 300);
  s.handle('turn/started', {});
  assert.deepEqual(usage(5000, 300), { type: 'outputTokens', of: 'turn', tokens: 0 });
  assert.deepEqual(usage(5050, 50), { type: 'outputTokens', of: 'turn', tokens: 50 });
});

test('an automatic compaction is said when it starts', () => {
  const s = new CodexStream(() => 'gpt');
  assert.deepEqual(s.handle('item/started', { item: { type: 'contextCompaction', id: 'c1' } }), [{ type: 'compacting', on: true }]);
});

test('reasoning counts for the estimate; what a command prints does not', () => {
  const s = new CodexStream(() => 'gpt');
  assert.deepEqual(s.handle('item/reasoning/summaryTextDelta', { delta: '12345678' }), [{ type: 'output', tokens: 2 }]);
  assert.deepEqual(s.handle('item/reasoning/textDelta', { delta: '1234' }), [{ type: 'output', tokens: 1 }]);
  assert.deepEqual(s.handle('item/commandExecution/outputDelta', { delta: 'npm test' }), [{ type: 'activity' }]);
});
