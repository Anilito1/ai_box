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

export type Period = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'custom';
export const PERIODS: Period[] = ['today', 'yesterday', '7d', '30d', 'month', 'custom'];

/** [from, to) in ms. */
export interface Range {
  from: number;
  to: number;
}

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Midnight of a day, `offset` days after `d` (a day lasts 23 or 25 hours when the clocks change). */
const midnight = (d: Date, offset = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset).getTime();
const pad = (n: number) => String(n).padStart(2, '0');

/** "2026-10-26": the local day of a time. */
export const dayKey = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Local midnight of "YYYY-MM-DD", or null when it is not a real date. */
export function parseDay(key: string): number | null {
  const m = DAY_KEY.exec(key);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return dayKey(d.getTime()) === key ? d.getTime() : null;
}

/** The days a period covers, up to the end of today; a custom one takes two days in any order, both included. */
export function periodRange(period: Period, now: Date, custom?: { from: string; to: string }): Range | null {
  switch (period) {
    case 'today':
      return { from: midnight(now), to: midnight(now, 1) };
    case 'yesterday':
      return { from: midnight(now, -1), to: midnight(now) };
    case '7d':
      return { from: midnight(now, -6), to: midnight(now, 1) };
    case '30d':
      return { from: midnight(now, -29), to: midnight(now, 1) };
    case 'month':
      return { from: new Date(now.getFullYear(), now.getMonth(), 1).getTime(), to: midnight(now, 1) };
    case 'custom': {
      const a = custom ? parseDay(custom.from) : null;
      const b = custom ? parseDay(custom.to) : null;
      if (a === null || b === null) return null;
      return { from: Math.min(a, b), to: midnight(new Date(Math.max(a, b)), 1) };
    }
  }
}

// ---------- aggregation, when the panel opens ----------

export interface CostRow {
  key: string;
  label: string;
  role: CostRole | null;
  usage: Usage;
  turns: number;
}

export interface Bucket {
  /** Day key, or the hour ("00" to "23") of a one-day period. */
  key: string;
  start: number;
  usage: Usage;
}

export interface CostSummary {
  total: Usage;
  turns: number;
  sessions: CostRow[];
  models: CostRow[];
  /** One bucket per day, or per hour when the period is a single day; empty ones included. */
  unit: 'day' | 'hour';
  buckets: Bucket[];
}

const byCost = (a: CostRow, b: CostRow) => b.usage.cost - a.usage.cost || a.label.localeCompare(b.label);

/** Starts of the buckets of a range: its local days, or the hours of its only day. */
function bucketStarts(range: Range): { unit: 'day' | 'hour'; starts: number[] } {
  const first = new Date(range.from);
  const days: number[] = [];
  for (let i = 0; midnight(first, i) < range.to; i++) days.push(midnight(first, i));
  if (days.length !== 1) return { unit: 'day', starts: days };
  const hours: number[] = [];
  for (let h = 0; h < 24; h++) hours.push(new Date(first.getFullYear(), first.getMonth(), first.getDate(), h).getTime());
  // A day the clocks go back has an hour twice: a bucket per distinct start.
  return { unit: 'hour', starts: [...new Set(hours)].filter((s) => s < range.to) };
}

export function summarize(records: TurnRecord[], range: Range): CostSummary {
  const sessions = new Map<string, CostRow>();
  const models = new Map<string, CostRow>();
  const named = new Map<string, number>();
  const { unit, starts } = bucketStarts(range);
  const buckets: Bucket[] = starts.map((start) => ({ key: unit === 'day' ? dayKey(start) : pad(new Date(start).getHours()), start, usage: ZERO }));
  let total = ZERO;
  let turns = 0;
  for (const r of records) {
    if (r.at < range.from || r.at >= range.to) continue;
    const spent = sumUsage(r.models);
    total = addUsage(total, spent);
    turns++;
    const s = sessions.get(r.id) ?? { key: r.id, label: r.name, role: r.role, usage: ZERO, turns: 0 };
    // Its latest name wins: a session renamed keeps one row.
    const latest = r.at >= (named.get(r.id) ?? 0);
    if (latest) named.set(r.id, r.at);
    sessions.set(r.id, { ...s, ...(latest ? { label: r.name, role: r.role } : {}), usage: addUsage(s.usage, spent), turns: s.turns + 1 });
    for (const [model, u] of Object.entries(r.models)) {
      const m = models.get(model) ?? { key: model, label: model, role: null, usage: ZERO, turns: 0 };
      models.set(model, { ...m, usage: addUsage(m.usage, u), turns: m.turns + 1 });
    }
    // The last bucket starting at or before the turn.
    let i = buckets.length - 1;
    while (i > 0 && buckets[i].start > r.at) i--;
    if (buckets[i]) buckets[i] = { ...buckets[i], usage: addUsage(buckets[i].usage, spent) };
  }
  return { total, turns, sessions: [...sessions.values()].sort(byCost), models: [...models.values()].sort(byCost), unit, buckets };
}

/** "claude-opus-5-5" → "Opus 5.5", "claude-sonnet-4-5-20250929[1m]" → "Sonnet 4.5 (1M)"; anything else as is. */
export function modelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i.exec(id);
  if (!m) return id;
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  return `${family} ${m[2]}${m[3] ? `.${m[3]}` : ''}${m[4] ? ' (1M)' : ''}`;
}

/** A spreadsheet cell: quoted when it holds the separator, and never read as a formula. */
const cell = (v: string | number, sep: string) => {
  const s = String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return safe.includes(sep) || /["\n\r]/.test(safe) ?`"${safe.replace(/"/g, '""')}"` : safe;
};

/**
 * One line per turn and model, oldest first, local time. `;` with decimal commas is what a spreadsheet set to French
 * reads, `,` an English one.
 */
export function toCsv(records: TurnRecord[], range: Range, header: string[], sep: ',' | ';' = ','): string {
  const cost = (v: number) => (sep === ';' ? v.toFixed(6).replace('.', ',') : v.toFixed(6));
  const lines = [header.map((h) => cell(h, sep)).join(sep)];
  const time = (at: number) => {
    const d = new Date(at);
    return `${dayKey(at)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  for (const r of [...records].sort((a, b) => a.at - b.at)) {
    if (r.at < range.from || r.at >= range.to) continue;
    for (const [model, u] of Object.entries(r.models)) {
      lines.push([time(r.at), r.name, r.role, model, cost(u.cost), u.input, u.output, u.cacheRead, u.cacheWrite].map((v) => cell(v, sep)).join(sep));
    }
  }
  return `${lines.join('\r\n')}\r\n`;
}
