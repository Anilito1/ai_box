import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Totals } from '../shared/costs';
import { loadConfig } from './config';
import type { CostLog } from './costLog';
import type { McpHub } from './mcpHub';
import { SessionManager } from './sessions';

test('Gemini detailed totals survive saving and restoring the hub state in an isolated fixture', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-provider-totals-'));
  const cfg = loadConfig(dir, 'en');
  const options = {
    cfg, dataDir: dir, executable: () => '', codexExecutable: () => '', geminiExecutable: () => '',
    mcpHub: {} as McpHub, sessionEnv: () => ({ set: {}, unset: [] }), persist() {}, costLog: {} as CostLog,
    capabilities: async () => '',
  };
  type Stored = { geminiUsage?: Totals };
  type Inner = { create(...args: unknown[]): Stored; sessions: Map<string, Stored> };
  const totals = { cost: .1, models: { 'gemini-2.5-pro': { cost: .1, input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 } } };
  const first = new SessionManager(options);
  let restored: SessionManager | undefined;
  try {
    const inner = first as unknown as Inner;
    inner.create('fixture', 'worker', 'fixture', '', dir, '', null).geminiUsage = totals;
    first.killAll();
    restored = new SessionManager(options);
    assert.deepEqual((restored as unknown as Inner).sessions.get('fixture')?.geminiUsage, totals);
  } finally {
    first.killAll();
    restored?.killAll();
    rmSync(dir, { recursive: true, force: true });
  }
});
