// What a keep-alive would have cost and saved: a "ping" re-reads an idle conversation's prefix before its 1-hour cache
// entry expires (a forked, unsaved resume: the conversation itself gains nothing). Replays the main conversations of
// the dataset: every pause longer than the TTL that was followed by a request is a rewrite a ping chain could have
// turned into a read; every pause, followed or not, costs its pings.
// With --gate, a ping is sent only while the hub is in use: another hub session made a request since the last ping
// (or since the pause began). Nights and finished days then cost one ping at most.
//   node scripts/cache-study/keepalive.mjs [--gate] [--every 45] [--min 100000] [--ping-write 400] [--ping-out 60]
import { classOf, load, priceOf, table } from './common.mjs';

const arg = (name, d) => (process.argv.includes(`--${name}`) ? Number(process.argv[process.argv.indexOf(`--${name}`) + 1]) : d);
const EVERY = arg('every', 45) * 60e3; // Under the hour by the length of a long request: the lifetime counts from its start.
const TTL = 60 * 60e3;
const MIN_CTX = arg('min', 100_000); // Conversations under this many tokens are left to expire.
const PING_WRITE = arg('ping-write', 400); // Tokens a ping writes (its own prompt and the notes around it).
const PING_OUT = arg('ping-out', 60);
const GATE = process.argv.includes('--gate');
const HORIZONS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 48];

const { files, requests, until } = load();
const end = Math.min(until, Math.max(...requests.map((r) => r.t)));
const byFile = new Map();
for (const r of requests) if (r.u && !files[r.f].sub) (byFile.get(r.f) ?? byFile.set(r.f, []).get(r.f)).push(r);

// Every request of a hub session, subagents included: what "the hub is in use" means for the gate.
const hubTimes = requests.filter((r) => r.u && classOf(files[r.f].agentName) !== 'direct').map((r) => r.t).sort((a, b) => a - b);
function hubActive(from, to) {
  let lo = 0, hi = hubTimes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (hubTimes[mid] <= from) lo = mid + 1;
    else hi = mid;
  }
  return lo < hubTimes.length && hubTimes[lo] < to;
}

// One record per pause over the TTL: its length, the prefix that sat in cache, what the next request rewrote of it.
const pauses = [];
for (const [fi, list] of byFile) {
  list.sort((a, b) => a.t - b.t);
  const cls = classOf(files[fi].agentName);
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const next = list[i + 1];
    const gap = (next ? next.t : end) - p.t;
    if (gap <= TTL || p.ttl !== '1h') continue;
    const prefix = p.u[0] + p.u[1] + p.u[2] + p.u[3];
    if (prefix < MIN_CTX) continue;
    const price = priceOf(p.model);
    if (!price) continue;
    // A model switch or a compaction rewrites whatever the cache holds: only the same model's lost prefix counts.
    const lost = next && next.model === p.model ? Math.min(next.u[1] + next.u[2], Math.max(0, prefix - next.u[3])) : 0;
    pauses.push({ cls, t: p.t, gap, prefix, lost, resumed: !!next, price, hour: new Date(p.t).getHours() });
  }
}

/** $ of a policy "ping every EVERY while idle, for at most `hours`" on one pause, at API prices. */
function replay(p, hours) {
  const [input, output, read] = p.price;
  const allowed = Math.floor((hours * 3600e3) / EVERY);
  let pings = Math.min(allowed, Math.ceil(p.gap / EVERY) - 1);
  if (GATE) {
    let k = 0;
    while (k < pings && hubActive(p.t + k * EVERY, p.t + (k + 1) * EVERY)) k++;
    pings = k;
  }
  const warmUntil = pings * EVERY + TTL;
  const cost = (pings * (p.prefix * read + PING_WRITE * input * 2 + PING_OUT * output)) / 1e6;
  const saved = p.resumed && pings > 0 && p.gap < warmUntil ? (p.lost * (input * 2 - read)) / 1e6 : 0;
  return { pings, cost, saved, readTok: pings * p.prefix, writeTok: saved > 0 ? p.lost : 0 };
}

const days = (end - Math.min(...requests.map((r) => r.t))) / 86400e3;
const resumed = pauses.filter((p) => p.resumed);
const q = (a, f) => a.sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * f))] ?? 0;
console.log(`${days.toFixed(1)} days, main conversations, pauses over 1 h: ${pauses.length} (${resumed.length} followed by a request, ${pauses.length - resumed.length} final).`);
console.log(`Pauses followed by a request, hours: median ${(q(resumed.map((p) => p.gap), 0.5) / 3600e3).toFixed(1)}, p75 ${(q(resumed.map((p) => p.gap), 0.75) / 3600e3).toFixed(1)}, p90 ${(q(resumed.map((p) => p.gap), 0.9) / 3600e3).toFixed(1)}; rewritten after them: ${(resumed.reduce((s, p) => s + p.lost, 0) / 1e6).toFixed(1)} M tokens.`);

const classes = ['all', 'master', 'post', 'instance', 'one-off', 'direct'];
for (const cls of classes) {
  const set = cls === 'all' ? pauses : pauses.filter((p) => p.cls === cls);
  if (set.length === 0) continue;
  const rows = HORIZONS.map((h) => {
    const t = set.reduce((s, p) => {
      const r = replay(p, h);
      return { pings: s.pings + r.pings, cost: s.cost + r.cost, saved: s.saved + r.saved, readTok: s.readTok + r.readTok, writeTok: s.writeTok + r.writeTok };
    }, { pings: 0, cost: 0, saved: 0, readTok: 0, writeTok: 0 });
    return [`${h} h`, t.pings, (t.readTok / 1e6).toFixed(0), (t.writeTok / 1e6).toFixed(1), t.cost.toFixed(1), t.saved.toFixed(1), (t.saved - t.cost).toFixed(1), t.writeTok ? (t.readTok / t.writeTok).toFixed(1) : '-'];
  });
  console.log(`\n${cls} (${set.length} pauses, ${set.filter((p) => p.resumed).length} followed)`);
  console.log(table(rows, ['ping for', 'pings', 'read M', 'writes avoided M', 'cost $', 'saved $', 'net $', 'reads per write avoided']));
}

// When the pause starts (local hour): an evening pause is the night, a ping chain through it is mostly wasted.
const byHour = new Map();
for (const p of pauses) {
  const b = p.hour < 8 ? '00-08' : p.hour < 12 ? '08-12' : p.hour < 18 ? '12-18' : p.hour < 21 ? '18-21' : '21-24';
  const e = byHour.get(b) ?? { n: 0, back2: 0, back4: 0, back8: 0 };
  e.n++;
  if (p.resumed && p.gap < 2 * 3600e3) e.back2++;
  if (p.resumed && p.gap < 4 * 3600e3) e.back4++;
  if (p.resumed && p.gap < 8 * 3600e3) e.back8++;
  byHour.set(b, e);
}
console.log('\nPauses over 1 h by the local hour they start, and the share back within 2, 4 and 8 h:');
console.log(table([...byHour].sort().map(([b, e]) => [b, e.n, `${Math.round((100 * e.back2) / e.n)} %`, `${Math.round((100 * e.back4) / e.n)} %`, `${Math.round((100 * e.back8) / e.n)} %`]), ['starts', 'pauses', '< 2 h', '< 4 h', '< 8 h']));

// The other trade: the 5-minute TTL (writes at 1.25x instead of 2x) held by a ping every 4.5 minutes of silence, a
// tool that runs long included. Same replay, on every gap between two requests of a main conversation.
const SHORT = 4.5 * 60e3;
const SHORT_TTL = 5 * 60e3;
const fam = (m) => (/fable/.test(m) ? 'Fable' : /opus/.test(m) ? 'Opus' : /sonnet/.test(m) ? 'Sonnet' : 'other');
const HOURS = [0.5, 1, 2, 4];
const ttlRows = new Map(); // family -> { now, alt: [per horizon], pings: [per horizon] }
for (const [fi, list] of byFile) {
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    const price = priceOf(r.model);
    if (!price || r.ttl !== '1h') continue;
    const [input, , read] = price;
    const e = ttlRows.get(fam(r.model)) ?? ttlRows.set(fam(r.model), { now: 0, alt: HOURS.map(() => 0), pings: HOURS.map(() => 0) }).get(fam(r.model));
    const written = r.u[1] + r.u[2];
    const prev = list[i - 1];
    const gap = prev ? r.t - prev.t : 0;
    const prefix = prev ? prev.u[0] + prev.u[1] + prev.u[2] + prev.u[3] : 0;
    e.now += (written * input * 2 + r.u[3] * read) / 1e6;
    HOURS.forEach((h, k) => {
      const allowed = Math.floor((h * 3600e3) / SHORT);
      const pings = prev && prev.model === r.model ? Math.min(allowed, Math.ceil(gap / SHORT) - 1) : 0;
      // Today the prefix survives a gap up to 1 h. With the short TTL it survives while the pings last.
      const keptNow = gap <= TTL;
      const keptAlt = gap < pings * SHORT + SHORT_TTL;
      let w = written, rd = r.u[3];
      if (prev && prev.model === r.model && keptNow && !keptAlt) {
        // Lost where it was kept: what was read is written again.
        w += rd;
        rd = 0;
      } else if (prev && prev.model === r.model && !keptNow && keptAlt) {
        const back = Math.min(written, Math.max(0, prefix - r.u[3]));
        w -= back;
        rd += back;
      }
      e.alt[k] += (w * input * 1.25 + rd * read + pings * (prefix * read + PING_WRITE * input * 1.25 + PING_OUT * price[1])) / 1e6;
      e.pings[k] += pings;
    });
    // Final pause of the conversation: pings until the horizon, for nothing.
    if (i === list.length - 1) HOURS.forEach((h, k) => {
      const pings = Math.min(Math.floor((h * 3600e3) / SHORT), Math.ceil((end - r.t) / SHORT) - 1);
      const p = r.u[0] + r.u[1] + r.u[2] + r.u[3];
      e.alt[k] += (Math.max(0, pings) * (p * read + PING_WRITE * input * 1.25 + PING_OUT * price[1])) / 1e6;
      e.pings[k] += Math.max(0, pings);
    });
  }
}
console.log('\nCache cost of the main conversations ($, writes + reads): today (1 h TTL) against the 5-minute TTL held by pings for at most N hours of silence:');
console.log(table([...ttlRows].map(([f, e]) => [f, e.now.toFixed(0), ...HOURS.flatMap((h, k) => [`${e.alt[k].toFixed(0)} (${e.alt[k] >= e.now ? '+' : ''}${Math.round((100 * (e.alt[k] - e.now)) / e.now)} %)`, e.pings[k]])]), ['model', 'today', ...HOURS.flatMap((h) => [`${h} h`, 'pings'])]));
