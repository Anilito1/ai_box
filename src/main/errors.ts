/**
 * Errors the settings screen explains to the user travel as short codes: `network` (offline, DNS, timeout),
 * `unauthorized` (a token or key refused), `http-<status>`, or a code of the API that failed. Anything else keeps its
 * message.
 */
export class CodedError extends Error {}

export function errorCode(err: unknown): string {
  if (err instanceof CodedError) return err.message;
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'network';
  // fetch() fails with a bare TypeError when the request never got an answer.
  if (err instanceof TypeError && /fetch failed|network/i.test(err.message)) return 'network';
  return err instanceof Error ? err.message : String(err);
}

/** Code of an HTTP answer that is not a success. */
export const httpCode = (status: number) =>
  status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 429 ? 'rate-limited' : `http-${status}`;
