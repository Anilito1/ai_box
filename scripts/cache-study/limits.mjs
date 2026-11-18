// How the plan counts tokens: the hub's plan-limit readings (usage/limits-*.jsonl, written when a figure changes) set
// against what was spent in the same minutes: the requests of the transcripts when load.mjs has run (each at its own
// time, sessions outside the hub and subagents included), else the hub's turns (usage/turns-*.jsonl), which only count
// when a turn ends: an hour-long turn then lands in the wrong interval. First what one point of the week is worth at API prices
// (a sum over the intervals, which whole-point readings allow early), then, with enough intervals, the fit of the rise
// on the tokens of each kind (input, cache write, cache read, output).
//
// Two things spoil the readings, both handled here. A second source writes a figure that lags behind (a lower weekly
// percentage inside the same week): dropped. And the account is also used where the hub does not see it (another
// computer, the Claude apps): an interval whose rise the hub's turns cannot explain is set aside, not fitted.
//   node scripts/cache-study/limits.mjs [--dir <usage dir>] [--account a-xxxx] [--hours 2] [--turns] [--detail]
import fs from 'node:fs';
import path from 'node:path';
import { costOf, DATA } from './common.mjs';

const arg = (name, d) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : d);
const dir = arg('dir', path.join(process.env.APPDATA ?? '', 'claude-hub', 'usage'));
const minHours = Number(arg('hours', 2));
const lines = (prefix) => fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).sort()
  .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));

const readings = lines('limits-').filter((r) => r.d7 != null);
if (readings.length < 3) {
  console.log(`${readings.length} plan-limit readings in ${dir}: the hub writes them from this version on, come back after a few days of use.`);
  process.exit(0);
}
const accounts = [...new Set(readings.map((r) => r.a))];
const account = arg('account', accounts[0]);
// The turn log names no account: the fit takes every Claude turn as this account's. True with one Anthropic account.
if (accounts.length > 1) console.log(`Readings from ${accounts.length} accounts (${accounts.join(', ')}): Claude turns are not tied to one, the fit below is only right if ${account} ran them all.`);
const week = (r) => Math.round(r.r7 / 60);
const mine = [];
for (const r of readings.filter((x) => x.a === account).sort((a, b) => a.t - b.t)) {
  const last = mine.at(-1);
  if (last && week(r) === week(last) && r.d7 < last.d7) continue; // The lagging source.
  mine.push(r);
}
// What was spent, as { t, model, u: [input, write 5 min, write 1 h, read, output] }. Claude models only: the readings
// are an Anthropic account's.
const fromRequests = !process.argv.includes('--turns') && fs.existsSync(DATA);
const spends = fromRequests
  ? JSON.parse(fs.readFileSync(DATA, 'utf8')).requests.filter((r) => r.u).map((r) => ({ t: r.t, model: r.rmodel || r.model, u: r.u }))
  // A turn: [cost, input, output, cacheRead, cacheWrite], its writes taken at the 1-hour rate (the main conversations' one).
  : lines('turns-').flatMap((turn) => Object.entries(turn.m).map(([model, a]) => ({ t: turn.t, model, u: [a[1], 0, a[4], a[3], a[2]] })));
const claude = spends.filter((e) => String(e.model).startsWith('claude-')).sort((a, b) => a.t - b.t);
const last = claude.at(-1)?.t ?? 0;
console.log(fromRequests ? `Spend: ${claude.length} requests of the transcripts, until ${new Date(last).toISOString().slice(0, 16)}Z.` : `Spend: ${claude.length} turn records of the hub (run load.mjs for the requests).`);

/** Tokens (input, write, read, output, in millions) and API $ spent in (from, to], Fable's apart. */
function spent(from, to) {
  const x = [0, 0, 0, 0];
  let api = 0, fable = 0;
  for (const e of claude) {
    if (e.t <= from || e.t > to) continue;
    x[0] += e.u[0] / 1e6;
    x[1] += (e.u[1] + e.u[2]) / 1e6;
    x[2] += e.u[3] / 1e6;
    x[3] += e.u[4] / 1e6;
    const c = costOf(e.model, e.u);
    api += c;
    if (e.model.includes('fable')) fable += c;
  }
  return { x, api, fable };
}

// One interval per rise of the weekly figure, inside one week (the reset date did not change).
const steps = [];
let start = mine[0];
for (const reading of mine.slice(1)) {
  // A reading without the Fable gauge keeps the last one known.
  const r = { ...reading, fb: reading.fb ?? start.fb };
  if (week(r) !== week(start)) {
    start = r;
    continue;
  }
  if (r.t > last) break; // Past what the spend covers.
  if (r.d7 === start.d7 && (r.fb ?? 0) === (start.fb ?? 0)) continue;
  steps.push({ from: start.t, to: r.t, dy: r.d7 - start.d7, dfb: (r.fb ?? 0) - (start.fb ?? 0), ...spent(start.t, r.t) });
  start = r;
}
// A rise the hub's turns cannot explain: the Fable gauge moved with no Fable turn here, or the week jumped two points
// or more for under a quarter of what a point costs over the rest. Used elsewhere, not seen here. One point alone
// proves nothing: a whole-point reading ticks over on a small spend as well as on a large one.
const total = (list, key) => list.reduce((sum, s) => sum + s[key], 0);
let seen = steps.filter((s) => !(s.dfb >= 2 && s.fable === 0));
for (;;) {
  const usual = total(seen, 'api') / Math.max(1, total(seen, 'dy'));
  const kept = seen.filter((s) => s.dy < 2 || s.api / s.dy >= usual / 4);
  if (kept.length === seen.length) break;
  seen = kept;
}
const elsewhere = steps.filter((s) => !seen.includes(s));
if (process.argv.includes('--detail')) for (const s of steps) console.log(`${new Date(s.from).toISOString().slice(5, 16)} +${((s.to - s.from) / 60e3).toFixed(0).padStart(4)} min  week +${s.dy}  fable +${s.dfb}  spent $${s.api.toFixed(1).padStart(6)} (Fable $${s.fable.toFixed(1)})${seen.includes(s) ? '' : '  set aside'}`);
const hours = (list) => (list.reduce((sum, s) => sum + s.to - s.from, 0) / 3600e3).toFixed(1);
console.log(`Account ${account}: ${mine.length} readings kept of ${readings.filter((r) => r.a === account).length}, ${steps.length} rises of a figure over ${hours(steps)} h.`);
if (elsewhere.length) console.log(`Set aside, used where the hub does not see it: ${elsewhere.length} interval(s), ${hours(elsewhere)} h, +${total(elsewhere, 'dy')} points of the week for $${total(elsewhere, 'api').toFixed(0)} spent here.`);
const dy = total(seen, 'dy');
if (dy < 2) {
  console.log('Not enough clean rises yet.');
  process.exit(0);
}
// Each reading is a whole point: the true rise over the kept span is within one point of the sum.
const api = total(seen, 'api');
console.log(`One point of the week = $${(api / dy).toFixed(0)} at API prices (between ${(api / (dy + 1)).toFixed(0)} and ${(api / (dy - 1)).toFixed(0)}): ${dy} points for $${api.toFixed(0)} over ${hours(seen)} h. The whole week: about $${((100 * api) / dy).toFixed(0)}.`);
const dfb = total(seen, 'dfb');
if (dfb >= 2) console.log(`One point of the Fable gauge = $${(total(seen, 'fable') / dfb).toFixed(1)} of Fable turns (between ${(total(seen, 'fable') / (dfb + 1)).toFixed(1)} and ${(total(seen, 'fable') / (dfb - 1)).toFixed(1)}).`);

// The fit by kind of token needs intervals long enough for whole points to mean something, and enough of them.
const rows = [];
let acc = null;
for (const s of seen) {
  acc = acc ? { from: acc.from, to: s.to, dy: acc.dy + s.dy, x: acc.x.map((v, i) => v + s.x[i]), api: acc.api + s.api } : { ...s };
  if (elsewhere.some((e) => e.from >= acc.from && e.to <= s.to)) acc = null; // A gap inside: start over.
  else if (acc.to - acc.from >= minHours * 3600e3) {
    rows.push(acc);
    acc = null;
  }
}
console.log(`${rows.length} clean intervals of ${minHours} h or more for the fit by kind of token (8 needed).`);
if (rows.length < 8) process.exit(0);

function ols(X, y) {
  const k = X[0].length;
  const A = Array.from({ length: k }, () => new Array(k).fill(0));
  const b = new Array(k).fill(0);
  X.forEach((x, n) => x.forEach((xi, i) => {
    b[i] += xi * y[n];
    x.forEach((xj, j) => (A[i][j] += xi * xj));
  }));
  for (let i = 0; i < k; i++) {
    for (let r = i + 1; r < k; r++) {
      const m = A[r][i] / A[i][i];
      for (let j = i; j < k; j++) A[r][j] -= m * A[i][j];
      b[r] -= m * b[i];
    }
  }
  const c = new Array(k).fill(0);
  for (let i = k - 1; i >= 0; i--) c[i] = (b[i] - A[i].slice(i + 1).reduce((s, a, j) => s + a * c[i + 1 + j], 0)) / A[i][i];
  return c;
}
const r2 = (X, y, c) => {
  const mean = y.reduce((s, v) => s + v, 0) / y.length;
  const tot = y.reduce((s, v) => s + (v - mean) ** 2, 0);
  const res = y.reduce((s, v, n) => s + (v - X[n].reduce((t, xi, i) => t + xi * c[i], 0)) ** 2, 0);
  return 1 - res / tot;
};
const y = rows.map((r) => r.dy);
const byKind = rows.map((r) => r.x);
const cKind = ols(byKind, y);
const byApi = rows.map((r) => [r.api]);
const cApi = ols(byApi, y);
console.log(`Weekly % per million tokens: input ${cKind[0].toFixed(3)}, cache write ${cKind[1].toFixed(3)}, cache read ${cKind[2].toFixed(4)}, output ${cKind[3].toFixed(3)} (R² ${r2(byKind, y, cKind).toFixed(2)})`);
console.log(`Relative to a cache write: read ${(cKind[2] / cKind[1]).toFixed(3)}, output ${(cKind[3] / cKind[1]).toFixed(2)}`);
console.log(`"Counts the API price": weekly % per $ ${cApi[0].toFixed(3)} (R² ${r2(byApi, y, cApi).toFixed(2)})`);
