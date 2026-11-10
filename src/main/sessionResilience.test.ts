import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from './config';
import type { CostLog } from './costLog';
import type { McpHub } from './mcpHub';
import { SessionManager } from './sessions';
import { policyOf, refusedPolicy } from './providers/capabilities';

// Access internal lifecycle operations without starting an installed provider or using personal data.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Internal = any;
const never = () => new Promise<never>(() => undefined);
const processStub = () => ({ close: () => undefined, interrupt: async () => undefined, context: never, totals: never, rateLimits: never });
const prompt = (text: string) => ({ text, images: [] });
const turn = { type: 'turn', subtype: 'success', isError: false, result: 'done', queued: 0, contextWindows: [], usage: { cost: 0, models: {} } };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'session-resilience-'));
  const work = join(dir, 'work'); mkdirSync(work);
  const cfg = loadConfig(dir, 'en'); cfg.workspaces = [work];
  const options = { cfg, dataDir: dir, executable: () => '', codexExecutable: () => '', geminiExecutable: () => '', mcpHub: {} as McpHub,
    sessionEnv: () => ({ set: {}, unset: [] }), persist: () => undefined, costLog: { today: () => 0 } as unknown as CostLog, capabilities: async () => '' };
  const manager = new SessionManager(options), inner: Internal = manager;
  const s = inner.create('w-fixture', 'worker', 'WORKER_001', 'TASK_001', work, '', null);
  const q = processStub(); Object.assign(s, { started: true, status: 'idle', query: q, inbox: inner.deliveryInbox(s) });
  return { dir, manager, inner, s, q, options, done: () => { manager.killAll(); rmSync(dir, { recursive: true, force: true }); } };
}

test('readiness blocks unacknowledged policy without consuming the journaled input', async () => {
  for (const acknowledged of [false, true]) {
    const { inner, s, q, done } = fixture();
    try {
      const requested = { mode: 'default' as const, readOnly: false, cwd: '/tmp', extraDirs: [], readDirs: [] };
      Object.assign(q, { ready: async () => ({ models: [], commands: [] }), context: async () => ({ tokens: 0, size: 0, model: '' }), policy: policyOf('claude', requested, acknowledged ? 'default' : undefined) });
      inner.pushUser(s, prompt('QUEUED_POLICY_001')); s.inbox.pause();
      await inner.onReady(s, q);
      assert.equal(s.deliveries[0].state, 'queued');
      if (acknowledged) assert.equal((await s.inbox[Symbol.asyncIterator]().next()).value.content, 'QUEUED_POLICY_001');
      else {
        assert.equal(s.query, null);
        assert.ok([...s.items.values()].some((item: Internal) => /permission policy was not applied/.test(item.detail ?? '')));
      }
    } finally { done(); }
  }
});

test('a refused mode keeps the old displayed mode and queued delivery', async () => {
  const { manager, inner, s, q, done } = fixture();
  try {
    const requested = { mode: 'default' as const, readOnly: false, cwd: '/tmp', extraDirs: [], readDirs: [] };
    Object.assign(q, { policy: policyOf('claude', requested, 'default'), setMode: async () => {
      (q as Internal).policy = refusedPolicy((q as Internal).policy, { ...requested, roots: [], mode: 'plan' }, 'refused');
      throw new Error('refused');
    } });
    s.mode = 'default';
    inner.pushUser(s, prompt('QUEUED_POLICY_002'));
    manager.setMode(s.id, 'plan');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(s.mode, 'default');
    assert.equal(s.query, null);
    assert.equal(s.deliveries[0].state, 'queued');
  } finally { done(); }
});

test('state survives stop/restart with queued and sent inputs; provider queue counts do not replace receipts', async () => {
  const { dir, manager, inner, s, q, options, done } = fixture();
  let restored: SessionManager | undefined;
  try {
    inner.pushUser(s, prompt('FIRST_001'));
    await s.inbox[Symbol.asyncIterator]().next();
    inner.pushUser(s, prompt('SECOND_002'));
    inner.onEvent(s, q, turn);
    assert.equal(s.queued, 2, 'turn completion alone is not an input receipt');
    manager.killAll();
    restored = new SessionManager(options);
    const next: Internal = restored;
    const resumed = next.sessions.get(s.id);
    assert.deepEqual(resumed.deliveries.map((entry: Internal) => entry.state), ['unknown', 'queued']);
    resumed.inbox = next.deliveryInbox(resumed); resumed.query = processStub();
    assert.equal((await resumed.inbox[Symbol.asyncIterator]().next()).value.content, 'SECOND_002');
    next.onEvent(resumed, resumed.query, { type: 'promptTaken', text: 'FIRST_001' });
    assert.equal(resumed.queued, 1);
    const saved = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    assert.deepEqual(saved.sessions.find((entry: Internal) => entry.id === s.id).deliveries.map((entry: Internal) => entry.state), ['acknowledged', 'sent']);
  } finally { restored?.killAll(); done(); }
});

test('a first input is journaled before asynchronous startup and remains queued when launch is stopped', async () => {
  const { dir, inner, s, done } = fixture();
  let release!: () => void;
  try {
    s.inbox = null; s.query = null; s.started = false;
    s.retiring = new Promise<void>(resolve => { release = resolve; });
    const start = inner.start(s, false, prompt('MISSION_BEFORE_START'));
    const persisted = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    assert.equal(persisted.sessions.find((entry: Internal) => entry.id === s.id).deliveries[0].state, 'queued');
    inner.stop(s.id); release(); await start;
    assert.equal(s.inbox, null);
    assert.equal(s.deliveries[0].state, 'queued');
    assert.equal(s.queued, 1);
  } finally { release?.(); done(); }
});

test('a finished parent stays active for agents, compaction, retries, approvals and transitions', () => {
  const { inner, s, q, done } = fixture();
  try {
    assert.equal(inner.settled(s), true);
    inner.onEvent(s, q, { type: 'agentTask', id: 'AGENT_001', state: 'start' });
    inner.onEvent(s, q, turn);
    assert.equal(inner.settled(s), false);
    assert.equal(inner.isWorking(s), true);
    inner.onEvent(s, q, { type: 'agentTask', id: 'AGENT_001', state: 'done' });
    assert.equal(inner.settled(s), true);
    for (const key of ['compacting', 'retrying', 'transitioning', 'moving']) {
      s[key] = true;
      assert.equal(inner.settled(s), false, key); assert.equal(inner.isWorking(s), true, key);
      s[key] = false;
    }
    s.pending.set('APPROVAL_001', () => undefined);
    assert.equal(inner.settled(s), false);
  } finally { done(); }
});

test('concurrent fallback returns share one transition and retain every queued message', async () => {
  const { inner, s, done } = fixture();
  let finish!: (note: string) => void;
  try {
    s.home = ''; s.runAccount = 'default';
    let summaries = 0, switches = 0;
    inner.handoffNote = () => { summaries++; return new Promise<string>(resolve => { finish = resolve; }); };
    inner.switchProcess = () => { switches++; };
    const first = inner.goHome(s, prompt('FIRST'));
    const second = inner.goHome(s, prompt('SECOND'));
    assert.equal(summaries, 1); assert.equal(inner.settled(s), false);
    assert.deepEqual(s.deliveries.map((entry: Internal) => entry.state), ['queued', 'queued']);
    finish('HANDOFF'); await Promise.all([first, second]);
    assert.equal(switches, 1);
    assert.equal(s.deliveries[0].value.content, 'HANDOFF\n\nFIRST');
    assert.equal(s.deliveries[1].value.content, 'SECOND');
    assert.equal(s.transitioning, false);
  } finally { finish?.('HANDOFF'); done(); }
});

test('a fallback summary completing after stop cannot replace the stopped process', async () => {
  const { inner, s, done } = fixture();
  let finish!: (note: string) => void;
  try {
    s.home = ''; s.runAccount = 'default';
    let switches = 0;
    inner.handoffNote = () => new Promise<string>(resolve => { finish = resolve; });
    inner.switchProcess = () => { switches++; };
    const returning = inner.goHome(s, prompt('PENDING_001'));
    inner.stop(s.id); finish('STALE_HANDOFF'); await returning;
    assert.equal(switches, 0); assert.equal(s.query, null);
    assert.equal(s.deliveries[0].state, 'queued');
  } finally { finish?.('HANDOFF'); done(); }
});

test('late context responses cannot mutate the replacement conversation', async () => {
  const { inner, s, done } = fixture();
  let finish!: (context: unknown) => void;
  try {
    const old = { context: () => new Promise(resolve => { finish = resolve; }) };
    s.query = old;
    const refreshing = inner.refreshContext(s, old);
    s.query = processStub(); s.metrics = null;
    finish({ tokens: 999, size: 1000, model: 'old-model' }); await refreshing;
    assert.equal(s.metrics, null);
  } finally { done(); }
});

test('queued deliveries keep every isolated worktree available for resumption', async () => {
  const { inner, s, done } = fixture();
  try {
    inner.pushUser(s, prompt('UNRECEIVED_001'));
    s.inbox.close(); s.inbox = null; s.query = null;
    s.tree = { path: '/SYNTHETIC_PRIMARY', state: 'active', kept: [] };
    s.extraTrees = [{ path: '/SYNTHETIC_SECONDARY', state: 'active', kept: [] }];
    const result = await inner.retire(s);
    assert.match(result, /accusé de réception/);
    assert.equal(s.tree.state, 'kept'); assert.equal(s.extraTrees[0].state, 'kept');
    assert.equal(s.deliveries[0].state, 'queued');
  } finally { done(); }
});
