import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyPatch, loadConfig } from './config';
import type { CostLog } from './costLog';
import type { McpHub } from './mcpHub';
import { SessionManager } from './sessions';

// The master asked the user before starting a worker outside the working folders and followed repos (a dotfiles repo,
// its worktrees next to it): a user who wants the master to work anywhere had to say yes every time.

interface Fake {
  pending: Map<string, (d: { behavior: 'allow' | 'deny' } | null) => void>;
}
interface Inner {
  sessions: Map<string, Fake>;
  create(id: string, role: string, name: string, mission: string, cwd: string, model: string, effort: null): Fake;
  allowCwd(args: { name: string; mission: string; cwd: string }, signal: AbortSignal): Promise<string>;
  createRole(args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
  deleteAsked(name: string, signal: AbortSignal): Promise<string>;
}

/** The answer, or a mark that it still waits for the user. */
const soon = <T>(p: Promise<T>) => Promise.race([p, new Promise((r) => setTimeout(() => r('still waiting for the user'), 200))]);

function hub(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-allfolders-'));
  const work = join(dir, 'work');
  const outside = join(dir, 'dotfiles');
  const sibling = join(dir, 'dotfiles-focus');
  for (const d of [work, outside, sibling]) mkdirSync(d);
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
  const master = inner.create('master', 'master', 'master', '', work, '', null);
  const signal = new AbortController().signal;
  return { m, inner, cfg, master, outside, sibling, signal };
}

test('every folder allowed: the master starts a worker or gives a post a folder anywhere without a question', async (t) => {
  const { inner, cfg, master, outside, sibling, signal } = hub(t);
  assert.equal(cfg.allowAllFolders, false);
  cfg.allowAllFolders = true;
  assert.equal(await soon(inner.allowCwd({ name: 'audit-interface', mission: 'x', cwd: sibling }, signal)), '');
  assert.match(String(await soon(inner.createRole({ name: 'dotfiles', description: 'dotfiles', folders: [outside] }, signal))), /dotfiles/);
  assert.ok(cfg.team.some((r) => r.name === 'dotfiles'));
  assert.equal(master.pending.size, 0);
  // Still checked: a folder that does not exist starts nothing.
  await assert.rejects(inner.allowCwd({ name: 'x', mission: 'x', cwd: join(outside, 'missing') }, signal));
});

test('allowing every folder answers yes to the folder questions still waiting, never to a deletion', async (t) => {
  const { m, inner, cfg, master, outside, signal } = hub(t);
  await inner.createRole({ name: 'brain', description: 'brain', folders: [cfg.workspaces[0]] }, signal);
  const asked = inner.allowCwd({ name: 'audit-interface', mission: 'x', cwd: outside }, signal);
  const deletion = inner.deleteAsked('brain', signal);
  assert.equal(master.pending.size, 2);

  cfg.allowAllFolders = true;
  m.allowAskedFolders();
  assert.equal(await asked, '');
  assert.equal(master.pending.size, 1);
  // The deletion keeps its question: the user still answers it.
  [...master.pending.values()][0]({ behavior: 'deny' });
  assert.match(await deletion, /brain/);
  assert.ok(cfg.team.some((r) => r.name === 'brain'));
});

test('the setting is off by default, saved with the settings and read back', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-allfolders-cfg-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = loadConfig(dir, 'en');
  assert.equal(cfg.allowAllFolders, false);
  assert.equal(applyPatch(cfg, { allowAllFolders: true }), null);
  assert.equal(cfg.allowAllFolders, true);
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ version: 2, allowAllFolders: true }));
  assert.equal(loadConfig(dir, 'en').allowAllFolders, true);
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ version: 2, allowAllFolders: 'yes' }));
  assert.equal(loadConfig(dir, 'en').allowAllFolders, false);
});
