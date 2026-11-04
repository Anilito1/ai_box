import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Inbox } from '../inbox';
import type { AgentInput, LaunchSpec } from '../types';
import { AcpClient } from './acp';
import { geminiAdapter } from './adapter';

test('Gemini resume refreshes instructions, retains usage and delivers ACP commands without replaying history', async (t) => {
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  t.mock.method(AcpClient.prototype, 'start', async () => ({}));
  t.mock.method(AcpClient.prototype, 'request', async function(this: AcpClient, method: string, params: Record<string, unknown>) {
    requests.push({ method, params });
    if (method === 'session/load') {
      this.onNotification('session/update', { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'old answer' } } });
      this.onNotification('session/update', { update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'explain', description: 'Explain' }] } });
      return { models: { currentModelId: 'gemini-2.5-pro' } };
    }
    return method === 'session/prompt' ? { stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 2 } } : {};
  });
  const input = new Inbox<AgentInput>();
  const initialUsage = { cost: .01, models: { 'gemini-2.5-pro': { cost: .01, input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } } };
  const spec: LaunchSpec = {
    role: 'worker', name: 'test', cwd: '/tmp', extraDirs: [], readDirs: [], readOnly: false,
    model: '', effort: null, ultracode: false, mode: null, instructions: 'Current instructions', stableInstructions: false,
    tools: [], mcp: null, executable: 'unused', env: { GEMINI_API_KEY: 'fixture' },
    conversation: { id: 'saved', resume: true }, initialUsage, input,
    onSignal() {}, onPermission: async () => ({ behavior: 'deny', message: 'fixture' }), onElicitation: async () => ({ action: 'decline' }),
  };
  const process = geminiAdapter.start(spec);
  try {
    await process.ready();
    assert.deepEqual(await process.totals(), initialUsage);
    await assert.rejects(process.setEffort('high'), /does not expose/);
    input.push({ content: 'Continue' });
    let commands = false;
    for await (const event of process.events) {
      if (event.type === 'commands') commands = event.commands[0].name === 'explain';
      assert.notEqual(event.type, 'stream', 'loaded history must not replay');
      if (event.type === 'turn') {
        assert.equal(event.usage.models['gemini-2.5-pro'].input, 120);
        assert.ok(event.usage.cost > initialUsage.cost);
        break;
      }
    }
    assert.equal(commands, true);
    const prompt = requests.find((r) => r.method === 'session/prompt')?.params.prompt as { text: string }[];
    assert.equal(prompt[0].text, 'Current instructions\n\n---\n');
    assert.equal(prompt[1].text, 'Continue');
  } finally {
    input.close();
    process.close();
  }
});

for (const firstCommand of ['/compact keep tests', '$ echo ready']) {
  test(`Gemini resume preserves first command ${firstCommand[0]} and refreshes instructions on the next conversational prompt`, async (t) => {
    const prompts: Record<string, unknown>[][] = [];
    const routedCommands: string[] = [];
    t.mock.method(AcpClient.prototype, 'start', async () => ({}));
    t.mock.method(AcpClient.prototype, 'request', async function(_method: string, params: Record<string, unknown>) {
      if (_method === 'session/load') return { models: { currentModelId: 'gemini-2.5-pro' } };
      if (_method !== 'session/prompt') return {};
      const prompt = params.prompt as Record<string, unknown>[];
      prompts.push(prompt);
      const text = prompt.map((part) => String(part.text ?? '')).join('').trim();
      // Match the CLI's prefix routing: prepending instructions here would turn a command into model input.
      if (text.startsWith('/') || text.startsWith('$')) {
        routedCommands.push(text);
        return { stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } };
      }
      return { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 1 } };
    });
    const input = new Inbox<AgentInput>();
    const spec: LaunchSpec = {
      role: 'worker', name: 'test', cwd: '/tmp', extraDirs: [], readDirs: [], readOnly: false,
      model: '', effort: null, ultracode: false, mode: null, instructions: 'Updated instructions', stableInstructions: false,
      tools: [], mcp: null, executable: 'unused', env: { GEMINI_API_KEY: 'fixture' },
      conversation: { id: 'saved', resume: true }, input,
      onSignal() {}, onPermission: async () => ({ behavior: 'deny', message: 'fixture' }), onElicitation: async () => ({ action: 'decline' }),
    };
    const process = geminiAdapter.start(spec);
    try {
      await process.ready();
      // Commands retain their arguments; neither command consumes the pending instruction refresh.
      const messages = [firstCommand, '  /compact second command', 'Continue working', 'Another question'];
      for (const content of messages) input.push({ content });
      let turns = 0;
      for await (const event of process.events) {
        if (event.type === 'turn' && ++turns === messages.length) break;
      }
      assert.equal(prompts.length, 4, 'no extra model request primes instructions');
      assert.deepEqual(prompts[0], [{ type: 'text', text: firstCommand }]);
      assert.deepEqual(prompts[1], [{ type: 'text', text: messages[1] }]);
      assert.deepEqual(routedCommands, [firstCommand, messages[1].trim()]);
      assert.deepEqual(prompts[2], [
        { type: 'text', text: 'Updated instructions\n\n---\n' },
        { type: 'text', text: 'Continue working' },
      ]);
      assert.deepEqual(prompts[3], [{ type: 'text', text: 'Another question' }], 'successful refresh is inserted once');
    } finally {
      input.close();
      process.close();
    }
  });
}
