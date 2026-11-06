import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ChatItem, SessionView, TeamRole } from '../shared/types';
import { loadConfig } from './config';
import type { CostLog } from './costLog';
import type { McpHub } from './mcpHub';
import { SessionManager } from './sessions';

// What a session that cannot start says: the cause the user can fix, not the program's own guess.

const VENICE = 'a-ven00001';
const SPAWN_ENOENT =
  'Claude Code native binary at C:\\hub\\claude.exe exists but failed to launch. This usually means the binary does not match this system\'s libc. Specify a matching binary with options.pathToClaudeCodeExecutable.';

interface Inner {
  sessions: Map<string, { id: string; cwd: string }>;
  createRole(args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
  failed(s: unknown, failure: string, noProgram: boolean, harness: string): void;
  notifyMaster(shown: string, note: string): void;
}

async function hub() {
  const dir = mkdtempSync(join(tmpdir(), 'hub-launch-'));
  const work = join(dir, 'work');
  mkdirSync(work);
  const cfg = loadConfig(dir, 'en');
  cfg.workspaces = [work];
  cfg.accounts = [
    { id: VENICE, kind: 'openai', name: 'Venice', baseUrl: 'https://api.venice.ai/api/v1', model: 'venice-uncensored', smallModel: '', slug: 'venice', models: [], isolated: false },
  ];
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
  const told: string[] = [];
  inner.notifyMaster = (shown) => void told.push(shown);
  await inner.createRole({ name: 'venice', description: 'general tasks', folders: [work] }, new AbortController().signal);
  const role = cfg.team.find((r) => r.name === 'venice') as TeamRole;
  const s = inner.sessions.get(role.id) as { id: string; cwd: string };
  const view = () => m.snapshot().sessions.find((x) => x.id === s.id) as SessionView;
  const notices = () => (m.allItems().find(([id]) => id === s.id)?.[1] ?? []).filter((i): i is Extract<ChatItem, { kind: 'notice' }> => i.kind === 'notice');
  const crashed = new Promise<void>((resolve) => m.on('event', (id: string, kind: string) => id === s.id && kind === 'crashed' && resolve()));
  return { m, inner, s, role, work, told, view, notices, crashed, done: () => (m.killAll(), rmSync(dir, { recursive: true, force: true })) };
}

test('a worker whose folder was deleted says so, keeps the message and starts nothing', async () => {
  const { m, s, work, told, view, notices, crashed, done } = await hub();
  try {
    rmSync(work, { recursive: true, force: true });
    m.send(s.id, 'hello');
    await crashed;
    assert.equal(view().error, 'Working folder not found');
    const [notice] = notices();
    assert.match(notice.text, /working folder no longer exists/);
    assert.equal(notice.detail, work);
    assert.ok((m.allItems().find(([id]) => id === s.id)?.[1] ?? []).some((i) => i.kind === 'user'));
    assert.equal(told.length, 1);
    assert.equal(view().status, 'exited');
  } finally {
    done();
  }
});

test('Claude Code failing on another provider\'s account does not send the user to sign in to Anthropic', async () => {
  const { inner, s, role, notices, done } = await hub();
  try {
    role.account = VENICE;
    inner.failed(s, SPAWN_ENOENT, true, 'claude');
    const [notice] = notices();
    assert.match(notice.text, /Your Venice account is not the cause/);
    assert.doesNotMatch(notice.text, /Sign in to Anthropic/);
    assert.equal(notice.detail, SPAWN_ENOENT);
  } finally {
    done();
  }
});

test('Claude Code failing on an Anthropic account still points to the Anthropic sign-in', async () => {
  const { inner, s, notices, done } = await hub();
  try {
    inner.failed(s, SPAWN_ENOENT, true, 'claude');
    assert.match(notices()[0].text, /Sign in to Anthropic/);
  } finally {
    done();
  }
});
