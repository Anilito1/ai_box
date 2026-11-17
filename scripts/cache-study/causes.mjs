// Why the cache is written: each request is compared with the one it extends (`base` in the transcript's request log).
// A write is growth (the new turn) unless the request read less than its base had cached: that loss was rewritten,
// and the first difference between the two requests names the cause.
//   node scripts/cache-study/causes.mjs [--detail]
import { classOf, costOf, load, M, pct, table } from './common.mjs';

const { files, requests, shapes } = load();
const detail = process.argv.includes('--detail');
const byClass = process.argv.includes('--by-class');
const TOL = 1024; // A read shorter by less than this is noise (the uncached tail of the base).

function shapeDiff(a, b) {
  const A = shapes[a], B = shapes[b];
  if (!A || !B) return 'shape?';
  const names = (s) => new Map(s.tools.map((t) => [t.name, t.h]));
  const na = names(A), nb = names(B);
  const added = [...nb.keys()].filter((k) => !na.has(k));
  const removed = [...na.keys()].filter((k) => !nb.has(k));
  const changed = [...nb.keys()].filter((k) => na.has(k) && na.get(k) !== nb.get(k));
  const server = (n) => (n.startsWith('mcp__') ? `mcp:${n.split('__')[1]}` : n);
  const parts = [];
  if (added.length) parts.push(`+tools(${[...new Set(added.map(server))].join(',')})`);
  if (removed.length) parts.push(`-tools(${[...new Set(removed.map(server))].join(',')})`);
  if (changed.length) parts.push(`~toolDef(${[...new Set(changed.map(server))].join(',')})`);
  if (!added.length && !removed.length && A.tools.map((t) => t.name).join() !== B.tools.map((t) => t.name).join()) parts.push('toolOrder');
  const sys = [];
  for (let i = 0; i < Math.max(A.sys.length, B.sys.length); i++) if (A.sys[i]?.h !== B.sys[i]?.h) sys.push(i);
  if (sys.length) parts.push(`~system[${sys.join(',')}]`);
  return parts.join(' ') || 'shape(same blocks)';
}

const causes = new Map();
const bump = (key, tokens, cost, ex) => {
  const c = causes.get(key) ?? { n: 0, tokens: 0, cost: 0, ex: [] };
  c.n++;
  c.tokens += tokens;
  c.cost += cost;
  if (ex && c.ex.length < 3) c.ex.push(ex);
  causes.set(key, c);
};
const byFile = new Map();
for (const r of requests) (byFile.get(r.f) ?? byFile.set(r.f, []).get(r.f)).push(r);

let growth = 0, growthCost = 0, writes = 0;
const gaps = []; // For the TTL simulation: start-to-start gap with the base, and what the base had cached.
for (const [fi, list] of byFile) {
  const f = files[fi];
  const cls = f.sub ? 'subagent' : classOf(f.agentName);
  const byId = new Map(list.map((r) => [r.id, r]));
  const compacts = f.compacts.map((c) => c.t);
  let last = null; // Last request with usage in this file.
  for (const r of list) {
    if (!r.u) continue;
    const w = r.u[1] + r.u[2];
    writes += w;
    // The base that was answered: an interrupted base passes on to its own base.
    let p = r.base ? byId.get(r.base) : null;
    while (p && !p.u && p.base) p = byId.get(p.base);
    if (p && !p.u) p = null;
    const wcost = (tok) => costOf(r.model, [0, r.ttl === '1h' ? 0 : tok, r.ttl === '1h' ? tok : 0, 0, 0]);
    let cause;
    let lost = 0;
    if (!p) {
      const ref = last;
      if (r.n <= 2 || !ref) cause = f.sub ? 'start:subagent' : 'start:conversation';
      else if (compacts.some((t) => t > ref.t && t <= r.t)) cause = 'compaction (new prompt after summary)';
      else {
        // Messages already there but no base in this process: the program restarted (resume).
        lost = Math.max(0, ref.u[1] + ref.u[2] + ref.u[3] - r.u[3]);
        const gap = r.t - ref.t;
        cause = lost <= TOL ? null : `resume${gap > 3600e3 ? ':after>1h' : gap > 300e3 ? ':after5m-1h' : ':within5m'}`;
        if (cause && ref.shape !== r.shape) cause += ` ${shapeDiff(ref.shape, r.shape)}`;
      }
      if (!cause) {
        growth += w;
        growthCost += wcost(w);
      } else bump(byClass ? `${cause} [${cls}]` : cause, w, wcost(w), `${cls}`);
      last = r;
      continue;
    }
    const expected = p.u[1] + p.u[2] + p.u[3];
    lost = Math.max(0, expected - r.u[3]);
    gaps.push({ cls, ttl: r.ttl, model: r.model, gap: r.t - p.t, cached: expected, lost, w, sub: f.sub });
    if (lost <= TOL) {
      growth += w;
      growthCost += wcost(w);
      last = r;
      continue;
    }
    const rebuild = Math.min(w, lost);
    growth += w - rebuild;
    growthCost += wcost(w - rebuild);
    const gap = r.t - p.t;
    const ttlMs = r.ttl === '1h' ? 3600e3 : 300e3;
    if (p.shape !== r.shape) cause = `shape ${shapeDiff(p.shape, r.shape)}`;
    else if (p.model !== r.model) cause = 'model switch';
    else if (p.effort !== r.effort) cause = `effort ${p.effort || 'default'}->${r.effort || 'default'}`;
    else if (p.think !== r.think) cause = 'thinking config';
    else if (p.betas !== r.betas) cause = 'beta headers';
    else if (p.cm !== r.cm) cause = 'context_management';
    else if (r.keep < p.n) cause = compacts.some((t) => t > p.t && t <= r.t) ? 'compaction' : 'history edited';
    else if (gap > ttlMs) cause = `ttl expired (${r.ttl})`;
    else if (r.u[3] === 0) cause = 'miss: nothing read';
    else cause = 'miss: partial read';
    bump(byClass ? `${cause} [${cls}]` : cause, rebuild, wcost(rebuild), `${cls} gap=${Math.round(gap / 1000)}s lost=${lost}`);
    last = r;
  }
}

const rebuilt = writes - growth;
console.log(`Cache writes ${M(writes)}M tokens: growth (new turns) ${M(growth)}M = ${pct(growth, writes)}%, rebuilt prefix ${M(rebuilt)}M = ${pct(rebuilt, writes)}%`);
console.log(`Write cost at API prices: growth $${growthCost.toFixed(0)}\n`);
console.log(table([...causes].sort((a, b) => b[1].tokens - a[1].tokens).slice(0, detail ? 60 : 25).map(([k, c]) => [k.slice(0, 90), c.n, M(c.tokens), pct(c.tokens, writes), c.cost.toFixed(0), ...(detail ? [c.ex.join(' | ').slice(0, 80)] : [])]), ['cause', 'req', 'Mtok', '%writes', '$api', ...(detail ? ['examples'] : [])]));

// TTL: what the same traffic would have cost with a 5-minute cache. Gap = start of the base to start of the request.
const buckets = [[0, 60e3, '<1 min'], [60e3, 300e3, '1-5 min'], [300e3, 900e3, '5-15 min'], [900e3, 3600e3, '15-60 min'], [3600e3, Infinity, '>1 h']];
console.log('\nGap between a request and its base (main sessions), and what the base had cached');
const main = gaps.filter((g) => !g.sub);
console.log(table(buckets.map(([lo, hi, label]) => {
  const b = main.filter((g) => g.gap >= lo && g.gap < hi);
  return [label, b.length, M(b.reduce((s, g) => s + g.cached, 0)), M(b.reduce((s, g) => s + g.lost, 0))];
}), ['gap', 'req', 'cached Mtok', 'lost Mtok']));
// Counterfactual: 5-minute TTL on the main sessions. Every write costs 1.25x instead of 2x; every request more than 5 min
// after its base rewrites what the base had cached (instead of reading it). Ignores refreshes by requests in between.
let now = 0, alt = 0;
for (const g of main) {
  if (g.ttl !== '1h') continue;
  const keepRead = g.cached - g.lost;
  now += costOf(g.model, [0, 0, g.w, keepRead, 0]);
  alt += g.gap > 300e3 ? costOf(g.model, [0, g.w + keepRead, 0, 0, 0]) : costOf(g.model, [0, g.w, 0, keepRead, 0]);
}
console.log(`\nMain sessions, writes+reads at API prices: 1-hour TTL (today) $${now.toFixed(0)}  vs 5-minute TTL $${alt.toFixed(0)} (${pct(alt - now, now)}%)`);
