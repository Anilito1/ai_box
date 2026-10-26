import { isAccountRef } from './accounts';
import type { AccountKind } from './types';

// Automatic fallback: when an account reaches a limit, its sessions go on with the next account of a chain the user
// wrote. No Node and no DOM: the settings screen and the main process share these rules.

export interface FallbackStep {
  /** An account id, or "default". */
  account: string;
  /** The model this step runs on; empty = the account's own default (or the session's, if the account takes it). */
  model: string;
}

/** `back`: when a session returns to its own account once it is available again. */
export type FallbackBack = 'message' | 'idle' | 'never';
export const FALLBACK_BACKS: FallbackBack[] = ['message', 'idle', 'never'];

export interface FallbackConfig {
  enabled: boolean;
  chain: FallbackStep[];
  /** Accounts billed per token that the user agreed to fall back on (an API key spends money). */
  paidOk: string[];
  back: FallbackBack;
}

export const CHAIN_MAX = 8;
export const FALLBACK_DEFAULTS: FallbackConfig = { enabled: false, chain: [], paidOk: [], back: 'message' };
const MODEL = /^\w[\w.:/@+-]{0,119}$/;

export const isFallback = (v: unknown): v is FallbackConfig => {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  if (typeof o.enabled !== 'boolean' || !FALLBACK_BACKS.includes(o.back as FallbackBack)) return false;
  if (!Array.isArray(o.chain) || o.chain.length > CHAIN_MAX || !Array.isArray(o.paidOk) || o.paidOk.length > CHAIN_MAX * 4 || !o.paidOk.every(isAccountRef)) return false;
  const seen = new Set<string>();
  for (const step of o.chain as Record<string, unknown>[]) {
    if (!step || typeof step.account !== 'string' || !isAccountRef(step.account) || seen.has(step.account)) return false;
    if (typeof step.model !== 'string' || (step.model !== '' && !MODEL.test(step.model))) return false;
    seen.add(step.account);
  }
  return true;
};

/** Accounts billed by the token (an API key): falling back on one costs money, so it needs the user's word. */
export const isPaid = (kind: AccountKind | 'default') => kind === 'anthropic-key' || kind === 'openai' || kind === 'anthropic-compatible';

// ---------- cooldowns ----------

export type LimitKind = 'rate' | 'quota' | 'overloaded' | 'auth';
/** How long an account is left alone when its provider did not say when it opens again. */
export const COOLDOWN_MS: Record<LimitKind, number> = { rate: 5 * 60_000, quota: 30 * 60_000, overloaded: 2 * 60_000, auth: 60 * 60_000 };
const MARGIN_MS = 15_000;
const MAX_MS = 8 * 86_400_000;

/** Which accounts are limited, and until when. Time is given, never read: tests and the main process agree. */
export class Cooldowns {
  private readonly until = new Map<string, { at: number; kind: LimitKind }>();

  /** Records a limit; `resetsAt` is in epoch seconds, as providers tell it. Returns when the account opens again (ms). */
  set(account: string, signal: { kind: LimitKind; resetsAt: number | null }, now: number): number {
    const told = signal.resetsAt && signal.resetsAt * 1000 > now ? signal.resetsAt * 1000 + MARGIN_MS : 0;
    const at = Math.min(now + MAX_MS, told || now + COOLDOWN_MS[signal.kind]);
    // A later opening wins: a weekly limit is not shortened by a 5-hour one.
    const known = this.until.get(account);
    const next = known && known.at > at && known.at > now ? known : { at, kind: signal.kind };
    this.until.set(account, next);
    return next.at;
  }

  limitedUntil(account: string, now: number): number | null {
    const e = this.until.get(account);
    if (!e) return null;
    if (e.at <= now) {
      this.until.delete(account);
      return null;
    }
    return e.at;
  }

  kindOf(account: string): LimitKind | null {
    return this.until.get(account)?.kind ?? null;
  }

  clear(account: string): void {
    this.until.delete(account);
  }

  /** What survives a restart. */
  state(): Record<string, { at: number; kind: LimitKind }> {
    return Object.fromEntries(this.until);
  }

  /** Reads `state()` back, keeping what is still in the future. */
  restore(raw: unknown, now: number): void {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, { at?: unknown; kind?: unknown }>;
    for (const [account, e] of Object.entries(o)) {
      if (!isAccountRef(account) || typeof e?.at !== 'number' || e.at <= now || e.at > now + MAX_MS) continue;
      if (e.kind === 'rate' || e.kind === 'quota' || e.kind === 'overloaded' || e.kind === 'auth') this.until.set(account, { at: e.at, kind: e.kind });
    }
  }
}

// ---------- choices ----------

/**
 * The account a limited session goes on with: the chain's next step after its own, then the ones before it, skipping
 * accounts that are limited too or that cannot be used (gone, billed per token without the user's word).
 */
export function pickTarget(i: { chain: FallbackStep[]; from: string; limited(account: string): boolean; usable(account: string): boolean }): FallbackStep | null {
  const k = i.chain.findIndex((s) => s.account === i.from);
  const order = k < 0 ? i.chain : [...i.chain.slice(k + 1), ...i.chain.slice(0, k)];
  return order.find((s) => s.account !== i.from && i.usable(s.account) && !i.limited(s.account)) ?? null;
}

export type ReturnWhen = 'now' | 'wait';
/**
 * Whether a session on a fallback account goes back to its own: the own account must be open again. `message`: when
 * the next message comes; `idle`: as soon as the session has nothing to do; `never`: it stays where it is.
 */
export function returnDue(i: { back: FallbackBack; homeLimited: boolean; settled: boolean; message: boolean }): ReturnWhen {
  if (i.homeLimited || i.back === 'never' || !i.settled) return 'wait';
  if (i.back === 'idle') return 'now';
  return i.message ? 'now' : 'wait';
}
