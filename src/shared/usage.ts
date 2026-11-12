import { canonAccount } from './accounts';
import type { RateLimits, UsageState } from './types';

// The plan-limit counter: what the CLI tells, what the status bar may claim from it. No Node and no DOM.

/** How often the displayed account is asked again while the hub is open, whatever its sessions do. */
export const USAGE_POLL_MS = 3 * 60_000;
/** Between two readings of one account after a turn or a start: a burst of turns asks once. */
export const USAGE_MIN_GAP_MS = 20_000;
/** A reading older than this is not shown as a figure: the user may have spent a good deal since. */
export const USAGE_FRESH_MS = 10 * 60_000;

/** What the manager keeps of one account: its last good reading, and whether the last attempt failed. */
export interface UsageRecord {
  /** False for an account that has no plan limits (API key, third-party server): nothing is shown for it. */
  applicable: boolean;
  limits: RateLimits | null;
  /** Epoch ms of the last good reading. */
  measuredAt: number | null;
  failed: boolean;
}

export const noUsage = (): UsageRecord => ({ applicable: true, limits: null, measuredAt: null, failed: false });

/** A reading came back: `null` means the account has no plan limits to tell. */
export function usageRead(limits: RateLimits | null, now: number): UsageRecord {
  return limits ? { applicable: true, limits, measuredAt: now, failed: false } : { applicable: false, limits: null, measuredAt: null, failed: false };
}

/** An attempt failed: the last good reading stays (with its date), flagged. */
export const usageFailed = (prev: UsageRecord | undefined): UsageRecord => ({ ...(prev ?? noUsage()), applicable: prev?.applicable ?? true, failed: true });

/** What the status bar is given: null when the account has no plan limits, else what is known (possibly nothing yet). */
export const usageState = (rec: UsageRecord | undefined, plan = ''): UsageState | null =>
  rec && !rec.applicable ? null : { plan, limits: rec?.limits ?? null, measuredAt: rec?.measuredAt ?? null, failed: rec?.failed ?? false };

export type UsageWindow = 'fiveHour' | 'sevenDay' | 'fable';

const planName = (plan: string | null | undefined): string => (plan ?? '').trim().toLowerCase();

/**
 * The windows the status bar tells for an account, by its plan. Ultra plans have no 5 h window to show. Max and Ultra
 * have a weekly window of their own for Fable, shown only when the answer holds its figure: never as a zero.
 */
export function usageWindows(usage: Pick<UsageState, 'plan' | 'limits'>): UsageWindow[] {
  const plan = planName(usage.plan);
  const windows: UsageWindow[] = [];
  if (!plan.includes('ultra')) windows.push('fiveHour');
  windows.push('sevenDay');
  if ((plan.includes('max') || plan.includes('ultra')) && usage.limits?.fablePct != null) windows.push('fable');
  return windows;
}

const pct = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null;
};

const epoch = (v: unknown): number | null => {
  const ms = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms / 1000 : null;
};

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/**
 * The Fable weekly window: the `model_scoped` entry the server labels "Fable", else the scoped row of the `limits`
 * list for that model. Null when the answer holds no such figure (the account has none: nothing is shown).
 */
function fableOf(r: Record<string, unknown>): [number | null, number | null] {
  const isFable = (name: unknown) => typeof name === 'string' && name.trim().toLowerCase() === 'fable';
  const scoped = Array.isArray(r.model_scoped) ? r.model_scoped.map(obj).find((m) => isFable(m.display_name) && pct(m.utilization) !== null) : undefined;
  if (scoped) return [pct(scoped.utilization), epoch(scoped.resets_at)];
  const row = Array.isArray(r.limits)
    ? r.limits.map(obj).find((l) => l.kind === 'weekly_scoped' && isFable(obj(obj(l.scope).model).display_name) && pct(l.percent) !== null)
    : undefined;
  return row ? [pct(row.percent), epoch(row.resets_at)] : [null, null];
}

/**
 * The 5 h, 7 d and Fable figures out of the `rate_limits` of Claude Code's /usage answer (percent of the window,
 * 0-100). The window objects first; the `limits` list ("session", "weekly_all") when a window is missing. Null when
 * neither the 5 h nor the 7 d window holds a figure: the answer then says nothing, and nothing must be shown as zero.
 */
export function limitsOfUsage(raw: unknown): RateLimits | null {
  const r = obj(raw);
  const listed = (kind: string) => (Array.isArray(r.limits) ? r.limits.map(obj).find((l) => l.kind === kind) : undefined);
  const window = (key: string, kind: string): [number | null, number | null] => {
    const w = obj(r[key]);
    if (pct(w.utilization) !== null) return [pct(w.utilization), epoch(w.resets_at)];
    const l = listed(kind) ?? {};
    return [pct(l.percent), epoch(l.resets_at)];
  };
  const [fiveHourPct, fiveHourResetsAt] = window('five_hour', 'session');
  const [sevenDayPct, sevenDayResetsAt] = window('seven_day', 'weekly_all');
  if (fiveHourPct === null && sevenDayPct === null) return null;
  const [fablePct, fableResetsAt] = fableOf(r);
  return { fiveHourPct, fiveHourResetsAt, sevenDayPct, sevenDayResetsAt, ...(fablePct === null ? {} : { fablePct, fableResetsAt }) };
}

/**
 * A window's figure as it can still be claimed: null (unknown) when there is no reading, when it is too old, or when
 * the window it measured has ended since (the figure belongs to the last one, the new one starts afresh).
 */
export function windowFigure(value: number | null | undefined, resetsAt: number | null | undefined, measuredAt: number | null, now: number): number | null {
  if (value == null || measuredAt == null || now - measuredAt > USAGE_FRESH_MS) return null;
  if (resetsAt && resetsAt * 1000 <= now) return null;
  return value;
}

/**
 * The account whose limits a session's reading belongs to: the one its process was started on (fixed for the life of
 * the process), else, for a session not running, the one it would start on. "default" is resolved when the process
 * starts: the active account may change afterwards, the process keeps the access it had.
 */
export const usageAccount = (startedOn: string, wanted: string, active: string): string => startedOn || canonAccount(wanted, active);
