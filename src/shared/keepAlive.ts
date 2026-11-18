import type { CostRole } from './costs';

// Prompt-cache keep-alive. A conversation's cached prefix lives one hour after the last request that read it; the
// request after a longer pause pays the whole context again as a cache write (40 to 80 times the price of reading
// it). A "ping" reads the prefix before it expires, from a forked copy of the conversation that is never saved: the
// conversation itself gains nothing, its cache gets another hour.
//
// The figures come from the replay of 15 days of use (scripts/cache-study/keepalive.mjs). The master comes back from
// most of its pauses (21 of 29 over 100K tokens), whatever their length; a one-off worker from a quarter of them,
// within a few hours; a post or one of its instances seldom, and then within the next hour. A conversation under 100K
// tokens brings 1 % of the gain for 60 % of the pings. No Node and no DOM.

/**
 * A ping goes out between these two ages of the last read. The cache lives 60 minutes from the start of the request
 * that read it, and the hub only knows when that request's reply came in: the margin is the length of a long request.
 */
export const KEEP_ALIVE_EVERY_MS = 45 * 60_000;
export const KEEP_ALIVE_TOO_LATE_MS = 55 * 60_000;
/** Pings in a row without a real reply between them: about 8 hours of silence for the master, 3 for a one-off worker. */
export const KEEP_ALIVE_MAX_PINGS: Record<CostRole, number> = { master: 10, worker: 4, post: 1, instance: 1 };
export const KEEP_ALIVE_MIN_TOKENS = 100_000;
/** Keep-alives running at once: each is a Claude Code process. The others go at the next sweep, still in their window. */
export const MAX_PINGS = 2;

export interface KeepAliveState {
  role: CostRole;
  /** When the provider last read this conversation's prefix: its last reply, or its last ping. 0 = never. */
  warmAt: number;
  /** Pings since the last real reply. */
  pings: number;
  contextTokens: number;
}

export type KeepAliveVerdict = 'ping' | 'wait' | 'expired' | 'spent' | 'small';

/**
 * What to do with an idle conversation now. `expired`: the time passed without a ping (the computer slept, the hub
 * was closed), the cache may be gone and a ping would then pay the full write for nothing. `spent`: the pause outlasted
 * the pings this role gets. `small`: not worth a process.
 */
export function keepAlive(s: KeepAliveState, now: number): KeepAliveVerdict {
  if (s.contextTokens < KEEP_ALIVE_MIN_TOKENS) return 'small';
  if (s.warmAt <= 0 || now - s.warmAt >= KEEP_ALIVE_TOO_LATE_MS) return 'expired';
  if (s.pings >= KEEP_ALIVE_MAX_PINGS[s.role]) return 'spent';
  return now - s.warmAt >= KEEP_ALIVE_EVERY_MS ? 'ping' : 'wait';
}

/**
 * Whether a ping did its job, from its own usage: it read the conversation instead of writing it. A ping that wrote
 * most of the context found the cache cold (expired, or a prefix that no longer matches): the next ones would only
 * keep warm what this one paid, so the caller stops.
 */
export function pingRead(usage: { read: number; written: number }): boolean {
  return usage.read > 0 && usage.written < usage.read;
}

/**
 * The Claude Code a session was launched with, as found on disk: a ping starts that program again, and an updated
 * one sends another prompt, which would pay the whole write the ping is there to avoid. '' when it cannot be told.
 */
export function programStamp(executable: string, stat: (path: string) => { size: number; mtimeMs: number }): string {
  if (!executable) return 'bundled';
  try {
    const st = stat(executable);
    return `${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {
    return '';
  }
}

/** A ping may start the session's program again only when it is the one the session was launched with. */
export const sameProgram = (atLaunch: string, now: string) => atLaunch !== '' && atLaunch === now;
