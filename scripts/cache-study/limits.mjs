// How the plan counts tokens: the hub's plan-limit readings (usage/limits-*.jsonl, written when a figure changes) set
// against the turns of the same hours (usage/turns-*.jsonl). Fits the rise of the weekly figure on the tokens of each
// kind (input, cache write, cache read, output) and compares with "the plan counts the API price".
//   node scripts/cache-study/limits.mjs [--dir <usage dir>] [--account a-xxxx] [--hours 2]
import fs from 'node:fs';
import path from 'node:path';
import { costOf } from './common.mjs';

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
const mine = readings.filter((r) => r.a === account).sort((a, b) => a.t - b.t);
// Claude turns only: the readings are an Anthropic account's.
const turns = lines('turns-').filter((r) => Object.keys(r.m).some((m) => m.startsWith('claude-')));

// Intervals of at least `minHours` inside one weekly window (the reset date did not change).
const rows = [];
let start = mine[0];
for (const r of mine.slice(1)) {
  if (r.r7 !== start.r7) {
    start = r;
    continue;
  }
  if (r.t - start.t < minHours * 3600e3) continue;
  const x = [0, 0, 0, 0];
  let api = 0;
  for (const turn of turns) {
    if (turn.t <= start.t || turn.t > r.t) continue;
    for (const [model, a] of Object.entries(turn.m)) {
      if (!model.startsWith('claude-')) continue;
      // [cost, input, output, cacheRead, cacheWrite] -> input, write, read, output
      x[0] += a[1];
      x[1] += a[4];
      x[2] += a[3];
      x[3] += a[2];
      api += costOf(model, [a[1], 0, a[4], a[3], a[2]]); // writes counted at the 1-hour rate, the main conversations' one
    }
  }
  rows.push({ dy: r.d7 - start.d7, x: x.map((v) => v / 1e6), api });
  start = r;
}
console.log(`Account ${account}: ${mine.length} readings, ${rows.length} intervals of ${minHours} h or more (weekly %, tokens in millions).`);
if (rows.length < 5) process.exit(0);

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
