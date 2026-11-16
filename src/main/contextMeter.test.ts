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

// The context meter's window is the one the runtime reports for the model that runs, never a fixed figure.

interface Fake {
  runAccount: string;
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
  applyModel(s: Fake, model: string): void;
  sleep(s: Fake): boolean;
  askHandoff(s: Fake): boolean;
  onEvent(s: Fake, q: unknown, ev: unknown): void;
  closeIfDone(s: Fake, q: unknown): void;
  renewStale(s: Fake): void;
  messageWorker(args: { name: string; message: string }): Promise<string>;
}

async function hub() {
  const dir = mkdtempSync(join(tmpdir(), 'hub-ctx-'));
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
  return { inner, s, cfg, done: () => (m.killAll(), rmSync(dir, { recursive: true, force: true })) };
}

const turn = (contextWindows: Record<string, number>) => ({ type: 'turn', subtype: 'success', isError: false, result: '', queued: 0, contextWindows, usage: { cost: 0, models: {} } });

test('the window is the runtime\'s: 47k of a 1M model is 5 %, and a subagent\'s larger window never wins', async () => {
  const { inner, s, done } = await hub();
  try {
    inner.applyModel(s, 'claude-fable-5-2');
    inner.setContext(s, 47_315, 0);
    assert.equal(s.metrics?.contextPct, null, 'before any report: unknown, not a default');
    inner.onEvent(s, {}, turn({ 'claude-fable-5-2': 1_000_000 }));
    assert.equal(Math.round(s.metrics?.contextPct ?? 0), 5);
    inner.onEvent(s, {}, turn({ 'claude-fable-5-2': 200_000, 'claude-sonnet-5-5': 1_000_000 }));
    assert.equal(s.metrics?.contextSize, 200_000, 'the session\'s own model, not the largest');
  } finally {
    done();
  }
});

test('a model switch drops the previous window; a model heard of before gets its own at once', async () => {
  const { inner, s, done } = await hub();
  try {
    inner.applyModel(s, 'claude-fable-5-2');
    inner.onEvent(s, {}, turn({ 'claude-fable-5-2': 1_000_000, 'claude-sonnet-5-5[1m]': 1_000_000 }));
    inner.setContext(s, 100_000, 0);
    inner.applyModel(s, 'claude-opus-4-1');
    assert.equal(s.metrics?.contextPct, null, 'new model, no report yet');
    inner.applyModel(s, 'claude-sonnet-5-5[1m]');
    assert.equal(s.metrics?.contextSize, 1_000_000);
    assert.equal(s.metrics?.contextPct, 10);
  } finally {
    done();
  }
});

test('Claude Code on another provider\'s model: the window is an estimate, said so', async () => {
  const { inner, s, cfg, done } = await hub();
  try {
    cfg.accounts.push({ id: 'ds', kind: 'anthropic-compatible', baseUrl: 'https://api.deepseek.com/anthropic', model: '' } as never);
    inner.applyModel(s, 'claude-sonnet-5-5');
    inner.setContext(s, 10_000, 200_000);
    assert.equal(s.metrics?.estimated, undefined);
    s.runAccount = 'ds';
    inner.setContext(s, 10_000, 200_000);
    assert.equal(s.metrics?.estimated, true);
  } finally {
    done();
  }
});
