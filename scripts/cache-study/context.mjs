// How big the prompt is when it is sent: cache reads are context size x number of requests.
//   node scripts/cache-study/context.mjs
import { classOf, costOf, load, M, pct, table } from './common.mjs';

const { files, requests } = load();
const BUCKETS = [[0, 50e3], [50e3, 100e3], [100e3, 200e3], [200e3, 300e3], [300e3, 500e3], [500e3, 1.1e6]];
const label = ([lo, hi]) => `${lo / 1e3}-${hi / 1e3}K`;
const rows = BUCKETS.map((b) => ({ b, n: 0, read: 0, cost: 0, sub: 0 }));
let allRead = 0, allCost = 0;
const byClass = new Map();
for (const r of requests) {
  if (!r.u) continue;
  const f = files[r.f];
  const ctx = r.u[0] + r.u[1] + r.u[2] + r.u[3];
  const c = costOf(r.model, r.u);
  const readCost = costOf(r.model, [0, 0, 0, r.u[3], 0]);
  allRead += r.u[3];
  allCost += c;
  const row = rows.find(({ b }) => ctx >= b[0] && ctx < b[1]);
  row.n++;
  row.read += r.u[3];
  row.cost += readCost;
  if (f.sub) row.sub++;
  const cls = f.sub ? 'subagent' : classOf(f.agentName);
  const g = byClass.get(cls) ?? { n: 0, ctx: 0, max: 0, sessions: new Set() };
  g.n++;
  g.ctx += ctx;
  g.max = Math.max(g.max, ctx);
  g.sessions.add(f.sub ? f.file : f.sid);
  byClass.set(cls, g);
}
console.log('Prompt size per request (input + cache write + cache read)');
console.log(table(rows.map((r) => [label(r.b), r.n, r.sub, M(r.read), pct(r.read, allRead), r.cost.toFixed(0), pct(r.cost, allCost)]), ['context', 'req', 'of which sub', 'read Mtok', '%reads', '$read', '%all$']));
console.log('\nBy class: requests, sessions, average and largest prompt');
console.log(table([...byClass].map(([k, g]) => [k, g.n, g.sessions.size, Math.round(g.ctx / g.n / 1e3) + 'K', Math.round(g.max / 1e3) + 'K', Math.round(g.n / g.sessions.size)]), ['class', 'req', 'sessions', 'avg ctx', 'max ctx', 'req/session']));
// Compactions seen in the window.
const comp = files.flatMap((f) => f.compacts.map((c) => ({ ...c, cls: f.sub ? 'subagent' : classOf(f.agentName) })));
console.log(`\nCompactions in the window: ${comp.length} (${comp.map((c) => `${c.cls}:${c.trigger}:${Math.round(c.pre / 1e3)}K`).join(', ')})`);
