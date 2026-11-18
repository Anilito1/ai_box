import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { MissionEvent } from '../shared/costs';
import type { TeamRole } from '../shared/types';
import { loadConfig } from './config';
import type { CostLog } from './costLog';
import type { McpHub } from './mcpHub';
import { Inbox } from './providers/inbox';
import { SessionManager } from './sessions';

// A delivery that failed goes back to its worker with retry: the hub moves it one step up by rule (effort, then the
// model), keeps what the user fixed, and writes the retry in the register of missions.

interface Fake {
  model: string;
  fixedModel: string;
  effort: string | null;
  fixedEffort: string | null;
  userModel: boolean;
}
interface Inner {
  sessions: Map<string, Fake>;
  createRole(args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
  messageWorker(args: { name: string; message: string; retry?: boolean; model?: string; effort?: string }): Promise<string>;
  create(id: string, role: string, name: string, mission: string, cwd: string, model: string, effort: string | null): Fake & { instanceOf: string | null };
}

async function hub() {
  const dir = mkdtempSync(join(tmpdir(), 'hub-retry-'));
  const work = join(dir, 'work');
  mkdirSync(work);
  const cfg = loadConfig(dir, 'en');
  cfg.workspaces = [work];
  cfg.workerModels = ['opus', 'sonnet', 'fable'];
  const events: MissionEvent[] = [];
  const m = new SessionManager({
    cfg,
    dataDir: dir,
    executable: () => '',
    codexExecutable: () => '',
    geminiExecutable: () => '',
    mcpHub: {} as McpHub,
    sessionEnv: () => ({ set: {}, unset: [] }),
    persist: () => undefined,
    costLog: { mission: (e: MissionEvent) => events.push(e) } as unknown as CostLog,
    capabilities: async () => '',
  });
  const inner = m as unknown as Inner;
  await inner.createRole({ name: 'dev', description: 'code', folders: [work] }, new AbortController().signal);
  const role = cfg.team.find((r) => r.name === 'dev') as TeamRole;
  const s = inner.sessions.get(role.id) as Fake;
  // A conversation at work on a mission, without a program: what is delivered lands in its inbox.
  const q = { close: () => undefined, interrupt: async () => undefined, setModel: async () => undefined, setEffort: async () => undefined, context: () => new Promise<never>(() => undefined) };
  Object.assign(s, { sessionId: 'conv-1', started: true, status: 'working', owesReport: true, query: q, inbox: new Inbox(), model: 'sonnet', fixedModel: 'sonnet', effort: 'medium', fixedEffort: 'medium' });
  return { inner, s, role, work, q, events, done: () => (m.killAll(), rmSync(dir, { recursive: true, force: true })) };
}

test('retry moves the worker one step up, effort then model, and the register keeps it', async () => {
  const { inner, s, events, done } = await hub();
  try {
    await inner.messageWorker({ name: 'hub-dev', message: 'Add the date filter' });
    assert.deepEqual([s.model, s.effort], ['sonnet', 'medium'], 'a plain follow-up changes nothing');

    const first = await inner.messageWorker({ name: 'hub-dev', message: 'Three tests are still red', retry: true });
    assert.deepEqual([s.model, s.effort], ['sonnet', 'high']);
    assert.match(first, /high/);

    await inner.messageWorker({ name: 'hub-dev', message: 'Still red', retry: true });
    assert.deepEqual([s.model, s.effort], ['opus', 'high']);

    await inner.messageWorker({ name: 'hub-dev', message: 'Still red', retry: true });
    assert.deepEqual([s.model, s.effort], ['fable', 'high'], 'Fable at the top of the ladder');

    const top = await inner.messageWorker({ name: 'hub-dev', message: 'Still red', retry: true });
    assert.deepEqual([s.model, s.effort], ['fable', 'high']);
    assert.match(top, /No step above/);

    // The first message opens the mission in the register; the four retries are follow-ups of it.
    assert.deepEqual(events.map((e) => [e.kind, e.retry ?? false]), [['start', false], ['follow', true], ['follow', true], ['follow', true], ['follow', true]]);
    assert.equal(new Set(events.map((e) => e.mission)).size, 1, 'one mission');
  } finally {
    done();
  }
});

test('retry leaves a model the user picked, and the master may still name its own choice', async () => {
  const { inner, s, done } = await hub();
  try {
    Object.assign(s, { effort: 'high', fixedEffort: 'high', userModel: true });
    const kept = await inner.messageWorker({ name: 'hub-dev', message: 'Still red', retry: true });
    assert.equal(s.model, 'sonnet');
    assert.match(kept, /sonnet/i);

    Object.assign(s, { userModel: false });
    await inner.messageWorker({ name: 'hub-dev', message: 'Still red', retry: true, model: 'fable' });
    assert.equal(s.model, 'fable', 'an explicit model wins over the rule');
  } finally {
    done();
  }
});

test('an instance of a post with a fixed model follows the grid, the post itself keeps it', async () => {
  const { inner, s, role, work, q, done } = await hub();
  try {
    Object.assign(role, { model: 'opus', effort: 'high' });
    Object.assign(s, { model: 'opus', fixedModel: 'opus', effort: 'high', fixedEffort: 'high' });
    const extra = inner.create('w-extra', 'worker', 'hub-dev-api', 'API', work, 'opus', 'high');
    Object.assign(extra, { instanceOf: role.id, sessionId: 'conv-2', started: true, status: 'working', owesReport: true, query: q, inbox: new Inbox() });

    await inner.messageWorker({ name: 'hub-dev-api', message: 'Routine change', model: 'sonnet', effort: 'medium' });
    assert.deepEqual([extra.model, extra.effort], ['sonnet', 'medium']);

    const kept = await inner.messageWorker({ name: 'hub-dev', message: 'Routine change', model: 'sonnet', effort: 'medium' });
    assert.deepEqual([s.model, s.effort], ['opus', 'high']);
    assert.match(kept, /fixed it for this post/);
  } finally {
    done();
  }
});
