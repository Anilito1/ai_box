// A turn the provider cut for a reason that passes on its own: when the hub asks the session to take it up again.

/** The reply errors that are the provider's own trouble. A limit, a sign-in or a refused request never is. */
const PASSING = new Set(['overloaded', 'server_error']);
/** An error the program could not name: only its wording says whether it was the network or the provider's side. */
const UNNAMED = new Set(['', 'unknown']);
const NETWORK = /ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|socket hang up|fetch failed|network error|connection error|request timed out/i;

/** `code`: the error of the reply (Agent SDK); `text`: the program's wording of how the turn ended. */
export function passingFault(code: string, text: string): boolean {
  if (PASSING.has(code)) return true;
  if (!UNNAMED.has(code)) return false;
  // A status only counts where the API states one, as in errors.ts.
  const status = Number(/(?:API Error|status(?: code)?|HTTP)\s*:?\s*(\d{3})\b/i.exec(text)?.[1] ?? 0);
  return status === 408 || status >= 500 || /overloaded/i.test(text) || NETWORK.test(text);
}

/**
 * Waits before each new try, by turns failed in a row. The program has already retried for minutes when a turn ends on
 * such an error, so these are long; past the last one the hub gives up and says so.
 */
export const FAULT_WAITS_MS = [60_000, 5 * 60_000, 15 * 60_000];

/** The wait before try number `failures`, spread by a quarter either way so that sessions cut together do not all come back at once; null once the tries are spent. */
export function faultWait(failures: number, random = Math.random()): number | null {
  const base = FAULT_WAITS_MS[failures - 1];
  return base === undefined ? null : Math.round(base * (0.75 + random * 0.5));
}
