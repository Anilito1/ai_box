import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ChatItem, TeamRole } from '../shared/types';
import { loadConfig } from './config';
import type { CostLog } from './costLog';
import type { McpHub } from './mcpHub';
import { SessionManager, type RemoteServerControl } from './sessions';

// "I'm stepping away" in the session manager: nothing of it shows or runs while remote workers are off; a post of this
// PC pauses with a trace in its conversation and the master's, and goes on when the user is back.

interface Fake {
  id: string;
  inbox: unknown;
  status: string;
  query: unknown;
  awayPaused: boolean;
}
interface Inner {
  sessions: Map<string, Fake>;
  createRole(args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
  notifyMaster(shown: string, note: string): void;
  deliver(s: Fake, prompt: { text: string; from?: string }): void;
}

async function hub(enabled: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-away-'));
  const work = join(dir, 'blender');
  mkdirSync(work);
  const cfg = loadConfig(dir, 'en');
  cfg.workspaces = [work];
  cfg.remoteWorkers = { ...cfg.remoteWorkers, enabled, host: '203.0.113.7', key: 'k' };
  let woken = 0;
  const server: RemoteServerControl = { wake: async () => (woken++, null), idle: () => undefined, state: () => '', secretsFor: async () => ({}) };
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
    remoteServer: server,
  });
  const inner = m as unknown as Inner;
  const told: string[] = [];
  const delivered: string[] = [];
  inner.notifyMaster = (shown, note) => void told.push(`${shown}\n${note}`);
  inner.deliver = (_s, prompt) => void delivered.push(prompt.text);
  await inner.createRole({ name: 'blender-3d', description: 'modèles Blender', folders: [work] }, new AbortController().signal);
  const role = cfg.team.find((r) => r.name === 'blender-3d') as TeamRole;
  const s = inner.sessions.get(role.id) as Fake;
  let interrupted = 0;
  // At work: a process, a turn under way.
  Object.assign(s, { inbox: { close: () => undefined }, status: 'busy', query: { interrupt: async () => void interrupted++ } });
  const notices = () => (m.allItems().find(([id]) => id === s.id)?.[1] ?? []).filter((i): i is Extract<ChatItem, { kind: 'notice' }> => i.kind === 'notice').map((n) => n.text);
  return { m, s, told, delivered, notices, interrupted: () => interrupted, woken: () => woken };
}

test('remote workers off: no button, no badge, and stepping away does nothing', async () => {
  const { m, s, told } = await hub(false);
  const snap = m.snapshot();
  assert.equal('away' in snap, false);
  assert.equal(snap.sessions.some((v) => 'remote' in v), false);
  await m.stepAway(false);
  assert.equal(m.awayPhase(), null);
  assert.equal(told.length, 0);
  assert.equal(s.awayPaused, false);
});

test('a post of this PC pauses while the user is away, says why, and goes on when they are back', async () => {
  const h = await hub(true);
  assert.deepEqual(h.m.snapshot().away, { phase: null, since: 0, auto: false, server: '', safe: false, onServer: 0 });
  await h.m.stepAway(false);
  assert.equal(h.m.awayPhase(), 'away');
  // Nothing could move: the server was not even switched on.
  assert.equal(h.woken(), 0);
  assert.equal(h.interrupted(), 1);
  assert.equal(h.s.awayPaused, true);
  assert.match(h.notices().join('\n'), /Paused while you are away: this post runs on this PC only/);
  assert.match(h.told.join('\n'), /The user is stepping away[\s\S]*blender-3d: paused/);
  assert.equal(h.m.snapshot().sessions.find((v) => v.id === h.s.id)?.remote?.state, 'paused');
  await h.m.comeBack();
  assert.equal(h.m.awayPhase(), null);
  assert.equal(h.s.awayPaused, false);
  assert.match(h.delivered.join('\n'), /take your mission up again/);
  assert.match(h.told.at(-1) ?? '', /is back[\s\S]*blender-3d: resumes on this PC/);
});
