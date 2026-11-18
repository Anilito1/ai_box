// The hub's own register of missions (usage/missions-*.jsonl and turns-*.jsonl in the app's data folder), by model and
// by who chose it: cost with subagents, follow-ups, retries after a failed delivery, tool errors, length. This is the
// production reading of the routing policy: a level whose missions are often retried is routed too low.
//
//   node scripts/routing-study/registry.mjs [--since 2026-11-17] [--dir <usage folder>]
import fs from 'node:fs';
import path from 'node:path';
import { table } from '../cache-study/common.mjs';

const arg = (name, d) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : d);
const dir = arg('dir', path.join(process.env.APPDATA ?? '', 'claude-hub', 'usage'));
const since = Date.parse(arg('since', '2026-11-01'));
const lines = (re) => fs.readdirSync(dir).filter((f) => re.test(f)).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean)).flatMap((l) => {
  try {
    return [JSON.parse(l)];
  } catch {
    return [];
  }
});

const rows = new Map();
for (const e of lines(/^missions-.*\.jsonl$/).sort((a, b) => a.t - b.t)) {
  if (e.t < since) continue;
  const r = rows.get(e.mi) ?? { model: e.m, effort: e.e, by: e.by, cost: 0, ms: 0, tools: 0, errors: 0, follows: 0, retries: 0, turns: 0 };
  if (e.k === 'follow') r.follows++;
  if (e.rt) r.retries++;
  rows.set(e.mi, r);
}
for (const t of lines(/^turns-.*\.jsonl$/)) {
  const r = t.mi ? rows.get(t.mi) : undefined;
  if (!r) continue;
  r.cost += Object.values(t.m).reduce((s, u) => s + u[0], 0);
  r.ms += t.d ?? 0;
  r.tools += t.k ?? 0;
  r.errors += t.x ?? 0;
  r.turns++;
}
const done = [...rows.values()].filter((r) => r.turns > 0);
const family = (m) => ['fable', 'opus', 'sonnet', 'haiku'].find((f) => String(m).toLowerCase().includes(f)) ?? (m || '?');
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const by = (key) => {
  const g = new Map();
  for (const r of done) g.set(key(r), [...(g.get(key(r)) ?? []), r]);
  return [...g.entries()].sort((a, b) => sum(b[1], (r) => r.cost) - sum(a[1], (r) => r.cost)).map(([k, a]) => [
    k, a.length, sum(a, (r) => r.cost).toFixed(0), median(a.map((r) => r.cost)).toFixed(2), Math.round(median(a.map((r) => r.ms)) / 6e4),
    (sum(a, (r) => r.follows) / a.length).toFixed(2), `${Math.round((100 * a.filter((r) => r.retries > 0).length) / a.length)}%`, `${Math.round((100 * sum(a, (r) => r.errors)) / Math.max(1, sum(a, (r) => r.tools)))}%`,
  ]);
};
const HEAD = ['', 'missions', '$', 'median $', 'median min', 'follow-ups', 'retried', 'tool errors'];
console.log(`${done.length} missions with turns since ${new Date(since).toISOString().slice(0, 10)}, $${sum(done, (r) => r.cost).toFixed(0)}\n`);
console.log(table(by((r) => `${family(r.model)} · ${r.effort || '?'}`), HEAD));
console.log(`\nBy who chose the model`);
console.log(table(by((r) => `${r.by} · ${family(r.model)}`), HEAD));
