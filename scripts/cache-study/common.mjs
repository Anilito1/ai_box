// Shared by the analysis scripts: the dataset written by load.mjs, session classes, API-equivalent prices.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DATA = process.env.CACHE_STUDY_DATA ?? path.join(process.env.AIBOX_SCRATCH_DIR ?? os.tmpdir(), 'cache-study', 'requests.json');
export const load = () => JSON.parse(fs.readFileSync(DATA, 'utf8'));

/**
 * $ per million tokens: input, output, cache read (platform.claude.com/docs/en/about-claude/pricing, 2026-11-17).
 * Writes are 1.25x input (5 min) and 2x input (1 h) on every model. Haiku 5.5: prompts up to 100K tokens.
 */
const PRICES = {
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-sonnet-5-5': [2, 10, 0.1],
  'claude-fable-5-1': [10, 50, 0.25],
  'claude-fable-5-2': [8, 40, 0.2],
  'claude-haiku-5-5': [0.1, 0.5, 0.01],
  'claude-opus-5': [5, 25, 0.5],
  'claude-sonnet-5': [2, 10, 0.2],
};
export const priceOf = (model) => PRICES[String(model).replace(/\[1m\]$/, '')] ?? null;
/** [in, cw5, cw1, cr, out] -> $ at API prices. */
export function costOf(model, u) {
  const p = priceOf(model);
  if (!p || !u) return 0;
  const [i, o, r] = p;
  return (u[0] * i + u[1] * i * 1.25 + u[2] * i * 2 + u[3] * r + u[4] * o) / 1e6;
}

function teamNames() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA ?? '', 'claude-hub', 'config.json'), 'utf8'));
    return (cfg.team ?? []).map((r) => r.name).sort((a, b) => b.length - a.length);
  } catch {
    return [];
  }
}
const TEAM = teamNames();
/** master | post | instance | one-off | direct, from the hub's session name (the hub names them hub-<name>). */
export function classOf(agentName) {
  if (!agentName) return 'direct';
  if (agentName === 'hub-maitre') return 'master';
  const n = agentName.replace(/^hub-/, '');
  if (TEAM.includes(n)) return 'post';
  if (TEAM.some((t) => n.startsWith(`${t}-`))) return 'instance';
  return 'one-off';
}
/** The post a session belongs to (itself for a post, its post for an instance). */
export function postOf(agentName) {
  const n = String(agentName).replace(/^hub-/, '');
  return TEAM.find((t) => n === t || n.startsWith(`${t}-`)) ?? '';
}

export const sum = (a, b) => a.map((x, i) => x + (b?.[i] ?? 0));
export const ZERO = [0, 0, 0, 0, 0];
export const M = (n) => (n / 1e6).toFixed(1);
export const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) : '0.0');
export function table(rows, cols) {
  const w = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => r.map((x, i) => (i === 0 ? String(x).padEnd(w[i]) : String(x).padStart(w[i]))).join('  ');
  return [line(cols), ...rows.map(line)].join('\n');
}
