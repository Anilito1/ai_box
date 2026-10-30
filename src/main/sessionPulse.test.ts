import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { pulseState } from '../shared/pulse';
import type { SessionView, TeamRole } from '../shared/types';
import { loadConfig } from './config';
import type { CostLog } from './costLog';
import type { McpHub } from './mcpHub';
import { translate } from './providers/claude/events';
import { Inbox } from './providers/inbox';
import { SessionManager } from './sessions';

// What the working line reads, from the events of a process to the view the windows get.

interface Fake {
  id: string;
  status: string;
  query: unknown;
  inbox: unknown;
  started: boolean;
  closeWhenDone: boolean;
  owesReport: boolean;
  activeAt: number;
  runAccount: string;
  signalAt: number | null;
  limit: { resetsAt: number | null } | null;
  retrying: boolean;
  agents: number;
  pending: Map<string, (d: { behavior: 'allow'; always: boolean } | null) => void>;
  tools: Map<string, unknown>;
}
interface Inner {
  sessions: Map<string, Fake>;
  createRole(args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
  onEvent(s: Fake, q: unknown, ev: unknown): void;
  consume(s: Fake, q: unknown, isMissing: () => boolean, adapter: unknown): Promise<void>;
  askPermission(s: Fake, req: unknown, inbox: unknown): Promise<unknown>;
  pushUser(s: Fake, prompt: unknown): void;
}

const pending = () => new Promise<never>(() => undefined);
const fakeProcess = (events?: AsyncGenerator<unknown>) => ({ events, close: () => undefined, interrupt: async () => undefined, context: pending, totals: pending, rateLimits: pending });

async function hub() {
  const dir = mkdtempSync(join(tmpdir(), 'hub-pulse-'));
  const work = join(dir, 'work');
  mkdirSync(work);
  const cfg = loadConfig(dir, 'en');
  cfg.workspaces = [work];
  const m = new SessionManager({
    cfg,
    dataDir: dir,
    executable: () => '',
    codexExecutable: () => '',
    geminiExecutable: () => '',
    mcpHub: {} as McpHub,
    sessionEnv: () => ({ set: {}, unset: [] }),
    persist: () => undefined,
    costLog: { today: () => 0 } as unknown as CostLog,
    capabilities: async () => '',
  });
  const inner = m as unknown as Inner;
  await inner.createRole({ name: 'securite', description: 'security', folders: [work] }, new AbortController().signal);
  const role = cfg.team.find((r) => r.name === 'securite') as TeamRole;
  const s = inner.sessions.get(role.id) as Fake;
  const q = fakeProcess();
  Object.assign(s, { sessionId: 'conv', started: true, status: 'idle', owesReport: false, query: q, inbox: new Inbox() });
  const feed = (...evs: unknown[]) => evs.forEach((ev) => inner.onEvent(s, q, ev));
  const frame = (msg: unknown) => feed(...translate(msg as SDKMessage));
  const view = () => m.snapshot().sessions.find((x) => x.id === s.id) as SessionView;
  return { inner, s, q, cfg, feed, frame, view, done: () => (m.killAll(), rmSync(dir, { recursive: true, force: true })) };
}

const toolUse = (id: string, name = 'Agent') => ({ type: 'assistant', id: `reply-${id}`, blocks: [{ type: 'tool_use', id, name, input: {} }], error: '', contextTokens: 0 });
const started = { type: 'stream', textStart: false, delta: '' };
const turnEnd = { type: 'turn', subtype: 'success', isError: false, result: 'done', queued: 0, contextWindows: [], usage: { cost: 0, models: {} } };
const refused = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1_900_000_000, rateLimitType: 'five_hour' } };
const heartbeat = { type: 'tool_progress', heartbeat: true, tool_use_id: 't1', tool_name: 'Agent', parent_tool_use_id: null, elapsed_time_seconds: 30 };

test('a subagent stopped by a limit stays shown as stopped: only a frame of its own says it went on', async () => {
  const { s, feed, frame, done } = await hub();
  try {
    feed(started, toolUse('t1'));
    frame(refused);
    assert.ok(s.limit && s.retrying);
    frame(heartbeat);
    frame({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } });
    frame({ type: 'system', subtype: 'task_updated', task_id: 'x', patch: { status: 'running' } });
    frame({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 9, estimated_tokens_delta: 9 });
    frame({ type: 'user', parent_tool_use_id: 't1', message: { content: [] } });
    frame({ type: 'assistant', parent_tool_use_id: 't1', error: 'rate_limit', message: { content: [] } });
    assert.ok(s.limit, 'nothing here is an answer of the model');
    assert.ok(s.retrying);
    frame({ type: 'stream_event', parent_tool_use_id: 't1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } });
    assert.equal(s.limit, null);
    assert.equal(s.retrying, false);
  } finally {
    done();
  }
});

test('a background subagent going on ends its own limit too', async () => {
  const { s, feed, frame, done } = await hub();
  try {
    feed(started, { type: 'agentTask', id: 'bg', state: 'start' });
    frame(refused);
    assert.ok(s.limit);
    frame({ type: 'assistant', parent_tool_use_id: 'x', uuid: 'u', message: { content: [] } });
    assert.equal(s.limit, null);
  } finally {
    done();
  }
});

test('a process that was replaced asks nothing of the session', async () => {
  const { inner, s, done } = await hub();
  try {
    Object.assign(s, { status: 'exited', query: null, inbox: null });
    const answer = await inner.askPermission(s, { tool: 'Bash', input: {}, reason: '', canAlways: false, signal: new AbortController().signal }, new Inbox());
    assert.equal((answer as { behavior: string }).behavior, 'deny');
    assert.equal(s.status, 'exited');
    assert.equal(s.pending.size, 0);
  } finally {
    done();
  }
});

test('a replaced process leaves no ghost: what it still says is dropped', async () => {
  const { inner, s, q, done } = await hub();
  try {
    const old = fakeProcess(
      (async function* () {
        yield toolUse('ghost', 'Bash');
        yield { type: 'limit', signal: { kind: 'rate', resetsAt: null, source: 'test' } };
        yield started;
      })(),
    );
    assert.notEqual(s.query, old);
    await inner.consume(s, old, () => false, {});
    assert.equal(s.tools.size, 0);
    assert.equal(s.limit, null);
    assert.equal(s.status, 'idle');
    assert.equal(s.query, q, 'the session runs on');
  } finally {
    done();
  }
});

test('a stopped session is not brought back to busy by what its process still says', async () => {
  const { inner, s, done } = await hub();
  try {
    const old = fakeProcess(
      (async function* () {
        yield started;
      })(),
    );
    Object.assign(s, { status: 'exited', query: null, inbox: null });
    await inner.consume(s, old, () => false, {});
    assert.equal(s.status, 'exited');
  } finally {
    done();
  }
});

test('a turn the process starts by itself opens on a signal, not on a silence', async () => {
  const { s, feed, view, done } = await hub();
  try {
    // The adapter stamps the frame as it reads it; the manager gets it a moment later.
    s.signalAt = Date.now() - 3;
    feed(started);
    const state = pulseState(view(), Date.now() + 2000);
    assert.equal(state?.silent, false);
  } finally {
    done();
  }
});

test('a prompt the process has not answered is a silence, not a signal', async () => {
  const { inner, s, view, done } = await hub();
  try {
    inner.pushUser(s, { text: 'hello', images: [], from: 'user' });
    assert.equal(s.status, 'busy');
    const state = pulseState(view(), Date.now() + 2000);
    assert.equal(state?.silent, true);
  } finally {
    done();
  }
});

test('hidden thinking counts for the turn only when nothing else can be thinking', async () => {
  const { feed, frame, view, done } = await hub();
  const thinking = { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 100, estimated_tokens_delta: 100 };
  try {
    feed(started);
    frame(thinking);
    assert.equal(view().pulse.tokens, 100);
    feed({ type: 'agentTask', id: 'bg', state: 'start' });
    frame(thinking);
    assert.equal(view().pulse.tokens, 100, 'a background subagent thinks on its own account');
    feed({ type: 'agentTask', id: 'bg', state: 'done' }, toolUse('t1'));
    frame(thinking);
    assert.equal(view().pulse.tokens, 100, 'as does the subagent of a tool');
  } finally {
    done();
  }
});

test('what the stream gives of the reply itself counts, even with a first tool of that reply running', async () => {
  const { feed, frame, view, done } = await hub();
  try {
    feed(started, toolUse('t1', 'Read'));
    frame({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: 'x'.repeat(400) } } });
    assert.equal(view().pulse.tokens, 100);
  } finally {
    done();
  }
});

test('a session on an account whose model may think in silence is not called stuck', async () => {
  const { s, cfg, feed, view, done } = await hub();
  try {
    feed(started);
    assert.equal(pulseState(view(), Date.now() + 200_000)?.tone, 'stuck');
    cfg.accounts.push({ id: 'a-codex001', kind: 'codex', name: 'ChatGPT', baseUrl: '', model: '', smallModel: '', slug: '', models: [], isolated: false });
    s.runAccount = 'a-codex001';
    assert.equal(pulseState(view(), Date.now() + 200_000)?.tone, 'slow');
  } finally {
    done();
  }
});

async function approvalAfterTurn(t: TestContext, setup: (s: Fake) => void, check: (s: Fake) => void) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const { inner, s, feed, done } = await hub();
  try {
    setup(s);
    feed(started);
    void inner.askPermission(s, { tool: 'Bash', input: { command: 'ls' }, reason: '', canAlways: false, signal: new AbortController().signal }, s.inbox);
    assert.equal(s.status, 'attention');
    feed(turnEnd);
    assert.equal(s.status, 'attention', 'a background subagent still waits for its approval');
    t.mock.timers.tick(6_000);
    for (const finish of s.pending.values()) finish({ behavior: 'allow', always: false });
    assert.equal(s.status, 'idle');
    t.mock.timers.tick(6_000);
    t.mock.timers.tick(6_000);
    check(s);
  } finally {
    done();
    t.mock.timers.reset();
  }
}

test('a session held open by an approval after its turn goes on to close once it is answered', async (t) => {
  await approvalAfterTurn(
    t,
    (s) => (s.closeWhenDone = true),
    (s) => assert.equal(s.query, null, 'closed'),
  );
});

test('a worker held by an approval after its turn is still asked for its report', async (t) => {
  await approvalAfterTurn(
    t,
    (s) => (s.owesReport = true),
    (s) => assert.equal(s.owesReport, false, 'chased'),
  );
});

test('a worker whose background tasks held its report back is asked for it when they end', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const { s, feed, done } = await hub();
  try {
    s.owesReport = true;
    feed(started, { type: 'background', tasks: ['a long build'] }, turnEnd);
    t.mock.timers.tick(6_000);
    assert.equal(s.owesReport, true, 'it still works');
    feed({ type: 'background', tasks: [] });
    t.mock.timers.tick(6_000);
    t.mock.timers.tick(6_000);
    assert.equal(s.owesReport, false);
  } finally {
    done();
    t.mock.timers.reset();
  }
});
