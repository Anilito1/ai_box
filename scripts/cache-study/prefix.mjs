// What every conversation pays before its first word: system blocks, tool definitions and the reminders of the first
// message, in characters, converted to tokens with a ratio fitted on the conversations' first requests.
//   node scripts/cache-study/prefix.mjs
import { classOf, load, table } from './common.mjs';

const { files, requests, shapes, openers } = load();
const byId = new Map(requests.map((r) => [`${r.f}:${r.id}`, r]));
const firstReq = new Map();
for (const r of requests) if (!r.base && !firstReq.has(r.f)) firstReq.set(r.f, r);

const toolGroup = (name) => (name.startsWith('mcp__hub__') ? 'tools:hub' : name.startsWith('mcp__') ? `tools:mcp` : 'tools:builtin');
const rows = [];
for (const o of openers) {
  const f = files[o.f];
  const r = firstReq.get(o.f);
  const s = shapes[o.shape];
  if (!r?.u || !s || o.msgs.some((m) => !m)) continue;
  const tokens = r.u[0] + r.u[1] + r.u[2] + r.u[3];
  const parts = {};
  const add = (k, n) => (parts[k] = (parts[k] ?? 0) + n);
  s.sys.forEach((b, i) => add(`system[${i}]`, b.len));
  for (const t of s.tools) add(t.defer ? 'tools:deferred' : toolGroup(t.name), t.len);
  for (const m of o.msgs) {
    for (const b of m.blocks) {
      if (m.role !== 'user') add('assistant', b.len);
      else if (b.parts) for (const [k, n] of Object.entries(b.parts)) add(`msg:${k}`, n);
      else add(`msg:${b.kind}`, b.len);
    }
  }
  const sys = s.sys.reduce((a, b) => a + b.len, 0);
  const tools = s.tools.reduce((a, b) => a + b.len, 0);
  const msgs = Object.entries(parts).filter(([k]) => k.startsWith('msg:') || k === 'assistant').reduce((a, [, n]) => a + n, 0);
  rows.push({ cls: f.sub ? 'subagent' : classOf(f.agentName), tokens, sys, tools, msgs, parts, nTools: s.tools.length, nMcp: s.tools.filter((t) => t.name.startsWith('mcp__') && !t.name.startsWith('mcp__hub__')).length, cr: r.u[3] });
}

// Least squares: tokens = a*sys + b*tools + c*msgs (characters per token differ for prose and JSON schemas).
function fit(data) {
  const X = data.map((d) => [d.sys, d.tools, d.msgs]);
  const y = data.map((d) => d.tokens);
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], B = [0, 0, 0];
  X.forEach((x, k) => x.forEach((xi, i) => {
    B[i] += xi * y[k];
    x.forEach((xj, j) => (A[i][j] += xi * xj));
  }));
  // Gaussian elimination, 3x3.
  for (let i = 0; i < 3; i++) {
    for (let k = i + 1; k < 3; k++) {
      const m = A[k][i] / A[i][i];
      for (let j = i; j < 3; j++) A[k][j] -= m * A[i][j];
      B[k] -= m * B[i];
    }
  }
  const c = [0, 0, 0];
  for (let i = 2; i >= 0; i--) c[i] = (B[i] - A[i].slice(i + 1).reduce((s, a, j) => s + a * c[i + 1 + j], 0)) / A[i][i];
  return c;
}
const coef = fit(rows);
const err = rows.map((d) => Math.abs(d.sys * coef[0] + d.tools * coef[1] + d.msgs * coef[2] - d.tokens) / d.tokens).sort((a, b) => a - b);
console.log(`${rows.length} first requests. Tokens per character: system ${coef[0].toFixed(3)} (${(1 / coef[0]).toFixed(2)} ch/tok), tools ${coef[1].toFixed(3)} (${(1 / coef[1]).toFixed(2)} ch/tok), messages ${coef[2].toFixed(3)} (${(1 / coef[2]).toFixed(2)} ch/tok); median error ${(100 * err[Math.floor(err.length / 2)]).toFixed(1)}%`);
const tok = (k, n) => Math.round(n * (k.startsWith('tools') ? coef[1] : k.startsWith('system') ? coef[0] : coef[2]));
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
for (const cls of ['master', 'post', 'instance', 'one-off', 'subagent']) {
  const set = rows.filter((r) => r.cls === cls);
  if (!set.length) continue;
  const keys = [...new Set(set.flatMap((r) => Object.keys(r.parts)))].sort();
  console.log(`\n${cls}: ${set.length} conversations, first prompt median ${Math.round(median(set.map((r) => r.tokens)) / 1e3)}K tokens (read from cache at start: median ${Math.round(median(set.map((r) => r.cr)) / 1e3)}K), tools median ${median(set.map((r) => r.nTools))} of which MCP ${median(set.map((r) => r.nMcp))}`);
  console.log(table(keys.map((k) => {
    const vals = set.map((r) => r.parts[k] ?? 0);
    const present = vals.filter((v) => v > 0).length;
    return [k, `${present}/${set.length}`, median(vals.filter((v) => v > 0)), tok(k, median(vals.filter((v) => v > 0)))];
  }).sort((a, b) => b[3] - a[3]), ['block', 'present', 'median chars', '~tokens']));
}
