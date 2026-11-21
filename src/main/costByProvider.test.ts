import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { summarize, type Totals, type TurnRecord } from '../shared/costs';
import type { Account } from '../shared/types';
import { loadConfig } from './config';
import { CostLog } from './costLog';
import type { McpHub } from './mcpHub';
import { PriceBook } from './providers/pricing';
import { SessionManager } from './sessions';
import type { VideoSpend } from './video/service';

// The hub's side of the cost by provider: what a session's turn or video spent goes to the log under the provider of
// the account it ran on, at that provider's prices. No program runs: the turns are handed to the manager as results.

const u = (cost: number, input = 0, output = 0, cacheRead = 0, cacheWrite = 0) => ({ cost, input, output, cacheRead, cacheWrite });
const account = (id: string, more: Partial<Account>): Account => ({ id, kind: 'openai', name: id, baseUrl: '', model: '', smallModel: '', slug: '', models: [], isolated: false, ...more });

interface Inner {
  create(id: string, role: string, name: string, mission: string, cwd: string, model: string, effort: null): { runAccount: string; metrics: { costUsd: number } | null };
  countTurn(s: unknown, totals: Totals): void;
  videoSpent(s: unknown, v: VideoSpend): void;
}

test('each turn and video is logged under the provider it ran at, at that provider’s prices', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-cost-provider-'));
  const cfg = loadConfig(dir, 'en');
  cfg.accounts = [
    account('a-ven00001', { name: 'Venice', baseUrl: 'https://api.venice.ai/api/v1', slug: 'venice', model: 'venice-uncensored', models: ['venice-uncensored', 'mystery-model'] }),
    account('a-dsk00001', { kind: 'anthropic-compatible', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic' }),
    account('a-own00001', { kind: 'anthropic-compatible', name: 'Mine', baseUrl: 'https://llm.example.org/anthropic' }),
  ];
  const log = new CostLog(dir);
  const prices = new PriceBook(join(dir, 'usage', 'prices.json'));
  prices.set('venice', { 'venice-uncensored': [0.5, 2] });
  const mgr = new SessionManager({
    cfg, dataDir: dir, executable: () => '', codexExecutable: () => '', geminiExecutable: () => '',
    mcpHub: {} as McpHub, sessionEnv: () => ({ set: {}, unset: [] }), persist() {}, costLog: log, prices,
    capabilities: async () => '',
  });
  const inner = mgr as unknown as Inner;
  const turn = async (id: string, accountId: string, totals: Totals) => {
    const s = inner.create(id, 'worker', `hub-${id}`, '', dir, '', null);
    s.runAccount = accountId;
    s.metrics = { contextTokens: 0, contextSize: 0, contextPct: null, costUsd: 0 } as never;
    inner.countTurn(s, totals);
    await new Promise((r) => setTimeout(r, 0));
    return s;
  };
  try {
    // Claude Code's figures, as it gives them: Anthropic's rates whatever the server.
    const ven = await turn('ven', 'a-ven00001', { cost: 7.5, models: { 'venice-uncensored': u(7.5, 1_000_000, 100_000), 'mystery-model': u(0.4, 50_000, 1000) } });
    await turn('ds', 'a-dsk00001', { cost: 6, models: { 'claude-opus-5-5': u(6, 1_000_000, 100_000) } });
    await turn('ant', 'default', { cost: 6, models: { 'claude-opus-5-5': u(6, 1_000_000, 100_000) } });
    await turn('own', 'a-own00001', { cost: 3, models: { 'claude-sonnet-5-5': u(3, 1_000_000, 100_000) } });
    inner.videoSpent(ven, { provider: 'venice', model: 'wan-2.5', usd: 0.085 });
    inner.videoSpent(ven, { provider: 'venice', model: 'kling-x', usd: null });

    const records = await log.read(0, Date.now() + 1);
    const by = (id: string) => records.filter((r) => r.id === id);
    const [venTurn, ...videos] = by('ven');
    assert.equal(venTurn.provider, 'venice');
    assert.equal(venTurn.models['venice-uncensored'].cost, 0.7, 'Venice’s price, not Claude Code’s $7.50');
    assert.deepEqual([venTurn.models['mystery-model'].cost, venTurn.unpriced], [0, ['mystery-model']]);
    assert.deepEqual(videos.map((v: TurnRecord) => [v.kind, v.provider, Object.keys(v.models)[0], v.models[Object.keys(v.models)[0]].cost, v.unpriced]), [
      ['video', 'venice', 'wan-2.5', 0.085, undefined],
      ['video', 'venice', 'kling-x', 0, ['kling-x']],
    ]);
    assert.equal(+ven.metrics!.costUsd.toFixed(3), 0.785, 'the session’s own cost: its turn and its priced video');

    const [ds] = by('ds');
    assert.equal(ds.provider, 'deepseek');
    assert.deepEqual(Object.keys(ds.models), ['deepseek-v4-pro']);
    assert.ok(ds.models['deepseek-v4-pro'].cost < 1.8, `DeepSeek’s price, not Opus’: ${ds.models['deepseek-v4-pro'].cost}`);

    const [ant] = by('ant');
    assert.deepEqual([ant.provider, ant.models['claude-opus-5-5'].cost], ['anthropic', 6], 'Anthropic: Claude Code’s own figure');

    // A server none of the blocks stands for: its address, and no price invented for it.
    const [own] = by('own');
    assert.deepEqual([own.provider, own.models['claude-sonnet-5-5'].cost, own.unpriced], ['llm.example.org', 0, ['claude-sonnet-5-5']]);

    // Today's figure in the status bar: the priced costs, and the turns with a part without a price.
    const today = log.today();
    assert.equal(+today.cost.toFixed(4), +summarize(records, { from: 0, to: Date.now() + 1 }).total.cost.toFixed(4));
    assert.equal(today.unpriced, 3);
  } finally {
    mgr.killAll();
    rmSync(dir, { recursive: true, force: true });
  }
});
