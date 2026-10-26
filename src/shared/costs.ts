/** Which kind of hub session spent it: the master, a post's own worker, an extra instance of a post, an ad-hoc worker. */
export type CostRole = 'master' | 'post' | 'instance' | 'worker';
export const COST_ROLES: CostRole[] = ['master', 'post', 'instance', 'worker'];

/** Cost (USD, as Claude Code estimates it) and tokens of one model. */
export interface Usage {
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Running totals of one Claude Code conversation, as its results carry them. */
export interface Totals {
  cost: number;
  models: Record<string, Usage>;
}

/** What one turn of one session spent, per model. */
export interface TurnRecord {
  at: number;
  /** Hub session id, and its name at the time. */
  id: string;
  name: string;
  role: CostRole;
  models: Record<string, Usage>;
}

export const ZERO: Usage = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const FIELDS = ['cost', 'input', 'output', 'cacheRead', 'cacheWrite'] as const;

export const addUsage = (a: Usage, b: Usage): Usage => ({
  cost: a.cost + b.cost,
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
});

export const sumUsage = (models: Record<string, Usage>): Usage => Object.values(models).reduce(addUsage, ZERO);

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/** Totals from a result's `total_cost_usd` and `modelUsage` (or the /usage API's `model_usage`). */
export function totalsOf(cost: number, modelUsage: Record<string, unknown> | undefined): Totals {
  const models: Record<string, Usage> = {};
  for (const [model, raw] of Object.entries(modelUsage ?? {})) {
    const u = (raw ?? {}) as Record<string, unknown>;
    models[model] = {
      cost: num(u.costUSD),
      input: num(u.inputTokens),
      output: num(u.outputTokens),
      cacheRead: num(u.cacheReadInputTokens),
      cacheWrite: num(u.cacheCreationInputTokens),
    };
  }
  return { cost: num(cost), models };
}

/**
 * What a turn spent: its result's running totals minus the previous ones of the same conversation (null: none yet).
 * Totals that went down were reset (a new conversation in the same process): the turn counts from zero. Null when
 * nothing was spent (a local command such as /context).
 */
export function turnDelta(prev: Totals | null, cur: Totals): Record<string, Usage> | null {
  const base = prev && cur.cost + 1e-9 >= prev.cost ? prev.models : {};
  const out: Record<string, Usage> = {};
  for (const [model, u] of Object.entries(cur.models)) {
    const p = base[model];
    const d = p && FIELDS.every((f) => u[f] + 1e-9 >= p[f]) ? (Object.fromEntries(FIELDS.map((f) => [f, u[f] - p[f]])) as unknown as Usage) : u;
    if (FIELDS.some((f) => d[f] > 1e-9)) out[model] = d;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ---------- storage: one JSON line per turn ----------

/** `{"t":…,"id":…,"n":…,"r":…,"m":{"model":[cost,input,output,cacheRead,cacheWrite]}}` */
export function encodeRecord(r: TurnRecord): string {
  const m = Object.fromEntries(Object.entries(r.models).map(([model, u]) => [model, FIELDS.map((f) => (f === 'cost' ? +u[f].toFixed(8) : u[f]))]));
  return JSON.stringify({ t: r.at, id: r.id, n: r.name, r: r.role, m });
}

/** A line written by encodeRecord(), or null for anything else (a torn last line, a hand-edited file). */
export function decodeRecord(line: string): TurnRecord | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o.t !== 'number' || !Number.isFinite(o.t) || typeof o.id !== 'string' || typeof o.n !== 'string') return null;
  if (!COST_ROLES.includes(o.r as CostRole) || !o.m || typeof o.m !== 'object') return null;
  const models: Record<string, Usage> = {};
  for (const [model, arr] of Object.entries(o.m as Record<string, unknown>)) {
    if (!Array.isArray(arr) || arr.length !== FIELDS.length) return null;
    models[model] = Object.fromEntries(FIELDS.map((f, i) => [f, num(arr[i])])) as unknown as Usage;
  }
  return { at: o.t, id: o.id, name: o.n, role: o.r as CostRole, models };
}

// ---------- periods, in the computer's own time zone ----------

export type Period = 'today' | '7d' | '30d' | 'month';
export const PERIODS: Period[] = ['today', '7d', '30d', 'month'];

/** [from, to) in ms. */
export interface Range {
  from: number;
  to: number;
}

/** Midnight of a day, `offset` days after `d` (a day lasts 23 or 25 hours when the clocks change). */
const midnight = (d: Date, offset = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset).getTime();

/** The days a period covers, up to the end of today. */
export function periodRange(period: Period, now: Date): Range {
  const to = midnight(now, 1);
  switch (period) {
    case 'today':
      return { from: midnight(now), to };
    case '7d':
      return { from: midnight(now, -6), to };
    case '30d':
      return { from: midnight(now, -29), to };
    case 'month':
      return { from: new Date(now.getFullYear(), now.getMonth(), 1).getTime(), to };
  }
}

// ---------- aggregation, when the panel opens ----------

export interface CostRow {
  key: string;
  label: string;
  role: CostRole;
  usage: Usage;
  turns: number;
  /** Models used, most expensive first. */
  models: string[];
}

export interface CostSummary {
  total: Usage;
  turns: number;
  /** Most expensive first. */
  sessions: CostRow[];
}

export function summarize(records: TurnRecord[], range: Range): CostSummary {
  const sessions = new Map<string, CostRow>();
  const named = new Map<string, number>();
  const byModel = new Map<string, Map<string, number>>();
  let total = ZERO;
  let turns = 0;
  for (const r of records) {
    if (r.at < range.from || r.at >= range.to) continue;
    const spent = sumUsage(r.models);
    total = addUsage(total, spent);
    turns++;
    const s = sessions.get(r.id) ?? { key: r.id, label: r.name, role: r.role, usage: ZERO, turns: 0, models: [] };
    // Its latest name wins: a session renamed keeps one row.
    const latest = r.at >= (named.get(r.id) ?? 0);
    if (latest) named.set(r.id, r.at);
    sessions.set(r.id, { ...s, ...(latest ? { label: r.name, role: r.role } : {}), usage: addUsage(s.usage, spent), turns: s.turns + 1 });
    const costs = byModel.get(r.id) ?? new Map<string, number>();
    for (const [model, u] of Object.entries(r.models)) costs.set(model, (costs.get(model) ?? 0) + u.cost);
    byModel.set(r.id, costs);
  }
  const rows = [...sessions.values()].map((s) => ({ ...s, models: [...(byModel.get(s.key) ?? [])].sort((a, b) => b[1] - a[1]).map(([model]) => model) }));
  return { total, turns, sessions: rows.sort((a, b) => b.usage.cost - a.usage.cost || a.label.localeCompare(b.label)) };
}

/** "claude-opus-5-5" → "Opus 5.5", "claude-sonnet-4-5-20250929[1m]" → "Sonnet 4.5 (1M)"; anything else as is. */
export function modelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i.exec(id);
  if (!m) return id;
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  return `${family} ${m[2]}${m[3] ? `.${m[3]}` : ''}${m[4] ? ' (1M)' : ''}`;
}