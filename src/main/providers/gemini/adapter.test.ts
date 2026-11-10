import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Inbox } from '../inbox';
import type { AgentEvent, AgentInput, LaunchSpec } from '../types';
import { AcpClient } from './acp';
import { GeminiProcess, geminiAdapter } from './adapter';

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

function fixture(t: TestContext, overrides: Partial<LaunchSpec> = {}, rejectMethod = '', onPrompt?: () => Promise<Record<string, unknown>>) {
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  let started = false;
  let closed = false;
  let client: AcpClient;
  t.mock.method(AcpClient.prototype, 'start', async () => { started = true; return {}; });
  t.mock.method(AcpClient.prototype, 'close', () => { closed = true; });
  t.mock.method(AcpClient.prototype, 'request', async function(this: AcpClient, method: string, params: Record<string, unknown>) {
    client = this;
    requests.push({ method, params });
    if (method === rejectMethod) throw new Error(`${method} refused`);
    if (method === 'session/prompt' && onPrompt) return onPrompt();
    if (method === 'session/new' || method === 'session/load') return {
      sessionId: 'fixture-session',
      models: { currentModelId: 'gemini-current', availableModels: [{ modelId: 'gemini-current' }, { modelId: 'gemini-requested' }] },
    };
    return {};
  });
  const input = new Inbox<AgentInput>();
  const spec: LaunchSpec = {
    role: 'worker', name: 'test', cwd: '/tmp', extraDirs: [], readDirs: [], readOnly: false,
    model: '', effort: null, ultracode: false, mode: 'default', instructions: '', stableInstructions: false,
    tools: [], mcp: null, executable: 'unused', env: { GEMINI_API_KEY: 'fixture' },
    conversation: { id: 'fixture-session', resume: false }, input,
    onSignal() {}, onPermission: async () => ({ behavior: 'deny', message: 'fixture' }), onElicitation: async () => ({ action: 'decline' }),
    ...overrides,
  };
  const process = new GeminiProcess(spec);
  t.after(() => { input.close(); process.close(); });
  return { process, input, requests, started: () => started, closed: () => closed, client: () => client };
}

for (const method of ['session/set_model', 'session/set_mode']) {
  test(`Gemini blocks startup and prompts when ${method} fails`, async (t) => {
    const { process, input, requests, closed } = fixture(t, { model: 'gemini-requested', mode: 'plan' }, method);
    input.push({ content: 'Do work' });
    await assert.rejects(process.ready(), new RegExp(`${method} refused`));
    const emitted: string[] = [];
    await assert.rejects(async () => { for await (const e of process.events) emitted.push(e.type); }, /refused/);
    assert.ok(!requests.some((r) => r.method === 'session/prompt'));
    assert.ok(!emitted.includes('conversation'));
    assert.equal(process.policy.status, 'refused');
    assert.equal(process.policy.effective.mode, null);
    assert.equal(closed(), true);
  });
}

test('Gemini refuses an unavailable requested model instead of silently selecting another', async (t) => {
  const { process, requests } = fixture(t, { model: 'unavailable' });
  await assert.rejects(process.ready(), /does not offer.*unavailable/);
  assert.ok(!requests.some((r) => r.method === 'session/prompt'));
});

test('Gemini dontAsk fails closed before launching, including read-only requests', async (t) => {
  const { process, started, requests } = fixture(t, { mode: 'dontAsk', readOnly: true });
  await assert.rejects(process.ready(), /does not support.*dontAsk/);
  assert.equal(started(), false);
  assert.deepEqual(requests, []);
  assert.equal(process.policy.requested.mode, 'dontAsk');
  assert.equal(process.policy.effective.mode, null);
});

test('Gemini explicitly applies default on a resumed session before delivering prompts', async (t) => {
  const { process, requests } = fixture(t, { conversation: { id: 'saved', resume: true }, mode: null });
  await process.ready();
  assert.deepEqual(requests.find((r) => r.method === 'session/set_mode')?.params, { sessionId: 'saved', modeId: 'default' });
  assert.equal(process.policy.status, 'applied');
  assert.equal(process.policy.effective.mode, 'default');
});

test('Gemini mode changes retain acknowledged state until success and rollback on rejection', async (t) => {
  const { process, requests } = fixture(t);
  await process.ready();
  let acknowledge!: () => void;
  t.mock.method(AcpClient.prototype, 'request', () => new Promise<void>((resolve) => { acknowledge = resolve; }));
  const pending = process.setMode('plan');
  await Promise.resolve();
  assert.equal(process.policy.status, 'pending');
  assert.equal(process.policy.effective.mode, 'default');
  assert.equal(process.policy.requested.mode, 'plan');
  acknowledge();
  await pending;
  assert.equal(process.policy.effective.mode, 'plan');
  t.mock.method(AcpClient.prototype, 'request', async () => { throw new Error('change refused'); });
  await assert.rejects(process.setMode('bypassPermissions'), /change refused/);
  assert.equal(process.policy.status, 'refused');
  assert.equal(process.policy.requested.mode, 'bypassPermissions');
  assert.equal(process.policy.effective.mode, 'plan');
  const before = requests.length;
  await assert.rejects(process.setMode('dontAsk'), /does not support.*dontAsk/);
  assert.equal(requests.length, before);
  assert.equal(process.policy.requested.mode, 'dontAsk');
  assert.equal(process.policy.effective.mode, 'plan');
});

test('Gemini model changes retain the acknowledged model after a refusal', async (t) => {
  const { process } = fixture(t);
  await process.ready();
  t.mock.method(AcpClient.prototype, 'request', async () => { throw new Error('model refused'); });
  await assert.rejects(process.setModel('gemini-requested'), /model refused/);
  assert.equal((await process.context()).model, 'gemini-current');
});

test('Gemini read-only publishes the acknowledged plan mode and its enforcement limits', async (t) => {
  const { process, requests } = fixture(t, { readOnly: true, mode: 'bypassPermissions' });
  await process.ready();
  assert.equal(requests.find((r) => r.method === 'session/set_mode')?.params.modeId, 'plan');
  assert.equal(process.policy.status, 'partial');
  assert.equal(process.policy.requested.mode, 'bypassPermissions');
  assert.equal(process.policy.effective.mode, 'plan');
  assert.equal(process.policy.effective.roots, null);
  for await (const e of process.events) {
    if (e.type === 'conversation') { assert.equal(e.mode, 'plan'); break; }
  }
});

for (const order of ['response-close', 'close-response', 'exit-response', 'cancel-response'] as const) {
  test(`Gemini ${order} emits one correlated terminal and ignores late replies`, async (t) => {
    let resolve!: (value: Record<string, unknown>) => void;
    const reply = new Promise<Record<string, unknown>>(yes => { resolve = yes; });
    const f = fixture(t, {}, '', () => reply);
    const events: AgentEvent[] = [];
    const ended = (async () => { try { for await (const e of f.process.events) events.push(e); } catch (err) { assert.match(String(err), /gemini exited/); } })();
    await f.process.ready();
    f.input.push({ content: 'FIRST_PERMUTATION' });
    await new Promise(yes => setImmediate(yes));
    assert.equal(f.requests.filter(r => r.method === 'session/prompt').length, 1);
    if (order === 'close-response') f.process.close();
    if (order === 'exit-response') f.client().onExit({ closed: false, code: 1, stderr: 'fixture' });
    if (order === 'cancel-response') await f.process.interrupt();
    resolve({ stopReason: order === 'cancel-response' ? 'cancelled' : 'end_turn', usage: { inputTokens: 2, outputTokens: 1 } });
    await new Promise(yes => setImmediate(yes));
    f.process.close(); f.input.close();
    await ended;
    const terminal = events.filter(e => e.type === 'turn');
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].subtype, order === 'response-close' ? 'success' : order === 'exit-response' ? 'error_during_execution' : 'interrupted');
    assert.equal(events.filter(e => e.type === 'promptTaken').length, 1);
  });
}
