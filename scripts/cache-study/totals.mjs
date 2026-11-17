// Where the tokens go: totals by session class, repo and model, and the costliest sessions.
//   node scripts/cache-study/totals.mjs [--top 10]
import { classOf, costOf, load, M, pct, postOf, sum, table, ZERO } from './common.mjs';

const { files, requests } = load();
const top = Number(process.argv[process.argv.indexOf('--top') + 1]) || 10;
const groups = { class: new Map(), repo: new Map(), model: new Map(), session: new Map(), post: new Map() };
const add = (map, key, u, cost) => {
  const g = map.get(key) ?? { u: ZERO, cost: 0, n: 0 };
  map.set(key, { u: sum(g.u, u), cost: g.cost + cost, n: g.n + 1 });
};
let total = ZERO, cost = 0, noUsage = 0;
for (const r of requests) {
  if (!r.u) {
    noUsage++;
    continue;
  }
  const f = files[r.f];
  const c = costOf(r.model, r.u);
  const cls = f.sub ? `subagent(${classOf(f.agentName)})` : classOf(f.agentName);
  total = sum(total, r.u);
  cost += c;
  add(groups.class, cls, r.u, c);
  add(groups.repo, f.sub ? (f.parentRepo ?? f.repo) : f.repo, r.u, c);
  add(groups.model, r.model, r.u, c);
  add(groups.post, f.sub ? `${postOf(f.agentName) || classOf(f.agentName)} (sub)` : postOf(f.agentName) || classOf(f.agentName), r.u, c);
  // A subagent counts with the session that launched it.
  add(groups.session, f.sub ? f.parent : f.sid, r.u, c);
}
const prompt = (u) => u[0] + u[1] + u[2] + u[3];
const row = (k, g) => [k, g.n, M(g.u[0]), M(g.u[1]), M(g.u[2]), M(g.u[3]), M(g.u[4]), pct(g.u[3], prompt(g.u)), g.cost.toFixed(0), pct(g.cost, cost)];
const COLS = ['', 'req', 'input', 'cw5m', 'cw1h', 'cread', 'output', 'hit%', '$api', '%$'];
console.log(`Requests ${requests.length} (without usage: ${noUsage}), tokens in millions, $ at API prices`);
console.log(table([row('TOTAL', { u: total, cost, n: requests.length - noUsage })], COLS));
const costShare = (u, model) => {
  // Share of the cost by token kind, at that model's prices.
  return [costOf(model, [u[0], 0, 0, 0, 0]), costOf(model, [0, u[1], 0, 0, 0]), costOf(model, [0, 0, u[2], 0, 0]), costOf(model, [0, 0, 0, u[3], 0]), costOf(model, [0, 0, 0, 0, u[4]])];
};
let kinds = ZERO;
for (const r of requests) if (r.u) kinds = sum(kinds, costShare(r.u, r.model));
console.log(`\nCost by token kind: input ${pct(kinds[0], cost)}%  write5m ${pct(kinds[1], cost)}%  write1h ${pct(kinds[2], cost)}%  read ${pct(kinds[3], cost)}%  output ${pct(kinds[4], cost)}%`);
for (const [name, map] of [['class', groups.class], ['post', groups.post], ['repo', groups.repo], ['model', groups.model]]) {
  console.log(`\nBy ${name}`);
  console.log(table([...map].sort((a, b) => b[1].cost - a[1].cost).slice(0, 14).map(([k, g]) => row(k, g)), COLS));
}
console.log(`\nTop ${top} sessions (subagents included)`);
const meta = new Map(files.filter((f) => !f.sub).map((f) => [f.sid, f]));
console.log(table([...groups.session].sort((a, b) => b[1].cost - a[1].cost).slice(0, top).map(([sid, g]) => {
  const f = meta.get(sid);
  return [`${sid.slice(0, 8)} ${f?.agentName || '-'} ${f?.repo ?? ''}`, ...row('', g).slice(1)];
}), COLS));
