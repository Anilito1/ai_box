import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { FAULT_WAITS_MS } from '../shared/providerFault';
import { loadConfig } from './config';
import type { CostLog } from './costLog';
import type { McpHub } from './mcpHub';
import { SessionManager } from './sessions';

// A turn the provider cut is taken up again by the hub, a few times, without the worker passing for idle meanwhile.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Internal = any;
const never = () => new Promise<never>(() => undefined);
const LONGEST = FAULT_WAITS_MS[FAULT_WAITS_MS.length - 1] * 1.25 + 1000;

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'fault-resume-'));
  const work = join(dir, 'work');
  mkdirSync(work);
  const cfg = loadConfig(dir, 'en');
  cfg.workspaces = [work];
  const manager = new SessionManager({ cfg, dataDir: dir, executable: () => '', codexExecutable: () => '', geminiExecutable: () => '', mcpHub: {} as McpHub,
    sessionEnv: () => ({ set: {}, unset: [] }), persist: () => undefined, costLog: { today: () => 0 } as unknown as CostLog, capabilities: async () => '' });
  const inner: Internal = manager;
  const s = inner.create('w-fault', 'worker', 'hub-fault', 'TASK_001', work, '', null);
  const q = { close: () => undefined, interrupt: async () => undefined, context: never, totals: never, rateLimits: never };
  Object.assign(s, { started: true, status: 'idle', query: q, inbox: inner.deliveryInbox(s) });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    t.mock.timers.reset();
    manager.killAll();
    rmSync(dir, { recursive: true, force: true });
  });
  const cut = (error = 'overloaded', result = 'API Error: 529 Overloaded') => {
    inner.onEvent(s, q, { type: 'assistant', id: `err-${Math.random()}`, blocks: [{ type: 'text', text: result }], error, contextTokens: 0 });
    inner.onEvent(s, q, { type: 'turn', subtype: 'success', isError: true, result, queued: 0, contextWindows: {}, usage: { cost: 0, models: {} } });
  };
  const queued = () => s.deliveries.filter((e: Internal) => e.state === 'queued').map((e: Internal) => String(e.value.content));
  const notices = () => [...s.items.values()].filter((i: Internal) => i.kind === 'notice').map((i: Internal) => String(i.text));
  return { manager, inner, s, q, cut, queued, notices };
}

test('a turn cut by an overload is taken up again by the hub, and the worker counts as working until then', (t) => {
  const { manager, inner, s, cut, queued, notices } = fixture(t);
  cut();
  assert.equal(s.status, 'idle');
  assert.equal(inner.settled(s), false, 'neither put to sleep nor reported silent while it waits');
  assert.equal(manager.snapshot().sessions.find((x) => x.id === s.id)?.retrying, true);
  assert.ok(notices().some((n: string) => /taken up again automatically/.test(n)));
  assert.deepEqual(queued(), []);
  t.mock.timers.tick(FAULT_WAITS_MS[0] * 1.25 + 1000);
  assert.equal(queued().length, 1);
  assert.match(queued()[0], /temporary error/);
  assert.equal(s.faultTimer, null);
});

test('a limit, a refused request or an interrupted turn is never taken up again', (t) => {
  const { inner, s, q, cut, queued } = fixture(t);
  cut('rate_limit', 'API Error: 429 rate limited');
  cut('invalid_request', 'API Error: 400 prompt is too long');
  inner.onEvent(s, q, { type: 'assistant', id: 'err', blocks: [], error: 'overloaded', contextTokens: 0 });
  inner.onEvent(s, q, { type: 'turn', subtype: 'error_during_execution', isError: true, result: '', queued: 0, contextWindows: {}, usage: { cost: 0, models: {} } });
  assert.equal(s.faultTimer, null);
  t.mock.timers.tick(LONGEST);
  assert.deepEqual(queued(), []);
});

test('a message that comes in during the wait takes the turn up: the hub adds nothing', (t) => {
  const { inner, s, cut, queued } = fixture(t);
  cut();
  inner.pushUser(s, { text: 'NEW_ORDER_001', images: [] });
  assert.equal(s.faultTimer, null);
  t.mock.timers.tick(LONGEST);
  assert.deepEqual(queued(), ['NEW_ORDER_001']);
});

test('the user stopping the session ends the wait', (t) => {
  const { manager, s, cut, queued } = fixture(t);
  cut();
  manager.interrupt(s.id);
  assert.equal(s.faultTimer, null);
  t.mock.timers.tick(LONGEST);
  assert.deepEqual(queued(), []);
});

test('after as many cut turns in a row as there are waits, the hub gives up and says so', async (t) => {
  const { inner, s, q, cut, queued, notices } = fixture(t);
  for (let i = 0; i < FAULT_WAITS_MS.length; i++) {
    cut();
    assert.ok(s.faultTimer, `try ${i + 1} is scheduled`);
    t.mock.timers.tick(LONGEST);
    assert.equal(queued().length, 1);
    // The process takes the prompt and starts the turn that will be cut again.
    const taken = (await s.inbox[Symbol.asyncIterator]().next()).value.content;
    inner.onEvent(s, q, { type: 'promptTaken', text: taken });
  }
  cut();
  assert.equal(s.faultTimer, null);
  assert.ok(notices().some((n: string) => /no longer taken up automatically/.test(n)));
  assert.equal(inner.settled(s), true, 'it may be put to sleep again');
  t.mock.timers.tick(LONGEST);
  assert.deepEqual(queued(), []);
});

test('a turn that ends well clears the count', (t) => {
  const { inner, s, q, cut } = fixture(t);
  cut();
  assert.equal(s.faults, 1);
  inner.onEvent(s, q, { type: 'assistant', id: 'fine', blocks: [{ type: 'text', text: 'done' }], error: '', contextTokens: 0 });
  inner.onEvent(s, q, { type: 'turn', subtype: 'success', isError: false, result: 'done', queued: 0, contextWindows: {}, usage: { cost: 0, models: {} } });
  assert.equal(s.faults, 0);
});

test('a worker the master closed during the wait is not set to work again', (t) => {
  const { s, cut, queued } = fixture(t);
  cut();
  assert.ok(s.faultTimer);
  s.closeWhenDone = true;
  t.mock.timers.tick(LONGEST);
  assert.deepEqual(queued(), []);
});

test('a worker closed before its turn was cut waits for nothing', (t) => {
  const { s, cut } = fixture(t);
  s.closeWhenDone = true;
  cut();
  assert.equal(s.faultTimer, null);
});
