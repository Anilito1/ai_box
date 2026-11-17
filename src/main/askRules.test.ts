import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TeamRole } from '../shared/types';
import { loadConfig } from './config';
import type { CostLog } from './costLog';
import type { McpHub } from './mcpHub';
import { Inbox } from './providers/inbox';
import type { PermissionAnswer, PermissionRequest } from './providers/types';
import { SessionManager } from './sessions';

// A repo's permissions.ask rule (marketing-factory asks before `npx supabase functions deploy` and `gh api`) stops
// Claude Code even in bypassPermissions: every deploy of a worker waited for a card the user had chosen not to get.

interface Fake {
  status: string;
  mode: string | null;
  inbox: unknown;
  pending: Map<string, (d: { behavior: 'allow'; always: boolean } | null) => void>;
}
interface Inner {
  sessions: Map<string, Fake>;
  createRole(args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
  askPermission(s: Fake, req: PermissionRequest, inbox: unknown): Promise<PermissionAnswer>;
}

async function worker(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-askrule-'));
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
  t.after(() => (m.killAll(), rmSync(dir, { recursive: true, force: true })));
  const inner = m as unknown as Inner;
  await inner.createRole({ name: 'brain', description: 'brain', folders: [work] }, new AbortController().signal);
  const s = inner.sessions.get((cfg.team.find((r) => r.name === 'brain') as TeamRole).id) as Fake;
  const inbox = new Inbox();
  Object.assign(s, { started: true, status: 'busy', inbox });
  const ask = (byRule: boolean) =>
    inner.askPermission(s, { tool: 'Bash', input: { command: 'npx supabase functions deploy ai-eval' }, reason: '', canAlways: false, byRule, signal: new AbortController().signal }, inbox);
  return { s, ask };
}

test('in "Allow everything", a permissions.ask rule goes through without a card', async (t) => {
  const { s, ask } = await worker(t);
  s.mode = 'bypassPermissions';
  const answer = await Promise.race([ask(true), new Promise((r) => setTimeout(() => r('still waiting for the user'), 200))]);
  assert.deepEqual(answer, { behavior: 'allow', always: false });
  assert.equal(s.pending.size, 0);
  assert.equal(s.status, 'busy');
});

test('a safety check or a hook still asks in "Allow everything", and a rule still asks in another mode', async (t) => {
  const { s, ask } = await worker(t);
  s.mode = 'bypassPermissions';
  const check = ask(false);
  assert.equal(s.pending.size, 1);
  assert.equal(s.status, 'attention');
  [...s.pending.values()][0]({ behavior: 'allow', always: false });
  assert.deepEqual(await check, { behavior: 'allow', always: false });

  s.mode = 'default';
  void ask(true);
  assert.equal(s.pending.size, 1);
});
