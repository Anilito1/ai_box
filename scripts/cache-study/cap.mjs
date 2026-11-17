// What a context ceiling would have saved: replays each conversation's prompt sizes as if it had been compacted (or
// handed off to a fresh conversation) whenever it passed the ceiling. Reads shrink by what the compaction dropped;
// each compaction costs one summary (output) and the rewrite of the new, smaller prompt.
//   node scripts/cache-study/cap.mjs [--after 60000] [--summary 8000]
import { classOf, costOf, load, M, pct, table } from './common.mjs';

const { files, requests } = load();
const opt = (name, d) => Number(process.argv[process.argv.indexOf(`--${name}`) + 1]) || d;
const AFTER = opt('after', 60e3); // Prompt right after a compaction: fixed prefix + summary + the turn in progress.
const SUMMARY = opt('summary', 8e3); // Output tokens of one summary.
const ctxOf = (r) => r.u[0] + r.u[1] + r.u[2] + r.u[3];

// Prompt size after the compactions seen in the window.
const after = [];
const chains = new Map();
for (const r of requests) {
  if (!r.u || files[r.f].sub) continue;
  (chains.get(r.f) ?? chains.set(r.f, []).get(r.f)).push(r);
}
for (const [fi, list] of chains) {
  for (const c of files[fi].compacts) {
    const next = list.find((r) => r.t > c.t);
    if (next) after.push(ctxOf(next));
  }
}
if (after.length) console.log(`After the ${after.length} compactions seen: prompt ${after.map((n) => Math.round(n / 1e3) + 'K').join(', ')}`);

const totalCost = requests.reduce((s, r) => s + (r.u ? costOf(r.model, r.u) : 0), 0);
const totalRead = requests.reduce((s, r) => s + (r.u ? r.u[3] : 0), 0);
const rows = [];
for (const cap of [150e3, 200e3, 300e3, 400e3, 600e3]) {
  let savedRead = 0, savedCost = 0, extraCost = 0, compactions = 0;
  const byCls = new Map();
  for (const [fi, list] of chains) {
    const cls = classOf(files[fi].agentName);
    let offset = 0, prev = 0;
    for (const r of list) {
      const ctx = ctxOf(r);
      if (ctx < prev - 50e3) offset = 0; // The conversation was compacted or cleared for real.
      prev = ctx;
      let sim = ctx - offset;
      if (sim > cap) {
        // Compaction now: one more request reads the prompt and writes a summary, then the prompt restarts small.
        compactions++;
        extraCost += costOf(r.model, [0, 0, 0, sim, SUMMARY]) + costOf(r.model, [0, 0, AFTER, 0, 0]);
        offset = ctx - AFTER;
        sim = AFTER;
      }
      const cut = Math.min(offset, r.u[3]);
      savedRead += cut;
      const c = costOf(r.model, [0, 0, 0, cut, 0]);
      savedCost += c;
      byCls.set(cls, (byCls.get(cls) ?? 0) + c);
    }
  }
  rows.push([`${cap / 1e3}K`, compactions, M(savedRead), pct(savedRead, totalRead), savedCost.toFixed(0), extraCost.toFixed(0), (savedCost - extraCost).toFixed(0), pct(savedCost - extraCost, totalCost), [...byCls].map(([k, v]) => `${k}:${v.toFixed(0)}`).join(' ')]);
}
console.log(`Main conversations, ceiling simulation (prompt after compaction ${AFTER / 1e3}K, summary ${SUMMARY / 1e3}K output)`);
console.log(table(rows, ['ceiling', 'compactions', 'reads saved M', '%reads', '$saved', '$extra', '$net', '%all$', 'saved by class']));
