import { t } from './i18n';

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

/**
 * What a session's failure means for the user, in a short sentence of the interface's language; the raw message goes
 * to a "Details" fold beside it, never into the sentence.
 */
export function humanError(raw: string): string {
  // A status only counts where the API states one ("API Error: 529", "status 401"), not any number (a stack's line).
  const status = Number(/(?:API Error|status(?: code)?|HTTP)\s*:?\s*(\d{3})\b/i.exec(raw)?.[1] ?? 0);
  if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|socket hang up|fetch failed|network error/i.test(raw)) return t('error.network');
  if (status === 429 || status === 529 || /overloaded|rate.?limit|usage limit/i.test(raw)) return t('error.overloaded');
  if (status === 402 || /credit balance|billing/i.test(raw)) return t('error.billing');
  if (status === 401 || /unauthori[sz]ed|authentication_error|invalid.{0,20}api.?key|oauth token|token.{0,20}(expired|revoked)|please run \/login/i.test(raw)) return t('error.auth');
  if (/prompt is too long|context.{0,20}(length|window|limit)|too many tokens/i.test(raw)) return t('error.tooLong');
  if (status >= 500 || /internal server error|api_error/i.test(raw)) return t('error.server');
  return t('error.unknown');
}

/** The error code an assistant message may carry (Agent SDK), said for the user. */
export function assistantError(code: string): string {
  const known: Record<string, Parameters<typeof t>[0]> = {
    authentication_failed: 'error.auth',
    billing_error: 'error.billing',
    rate_limit: 'error.overloaded',
    invalid_request: 'error.request',
    server_error: 'error.server',
    max_output_tokens: 'error.output',
    context_exceeded: 'error.tooLong',
  };
  return t(known[code] ?? 'error.unknown');
}

/** Code of an HTTP answer that is not a success. */
export const httpCode = (status: number) =>
  status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 429 ? 'rate-limited' : `http-${status}`;
