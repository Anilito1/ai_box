// Sums up an A/B run of missions.mjs: per arm the mean and spread of cost, tokens, calls, time and success, the
// search's adoption, the paired difference with the baseline arm, and how many missions a full A/B would need.
//   node scripts/search-bench/tokens/pilot-report.mjs <out.jsonl> [baseline=current] [effect=0.10]
// effect: the relative cost change the full A/B must be able to detect (0.10 = 10 %), at 5 % risk and 80 % power.
import { readFileSync } from 'node:fs';

const [file, baseline = 'current', effectArg = '0.10'] = process.argv.slice(2);
const effect = Number(effectArg);
const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.error || r.costUsd);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
const sd = (xs) => (xs.length > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - mean(xs)) ** 2, 0) / (xs.length - 1)) : NaN);
const fmt = (xs, digits = 0) => `${mean(xs).toFixed(digits)} ± ${sd(xs).toFixed(digits)}`;
const metrics = {
  costUsd: (r) => r.costUsd,
  contextK: (r) => ((r.input ?? 0) + (r.cacheCreation ?? 0) + (r.cacheRead ?? 0)) / 1000,
  outputK: (r) => (r.output ?? 0) / 1000,
  calls: (r) => r.calls ?? NaN,
  turns: (r) => r.turns,
  minutes: (r) => (r.durationMs ?? r.wallMs) / 60_000,
};
const arms = [...new Set(rows.map((r) => r.arm))];
for (const arm of arms) {
  const rs = rows.filter((r) => r.arm === arm);
  const parts = Object.entries(metrics).map(([k, f]) => `${k} ${fmt(rs.map(f), k === 'costUsd' ? 3 : 1)}`);
  const judged = rs.filter((r) => r.success !== undefined);
  const adopted = rs.filter((r) => r.searchCalls > 0).length;
  console.log(`${arm.padEnd(10)} n=${rs.length}  ${parts.join('  ')}  success ${judged.filter((r) => r.success).length}/${judged.length}  search used ${adopted}/${rs.length} (${mean(rs.map((r) => r.searchCalls ?? 0)).toFixed(1)} calls)  first look ${JSON.stringify(Object.fromEntries([...new Set(rs.map((r) => r.firstLook))].map((f) => [f, rs.filter((r) => r.firstLook === f).length])))}`);
}

// Paired by mission (and run): the difference each arm makes on the same mission, relative to the baseline's cost.
const base = new Map(rows.filter((r) => r.arm === baseline).map((r) => [`${r.mission}#${r.run}`, r]));
const z = 1.96 + 0.8416;
for (const arm of arms.filter((a) => a !== baseline)) {
  const pairs = rows.filter((r) => r.arm === arm && base.has(`${r.mission}#${r.run}`)).map((r) => [r, base.get(`${r.mission}#${r.run}`)]);
  if (pairs.length < 2) continue;
  const rel = pairs.map(([r, b]) => (r.costUsd - b.costUsd) / b.costUsd);
  const s = sd(rel);
  // Missions needed per arm to see `effect` on the mean paired relative difference; unpaired needs about twice as many.
  const n = Math.ceil(((z * s) / effect) ** 2);
  const t = mean(rel) / (s / Math.sqrt(rel.length));
  console.log(`${arm} vs ${baseline}: cost ${(100 * mean(rel)).toFixed(1)} % ± ${(100 * s).toFixed(1)} (sd of ${pairs.length} paired differences, t=${t.toFixed(2)})  → ${n} paired missions per arm to detect ${Math.round(effect * 100)} %`);
}
