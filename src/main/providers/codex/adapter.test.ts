import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventQueue } from '../queue';
import type { AgentEvent, AgentInput, LaunchSpec } from '../types';
import { CodexProcess, isMissingThread } from './adapter';
import { CodexClient, RpcError } from './client';
import { sandboxPolicy, type SandboxMode } from './modes';

type Json = Record<string, unknown>;
function deferred() {
  let resolve!: (value: Json) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Json>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class FakeClient {
  onNotification: (method: string, params: Json) => void = () => undefined;
  onRequest = async () => ({});
  onExit: (info: { closed: boolean; code: number | null; stderr: string }) => void = () => undefined;
  calls: { method: string; params: Json; response: ReturnType<typeof deferred> }[] = [];
  closed = false;
  threadReply: Json | undefined;
  start = async () => undefined;
  close = () => { this.closed = true; };
  request(method: string, params: Json) {
    if (method === 'model/list') return Promise.resolve({ data: [] });
    if (method === 'thread/start' || method === 'thread/resume') return Promise.resolve(this.threadReply ?? {
      thread: { id: 'thread' }, approvalPolicy: params.approvalPolicy, approvalsReviewer: params.approvalsReviewer,
      sandbox: sandboxPolicy(params.sandbox as SandboxMode, ['/tmp']),
    });
    const response = deferred();
    this.calls.push({ method, params, response });
    return response.promise;
  }
  emit(method: string, params: Json = {}) { this.onNotification(method, { threadId: 'thread', ...params }); }
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
async function fixture(compactTimeoutMs?: number, client = new FakeClient()) {
  const input = new EventQueue<AgentInput>();
  const spec: LaunchSpec = {
    role: 'worker', name: 'test', cwd: '/tmp', extraDirs: [], readDirs: [], readOnly: true,
    model: '', effort: null, ultracode: false, mode: null, instructions: '', stableInstructions: false,
    tools: [], mcp: null, executable: '', env: {}, conversation: { id: '', resume: false }, input,
    onSignal: () => undefined, onPermission: async () => ({ behavior: 'deny', message: '' }),
    onElicitation: async () => ({ action: 'decline' }),
  };
  const process = new CodexProcess(spec, client as unknown as CodexClient, compactTimeoutMs);
  const events: AgentEvent[] = [];
  const ended = (async () => { for await (const event of process.events) events.push(event); })();
  ended.catch(() => undefined);
  await process.ready();
  return {
    client, process, events,
    async send(content: string) { input.push({ content }); await flush(); },
    async done() { process.close(); input.close(); await ended; },
  };
}
const turns = (events: AgentEvent[]) => events.filter((e) => e.type === 'turn');

test('Codex acknowledges its sandbox and refuses missing or weakened startup policy', async () => {
  const f = await fixture();
  try {
    assert.equal(f.process.capabilities.transport, 'app-server');
    assert.equal(f.process.policy.status, 'applied');
    assert.equal(f.process.policy.effective.sandbox, 'read-only');
    assert.equal(f.process.policy.effective.network, 'restricted');
    await f.process.setMode('plan');
    assert.equal(f.process.policy.requested.mode, 'plan');
    f.client.threadReply = { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'dangerFullAccess' } };
    await assert.rejects(f.process.setMode('default'), /did not acknowledge/);
    assert.equal(f.process.policy.status, 'refused');
    assert.equal(f.process.policy.effective.mode, 'plan');
  } finally { await f.done(); }
  for (const response of [{ thread: { id: 'thread' } }, { approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: true } }]) {
    const client = new FakeClient(); client.threadReply = response;
    await assert.rejects(fixture(undefined, client), /did not acknowledge/);
    assert.equal(client.closed, true);
    assert.ok(!client.calls.some(call => call.method === 'turn/start'));
  }
});

test('all start/completion response orders emit a single terminal and accept the next input', async () => {
  for (const order of [['started', 'reply', 'completed'], ['reply', 'started', 'completed'], ['started', 'completed', 'reply'], ['completed', 'reply']]) {
    const f = await fixture();
    try {
      await f.send('one');
      const first = f.client.calls[0];
      for (const step of order) {
        if (step === 'reply') first.response.resolve({ turn: { id: 'one' } });
        else f.client.emit(`turn/${step}`, { turn: { id: 'one', status: step === 'completed' ? 'completed' : 'inProgress' } });
        await flush();
      }
      f.client.emit('turn/completed', { turn: { id: 'one', status: 'completed' } });
      await f.send('two');
      assert.equal(f.client.calls[1].method, 'turn/start', order.join(','));
      // A stale turn must not bind to the second input while its start is pending.
      f.client.emit('turn/completed', { turn: { id: 'one', status: 'completed' } });
      f.client.calls[1].response.resolve({ turn: { id: 'two' } });
      await flush();
      f.client.emit('turn/completed', { turn: { id: 'two', status: 'completed' } });
      await flush();
      assert.deepEqual(turns(f.events).map((e) => e.subtype), ['success', 'success']);
      assert.ok(f.events.findIndex((e) => e.type === 'promptTaken') < f.events.findIndex((e) => e.type === 'turn'));
    } finally { await f.done(); }
  }
});

test('interrupt during start uses turn/started and is sent once despite the delayed RPC reply', async () => {
  const f = await fixture();
  try {
    await f.send('one');
    await f.process.interrupt();
    assert.equal(f.client.calls.length, 1);
    f.client.emit('turn/started', { turn: { id: 'one' } });
    assert.equal(f.client.calls[1].method, 'turn/interrupt');
    f.client.calls[0].response.resolve({ turn: { id: 'one' } });
    f.client.calls[1].response.resolve({});
    await flush();
    assert.equal(f.client.calls.filter((c) => c.method === 'turn/interrupt').length, 1);
    f.client.emit('turn/completed', { turn: { id: 'one', status: 'interrupted' } });
    await flush();
    assert.deepEqual(turns(f.events).map((e) => e.subtype), ['interrupted']);
  } finally { await f.done(); }
});

test('compact rejection clears busy and yields an error terminal; the next input proceeds', async () => {
  const f = await fixture();
  try {
    await f.send('/compact');
    f.client.calls[0].response.reject(new RpcError('compact refused', -32602));
    await flush();
    assert.deepEqual(f.events.filter((e) => e.type === 'compacting').map((e) => e.on), [true, false]);
    assert.equal(turns(f.events)[0].isError, true);
    await f.send('after');
    assert.equal(f.client.calls[1].method, 'turn/start');
    f.client.calls[1].response.resolve({ turn: { id: 'after' } });
  } finally { await f.done(); }
});

test('compact notification wins over late RPC rejection and duplicate completion', async () => {
  const f = await fixture();
  try {
    await f.send('/compact');
    f.client.emit('thread/compacted');
    f.client.emit('thread/compacted');
    f.client.calls[0].response.reject(new Error('late transport failure'));
    await flush();
    assert.deepEqual(turns(f.events).map((e) => e.subtype), ['success']);
    assert.equal(f.events.filter((e) => e.type === 'compacted').length, 1);
    assert.deepEqual(f.events.filter((e) => e.type === 'compacting').map((e) => e.on), [true, false]);
  } finally { await f.done(); }
});

test('compact timeout ends the operation and closes its generation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(200);
  try {
    await f.send('/compact');
    f.client.calls[0].response.resolve({});
    await flush();
    t.mock.timers.tick(200);
    await flush();
    assert.equal(f.client.closed, true);
    assert.deepEqual(turns(f.events).map((e) => e.subtype), ['error_during_execution']);
    assert.deepEqual(f.events.filter((e) => e.type === 'compacting').map((e) => e.on), [true, false]);
    f.client.emit('thread/compacted');
    await flush();
    assert.equal(turns(f.events).length, 1);
  } finally { await f.done(); }
});

test('close emits one interruption and ignores late start responses and notifications', async () => {
  const f = await fixture();
  await f.send('one');
  await f.done();
  f.client.calls[0].response.resolve({ turn: { id: 'one' } });
  f.client.emit('turn/completed', { turn: { id: 'one', status: 'completed' } });
  await flush();
  assert.deepEqual(turns(f.events).map((e) => e.subtype), ['interrupted']);
});

test('unexpected process exit emits a failed terminal once', async () => {
  const f = await fixture();
  await f.send('one');
  f.client.onExit({ closed: false, code: 1, stderr: 'failed' });
  f.client.calls[0].response.reject(new Error('exited'));
  await f.done();
  assert.deepEqual(turns(f.events).map((e) => e.subtype), ['error_during_execution']);
});

test('only explicit thread absence discards a conversation link', () => {
  assert.ok(isMissingThread(new RpcError('thread not found', -32602)));
  assert.ok(isMissingThread(new RpcError('thread with id abc was not found', -32602)));
  for (const error of [new RpcError('invalid request', -32602), new RpcError('unauthorized', -32000), new RpcError('failed to read thread: permission denied', -32603), new Error('connection closed')]) {
    assert.equal(isMissingThread(error), false);
  }
});

test('a non-retry error is terminal even when turn/completed never arrives', async () => {
  const f = await fixture();
  try {
    await f.send('one');
    f.client.emit('error', { turnId: 'one', error: { message: 'failed', codexErrorInfo: 'internalServerError' }, willRetry: false });
    f.client.calls[0].response.resolve({ turn: { id: 'one' } });
    f.client.emit('turn/completed', { turn: { id: 'one', status: 'failed' } });
    await flush();
    assert.deepEqual(turns(f.events).map((e) => e.subtype), ['error_during_execution']);
  } finally { await f.done(); }
});

test('interrupt cancels compaction without a turn id and clears busy', async () => {
  const f = await fixture();
  await f.send('/compact');
  await f.process.interrupt();
  f.client.calls[0].response.resolve({});
  await f.done();
  assert.equal(f.client.closed, true);
  assert.deepEqual(turns(f.events).map((e) => e.subtype), ['interrupted']);
  assert.deepEqual(f.events.filter((e) => e.type === 'compacting').map((e) => e.on), [true, false]);
});

test('completion before turn/started cannot reuse the previous turn answer', async () => {
  const f = await fixture();
  try {
    await f.send('one');
    f.client.calls[0].response.resolve({ turn: { id: 'one' } });
    f.client.emit('item/completed', { turnId: 'one', item: { id: 'answer-one', type: 'agentMessage', text: 'old answer' } });
    f.client.emit('turn/completed', { turn: { id: 'one', status: 'completed' } });
    await f.send('two');
    f.client.emit('turn/completed', { turn: { id: 'two', status: 'completed' } });
    f.client.calls[1].response.resolve({ turn: { id: 'two' } });
    await flush();
    assert.deepEqual(turns(f.events).map((e) => e.result), ['old answer', '']);
  } finally { await f.done(); }
});

test('a duplicate turn/started does not erase the answer already received', async () => {
  const f = await fixture();
  try {
    await f.send('one');
    f.client.calls[0].response.resolve({ turn: { id: 'one' } });
    f.client.emit('turn/started', { turn: { id: 'one' } });
    f.client.emit('item/completed', { turnId: 'one', item: { id: 'answer-one', type: 'agentMessage', text: 'answer' } });
    f.client.emit('turn/started', { turn: { id: 'one' } });
    f.client.emit('turn/completed', { turn: { id: 'one', status: 'completed' } });
    await flush();
    assert.deepEqual(turns(f.events).map((e) => e.result), ['answer']);
  } finally { await f.done(); }
});
