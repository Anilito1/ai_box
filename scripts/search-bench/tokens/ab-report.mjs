// Paired A/B of the exploration arms of missions.mjs against `current`: requests, tokens, cost, adoption, success and
// time, with 95 % intervals, overall and by kind of mission. The cost is also given for other context sizes and other
// models of the asking session, from each session's own counts (requests, tokens written, read and produced).
//   node scripts/search-bench/tokens/ab-report.mjs <out.jsonl> <missions.json> [--pad 205000] [--context 0,181000]
// --pad      tokens of padding each request of a padded session carried (BENCH_PAD_TOKENS as measured)
// --context  the context sizes to price the run at (0 = the bench's own small context)
import { readFileSync } from 'node:fs';

const [file, missionsFile] = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const PAD = Number(arg('pad', '0'));
const CONTEXTS = arg('context', '0,181000').split(',').map(Number);
// Dollars per million tokens: input, cache write (1 h, what Claude Code asks for), cache read, output.
const PRICES = { sonnet: { in: 2, write: 4, read: 0.1, out: 10 }, opus: { in: 4, write: 8, read: 0.2, out: 20 }, fable: { in: 8, write: 16, read: 0.2, out: 40 } };

const kinds = new Map(JSON.parse(readFileSync(missionsFile, 'utf8')).map((m) => [m.id, m.kind ?? 'explore']));
const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.mission && r.costUsd && !r.error);
const by = new Map(rows.map((r) => [`${r.mission}|${r.arm}`, r]));
const arms = [...new Set(rows.map((r) => r.arm))].filter((a) => a !== 'current');

/** The padding a session's requests carried: a run without BENCH_PAD_TOKENS has none. */
const padOf = (r) => (r.padTokens ? PAD : 0);

/**
 * What a session costs with `context` tokens of earlier conversation in every request, on a given model of the asking
 * session: its own tokens without the bench's padding, the context read from the cache each time, and the helper.
 */
function priced(r, context, model) {
  const p = PRICES[model];
  // The first session of an arm wrote the padding to the cache; the others read it.
  const pad = padOf(r);
  const padWritten = pad && r.cacheCreation > pad ? pad : 0;
  const write = r.cacheCreation - padWritten;
  const read = r.cacheRead - (r.requests * pad - padWritten);
  return (r.input * p.in + write * p.write + read * p.read + r.output * p.out + r.requests * context * p.read) / 1e6 + (r.helperUsd ?? 0);
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
const sd = (xs) => Math.sqrt(xs.reduce((a, x) => a + (x - mean(xs)) ** 2, 0) / Math.max(xs.length - 1, 1));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)] ?? NaN;
// Two-sided 95 % t quantiles by degrees of freedom.
const T = [0, 12.71, 4.3, 3.18, 2.78, 2.57, 2.45, 2.36, 2.31, 2.26, 2.23, 2.2, 2.18, 2.16, 2.14, 2.13, 2.12, 2.11, 2.1, 2.09, 2.09, 2.08, 2.07, 2.07, 2.06, 2.06, 2.06, 2.05, 2.05, 2.05, 2.04];
const half = (xs) => ((T[Math.min(xs.length - 1, 30)] ?? 1.96) * sd(xs)) / Math.sqrt(xs.length);
const ci = (xs, unit = '%', scale = 100, digits = 1) => `${(scale * mean(xs)).toFixed(digits)} ${unit} [${(scale * (mean(xs) - half(xs))).toFixed(digits)} ; ${(scale * (mean(xs) + half(xs))).toFixed(digits)}]`;
/** The saving on the whole set (sum of the arm over sum of the baseline), with an interval by bootstrap over missions. */
function total(pairs, f) {
  const ratio = (ps) => ps.reduce((a, [, b]) => a + f(b), 0) / ps.reduce((a, [x]) => a + f(x), 0) - 1;
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const draws = Array.from({ length: 2000 }, () => ratio(pairs.map(() => pairs[Math.floor(rand() * pairs.length)]))).sort((a, b) => a - b);
  return `${(100 * ratio(pairs)).toFixed(1)} % [${(100 * draws[50]).toFixed(1)} ; ${(100 * draws[1949]).toFixed(1)}]`;
}

function section(name, ids, arm) {
  const pairs = ids.map((id) => [by.get(`${id}|current`), by.get(`${id}|${arm}`)]).filter(([a, b]) => a && b);
  if (pairs.length < 2) return;
  const used = pairs.filter(([, b]) => (b.helperCalls ?? 0) > 0 || (b.searchCalls ?? 0) > 0);
  console.log(`\n${arm} · ${name} : ${pairs.length} paires`);
  console.log(`  requêtes de la session   current ${mean(pairs.map(([a]) => a.requests)).toFixed(1)} · ${arm} ${mean(pairs.map(([, b]) => b.requests)).toFixed(1)} · écart apparié ${ci(pairs.map(([a, b]) => b.requests - a.requests), 'req', 1)} · total ${total(pairs, (r) => r.requests)}`);
  console.log(`  requêtes à plusieurs appels   current ${(100 * mean(pairs.map(([a]) => a.grouped / a.requests))).toFixed(0)} % · ${arm} ${(100 * mean(pairs.map(([, b]) => b.grouped / b.requests))).toFixed(0)} %`);
  console.log(`  coût mesuré (Sonnet${PAD ? `, contexte rempli de ${Math.round(PAD / 1000)} K` : ''})   current ${mean(pairs.map(([a]) => priced(a, PAD, 'sonnet'))).toFixed(3)} $ · ${arm} ${mean(pairs.map(([, b]) => priced(b, PAD, 'sonnet'))).toFixed(3)} $ · total ${total(pairs, (r) => priced(r, PAD, 'sonnet'))} · moyenne des écarts ${ci(pairs.map(([a, b]) => priced(b, PAD, 'sonnet') / priced(a, PAD, 'sonnet') - 1))}`);
  for (const context of CONTEXTS) for (const model of Object.keys(PRICES)) console.log(`  coût à ${String(Math.round(context / 1000)).padStart(3)} K de contexte, session ${model.padEnd(6)}  current ${mean(pairs.map(([a]) => priced(a, context, model))).toFixed(3)} $ · ${arm} ${mean(pairs.map(([, b]) => priced(b, context, model))).toFixed(3)} $ · total ${total(pairs, (r) => priced(r, context, model))}`);
  console.log(`  tokens propres à la mission (écrits + produits)   total ${total(pairs, (r) => r.cacheCreation - (padOf(r) && r.cacheCreation > padOf(r) ? padOf(r) : 0) + r.output)}`);
  console.log(`  aide appelée ${used.length}/${pairs.length} (${mean(pairs.map(([, b]) => b.helperCalls ?? 0)).toFixed(1)} appel, ${mean(used.map(([, b]) => b.helperUsd / Math.max(b.helperCalls, 1))).toFixed(4)} $ et ${(mean(used.map(([, b]) => (b.helperMs ?? 0) / Math.max(b.helperCalls, 1))) / 1000).toFixed(0)} s par appel) · réussite current ${pairs.filter(([a]) => a.success).length}/${pairs.length} · ${arm} ${pairs.filter(([, b]) => b.success).length}/${pairs.length}`);
  console.log(`  durée médiane   current ${median(pairs.map(([a]) => a.wallMs / 1000)).toFixed(0)} s · ${arm} ${median(pairs.map(([, b]) => b.wallMs / 1000)).toFixed(0)} s · écart apparié ${ci(pairs.map(([a, b]) => (b.wallMs - a.wallMs) / 1000), 's', 1, 0)}`);
  if (used.length >= 2 && used.length < pairs.length) console.log(`  là où l'aide est appelée (${used.length}) : requêtes ${total(used, (r) => r.requests)} · coût à ${Math.round(CONTEXTS.at(-1) / 1000)} K (opus) ${total(used, (r) => priced(r, CONTEXTS.at(-1), 'opus'))}`);
}

const ids = [...new Set(rows.map((r) => r.mission))];
// The prices against the bill Claude Code reports, on the sessions without a helper.
const plain = rows.filter((r) => !r.helperUsd);
console.log(`${rows.length} sessions · prix recalculé / facturé (sans aide) : ${(plain.reduce((a, r) => a + (r.input * 2 + r.cacheCreation * 4 + r.cacheRead * 0.1 + r.output * 10) / 1e6, 0) / plain.reduce((a, r) => a + r.costUsd, 0)).toFixed(3)} · dépense ${rows.reduce((a, r) => a + r.costUsd, 0).toFixed(2)} $`);
for (const arm of arms) {
  section('toutes', ids, arm);
  for (const k of ['explore', 'modify']) section(k, ids.filter((id) => kinds.get(id) === k), arm);
}
