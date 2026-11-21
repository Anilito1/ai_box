// A turn the provider cut for a reason that passes on its own: when the hub asks the session to take it up again.

/** The reply errors that are the provider's own trouble. A limit, a sign-in or a refused request never is. */
const PASSING = new Set(['overloaded', 'server_error']);
/** An error the program could not name: only its wording says whether it was the network or the provider's side. */
const UNNAMED = new Set(['', 'unknown']);
/**
 * A connection that broke: the system's codes, and the programs' own wording of a reply cut on the way (Claude Code:
 * "Connection lost mid-response", "Connection to the API was lost (ECONNRESET)", "Your computer went to sleep…", "The
 * response stopped arriving"; Codex: responseStreamDisconnected; Node's fetch: "terminated", "other side closed").
 */
const NETWORK =
  /ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ECONNABORTED|EAI_AGAIN|ENETUNREACH|ENETDOWN|EHOSTUNREACH|EPIPE|UND_ERR_SOCKET|socket hang up|other side closed|\bterminated\b|fetch failed|network error|connection error|request timed out|connection (?:to the api )?(?:was )?lost|went to sleep|stopped arriving|never arrived|response stalled|stream ?disconnected|(?:http|stream) ?connection ?failed|error sending request/i;

/** What cut a turn: the connection (back as soon as the network is), or the provider's side (back in its own time). */
export type FaultKind = 'network' | 'provider';

/** `code`: the error of the reply (Agent SDK); `text`: the program's wording of how the turn ended. Null: not a cut that passes. */
export function faultKind(code: string, text: string): FaultKind | null {
  if (!PASSING.has(code) && !UNNAMED.has(code)) return null;
  if (NETWORK.test(text)) return 'network';
  if (PASSING.has(code)) return 'provider';
  // A status only counts where the API states one, as in errors.ts.
  const status = Number(/(?:API Error|status(?: code)?|HTTP)\s*:?\s*(\d{3})\b/i.exec(text)?.[1] ?? 0);
  return status === 408 || status >= 500 || /overloaded/i.test(text) ? 'provider' : null;
}

export function passingFault(code: string, text: string): boolean {
  return faultKind(code, text) !== null;
}

/**
 * Waits before each new try, by turns failed in a row. The program has already retried for minutes when a turn ends on
 * such an error, so these are long; past the last one the hub gives up and says so.
 */
export const FAULT_WAITS_MS = [60_000, 5 * 60_000, 15 * 60_000];

/**
 * A connection cut: the program does not retry a reply cut on the way, and a network that switches (a Wi-Fi that
 * drops, a phone's hotspot) is back within seconds. The hub also tries at once when it sees the network change, and
 * a try never counts while the computer is offline.
 */
export const NETWORK_WAITS_MS = [3_000, 15_000, 60_000, 3 * 60_000, 10 * 60_000];

export const waitsOf = (kind: FaultKind): number[] => (kind === 'network' ? NETWORK_WAITS_MS : FAULT_WAITS_MS);

/** The wait before try number `failures`, spread by a quarter either way so that sessions cut together do not all come back at once; null once the tries are spent. */
export function faultWait(failures: number, random = Math.random(), waits = FAULT_WAITS_MS): number | null {
  const base = waits[failures - 1];
  return base === undefined ? null : Math.round(base * (0.75 + random * 0.5));
}
