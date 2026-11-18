// What handing the runs of exploring steps to a cheap fresh context could save, on the real sessions of the last days:
// a run of L requests that only explore becomes one request (the call and its short answer), the same steps being
// paid in a small context at the helper's price. Reads the local transcripts only; prints numbers, never a word of them.
//   node scripts/search-bench/tokens/delegation.mjs [--from 2026-11-03] [--to 2026-11-17] [--cache sessions.json]
//     [--answer 900] [--helper-usd 0.006,0.045] [--json out.json]
// --answer  tokens of the helper's answer, kept by the main context instead of the raw results
// --helper-usd  what one exploration by the helper costs (measured by explore-eval.mjs and the A/B), one value per
//               helper to compare: Haiku 5.5 and Sonnet 5.5 by default
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXPLORE, listTranscripts, readSession, sessionClass, weigh } from './transcripts.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const from = new Date(`${arg('from', '2026-11-03')}T00:00:00`).getTime();
const to = new Date(`${arg('to', '2026-11-17')}T23:59:59.999`).getTime();
const ANSWER = Number(arg('answer', '900'));
const HELPER_USD = arg('helper-usd', '0.006,0.045').split(',').map(Number);
// Characters per token, as measured by usage.mjs on these sessions.
const CHARS_PER_TOKEN = 2.25;
const hubData = join(process.env.APPDATA ?? '', 'claude-hub');
const posts = process.env.AIBOX_POSTS
  ? process.env.AIBOX_POSTS.split(',')
  : JSON.parse(readFileSync(join(hubData, 'state.json'), 'utf8')).sessions.filter((s) => s.roleId && !s.instanceOf).map((s) => s.name);

/** Dollars per input-token equivalent, by model, from the hub's own cost log. */
function unitPrices() {
  const sums = {};
  for (const month of ['10', '11']) {
    let text = '';
    try {
      text = readFileSync(join(hubData, 'usage', `turns-2026-${month}.jsonl`), 'utf8');
    } catch {}
    for (const line of text.split('\n')) {
      if (!line) continue;
      for (const [model, [cost, input, output, cacheRead, cacheWrite]] of Object.entries(JSON.parse(line).m)) {
        const s = (sums[model] ??= { cost: 0, eq: 0 });
        s.cost += cost;
        s.eq += input + 1.25 * cacheWrite + 0.1 * cacheRead + 5 * output;
      }
    }
  }
  return Object.fromEntries(Object.entries(sums).filter(([, s]) => s.eq > 0).map(([m, s]) => [m, s.cost / s.eq]));
}
const units = unitPrices();
const unitOf = (model) => units[model] ?? 3e-6;

const cacheFile = arg('cache');
let sessions;
if (cacheFile && existsSync(cacheFile)) sessions = JSON.parse(readFileSync(cacheFile, 'utf8'));
else {
  sessions = [];
  for (const entry of listTranscripts(undefined, from)) sessions.push(await readSession(entry, { from, to }));
  if (cacheFile) writeFileSync(cacheFile, JSON.stringify(sessions.map((s) => ({ ...s, dirs: [] }))));
}
const byId = new Map(sessions.filter((s) => !s.parent).map((s) => [`${s.session}.jsonl`, s]));
const tok = (x) => x.chars / CHARS_PER_TOKEN + (x.images ?? 0) * 1600;
const kindOf = (tag) => tag.split(':')[0];
/** A result the helper's answer can stand in for: exploring, and not the read of a file the session then changes. */
const replaceable = (tag) => EXPLORE.has(kindOf(tag)) && !tag.includes('edited');

const THRESHOLDS = [2, 3, 4, 6];
const blank = () => ({ cost: 0, exploreTrips: 0, exploreContent: 0, episodes: 0, requests: 0, by: Object.fromEntries(THRESHOLDS.map((t) => [t, { episodes: 0, requests: 0, trips: 0, content: 0, context: 0 }])), lengths: {} });
const groups = {};
const groupOf = (key) => (groups[key] ??= blank());

for (const s of sessions) {
  const owner = s.parent ? byId.get(s.parent) ?? s : s;
  const cls = sessionClass({ name: owner.name, cwd: owner.cwd, entrypoint: owner.entrypoint, posts });
  const gs = ['all', `class:${cls}`, `kind:${s.parent ? 'subagent' : 'session'}`].map(groupOf);
  // What each tag of result cost this session over the requests that carried it, and how many tokens it produced.
  const contentCost = {};
  const produced = {};
  const rows = [];
  for (const r of s.requests) {
    const unit = unitOf(r.model);
    const w = weigh(r.usage);
    const ctx = r.usage.input + r.usage.cacheWrite5m + r.usage.cacheWrite1h + r.usage.cacheRead;
    const carried = Object.entries(r.carried).map(([tag, x]) => [tag, tok(x)]);
    const sum = carried.reduce((a, [, t]) => a + t, 0);
    const scale = sum > ctx && sum > 0 ? ctx / sum : 1;
    for (const [tag, t] of carried) contentCost[tag] = (contentCost[tag] ?? 0) + ((w.input * t * scale) / Math.max(ctx, 1)) * unit;
    for (const [tag, x] of Object.entries(r.results ?? {})) produced[tag] = (produced[tag] ?? 0) + tok(x);
    const emits = Object.entries(r.emits);
    const calls = emits.reduce((a, [, n]) => a + n, 0);
    const trip = (w.input * (1 - (sum * scale) / Math.max(ctx, 1)) + w.output) * unit;
    rows.push({ r, ctx, cost: w.total * unit, trip, explore: calls > 0 && emits.every(([c]) => EXPLORE.has(kindOf(c))) });
  }
  for (const g of gs) {
    g.cost += rows.reduce((a, x) => a + x.cost, 0);
    g.exploreTrips += rows.filter((x) => x.explore).reduce((a, x) => a + x.trip, 0);
    g.exploreContent += Object.entries(contentCost).filter(([t]) => EXPLORE.has(kindOf(t))).reduce((a, [, v]) => a + v, 0);
  }
  let run = [];
  const close = () => {
    if (!run.length) return;
    const length = run.length;
    const trips = run.reduce((a, x) => a + x.trip, 0);
    // The run's own results, and the share of the session's carried cost they stand for (same tag, by tokens).
    let content = 0;
    let tokens = 0;
    for (const x of run) {
      for (const [tag, res] of Object.entries(x.r.results ?? {})) {
        if (!replaceable(tag) || !produced[tag]) continue;
        tokens += tok(res);
        content += ((contentCost[tag] ?? 0) * tok(res)) / produced[tag];
      }
    }
    for (const g of gs) {
      g.episodes++;
      g.requests += length;
      const bucket = length >= 6 ? '6+' : String(length);
      g.lengths[bucket] = (g.lengths[bucket] ?? 0) + 1;
      for (const t of THRESHOLDS) {
        if (length < t) continue;
        const b = g.by[t];
        b.episodes++;
        b.requests += length;
        // All its trips but one: the call that asks and reads the answer.
        b.trips += (trips * (length - 1)) / length;
        b.content += content * Math.max(0, 1 - ANSWER / Math.max(tokens, 1));
        b.context += run.reduce((a, x) => a + x.ctx, 0);
      }
    }
    run = [];
  };
  for (const x of rows) {
    if (x.explore) run.push(x);
    else close();
  }
  close();
}

const pct = (x, total) => (total > 0 ? +((100 * x) / total).toFixed(1) : 0);
const out = { window: [new Date(from).toISOString(), new Date(to).toISOString()], answerTokens: ANSWER, helperUsdPerRun: HELPER_USD, groups: {} };
for (const [key, g] of Object.entries(groups).sort((a, b) => b[1].cost - a[1].cost)) {
  out.groups[key] = {
    costUsd: +g.cost.toFixed(0),
    exploreTripShare: pct(g.exploreTrips, g.cost),
    exploreContentShare: pct(g.exploreContent, g.cost),
    episodes: g.episodes,
    lengths: g.lengths,
    delegate: Object.fromEntries(
      THRESHOLDS.map((t) => {
        const b = g.by[t];
        return [
          `>=${t}`,
          {
            episodes: b.episodes,
            requests: b.requests,
            avgContextK: Math.round(b.context / Math.max(b.requests, 1) / 1000),
            tripsSaved: pct(b.trips, g.cost),
            contentSaved: pct(b.content, g.cost),
            // Net of the helper, which pays the same steps in its own small context.
            net: HELPER_USD.map((usd) => pct(b.trips + b.content - usd * b.episodes, g.cost)),
          },
        ];
      }),
    ),
  };
}
const file = arg('json');
if (file) writeFileSync(file, JSON.stringify(out, null, 1));
console.log(`window ${out.window.join(' → ')}  answer ${ANSWER} tokens  helper $/run ${HELPER_USD.join(' | ')}`);
for (const [k, g] of Object.entries(out.groups)) {
  console.log(`${k.padEnd(28)} ${String(g.costUsd).padStart(6)} $  explore trips ${g.exploreTripShare}% content ${g.exploreContentShare}%  episodes ${g.episodes} ${JSON.stringify(g.lengths)}`);
  for (const [t, d] of Object.entries(g.delegate)) console.log(`   runs ${t.padEnd(4)} ${String(d.episodes).padStart(5)} runs ${String(d.requests).padStart(6)} req @${d.avgContextK}K  trips −${d.tripsSaved}%  content −${d.contentSaved}%  net ${d.net.map((n) => `${n}%`).join(' | ')}`);
}
