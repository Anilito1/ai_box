import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Metrics, TeamRole } from '../shared/types';
import { loadConfig } from './config';
import type { CostLog } from './costLog';
import type { McpHub } from './mcpHub';
import { Inbox } from './providers/inbox';
import { SessionManager } from './sessions';

// A permanent worker that worked writes its handoff note when it falls asleep; its next mission starts a fresh
// conversation with that note. Woken after its prompt cache expired, it starts afresh with a note the hub writes.

interface Fake {
  sessionId: string;
  started: boolean;
  status: string;
  background: string[];
  owesReport: boolean;
  activeAt: number;
  metrics: Metrics | null;
  note: string;
  noteFresh: boolean;
  handoff: boolean;
  query: unknown;
  inbox: Inbox<{ content: unknown }> | null;
}
interface Inner {
  sessions: Map<string, Fake>;
  createRole(args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
  setContext(s: Fake, tokens: number, size: number): void;
  sleep(s: Fake): boolean;
  askHandoff(s: Fake): boolean;
  onEvent(s: Fake, q: unknown, ev: unknown): void;
  closeIfDone(s: Fake, q: unknown): void;
  renewStale(s: Fake): void;
  messageWorker(args: { name: string; message: string }): Promise<string>;
}

const HOUR = 3_600_000;
const pending = () => new Promise<never>(() => undefined);

async function hub() {
  const dir = mkdtempSync(join(tmpdir(), 'hub-fresh-'));
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
    costLog: {} as CostLog,
    capabilities: async () => '',
  });
  const inner = m as unknown as Inner;
  await inner.createRole({ name: 'securite', description: 'security', folders: [work] }, new AbortController().signal);
  const role = cfg.team.find((r) => r.name === 'securite') as TeamRole;
  const s = inner.sessions.get(role.id) as Fake;
  // A conversation running without a program: what is delivered lands in its inbox.
  const run = (conversation: string, first: number, now: number) => {
    const q = { close: () => undefined, interrupt: async () => undefined, context: pending, totals: pending, rateLimits: pending };
    Object.assign(s, { sessionId: conversation, started: true, status: 'idle', owesReport: false, query: q, inbox: new Inbox() });
    inner.setContext(s, first, 1_000_000);
    inner.setContext(s, now, 1_000_000);
    return q;
  };
  const sent = () => ((s.inbox as unknown as { queue: { content: unknown }[] }).queue ?? []).map((m) => String(m.content));
  return { inner, s, run, sent, done: () => (m.killAll(), rmSync(dir, { recursive: true, force: true })) };
}

test('a mission past 20k tokens of work: note at sleep, the next mission in a fresh conversation with it', async () => {
  const { inner, s, run, sent, done } = await hub();
  try {
    const q = run('conv-1', 52_000, 90_000);
    assert.equal(inner.sleep(s), false, 'it writes its note before falling asleep');
    assert.match(sent().at(-1) ?? '', /Mission over: it writes its handoff note[\s\S]*Recent missions[\s\S]*Pending[\s\S]*40 lines at most/);
    const note = '## Recent missions\n- Fixed the CORS allowlist (commit abc123)';
    inner.onEvent(s, q, { type: 'turn', subtype: 'success', isError: false, result: note, queued: 0, contextWindows: [], usage: { cost: 0, models: {} } });
    assert.equal(s.note, note);
    s.activeAt = Date.now() - 10_000;
    inner.closeIfDone(s, q);
    assert.equal(s.query, null, 'asleep');
    assert.notEqual(s.sessionId, 'conv-1');
    assert.equal(s.started, false, 'its next launch is a new conversation');

    // The next mission: the hub launches it, here into an inbox, with the note.
    Object.assign(s, { inbox: new Inbox(), status: 'idle' });
    await inner.messageWorker({ name: 'hub-securite', message: 'Audit the webhooks' });
    const first = sent().at(-1) ?? '';
    assert.match(first, /Audit the webhooks/);
    assert.match(first, /<handoff-note>\n## Recent missions\n- Fixed the CORS allowlist/);
  } finally {
    done();
  }
});

test('a short mission (20k tokens of work or less) keeps its conversation', async () => {
  const { inner, s, run, done } = await hub();
  try {
    run('conv-1', 52_000, 72_000);
    assert.equal(inner.sleep(s), true);
    assert.equal(s.sessionId, 'conv-1');
    assert.equal(s.started, true);
  } finally {
    done();
  }
});

test('a worker at work or with background tasks is never asked for its note', async () => {
  const { inner, s, run, done } = await hub();
  try {
    run('conv-1', 52_000, 600_000);
    s.status = 'busy';
    assert.equal(inner.askHandoff(s), false);
    Object.assign(s, { status: 'idle', background: ['npm test'] });
    assert.equal(inner.askHandoff(s), false);
    assert.equal(s.handoff, false);
  } finally {
    done();
  }
});

test('woken after more than an hour, a worker that was not renewed starts afresh with a note the hub writes', async () => {
  const { inner, s, run, done } = await hub();
  try {
    run('conv-1', 52_000, 400_000);
    Object.assign(s, { query: null, inbox: null, status: 'exited', note: 'Earlier: the CORS allowlist', activeAt: Date.now() - HOUR / 2 });
    inner.renewStale(s);
    assert.equal(s.sessionId, 'conv-1', 'within the hour its cache still holds');
    s.activeAt = Date.now() - 2 * HOUR;
    inner.renewStale(s);
    assert.notEqual(s.sessionId, 'conv-1');
    assert.equal(s.started, false);
    assert.match(s.note, /asleep for over an hour[\s\S]*Your previous note:\nEarlier: the CORS allowlist/);
  } finally {
    done();
  }
});
