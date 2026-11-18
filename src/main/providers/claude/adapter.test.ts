import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { LaunchSpec } from '../types';
import { askedByRule, hookAsks, ClaudeProcess, disallowedTools, fullWindow, keepAliveOptions, launchSettings } from './adapter';

test('a worker has no Workflow tool, unless it runs in Ultracode', () => {
  assert.ok(disallowedTools({ role: 'worker', readOnly: false, ultracode: false }).includes('Workflow'));
  assert.ok(!disallowedTools({ role: 'worker', readOnly: false, ultracode: true }).includes('Workflow'));
  assert.ok(disallowedTools({ role: 'worker', readOnly: true, ultracode: false }).includes('Workflow'));
  const readOnly = disallowedTools({ role: 'worker', readOnly: true, ultracode: true });
  assert.ok(!readOnly.includes('Workflow') && readOnly.includes('Edit') && readOnly.includes('ScheduleWakeup'));
  // The master never had the tool taken away, and still edits nothing.
  const master = disallowedTools({ role: 'master', readOnly: false, ultracode: true });
  assert.ok(!master.includes('Workflow') && master.includes('Edit'));
});

test('Ultracode goes to Claude Code in the flag settings of the launch, only when on', () => {
  assert.equal(launchSettings({ role: 'master', ultracode: true }).ultracode, true);
  assert.deepEqual(launchSettings({ role: 'master', ultracode: false }), {});
  const worker = launchSettings({ role: 'worker', ultracode: true });
  assert.equal(worker.ultracode, true);
  assert.equal(worker.autoCompactWindow, 1_000_000);
  assert.ok(!('ultracode' in launchSettings({ role: 'worker', ultracode: false })));
});

test('Fable is asked for in its 1M variant: an older Claude Code would give it 200k and compact near 170k', () => {
  assert.equal(fullWindow('claude-fable-5-2'), 'claude-fable-5-2[1m]');
  assert.equal(fullWindow('claude-fable-5-2[1m]'), 'claude-fable-5-2[1m]');
  // Aliases are resolved by Claude Code itself, other models already run their whole window.
  for (const m of ['fable', 'opus', 'claude-opus-5-5', 'claude-sonnet-5-5', 'deepseek-v4-1-flash']) assert.equal(fullWindow(m), m);
});

test('a worker gets neither the unused claude.ai connectors nor MasterTools; the master keeps them', () => {
  const denied = (launchSettings({ role: 'worker', ultracode: false }).deniedMcpServers ?? []).map((d) => d.serverName);
  assert.ok(denied.includes('claude.ai MasterTools') && denied.includes('higgsfield'));
  assert.equal(launchSettings({ role: 'master', ultracode: false }).deniedMcpServers, undefined);
});

function fakeQuery() {
  const applied: unknown[] = [];
  const q = { applyFlagSettings: async (settings: unknown) => void applied.push(settings) } as unknown as Query;
  return { applied, proc: new ClaudeProcess(q, 'conv', () => undefined) };
}

test('every message is a signal of life, except the heartbeat of the CLI', async () => {
  const messages = [
    { type: 'system', subtype: 'status', status: null },
    { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '' } } },
    { type: 'tool_progress', tool_use_id: 'toolu_1-heartbeat', tool_name: 'Bash', parent_tool_use_id: null, elapsed_time_seconds: 30, heartbeat: true },
    { type: 'tool_progress', tool_use_id: 'toolu_1', tool_name: 'Bash', parent_tool_use_id: null, elapsed_time_seconds: 31 },
    { type: 'user', parent_tool_use_id: 'toolu_9', message: { content: [] } },
  ];
  const q = (async function* () {
    yield* messages;
  })() as unknown as Query;
  let signals = 0;
  const proc = new ClaudeProcess(q, 'conv', () => signals++);
  for await (const _ of proc.events);
  assert.equal(signals, 4);
});

test('turning Ultracode on or off is one flag setting', async () => {
  const { applied, proc } = fakeQuery();
  await proc.setUltracode(true);
  await proc.setUltracode(false);
  assert.deepEqual(applied, [{ ultracode: true }, { ultracode: false }]);
});

test('a new effort carries Ultracode along: alone, Claude Code would turn it off', async () => {
  const { applied, proc } = fakeQuery();
  await proc.setEffort('xhigh', true);
  await proc.setEffort('high');
  assert.deepEqual(applied, [{ effortLevel: 'xhigh', ultracode: true }, { effortLevel: 'high' }]);
});

test('Claude reports the acknowledged mode and the limits of its read-only tool filter', async () => {
  const q = (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 'conv', permissionMode: 'default', tools: [], mcp_servers: [], slash_commands: [], model: 'fixture' };
  })() as unknown as Query;
  const process = new ClaudeProcess(q, 'conv', () => {}, { mode: 'default', readOnly: true, cwd: '/tmp', extraDirs: [], readDirs: [] });
  assert.equal(process.policy.status, 'pending');
  for await (const _ of process.events);
  assert.equal(process.policy.effective.mode, 'default');
  assert.equal(process.policy.status, 'partial');
  assert.equal(process.policy.effective.write, 'tool-filtered');
  assert.equal(process.policy.effective.roots, null);
  assert.match(process.policy.limitations.join(' '), /Bash, MCP/);
  const denied = disallowedTools({ role: 'worker', readOnly: true, ultracode: false });
  assert.ok(!denied.includes('Bash'), 'a tool filter must not be advertised as a Bash sandbox');
});

test('Claude keeps the old effective mode until acknowledgment and after a refusal', async () => {
  let accept!: () => void;
  const q = { setPermissionMode: () => new Promise<void>((resolve) => { accept = resolve; }) } as unknown as Query;
  const process = new ClaudeProcess(q, 'conv', () => {});
  const change = process.setMode('plan');
  assert.equal(process.policy.status, 'pending');
  assert.equal(process.policy.requested.mode, 'plan');
  assert.equal(process.policy.effective.mode, null);
  accept();
  await change;
  assert.equal(process.policy.effective.mode, 'plan');
  q.setPermissionMode = async () => { throw new Error('mode refused'); };
  await assert.rejects(process.setMode('bypassPermissions'), /mode refused/);
  assert.equal(process.policy.status, 'refused');
  assert.equal(process.policy.requested.mode, 'bypassPermissions');
  assert.equal(process.policy.effective.mode, 'plan');
});

test('Claude readiness acknowledges the requested mode before the first user turn', async () => {
  const applied: string[] = [];
  const q = {
    initializationResult: async () => ({ models: [], commands: [] }),
    setPermissionMode: async (mode: string) => { applied.push(mode); },
  } as unknown as Query;
  const proc = new ClaudeProcess(q, 'conv', () => {}, { mode: 'plan', readOnly: false, cwd: '/tmp', extraDirs: [], readDirs: [] });
  await proc.ready();
  assert.deepEqual(applied, ['plan']);
  assert.equal(proc.policy.status, 'applied');
  q.setPermissionMode = async () => { throw new Error('not allowed'); };
  const refused = new ClaudeProcess(q, 'conv', () => {});
  await assert.rejects(refused.ready(), /not allowed/);
  assert.equal(refused.policy.status, 'refused');
});

// What Claude Code 2.1.321 sends in bypass mode with the ask rule `Bash(echo deploy:*)` (probe of 17/11).
const askRule = { source: 'projectSettings', toolName: 'Bash', ruleContent: 'echo deploy:*' };

test('a compound command whose only ask is a permissions.ask rule is the rule alone', () => {
  // echo deploy a && echo done · for s in a b; do echo deploy $s; done
  assert.equal(askedByRule({ decisionReasonType: 'rule' }), true);
  // for s in a b; do r=$(npx supabase functions deploy $s … | tail -1); echo "$s: $r"; done: the deploy loop that waited
  assert.equal(askedByRule({ decisionReasonType: 'other', matchedAskRule: askRule }), true);
});

test('a command substitution whose only ask is a permissions.ask rule is the rule alone', () => {
  // echo "result: $(echo deploy a)"
  assert.equal(askedByRule({ decisionReasonType: 'rule' }), true);
  assert.equal(askedByRule({ matchedAskRule: askRule }), true);
});

test('a safety check, a hook or a question to the user are not the rule alone', () => {
  assert.equal(askedByRule({ decisionReasonType: 'safetyCheck', matchedAskRule: askRule }), false);
  assert.equal(askedByRule({ decisionReasonType: 'hook', matchedAskRule: askRule }), false);
  assert.equal(askedByRule({ decisionReasonType: 'other' }), false);
  assert.equal(askedByRule({ decisionReasonType: 'rule', requiresUserInteraction: true }), false);
  assert.equal(askedByRule({}), false);
});

// What Claude Code 2.1.308 sends in bypass mode, read from a real session with the ask rule Bash(echo deploy:*).
test('a command checked part by part is the rule alone only when none of its parts carries a safety check', () => {
  // cd . && echo deploy a | cat: no reason, no code, no rule named
  assert.equal(askedByRule({ tool: 'Bash', decisionReasonType: 'subcommandResults' }), true);
  assert.equal(askedByRule({ tool: 'PowerShell', decisionReasonType: 'subcommandResults' }), true);
  // echo deploy a && echo x > .claude/settings.local.json: the reason is the warning of the part that writes there
  assert.equal(askedByRule({ tool: 'Bash', decisionReasonType: 'subcommandResults', decisionReason: "Claude requested permissions to write to .claude/settings.local.json, but you haven't granted it yet." }), false);
  // Reads outside the working folders are blocked: that check has a code and no text.
  assert.equal(askedByRule({ tool: 'Bash', decisionReasonType: 'subcommandResults', decisionReasonCode: 'outside_reads_blocked' }), false);
  assert.equal(askedByRule({ tool: 'Bash', decisionReasonType: 'subcommandResults', requiresUserInteraction: true }), false);
  // Only a shell command is checked part by part.
  assert.equal(askedByRule({ tool: 'Edit', decisionReasonType: 'subcommandResults' }), false);
  assert.equal(askedByRule({ decisionReasonType: 'subcommandResults' }), false);
});

test('a hook that asks for a person is read from its output, and holds until the turn ends', async () => {
  const ask = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'a person decides' } });
  assert.equal(hookAsks({ hook_event: 'PreToolUse', stdout: ask, output: '' }), true);
  assert.equal(hookAsks({ hook_event: 'PreToolUse', stdout: '', output: ask }), true);
  assert.equal(hookAsks({ hook_event: 'PreToolUse', stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow' } }), output: '' }), false);
  assert.equal(hookAsks({ hook_event: 'PostToolUse', stdout: ask, output: '' }), false);
  assert.equal(hookAsks({ hook_event: 'PreToolUse', stdout: '', output: '' }), false);

  const seen: boolean[] = [];
  const hook = (stdout: string) => ({ type: 'system', subtype: 'hook_response', hook_id: 'h', hook_name: 'PreToolUse:Bash', hook_event: 'PreToolUse', output: '', stdout, stderr: '', outcome: 'success' });
  const q = (async function* () {
    yield hook('');
    yield hook(ask);
    yield { type: 'system', subtype: 'status', status: null };
    yield { type: 'result', subtype: 'success', is_error: false, result: '', total_cost_usd: 0, modelUsage: {} };
    yield { type: 'system', subtype: 'status', status: null };
  })() as unknown as Query;
  // Each message signals before it is read: the flag seen is the one the messages before it left.
  const held: { proc?: ClaudeProcess } = {};
  const proc = (held.proc = new ClaudeProcess(q, 'conv', () => seen.push(held.proc?.hookAsked ?? false)));
  for await (const _ of proc.events);
  assert.deepEqual(seen, [false, false, true, true, false]);
  assert.equal(proc.hookAsked, false, 'the end of the turn clears it');
});

test('a keep-alive reads the session as it was launched, on a fork that leaves no file and runs no tool', async () => {
  const spec = {
    role: 'worker', name: 'hub-x', cwd: '/repo', extraDirs: ['/extra'], readDirs: [], readOnly: false, model: 'claude-fable-5-2', effort: 'high', ultracode: false,
    mode: 'bypassPermissions', instructions: 'hub rules', stableInstructions: true, mcp: null, executable: '', env: { A: '1' }, conversation: { id: 'c-1', resume: true },
    tools: [{ name: 'message_master', description: 'Writes to the master.', shape: {}, handler: async () => { throw new Error('a keep-alive ran a hub tool'); } }],
    input: (async function* () {})(), onSignal: () => undefined, onPermission: async () => ({ behavior: 'allow' }), onElicitation: async () => ({ action: 'decline' }),
  } as unknown as LaunchSpec;
  const o = keepAliveOptions(spec, new AbortController());
  // What the cache is keyed on: the same as the launch.
  assert.equal(o.model, 'claude-fable-5-2[1m]');
  assert.equal(o.effort, 'high');
  assert.deepEqual(o.systemPrompt, { type: 'preset', preset: 'claude_code', append: 'hub rules', snapshot: false });
  assert.deepEqual(o.disallowedTools, disallowedTools(spec));
  assert.deepEqual(o.settings, launchSettings(spec));
  assert.equal((o.env as Record<string, string>).A, '1');
  // The conversation itself gains nothing.
  assert.deepEqual([o.resume, o.forkSession, o.persistSession, o.maxTurns], ['c-1', true, false, 1]);
  // Not under the session's name: a second process of that name would take its peers' messages.
  assert.equal(o.extraArgs, undefined);
  assert.equal(o.permissionMode, undefined);
  const denied = await o.canUseTool!('Bash', {}, { signal: new AbortController().signal } as never);
  assert.equal(denied?.behavior, 'deny');
  const hook = await o.hooks!.PreToolUse![0].hooks[0]({} as never, undefined, { signal: new AbortController().signal });
  assert.equal((hook as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision, 'deny');
});
