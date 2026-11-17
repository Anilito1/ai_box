// Conversations left idle past the 1-hour cache with a large prompt: how many come back (and rewrite it all), how many
// never do, and what a fresh start (a hub-written note, no model call) or a warm compaction before expiry would cost.
//   node scripts/cache-study/idle.mjs [--min 150000] [--after 60000] [--summary 8000]
import { classOf, costOf, load, M, table } from './common.mjs';

const { files, requests, until } = load();
const opt = (name, d) => Number(process.argv[process.argv.indexOf(`--${name}`) + 1]) || d;
const MIN = opt('min', 150e3), AFTER = opt('after', 60e3), SUMMARY = opt('summary', 8e3);
const HOUR = 3600e3;
const ctxOf = (r) => r.u[0] + r.u[1] + r.u[2] + r.u[3];

// One timeline per conversation (session id), across process restarts; subagents apart.
const conv = new Map();
for (const r of requests) {
  const f = files[r.f];
  if (!r.u || f.sub) continue;
  (conv.get(f.sid) ?? conv.set(f.sid, { cls: classOf(f.agentName), list: [] }).get(f.sid)).list.push(r);
}
const by = new Map();
const get = (cls) => by.get(cls) ?? by.set(cls, { back: 0, never: 0, rewrite: 0, rewriteCost: 0, fresh: 0, warm: 0, warmWasted: 0 }).get(cls);
for (const { cls, list } of conv.values()) {
  list.sort((a, b) => a.t - b.t);
  for (let i = 0; i < list.length; i++) {
    const r = list[i], next = list[i + 1];
    const ctx = ctxOf(r);
    if (ctx < MIN) continue;
    const gap = (next ? next.t : until) - r.t;
    if (gap < HOUR) continue;
    const g = get(cls);
    // Warm compaction ~55 min after the last request: reads the prompt, writes a summary.
    const warm = costOf(r.model, [0, 0, 0, ctx, SUMMARY]);
    if (!next) {
      g.never++;
      g.warmWasted += warm;
      continue;
    }
    g.back++;
    const lost = Math.max(0, ctx - next.u[3]);
    g.rewrite += lost;
    g.rewriteCost += costOf(next.model, [0, 0, lost, 0, 0]);
    // Fresh start: the next request writes a small prompt instead of the whole conversation.
    g.fresh += costOf(next.model, [0, 0, Math.min(lost, AFTER), 0, 0]);
    g.warm += warm + costOf(next.model, [0, 0, Math.min(lost, AFTER), 0, 0]);
  }
}
console.log(`Idle > 1 h with a prompt over ${MIN / 1e3}K (main conversations). Today: the next request rewrites it all.`);
console.log(table([...by].map(([cls, g]) => [cls, g.back, g.never, M(g.rewrite), g.rewriteCost.toFixed(0), g.fresh.toFixed(0), (g.warm + g.warmWasted).toFixed(0), (g.rewriteCost - g.fresh).toFixed(0)]),
  ['class', 'came back', 'never (yet)', 'rewritten M', '$ today', '$ fresh start', '$ warm compaction', '$ saved (fresh)']));
