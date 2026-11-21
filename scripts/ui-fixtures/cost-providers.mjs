// Made-up spending at four providers, dated today (the cost panel reads the log by day): a data folder for
// `npm run ui -- --data <folder>`, or for a test instance of the app. No key, no call to any provider: the Venice
// account points at a closed local port, the others have no key, so nothing is checked over the network.
//
//   node scripts/ui-fixtures/cost-providers.mjs            → a new hub-ui-… folder in the temporary folder, printed
//   node scripts/ui-fixtures/cost-providers.mjs <folder>   → that folder (made if needed; its usage log is replaced)
//
// Today: Anthropic ≈ $100 (one turn logged before the provider was kept), OpenAI ≈ $14, Venice ≈ $2 with a model and a
// video without a known price, DeepSeek ≈ $1.4; a few earlier days for the other periods.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dir = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(join(tmpdir(), 'hub-ui-'));
const usage = join(dir, 'usage');
rmSync(usage, { recursive: true, force: true });
mkdirSync(usage, { recursive: true });

const now = Date.now();
const MIN = 60_000;
const DAY = 86_400_000;
const shop = 'A:\\DEV\\demo-boutique';
const api = 'A:\\DEV\\demo-api';

writeFileSync(
  join(dir, 'config.json'),
  JSON.stringify({
    onboarded: true,
    language: 'fr',
    updates: 'ask',
    masterCwd: dir,
    accounts: [
      { id: 'a-venice01', kind: 'openai', name: 'Venice', baseUrl: 'http://127.0.0.1:9/api/v1', slug: 'venice', models: ['venice-uncensored', 'llama-4-maverick-xl'], isolated: false },
      { id: 'a-dseek001', kind: 'anthropic-compatible', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic', model: '', smallModel: '', slug: '', models: [], isolated: false },
      { id: 'a-oaiapi01', kind: 'openai', name: 'OpenAI (API)', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6.1-sol', smallModel: 'gpt-6-luna', slug: '', models: [], isolated: false },
    ],
  }),
);
writeFileSync(join(usage, 'since.json'), JSON.stringify({ since: now - 45 * DAY }));

/** One line of the turn log, as encodeRecord() writes it: m = { model: [cost, input, output, cacheRead, cacheWrite] }. */
const turn = (ago, id, name, role, m, more = {}) => ({ t: now - ago, id, n: name, r: role, m, ...more });
const master = (ago, m, more) => turn(ago, 'master', 'hub-maitre', 'master', m, { w: shop, ...more });
const lines = [
  // Logged before the provider was kept: read as Anthropic's from its model's name.
  master(300 * MIN, { 'claude-opus-5-5': [38.2, 120_000, 41_000, 9_800_000, 600_000] }),
  master(120 * MIN, { 'claude-opus-5-5': [42.6, 140_000, 52_000, 11_200_000, 520_000] }, { p: 'anthropic' }),
  turn(90 * MIN, 'w-front', 'hub-front', 'worker', { 'claude-sonnet-5-5': [19.4, 300_000, 90_000, 14_000_000, 900_000] }, { w: shop, p: 'anthropic', mi: 'm-front', e: 'high', d: 25 * MIN, k: 48 }),
  turn(88 * MIN, 'w-front', 'hub-front', 'worker', { 'claude-haiku-4-5': [0.12, 40_000, 3000, 0, 0] }, { w: shop, p: 'anthropic', mi: 'm-front', kd: 'explore' }),
  turn(80 * MIN, 'w-api', 'hub-api', 'worker', { 'gpt-6.1-sol': [13.1, 2_600_000, 590_000, 3_000_000, 0], 'gpt-6-luna': [0.8, 3_000_000, 900_000, 0, 0] }, { w: api, p: 'openai', mi: 'm-api', e: 'high', d: 31 * MIN, k: 62 }),
  turn(70 * MIN, 'w-trad', 'hub-traduction', 'worker', { 'venice-uncensored': [1.62, 2_100_000, 285_000, 0, 0] }, { w: shop, p: 'venice', mi: 'm-trad', e: 'medium', d: 12 * MIN, k: 9 }),
  // A model whose price Venice's list does not give: its tokens, no cost.
  turn(65 * MIN, 'w-trad', 'hub-traduction', 'worker', { 'llama-4-maverick-xl': [0, 850_000, 120_000, 0, 0] }, { w: shop, p: 'venice', up: ['llama-4-maverick-xl'], mi: 'm-trad' }),
  // Two videos: one at the price Venice quoted, one it gave no price for.
  turn(60 * MIN, 'w-trad', 'hub-traduction', 'worker', { 'wan-2.5-preview-text-to-video': [0.425, 0, 0, 0, 0] }, { w: shop, p: 'venice', mi: 'm-trad', kd: 'video' }),
  turn(55 * MIN, 'w-trad', 'hub-traduction', 'worker', { 'kling-2.6-pro-text-to-video': [0, 0, 0, 0, 0] }, { w: shop, p: 'venice', up: ['kling-2.6-pro-text-to-video'], mi: 'm-trad', kd: 'video' }),
  turn(40 * MIN, 'w-tests', 'hub-tests', 'worker', { 'deepseek-v4-pro': [1.21, 820_000, 160_000, 2_400_000, 0], 'deepseek-flash': [0.18, 400_000, 50_000, 0, 0] }, { w: api, p: 'deepseek', mi: 'm-tests', e: 'high', d: 18 * MIN, k: 33 }),
  // Earlier days, for 7 days, 30 days and this month.
  master(DAY + 60 * MIN, { 'claude-opus-5-5': [64.3, 200_000, 70_000, 15_000_000, 800_000] }, { p: 'anthropic' }),
  turn(DAY + 30 * MIN, 'w-api', 'hub-api', 'worker', { 'gpt-6.1-sol': [8.4, 1_900_000, 400_000, 0, 0] }, { w: api, p: 'openai' }),
  turn(3 * DAY, 'w-trad', 'hub-traduction', 'worker', { 'venice-uncensored': [0.94, 1_300_000, 140_000, 0, 0] }, { w: shop, p: 'venice' }),
  turn(3 * DAY + 10 * MIN, 'w-tests', 'hub-tests', 'worker', { 'deepseek-flash': [0.32, 1_100_000, 90_000, 600_000, 0] }, { w: api, p: 'deepseek' }),
  turn(12 * DAY, 'w-front', 'hub-front', 'worker', { 'claude-sonnet-5-5': [27.5, 400_000, 120_000, 20_000_000, 1_000_000] }, { w: shop, p: 'anthropic' }),
];
const missions = [
  { t: now - 95 * MIN, mi: 'm-front', id: 'w-front', n: 'hub-front', k: 'start', m: 'sonnet', e: 'high', by: 'master' },
  { t: now - 85 * MIN, mi: 'm-api', id: 'w-api', n: 'hub-api', k: 'start', m: 'gpt-6.1-sol', e: 'high', by: 'master' },
  { t: now - 75 * MIN, mi: 'm-trad', id: 'w-trad', n: 'hub-traduction', k: 'start', m: 'venice-uncensored', e: 'medium', by: 'user' },
  { t: now - 45 * MIN, mi: 'm-tests', id: 'w-tests', n: 'hub-tests', k: 'start', m: 'deepseek-v4-pro', e: 'high', by: 'master' },
];

/** The month file (UTC) of a line, as the log names them. */
const month = (at, kind) => {
  const d = new Date(at);
  return `${kind}-${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}.jsonl`;
};
const write = (kind, rows) => {
  const files = new Map();
  for (const r of [...rows].sort((a, b) => a.t - b.t)) files.set(month(r.t, kind), `${files.get(month(r.t, kind)) ?? ''}${JSON.stringify(r)}\n`);
  for (const [name, text] of files) writeFileSync(join(usage, name), text);
};
write('turns', lines);
write('missions', missions);
// The prices Venice's list gave (USD per million tokens): what its next turns would be priced with.
writeFileSync(join(usage, 'prices.json'), JSON.stringify({ venice: { 'venice-uncensored': [0.5, 2] } }));
console.log(dir);
