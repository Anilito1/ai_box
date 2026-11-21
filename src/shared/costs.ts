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
  /**
   * Main folder of the repo it worked in (a worktree counts with its repo), '' outside any repo; missing on the turns
   * logged before it was kept.
   */
  repo?: string;
  /** The mission the turn belongs to (missions log), when the hub knows it. */
  mission?: string;
  /** Effort it ran at, its length from the start of the work to the end of the turn, its tool calls and failed ones. */
  effort?: string;
  ms?: number;
  tools?: number;
  errors?: number;
  /**
   * Not a turn of its work: a keep-alive of its prompt cache (keepAlive.ts), an exploration it asked for, or a video it
   * had made (generate_video: no tokens, the provider's price as the cost of its model).
   */
  kind?: 'keepAlive' | 'explore' | 'video';
  /**
   * The provider it was spent at (shared/providers.ts: "anthropic", "deepseek", or the id of one the user added such as
   * "venice"), its costs at that provider's prices. Missing on the turns logged before it was kept: recordProvider().
   */
  provider?: string;
  /** Models whose price at that provider is not known: their tokens are real, their cost 0 is not a price. */
  unpriced?: string[];
}

/**
 * A mission as the hub hands it out: a worker's first task (`start`) or more work on the same one (`follow`, a
 * relaunch). `by`: who chose its model, the user (on the worker), its post, the master, or nobody (it kept its own).
 */
export interface MissionEvent {
  at: number;
  mission: string;
  /** Hub session id and name of the worker. */
  id: string;
  name: string;
  kind: 'start' | 'follow';
  model: string;
  effort: string;
  by: 'user' | 'post' | 'master' | 'auto';
  /** A follow-up the master sent because the delivery before it had failed. */
  retry?: true;
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

/** `{"t":…,"id":…,"n":…,"r":…,"m":{"model":[cost,input,output,cacheRead,cacheWrite]},"w":repo,"p":provider,"up":[model]}` */
export function encodeRecord(r: TurnRecord): string {
  const m = Object.fromEntries(Object.entries(r.models).map(([model, u]) => [model, FIELDS.map((f) => (f === 'cost' ? +u[f].toFixed(8) : u[f]))]));
  const extra = { mi: r.mission, e: r.effort, d: r.ms, k: r.tools, x: r.errors, kd: r.kind, p: r.provider, up: r.unpriced?.length ? r.unpriced : undefined };
  return JSON.stringify({ t: r.at, id: r.id, n: r.name, r: r.role, m, ...(r.repo === undefined ? {} : { w: r.repo }), ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined)) });
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
  const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  const unpriced = Array.isArray(o.up) ? o.up.filter((x): x is string => typeof x === 'string' && Object.hasOwn(models, x)) : [];
  const extra = {
    mission: typeof o.mi === 'string' ? o.mi : undefined,
    effort: typeof o.e === 'string' ? o.e : undefined,
    ms: count(o.d),
    tools: count(o.k),
    errors: count(o.x),
    kind: o.kd === 'keepAlive' || o.kd === 'explore' || o.kd === 'video' ? (o.kd as TurnRecord['kind']) : undefined,
    provider: typeof o.p === 'string' && o.p ? o.p : undefined,
    unpriced: unpriced.length > 0 ? unpriced : undefined,
  };
  return { at: o.t, id: o.id, name: o.n, role: o.r as CostRole, models, ...(typeof o.w === 'string' ? { repo: o.w } : {}), ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined)) };
}

// ---------- providers: where a turn was spent ----------

/** Model names that say their provider, for the turns logged before it was kept. */
const FAMILIES: [RegExp, string][] = [
  [/^(claude-|(opus|sonnet|haiku|fable)\b)/i, 'anthropic'],
  [/^(gpt-|o\d|chatgpt-|codex)/i, 'openai'],
  [/^gemini-/i, 'gemini'],
  [/^deepseek-/i, 'deepseek'],
];

/**
 * The provider of a turn: the one it was logged with; else (logged before it was kept) the provider that lists one of
 * its models now (`known`: a provider the user added), or the one its models' names say. Anthropic when nothing says
 * otherwise: the hub ran on Claude alone before it had other providers.
 */
export function recordProvider(r: Pick<TurnRecord, 'provider' | 'models'>, known?: (model: string) => string | undefined): string {
  if (r.provider) return r.provider;
  for (const model of Object.keys(r.models)) {
    const listed = known?.(model);
    if (listed) return listed;
    const family = FAMILIES.find(([re]) => re.test(model));
    if (family) return family[1];
  }
  return 'anthropic';
}

/** The turns spent at one provider. */
export const ofProvider = (records: TurnRecord[], provider: string) => records.filter((r) => recordProvider(r) === provider);

/** All the tokens of a usage: input, output, cache read and written. */
export const tokenCount = (u: Usage) => u.input + u.output + u.cacheRead + u.cacheWrite;

const BY: MissionEvent['by'][] = ['user', 'post', 'master', 'auto'];

export const encodeMission = (e: MissionEvent) => JSON.stringify({ t: e.at, mi: e.mission, id: e.id, n: e.name, k: e.kind, m: e.model, e: e.effort, by: e.by, ...(e.retry ? { rt: 1 } : {}) });

/** A line written by encodeMission(), or null. */
export function decodeMission(line: string): MissionEvent | null {
  let o: Record<string, unknown> | null;
  try {
    o = JSON.parse(line) as Record<string, unknown> | null;
  } catch {
    return null;
  }
  if (!o || typeof o.t !== 'number' || typeof o.mi !== 'string' || typeof o.id !== 'string' || typeof o.n !== 'string') return null;
  if ((o.k !== 'start' && o.k !== 'follow') || !BY.includes(o.by as MissionEvent['by'])) return null;
  return { at: o.t, mission: o.mi, id: o.id, name: o.n, kind: o.k, model: String(o.m ?? ''), effort: String(o.e ?? ''), by: o.by as MissionEvent['by'], ...(o.rt === 1 ? { retry: true as const } : {}) };
}

/** One mission in the cost panel: who ran it, how, what it cost with its subagents, and how it went. */
export interface MissionRow {
  mission: string;
  name: string;
  model: string;
  effort: string;
  by: MissionEvent['by'];
  cost: number;
  turns: number;
  /** More work sent after the first task; `retries`: those sent because a delivery had failed. */
  follows: number;
  retries: number;
  ms: number;
  tools: number;
  errors: number;
  lastAt: number;
}

/** The missions of a period, costliest first: their turns (subagents included in a turn's cost) and their events. */
export function missionRows(records: TurnRecord[], events: MissionEvent[]): MissionRow[] {
  const rows = new Map<string, MissionRow>();
  for (const e of [...events].sort((a, b) => a.at - b.at)) {
    const row = rows.get(e.mission) ?? { mission: e.mission, name: e.name, model: e.model, effort: e.effort, by: e.by, cost: 0, turns: 0, follows: 0, retries: 0, ms: 0, tools: 0, errors: 0, lastAt: e.at };
    if (e.kind === 'follow') row.follows++;
    if (e.retry) row.retries++;
    if (e.model) row.model = e.model;
    if (e.effort) row.effort = e.effort;
    rows.set(e.mission, row);
  }
  for (const r of records) {
    const row = r.mission ? rows.get(r.mission) : undefined;
    if (!row) continue;
    row.cost += sumUsage(r.models).cost;
    if (!r.kind) row.turns++;
    row.ms += r.ms ?? 0;
    row.tools += r.tools ?? 0;
    row.errors += r.errors ?? 0;
    row.lastAt = Math.max(row.lastAt, r.at);
    if (!row.effort && r.effort) row.effort = r.effort;
  }
  return [...rows.values()].filter((r) => r.turns > 0).sort((a, b) => b.cost - a.cost);
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

/** What one repo spent, all its sessions and worktrees together. */
export interface RepoCostRow {
  /** Main folder of the repo; '' for the turns outside any repo, or logged before the repo was kept. */
  key: string;
  label: string;
  usage: Usage;
  turns: number;
  /** The sessions that worked in it, most expensive first. */
  sessions: Pick<CostRow, 'label' | 'role'>[];
}

/** What has no known price: the tokens of models no price is known for, the videos made without one. In no cost. */
export interface Unpriced {
  tokens: number;
  videos: number;
}

/** What one model spent, its videos included (a video model makes no tokens). */
export interface ModelCostRow {
  model: string;
  usage: Usage;
  videos: number;
  unpriced: Unpriced;
}

/** What one provider spent, at its own prices. */
export interface ProviderCostRow {
  /** Its id (recordProvider()). */
  key: string;
  usage: Usage;
  turns: number;
  videos: number;
  unpriced: Unpriced;
}

export interface CostSummary {
  total: Usage;
  turns: number;
  videos: number;
  /** Not in `total.cost`. */
  unpriced: Unpriced;
  /** Most expensive first. */
  sessions: CostRow[];
  /** Most expensive first, the turns outside any repo last. */
  repos: RepoCostRow[];
  /** Most expensive first, then the most tokens: a model without a price costs nothing known. */
  models: ModelCostRow[];
}

const noUnpriced = (): Unpriced => ({ tokens: 0, videos: 0 });

/** What of a turn's models has no known price. */
function unpricedOf(r: TurnRecord): Unpriced {
  const out = noUnpriced();
  for (const model of r.unpriced ?? []) {
    const u = r.models[model];
    if (!u) continue;
    if (r.kind === 'video') out.videos++;
    else out.tokens += tokenCount(u);
  }
  return out;
}

const addUnpriced = (a: Unpriced, b: Unpriced): Unpriced => ({ tokens: a.tokens + b.tokens, videos: a.videos + b.videos });

/** The providers of the range, most expensive first (then the most tokens), each at its own prices. */
export function byProvider(records: TurnRecord[], range: Range): ProviderCostRow[] {
  const rows = new Map<string, ProviderCostRow>();
  for (const r of records) {
    if (r.at < range.from || r.at >= range.to) continue;
    const key = recordProvider(r);
    const row = rows.get(key) ?? { key, usage: ZERO, turns: 0, videos: 0, unpriced: noUnpriced() };
    rows.set(key, {
      key,
      usage: addUsage(row.usage, sumUsage(r.models)),
      turns: row.turns + (r.kind ? 0 : 1),
      videos: row.videos + (r.kind === 'video' ? 1 : 0),
      unpriced: addUnpriced(row.unpriced, unpricedOf(r)),
    });
  }
  return [...rows.values()].sort((a, b) => b.usage.cost - a.usage.cost || tokenCount(b.usage) - tokenCount(a.usage) || a.key.localeCompare(b.key));
}

/** The models of the range, most expensive first, then the most tokens. */
function modelRows(records: TurnRecord[], range: Range): ModelCostRow[] {
  const rows = new Map<string, ModelCostRow>();
  for (const r of records) {
    if (r.at < range.from || r.at >= range.to) continue;
    const unpriced = new Set(r.unpriced ?? []);
    for (const [model, u] of Object.entries(r.models)) {
      const row = rows.get(model) ?? { model, usage: ZERO, videos: 0, unpriced: noUnpriced() };
      const video = r.kind === 'video' ? 1 : 0;
      const none = unpriced.has(model) ? { tokens: video ? 0 : tokenCount(u), videos: video } : noUnpriced();
      rows.set(model, { model, usage: addUsage(row.usage, u), videos: row.videos + video, unpriced: addUnpriced(row.unpriced, none) });
    }
  }
  return [...rows.values()].sort((a, b) => b.usage.cost - a.usage.cost || tokenCount(b.usage) - tokenCount(a.usage) || b.videos - a.videos || a.model.localeCompare(b.model));
}

/** Last folder of a path, Windows or POSIX. */
const folderName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;

export function summarize(records: TurnRecord[], range: Range): CostSummary {
  const sessions = new Map<string, CostRow>();
  const named = new Map<string, number>();
  const byModel = new Map<string, Map<string, number>>();
  let total = ZERO;
  let turns = 0;
  let videos = 0;
  let unpriced = noUnpriced();
  for (const r of records) {
    if (r.at < range.from || r.at >= range.to) continue;
    const spent = sumUsage(r.models);
    total = addUsage(total, spent);
    const turn = r.kind ? 0 : 1;
    turns += turn;
    if (r.kind === 'video') videos++;
    unpriced = addUnpriced(unpriced, unpricedOf(r));
    const s = sessions.get(r.id) ?? { key: r.id, label: r.name, role: r.role, usage: ZERO, turns: 0, models: [] };
    // Its latest name wins: a session renamed keeps one row.
    const latest = r.at >= (named.get(r.id) ?? 0);
    if (latest) named.set(r.id, r.at);
    sessions.set(r.id, { ...s, ...(latest ? { label: r.name, role: r.role } : {}), usage: addUsage(s.usage, spent), turns: s.turns + turn });
    const costs = byModel.get(r.id) ?? new Map<string, number>();
    for (const [model, u] of Object.entries(r.models)) costs.set(model, (costs.get(model) ?? 0) + u.cost);
    byModel.set(r.id, costs);
  }
  const rows = [...sessions.values()].map((s) => ({ ...s, models: [...(byModel.get(s.key) ?? [])].sort((a, b) => b[1] - a[1]).map(([model]) => model) }));
  rows.sort((a, b) => b.usage.cost - a.usage.cost || a.label.localeCompare(b.label));
  return { total, turns, videos, unpriced, sessions: rows, repos: byRepo(records, range, rows), models: modelRows(records, range) };
}

/** The turns of the range by repo; `sessions` (most expensive first) orders the names of each row. */
function byRepo(records: TurnRecord[], range: Range, sessions: CostRow[]): RepoCostRow[] {
  const repos = new Map<string, { usage: Usage; turns: number; ids: Set<string> }>();
  for (const r of records) {
    if (r.at < range.from || r.at >= range.to) continue;
    const key = r.repo ?? '';
    const row = repos.get(key) ?? { usage: ZERO, turns: 0, ids: new Set<string>() };
    row.ids.add(r.id);
    repos.set(key, { usage: addUsage(row.usage, sumUsage(r.models)), turns: row.turns + 1, ids: row.ids });
  }
  const rows = [...repos].map(([key, row]): RepoCostRow => ({
    key,
    label: key ? folderName(key) : '',
    usage: row.usage,
    turns: row.turns,
    sessions: sessions.filter((s) => row.ids.has(s.key)).map((s) => ({ label: s.label, role: s.role })),
  }));
  return rows.sort((a, b) => Number(!a.key) - Number(!b.key) || b.usage.cost - a.usage.cost || a.label.localeCompare(b.label));
}

/** What the turns of one day cost; `day` is its local midnight. */
export interface DayCost {
  day: number;
  cost: number;
  /** Its turns and videos of which a part has no known price (in no cost). */
  unpriced?: number;
}

/** Local midnight of the day of `at`. */
export const dayOf = (at: number) => midnight(new Date(at));

/** "claude-opus-5-5" → "Opus 5.5", "claude-sonnet-4-5-20250929[1m]" → "Sonnet 4.5 (1M)"; anything else as is. */
export function modelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i.exec(id);
  if (!m) return id;
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  return `${family} ${m[2]}${m[3] ? `.${m[3]}` : ''}${m[4] ? ' (1M)' : ''}`;
}