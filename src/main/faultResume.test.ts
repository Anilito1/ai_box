import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { FAULT_WAITS_MS, NETWORK_WAITS_MS } from '../shared/providerFault';
import { loadConfig } from './config';
import type { CostLog } from './costLog';
import type { McpHub } from './mcpHub';
import { SessionManager } from './sessions';

// A turn the provider cut is taken up again by the hub, a few times, without the worker passing for idle meanwhile.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Internal = any;
const never = () => new Promise<never>(() => undefined);
const LONGEST = FAULT_WAITS_MS[FAULT_WAITS_MS.length - 1] * 1.25 + 1000;

/** `net`: the network as the manager sees it (online, its interfaces), with the clock mocked too. */
function fixture(t: TestContext, net?: { online: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'fault-resume-'));
  const work = join(dir, 'work');
  mkdirSync(work);
  const cfg = loadConfig(dir, 'en');
  cfg.workspaces = [work];
  const network = net && { interfaces: () => ({}), online: () => net.online };
  const manager = new SessionManager({ cfg, dataDir: dir, executable: () => '', codexExecutable: () => '', geminiExecutable: () => '', mcpHub: {} as McpHub,
    sessionEnv: () => ({ set: {}, unset: [] }), persist: () => undefined, costLog: { today: () => 0 } as unknown as CostLog, capabilities: async () => '', ...(network ? { network } : {}) });
  const inner: Internal = manager;
  const s = inner.create('w-fault', 'worker', 'hub-fault', 'TASK_001', work, '', null);
  const q = { closed: 0, close() { this.closed++; }, interrupt: async () => undefined, context: never, totals: never, rateLimits: never };
  Object.assign(s, { started: true, status: 'idle', query: q, inbox: inner.deliveryInbox(s) });
  t.mock.timers.enable(net ? { apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 } : { apis: ['setTimeout'] });
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

// A connection cut (a Wi-Fi that drops, a phone's hotspot, sleep): taken up within seconds, or at once when the
// network changes; never twice, never while offline, within a ceiling; a process that may hold the old network's
// connections is started again on its conversation.
const LOST = 'API Error: Connection lost mid-response. The response above may be incomplete.';
const NET_LONGEST = NETWORK_WAITS_MS[NETWORK_WAITS_MS.length - 1] * 1.25 + 1000;

/** Replaces the launch of a new process: what it was asked. */
function launches(inner: Internal) {
  const calls: { resume: boolean; prompt: string }[] = [];
  inner.launch = async (_s: unknown, resume: boolean, prompt?: { text: string }) => {
    calls.push({ resume, prompt: prompt?.text ?? '' });
  };
  return calls;
}

test('a reply cut by the connection is taken up within seconds, not after the provider waits', (t) => {
  const { s, cut, queued, notices } = fixture(t, { online: true });
  cut('server_error', LOST);
  assert.equal(s.cut, 'network');
  assert.ok(notices().some((n: string) => /connection dropped/.test(n)));
  t.mock.timers.tick(NETWORK_WAITS_MS[0] * 1.25 + 10);
  assert.equal(queued().length, 1);
  assert.match(queued()[0], /connection to the provider dropped/);
});

test('the network coming back takes the cut turn up at once, and only once', (t) => {
  const { manager, s, cut, queued } = fixture(t, { online: true });
  s.faults = 2; // Its third cut in a row: a minute's wait.
  cut('', 'API Error: Connection error. (ECONNRESET)');
  s.launchedAt = Date.now() + 60 * 60_000; // A process started after the change: no restart.
  manager.networkChanged();
  manager.networkChanged();
  t.mock.timers.tick(5_000);
  assert.equal(queued().length, 1, 'taken up seconds after the change, not after its minute');
  assert.equal(s.faultTimer, null);
  manager.networkChanged();
  t.mock.timers.tick(NET_LONGEST);
  assert.equal(queued().length, 1, 'never a second time');
});

test('offline, a try waits for the network and does not count', (t) => {
  const net = { online: false };
  const { manager, s, cut, queued } = fixture(t, net);
  cut('server_error', LOST);
  t.mock.timers.tick(10 * 60_000);
  assert.deepEqual(queued(), []);
  assert.equal(s.faults, 1);
  assert.ok(s.faultTimer, 'still waiting');
  net.online = true;
  manager.networkChanged();
  t.mock.timers.tick(5_000);
  assert.equal(queued().length, 1);
});

test('connection cuts in a row stop at the ceiling, and the master hears of it', async (t) => {
  const { inner, s, q, cut, queued, notices } = fixture(t, { online: true });
  launches(inner);
  for (let i = 0; i < NETWORK_WAITS_MS.length; i++) {
    cut('server_error', LOST);
    assert.ok(s.faultTimer, `try ${i + 1} is scheduled`);
    s.launchedAt = Date.now() + 60 * 60_000;
    t.mock.timers.tick(NET_LONGEST);
    assert.equal(queued().length, 1);
    const taken = (await s.inbox[Symbol.asyncIterator]().next()).value.content;
    inner.onEvent(s, q, { type: 'promptTaken', text: taken });
  }
  cut('server_error', LOST);
  assert.equal(s.faultTimer, null);
  assert.ok(notices().some((n: string) => /dropped \d+ times in a row/.test(n)));
  t.mock.timers.tick(NET_LONGEST);
  assert.deepEqual(queued(), []);
});

test('cut again by a process older than the network change: a new process takes the turn up on the same conversation', (t) => {
  const { manager, inner, s, q, cut, notices } = fixture(t, { online: true });
  const calls = launches(inner);
  s.faults = 1;
  cut('server_error', LOST);
  manager.networkChanged();
  t.mock.timers.tick(5_000);
  assert.equal(q.closed, 1, 'the old process is closed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].resume, true, 'on its conversation');
  assert.match(calls[0].prompt, /connection to the provider dropped/);
  assert.ok(notices().some((n: string) => /started again on the same conversation/.test(n)));
});

test('after a network change, a turn that hears nothing from the model is started again; one that hears it is left alone', (t) => {
  const { manager, inner, s, q } = fixture(t, { online: true });
  const calls = launches(inner);
  inner.onEvent(s, q, { type: 'promptTaken', text: 'x' });
  assert.equal(s.status, 'busy');
  manager.networkChanged();
  // A tool at work: no word from the model is expected meanwhile.
  s.tools.set('tool-1', {});
  t.mock.timers.tick(3 * 60_000);
  assert.equal(calls.length, 0);
  s.tools.clear();
  inner.onEvent(s, q, { type: 'toolResults', blocks: [] });
  t.mock.timers.tick(60_000);
  assert.equal(calls.length, 0, 'the model gets its whole delay after the tool');
  t.mock.timers.tick(45_000);
  assert.equal(q.closed, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].resume, true);
});

test('a turn the model answers after the network change is not started again', (t) => {
  const { manager, inner, s, q } = fixture(t, { online: true });
  const calls = launches(inner);
  inner.onEvent(s, q, { type: 'promptTaken', text: 'x' });
  manager.networkChanged();
  t.mock.timers.tick(10_000);
  inner.onEvent(s, q, { type: 'stream', textStart: true, delta: '' });
  t.mock.timers.tick(10 * 60_000);
  assert.equal(calls.length, 0);
  assert.equal(q.closed, 0);
  assert.equal(s.stallTimer, null);
});

test('Codex or Gemini: a turn given up on a connection cut is taken up, one given up on another error is not', (t) => {
  const { inner, s, q } = fixture(t, { online: true });
  const fail = (text: string) => {
    inner.onEvent(s, q, { type: 'assistant', id: `err-${Math.random()}`, blocks: [{ type: 'text', text }], error: 'server_error', contextTokens: 0 });
    inner.onEvent(s, q, { type: 'turn', subtype: 'error_during_execution', isError: true, result: '', failed: true, queued: 0, contextWindows: {}, usage: { cost: 0, models: {} } });
  };
  fail('internalServerError: something broke');
  assert.equal(s.faultTimer, null);
  fail('responseStreamDisconnected: stream disconnected before completion');
  assert.ok(s.faultTimer);
  assert.equal(s.cut, 'network');
});

test('no network watch while no session works', (t) => {
  const { inner, s, q } = fixture(t, { online: true });
  assert.equal(inner.net.watching, false);
  inner.onEvent(s, q, { type: 'promptTaken', text: 'x' });
  assert.equal(inner.net.watching, true);
  inner.onEvent(s, q, { type: 'turn', subtype: 'success', isError: false, result: 'done', queued: 0, contextWindows: {}, usage: { cost: 0, models: {} } });
  t.mock.timers.tick(10_000);
  assert.equal(inner.net.watching, false);
});
