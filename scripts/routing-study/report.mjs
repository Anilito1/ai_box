// Aggregates of the dataset written by load.mjs: what missions cost by model, how they went, what the master asked
// for, and where the money is. Prints tables only.
//
//   node scripts/routing-study/report.mjs [--data <file>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { table } from '../cache-study/common.mjs';

const i = process.argv.indexOf('--data');
const file = i > 0 ? process.argv[i + 1] : path.join(process.env.AIBOX_SCRATCH_DIR ?? os.tmpdir(), 'routing-study', 'missions.json');
const { since, until, missions, delegations, masters } = JSON.parse(fs.readFileSync(file, 'utf8'));

const q = (a, p) => {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const mean = (a, f) => (a.length ? sum(a, f) / a.length : 0);
const usd = (n) => n.toFixed(n < 10 ? 2 : 0);
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-');
const family = (m) => /fable/.test(m) ? 'fable' : /opus/.test(m) ? 'opus' : /sonnet/.test(m) ? 'sonnet' : /haiku/.test(m) ? 'haiku' : 'other';
const group = (a, key) => {
  const g = new Map();
  for (const x of a) g.set(key(x), [...(g.get(key(x)) ?? []), x]);
  return [...g.entries()].sort((x, y) => sum(y[1], (m) => m.total ?? 0) - sum(x[1], (m) => m.total ?? 0));
};
const tools = (m) => Object.values(m.tools).reduce((s, n) => s + n, 0);
const hours = (m) => m.activeMs / 3.6e6;

const days = (until - since) / 864e5;
const total = sum(missions, (m) => m.total);
const masterCost = sum(masters, (m) => m.cost);
console.log(`Window: ${days} days. ${missions.length} missions, $${usd(total)} (subagents $${usd(sum(missions, (m) => m.subCost))}); master $${usd(masterCost)} = ${pct(masterCost, masterCost + total)} of the hub's spend.\n`);

const row = (label, a) => [
  label, a.length, usd(sum(a, (m) => m.total)), pct(sum(a, (m) => m.total), total), usd(q(a.map((m) => m.total), 0.5)), usd(q(a.map((m) => m.total), 0.9)),
  Math.round(q(a.map((m) => m.activeMs / 6e4), 0.5)), mean(a, (m) => m.follows).toFixed(2), mean(a, (m) => m.corrective).toFixed(2),
  pct(sum(a, (m) => m.toolErrors), sum(a, tools)), Math.round(q(a.map(tools), 0.5)), Math.round(q(a.map((m) => m.out), 0.5) / 1e3),
];
const HEAD = ['', 'n', '$', 'share', 'med $', 'p90 $', 'med min', 'follows', 'corrective', 'tool err', 'med tools', 'med out K'];

console.log('By model · effort');
console.log(table(group(missions, (m) => `${family(m.model)} · ${m.effort || '?'}`).map(([k, a]) => row(k, a)), HEAD));

console.log('\nBy length of work (active time)');
const band = (m) => (hours(m) < 0.25 ? '1 <15 min' : hours(m) < 0.5 ? '2 15-30 min' : hours(m) < 2 ? '3 30 min-2 h' : '4 >2 h');
console.log(table(group(missions, band).sort((a, b) => a[0].localeCompare(b[0])).map(([k, a]) => row(k, a)), HEAD));

console.log('\nBy kind of brief (flags matched on its words; a brief can be in several)');
const KINDS = { 'analysis, no code word': (m) => m.flags.analysis && !m.flags.code, 'analysis': (m) => m.flags.analysis, 'read-only': (m) => m.flags.readOnly, 'security': (m) => m.flags.security, 'prod': (m) => m.flags.prod, 'debug': (m) => m.flags.debug, 'design': (m) => m.flags.design, 'ui': (m) => m.flags.ui, 'mechanical': (m) => m.flags.mechanical, 'no edit, no commit (observed)': (m) => !m.tools.edit && !m.commits };
console.log(table(Object.entries(KINDS).map(([k, f]) => row(k, missions.filter(f))), HEAD));

console.log('\nObserved read-only missions (no edit, no commit) by model');
console.log(table(group(missions.filter((m) => !m.tools.edit && !m.commits), (m) => family(m.model)).map(([k, a]) => row(k, a)), HEAD));

console.log('\nWhere the tool calls go, by model (share of calls)');
const KIND = ['read', 'bash', 'edit', 'agent', 'web', 'hub', 'mcp', 'other'];
console.log(table(group(missions, (m) => family(m.model)).map(([k, a]) => {
  const all = sum(a, tools);
  return [k, all, ...KIND.map((t) => pct(sum(a, (m) => m.tools[t] ?? 0), all)), pct(a.filter((m) => m.subagents > 0).length, a.length), usd(sum(a, (m) => m.subCost))];
}), ['', 'calls', ...KIND, 'with subagents', 'subagents $']));

console.log('\nSubagents: cost by model');
const sub = {};
for (const m of missions) for (const [k, c] of Object.entries(m.subModels)) sub[family(k)] = (sub[family(k)] ?? 0) + c;
console.log(table(Object.entries(sub).map(([k, c]) => [k, usd(c)]), ['model', '$']));
const asked = {};
for (const m of missions) for (const [k, n] of Object.entries(m.agentModels)) asked[k] = (asked[k] ?? 0) + n;
console.log(`Agent calls by the model or type asked: ${Object.entries(asked).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} ${n}`).join(', ')}`);

console.log('\nBriefs and reports (characters)');
const sizes = (label, a) => [label, a.length, q(a, 0.5), q(a, 0.9), Math.round(sum(a, (x) => x) / 1e3)];
console.log(table([
  sizes('brief (mission)', missions.map((m) => m.briefChars)),
  sizes('follow-ups, per mission', missions.filter((m) => m.follows).map((m) => m.followChars)),
  sizes('last report', missions.filter((m) => m.reports).map((m) => m.lastReportChars)),
  sizes('all reports of a mission', missions.filter((m) => m.reports).map((m) => m.reportChars)),
], ['', 'n', 'median', 'p90', 'total K']));
console.log(`Reports per mission: median ${q(missions.map((m) => m.reports), 0.5)}, p90 ${q(missions.map((m) => m.reports), 0.9)}; missions with none: ${missions.filter((m) => !m.reports).length}.`);

console.log('\nWhat the master asked for (spawn_worker, message_worker)');
const dkey = (d) => `${d.tool} · ${d.model || '(none)'} · ${d.effort || '(none)'}`;
const dg = new Map();
for (const d of delegations) dg.set(dkey(d), [...(dg.get(dkey(d)) ?? []), d]);
console.log(table([...dg.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 14).map(([k, a]) => [k, a.length, pct(a.filter((d) => d.userNamed && family(d.userNamed) === family(d.model)).length, a.length), pct(a.filter((d) => d.flags.analysis && !d.flags.code).length, a.length), q(a.map((d) => d.chars), 0.5)]), ['', 'n', 'user named it', 'analysis', 'med chars']));
const spawns = delegations.filter((d) => d.tool === 'spawn_worker' && d.model);
const ana = spawns.filter((d) => d.flags.analysis && !d.flags.code);
console.log(`Spawns of an analysis brief (no code word): ${ana.length}; sent to opus or fable: ${ana.filter((d) => /opus|fable/.test(d.model)).length}, of which the user named the model: ${ana.filter((d) => /opus|fable/.test(d.model) && d.userNamed && family(d.userNamed) === family(d.model)).length}.`);

console.log('\nDaily spend by model ($)');
const day = (t) => new Date(t + 36e5).toISOString().slice(5, 10);
const dd = new Map();
for (const m of missions) {
  const r = dd.get(day(m.start)) ?? {};
  r[family(m.model)] = (r[family(m.model)] ?? 0) + m.total;
  dd.set(day(m.start), r);
}
console.log(table([...dd.entries()].sort().map(([d, r]) => [d, ...['opus', 'fable', 'sonnet', 'other'].map((k) => usd(r[k] ?? 0))]), ['day', 'opus', 'fable', 'sonnet', 'other']));

console.log('\nWho the mission ran for: a post whose model the user fixed, a post left to the master, an instance, an ad-hoc worker');
console.log(table(group(missions, (m) => `${m.cls}${m.cls === 'one-off' ? '' : m.fixed ? ' (model fixed)' : ' (auto)'} · ${family(m.model)}`).map(([k, a]) => row(k, a)), HEAD));

console.log('\nThe master, by model · effort ($)');
const mm = {};
for (const m of masters) for (const [k, c] of Object.entries(m.byModel ?? {})) mm[k] = (mm[k] ?? 0) + c;
console.log(table(Object.entries(mm).sort((a, b) => b[1] - a[1]).map(([k, c]) => [k, usd(c)]), ['model · effort', '$']));
console.log(`Master requests: ${sum(masters, (m) => m.requests)}; delegations: ${delegations.length}; $ per delegation: ${usd(masterCost / Math.max(1, delegations.length))}.`);

// What a cheap model predicts from the brief alone, against how the mission really went.
const rated = missions.filter((m) => m.tier >= 0);
if (rated.length) {
  const TIER = ['simple', 'standard', 'hard', 'critical'];
  console.log(`\nLevel a cheap model gives the brief (${rated.length} missions) against how the mission went`);
  console.log(table(TIER.map((t, k) => row(t, rated.filter((m) => m.tier === k))), HEAD));
  console.log('\nLevel given by the cheap model × model the mission ran on (missions, $)');
  console.log(table(TIER.map((t, k) => [t, ...['sonnet', 'opus', 'fable'].map((f) => {
    const a = rated.filter((m) => m.tier === k && family(m.model) === f);
    return `${a.length} · $${usd(sum(a, (m) => m.total))}`;
  })]), ['', 'sonnet', 'opus', 'fable']));
  // Rank agreement (Spearman) between a predictor known before the work and a measure of the work done.
  const ranks = (a) => {
    const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
    const r = new Array(a.length);
    for (let i = 0; i < idx.length;) {
      let j = i;
      while (j < idx.length && idx[j][0] === idx[i][0]) j++;
      for (let k = i; k < j; k++) r[idx[k][1]] = (i + j - 1) / 2;
      i = j;
    }
    return r;
  };
  const spearman = (x, y) => {
    const [a, b] = [ranks(x), ranks(y)];
    const ma = mean(a, (v) => v);
    const mb = mean(b, (v) => v);
    const cov = sum(a.map((v, i) => (v - ma) * (b[i] - mb)), (v) => v);
    return cov / Math.sqrt(sum(a, (v) => (v - ma) ** 2) * sum(b, (v) => (v - mb) ** 2));
  };
  /** Probability that a mission over the threshold is ranked above one under it (0.5 = chance). */
  const auc = (score, label) => {
    const pos = score.filter((_, i) => label[i]);
    const neg = score.filter((_, i) => !label[i]);
    let s = 0;
    for (const p of pos) for (const n of neg) s += p > n ? 1 : p === n ? 0.5 : 0;
    return pos.length && neg.length ? s / (pos.length * neg.length) : 0;
  };
  const priced = { sonnet: 0, opus: 1, fable: 2, other: 0 };
  const PRED = {
    'cheap model: level': (m) => m.tier,
    'cheap model: minutes': (m) => m.tierMinutes,
    'master: model chosen': (m) => priced[family(m.model)],
    'brief length': (m) => m.briefChars,
  };
  const WORK = { 'requests': (m) => m.requests, 'active min': (m) => m.activeMs, 'follow-ups': (m) => m.follows };
  console.log('\nDoes it predict the work? Spearman rank correlation, then AUC for "more than 30 min of work" and "3 follow-ups or more"');
  console.log(table(Object.entries(PRED).map(([k, f]) => [k, ...Object.values(WORK).map((w) => spearman(rated.map(f), rated.map(w)).toFixed(2)), auc(rated.map(f), rated.map((m) => m.activeMs > 18e5)).toFixed(2), auc(rated.map(f), rated.map((m) => m.follows >= 3)).toFixed(2)]), ['predictor', ...Object.keys(WORK), 'AUC >30 min', 'AUC 3+ follows']));
}

// What it costs to hand anything at all to a worker: the missions that did little.
console.log('\nPrice of entry: missions of 25 requests or fewer, by model');
console.log(table(group(missions.filter((m) => m.requests <= 25), (m) => family(m.model)).map(([k, a]) => [k, a.length, usd(q(a.map((m) => m.total), 0.5)), usd(q(a.map((m) => m.total), 0.9)), Math.round(q(a.map((m) => m.ctxMax), 0.5) / 1e3)]), ['', 'n', 'median $', 'p90 $', 'median context K']));

// Several workers at once: how often, and what the missions that ran alongside others cost.
const overlap = (m) => missions.filter((o) => o !== m && o.start < m.end && m.start < o.end).length;
const alone = missions.filter((m) => overlap(m) === 0);
const few = missions.filter((m) => overlap(m) >= 1 && overlap(m) <= 2);
const many = missions.filter((m) => overlap(m) >= 3);
console.log('\nMissions by how many others ran during them');
console.log(table([row('alone', alone), row('with 1-2 others', few), row('with 3 or more', many)], HEAD));
