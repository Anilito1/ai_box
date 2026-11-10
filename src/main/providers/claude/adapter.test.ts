import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeProcess, disallowedTools, launchSettings } from './adapter';

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
