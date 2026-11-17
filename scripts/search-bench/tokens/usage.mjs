// What exploring the code and the memory cost in the real sessions of the last days, and the most the search tools
// could save of it. Reads the local transcripts only; prints numbers, never a word of them.
//   node scripts/search-bench/tokens/usage.mjs [--from 2026-11-03] [--to 2026-11-17] [--json out.json]
// Sessions are told apart by the names the hub gives them: the posts are read from AIBOX_POSTS (comma-separated) or
// else, read-only, from the hub's state.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXPLORE, listTranscripts, readSession, repoOf, sessionClass, weigh } from './transcripts.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const from = new Date(`${arg('from', '2026-11-03')}T00:00:00`).getTime();
const to = new Date(`${arg('to', '2026-11-17')}T23:59:59.999`).getTime();
const hubData = join(process.env.APPDATA ?? '', 'claude-hub');
const posts = process.env.AIBOX_POSTS
  ? process.env.AIBOX_POSTS.split(',')
  : JSON.parse(readFileSync(join(hubData, 'state.json'), 'utf8')).sessions.filter((s) => s.roleId && !s.instanceOf).map((s) => s.name);

/** Dollars per input-token equivalent, by model, from the hub's own cost log when it has one. */
function unitPrices() {
  const units = {};
  try {
    const sums = {};
    for (const month of ['10', '11']) {
      for (const line of readFileSync(join(hubData, 'usage', `turns-2026-${month}.jsonl`), 'utf8').split('\n')) {
        if (!line) continue;
        for (const [model, [cost, input, output, cacheRead, cacheWrite]] of Object.entries(JSON.parse(line).m)) {
          const s = (sums[model] ??= { cost: 0, eq: 0 });
          s.cost += cost;
          s.eq += input + 1.25 * cacheWrite + 0.1 * cacheRead + 5 * output;
        }
      }
    }
    for (const [model, s] of Object.entries(sums)) if (s.eq > 0) units[model] = s.cost / s.eq;
  } catch {}
  return units;
}
const units = unitPrices();
const unitOf = (model) => units[model] ?? 3e-6;

// 1. Every session of the window, read once (or from --cache, a file of numbers and paths kept outside the repo).
const cacheFile = arg('cache');
let sessions;
let entries = [];
if (cacheFile && existsSync(cacheFile)) sessions = JSON.parse(readFileSync(cacheFile, 'utf8')).map((s) => ({ ...s, dirs: new Map(s.dirs) }));
else {
  entries = listTranscripts(undefined, from);
  sessions = [];
  for (const entry of entries) sessions.push(await readSession(entry, { from, to }));
  if (cacheFile) writeFileSync(cacheFile, JSON.stringify(sessions.map((s) => ({ ...s, dirs: [...s.dirs] }))));
}
const byId = new Map(sessions.filter((s) => !s.parent).map((s) => [`${s.session}.jsonl`, s]));
const known = [...new Set(sessions.map((s) => repoOf(s.cwd)).filter(Boolean))];
/** The repo a session worked in: its cwd's, else the one its tools named most (a worker started on the Desktop). */
function repoOfSession(s) {
  const root = repoOf(s.cwd, known);
  if (root) return root;
  const counts = new Map();
  for (const [dir, n] of s.dirs) {
    const r = known.find((k) => dir.toLowerCase().startsWith(`${k.toLowerCase()}\\`) || dir.toLowerCase() === k.toLowerCase());
    if (r) counts.set(r, (counts.get(r) ?? 0) + n);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}
for (const s of sessions) {
  const owner = s.parent ? byId.get(s.parent) ?? s : s;
  s.cls = sessionClass({ name: owner.name, cwd: owner.cwd, entrypoint: owner.entrypoint, posts });
  const root = repoOfSession(owner);
  s.repo = root ? root.replace(/^.*[\\/]/, '') : '(hors repo)';
  s.sub = !!s.parent;
}

// 2. How many characters a token holds here: requests whose only news is one large text result.
const ratios = [];
for (const s of sessions) {
  for (const r of s.requests) {
    const f = r.fresh;
    const added = r.usage.input + r.usage.cacheWrite5m + r.usage.cacheWrite1h - (r.prevOutput ?? 0);
    if (f.n === 1 && !f.text && !f.images && f.chars >= 8000 && r.usage.cacheRead > 0 && r.prevOutput !== null && added > 500) ratios.push(f.chars / added);
  }
}
ratios.sort((a, b) => a - b);
const charsPerToken = ratios.length >= 20 ? ratios[Math.floor(ratios.length / 2)] : 3.4;
const tok = (x) => x.chars / charsPerToken + x.images * 1600;

// The size a bounded Read actually takes in these sessions: what a full read of a large file would have cost instead.
const bounded = [];
for (const s of sessions) for (const r of s.requests) for (const [tag, x] of Object.entries(r.results ?? {})) if (tag === 'read' && x.n === 1 && x.lines > 0 && x.lines < x.total) bounded.push(x.lines);
bounded.sort((a, b) => a - b);
const boundedLines = bounded.length ? bounded[Math.floor(bounded.length / 2)] : 150;

// 3. Each request's cost, split between the results its context carried and the step it took.
const blank = () => ({ cost: 0, eq: 0, requests: 0, usage: { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 }, content: {}, trip: {}, sessions: new Set(), results: {}, episodes: { n: 0, locateRuns: 0, locateTrips: 0, savedTrips: 0, savedTripCost: 0, lengths: {} }, overflow: 0, explore: { requests: 0, calls: 0, single: 0, context: 0 } });
const groups = { all: blank() };
const groupOf = (key) => (groups[key] ??= blank());
const add = (o, k, v) => (o[k] = (o[k] ?? 0) + v);
for (const s of sessions) {
  const keys = ['all', `class:${s.cls}`, `repo:${s.repo}`, `kind:${s.sub ? 'subagent' : 'session'}`];
  const gs = keys.map(groupOf);
  for (const g of gs) g.sessions.add(s.parent ?? s.session);
  let episode = null;
  const closeEpisode = () => {
    // A run of locating steps the search could have answered in one: every one but the first is a trip saved.
    if (episode && episode.locate > 1) {
      for (const g of gs) {
        g.episodes.savedTrips += episode.locate - 1;
        g.episodes.savedTripCost += (episode.locateCost * (episode.locate - 1)) / episode.locate;
      }
    }
    if (episode) for (const g of gs) {
      g.episodes.n++;
      g.episodes.locateTrips += episode.locate;
      if (episode.locate) g.episodes.locateRuns++;
      const bucket = episode.length >= 6 ? '6+' : String(episode.length);
      g.episodes.lengths[bucket] = (g.episodes.lengths[bucket] ?? 0) + 1;
    }
    episode = null;
  };
  for (const r of s.requests) {
    const unit = unitOf(r.model);
    const w = weigh(r.usage);
    const ctx = r.usage.input + r.usage.cacheWrite5m + r.usage.cacheWrite1h + r.usage.cacheRead;
    const carried = Object.entries(r.carried).map(([tag, x]) => [tag, tok(x)]);
    const sum = carried.reduce((a, [, t]) => a + t, 0);
    // Old results may have been trimmed from the context: never give them more than it held.
    const scale = sum > ctx && sum > 0 ? ctx / sum : 1;
    const emits = Object.entries(r.emits);
    const calls = emits.reduce((a, [, n]) => a + n, 0);
    const rest = (w.input * (1 - (sum * scale) / Math.max(ctx, 1)) + w.output) * unit;
    for (const g of gs) {
      g.cost += w.total * unit;
      g.eq += w.total;
      g.requests++;
      for (const k of Object.keys(g.usage)) g.usage[k] += r.usage[k];
      if (scale < 1) g.overflow++;
      for (const [tag, t] of carried) add(g.content, tag, ((w.input * t * scale) / Math.max(ctx, 1)) * unit);
      if (!calls) add(g.trip, 'answer', rest);
      for (const [cls, n] of emits) add(g.trip, cls, (rest * n) / calls);
      for (const [tag, x] of Object.entries(r.results ?? {})) {
        const agg = (g.results[tag] ??= { n: 0, tokens: 0, lines: 0, total: 0 });
        agg.n += x.n;
        agg.tokens += tok(x);
        agg.lines += x.lines;
        agg.total += x.total;
      }
    }
    const explore = calls > 0 && emits.every(([cls]) => EXPLORE.has(cls.split(':')[0]));
    if (explore) for (const g of gs) {
      g.explore.requests++;
      g.explore.calls += calls;
      if (calls === 1) g.explore.single++;
      g.explore.context += ctx;
    }
    if (!explore) closeEpisode();
    else {
      episode ??= { locate: 0, locateCost: 0, length: 0 };
      episode.length++;
      if (r.emits.locate) {
        episode.locate++;
        episode.locateCost += (rest * r.emits.locate) / calls;
      }
    }
  }
  closeEpisode();
}

// 4. Shares and ceilings.
const SEARCH_ANSWER = 800; // tokens of a default search_code answer
const MEMORY_ANSWER = 400; // tokens of a search_memory answer
/** Share of the reads of files a session never changes that the excerpts of a search could stand in for. */
const CONSULT_REPLACED = 0.25;
const pct = (x, total) => (total > 0 ? +((100 * x) / total).toFixed(1) : 0);
const sumBy = (o, test) => Object.entries(o).filter(([k]) => test(k)).reduce((a, [, v]) => a + v, 0);
const kindOf = (tag) => tag.split(':')[0];
function summary(g) {
  const content = sumBy(g.content, (t) => EXPLORE.has(kindOf(t)));
  const trips = sumBy(g.trip, (t) => EXPLORE.has(kindOf(t)));
  const of = (kind) => sumBy(g.content, (t) => kindOf(t) === kind) + sumBy(g.trip, (t) => kindOf(t) === kind);
  const byKind = Object.fromEntries(['locate', 'read', 'memory', 'explore-agent', 'git', 'view', 'web'].map((k) => [k, pct(of(k), g.cost)]));
  const reread = sumBy(g.content, (t) => t.includes(':reread') && !t.includes('after-edit'));
  const rereadAfterEdit = sumBy(g.content, (t) => t.includes('reread-after-edit'));
  // A full read of a large file, had it been bounded to the usual size: the rest of its carried cost.
  const big = Object.entries(g.results).filter(([t]) => t.startsWith('read') && t.includes('full-big'));
  const bigLines = big.reduce((a, [, x]) => a + x.lines, 0);
  const bigN = big.reduce((a, [, x]) => a + x.n, 0);
  const fullBig = sumBy(g.content, (t) => t.startsWith('read') && t.includes('full-big'));
  const fullBigSaved = bigLines > 0 ? fullBig * Math.max(0, 1 - (boundedLines * bigN) / bigLines) : 0;
  // Locating: every result traded for one search answer per run of locating steps, and the extra trips of each run.
  const locate = g.results.locate ?? { n: 0, tokens: 0 };
  const locateContent = sumBy(g.content, (t) => kindOf(t) === 'locate');
  const locateContentSaved = locate.tokens > 0 ? locateContent * Math.max(0, 1 - (SEARCH_ANSWER * Math.min(g.episodes.locateRuns, locate.n)) / locate.tokens) : 0;
  const memoryResults = Object.entries(g.results).filter(([t]) => kindOf(t) === 'memory');
  const memoryTokens = memoryResults.reduce((a, [, x]) => a + x.tokens, 0);
  const memoryN = memoryResults.reduce((a, [, x]) => a + x.n, 0);
  const memorySaved = memoryTokens > 0 ? sumBy(g.content, (t) => kindOf(t) === 'memory') * Math.max(0, 1 - (MEMORY_ANSWER * memoryN) / memoryTokens) : 0;
  // Reads of files the session never changes, apart from re-reads and large full reads already counted above.
  const consult = sumBy(g.content, (t) => kindOf(t) === 'read' && !/edited|reread|full-big/.test(t)) + (g.trip.read ?? 0);
  const strict = g.episodes.savedTripCost + locateContentSaved + fullBigSaved + reread + memorySaved;
  return {
    sessions: g.sessions.size,
    requests: g.requests,
    costUsd: +g.cost.toFixed(2),
    usageM: Object.fromEntries(Object.entries(g.usage).map(([k, v]) => [k, +(v / 1e6).toFixed(1)])),
    exploreShare: pct(content + trips, g.cost),
    exploreContentShare: pct(content, g.cost),
    exploreTripShare: pct(trips, g.cost),
    byKind,
    readOfChangedFiles: pct(sumBy(g.content, (t) => kindOf(t) === 'read' && t.includes('edited')) + (g.trip['read:edited'] ?? 0), g.cost),
    consultReads: pct(consult, g.cost),
    rereadShare: pct(reread, g.cost),
    rereadAfterEditShare: pct(rereadAfterEdit, g.cost),
    ceiling: {
      locateTrips: pct(g.episodes.savedTripCost, g.cost),
      locateContent: pct(locateContentSaved, g.cost),
      boundedReads: pct(fullBigSaved, g.cost),
      rereads: pct(reread, g.cost),
      memory: pct(memorySaved, g.cost),
      strict: pct(strict, g.cost),
      withConsult: pct(strict + CONSULT_REPLACED * consult, g.cost),
    },
    episodes: { n: g.episodes.n, locateRuns: g.episodes.locateRuns, locateTrips: g.episodes.locateTrips, savedTrips: g.episodes.savedTrips, lengths: g.episodes.lengths },
    results: Object.fromEntries(Object.entries(g.results).map(([t, x]) => [t, { n: x.n, avgTokens: Math.round(x.tokens / Math.max(x.n, 1)) }])),
    overflowRequests: g.overflow,
    // Round trips spent exploring: how many, how many calls each carried, and the context each one read again.
    exploreRequests: { n: g.explore.requests, share: pct(g.explore.requests, g.requests), callsPer: +(g.explore.calls / Math.max(g.explore.requests, 1)).toFixed(2), single: pct(g.explore.single, g.explore.requests), avgContextK: Math.round(g.explore.context / Math.max(g.explore.requests, 1) / 1000) },
    avgContextK: Math.round((g.usage.input + g.usage.cacheWrite5m + g.usage.cacheWrite1h + g.usage.cacheRead) / Math.max(g.requests, 1) / 1000),
  };
}
const q = (p) => +(ratios[Math.floor(ratios.length * p)] ?? 0).toFixed(2);
const out = { window: [new Date(from).toISOString(), new Date(to).toISOString()], charsPerToken: +charsPerToken.toFixed(2), calibration: { samples: ratios.length, p25: q(0.25), p75: q(0.75) }, boundedLines, transcripts: sessions.length, groups: {} };
for (const [key, g] of Object.entries(groups).sort((a, b) => b[1].cost - a[1].cost)) out.groups[key] = summary(g);
const file = arg('json');
if (file) writeFileSync(file, JSON.stringify(out, null, 1));
const row = (k, s) => `${k.padEnd(34)} ${String(s.sessions).padStart(4)} ${String(s.costUsd).padStart(9)}  explore ${String(s.exploreShare).padStart(5)}% (content ${s.exploreContentShare}%, trips ${s.exploreTripShare}%)  loc ${s.byKind.locate} read ${s.byKind.read} mem ${s.byKind.memory} git ${s.byKind.git} view ${s.byKind.view}  ceiling ${s.ceiling.strict}-${s.ceiling.withConsult}%`;
console.log(`window ${out.window.join(' → ')}  chars/token ${out.charsPerToken} (p25 ${out.calibration.p25}, p75 ${out.calibration.p75}, n ${out.calibration.samples})  bounded read ${boundedLines} lines  transcripts ${out.transcripts}`);
for (const [k, s] of Object.entries(out.groups)) console.log(row(k, s));
console.log('ceiling (all):', JSON.stringify(out.groups.all.ceiling), 'episodes:', JSON.stringify(out.groups.all.episodes));
