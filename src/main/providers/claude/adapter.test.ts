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
  return { applied, proc: new ClaudeProcess(q, 'conv') };
}

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
