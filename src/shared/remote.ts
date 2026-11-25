import type { AccountKind, Provider, RemoteView } from './types';

// Remote Control: a Claude Code session driven from claude.ai/code or the Claude app as well. Claude Code keeps the
// connection; the hub only turns it on or off when the user asks, and shows what the program says of it.

/**
 * Remote Control needs Claude Code signed in to claude.ai: a Claude account, or the user's own sign-in unless the
 * settings give the sessions an API key. A key, a compatible server or another provider cannot have it.
 */
export const remoteCapable = (kind: AccountKind | 'default', provider: Provider) => kind === 'claude' || (kind === 'default' && provider !== 'api-key');

/** The session's page as Claude Code gives it, kept only when it is claude.ai's: anything else is neither shown nor opened. */
export function remoteLink(url: unknown): string {
  if (typeof url !== 'string' || url.length > 500) return '';
  try {
    const u = new URL(url);
    const host = u.hostname === 'claude.ai' || u.hostname.endsWith('.claude.ai');
    return u.protocol === 'https:' && host && !u.username && !u.password && !u.port ? u.href : '';
  } catch {
    return '';
  }
}

/** A state after which Claude Code's connection to claude.ai is gone for good: it is never retried on its own. */
export const remoteEnds = (state: string) => state === 'failed' || state === 'policy_disabled';

/**
 * Remote Control after a state Claude Code reports (`bridge_state`: ready, connected, reconnecting, failed,
 * policy_disabled): null once it has ended. While it is being turned on or off, the answer to that request says how it
 * ended: a state only moves the connection.
 */
export function remoteAfter(view: RemoteView, state: string): RemoteView | null {
  const connected = state === 'connected' ? true : state === 'ready' || state === 'reconnecting' || remoteEnds(state) ? false : view.connected;
  if (view.state === 'starting' || view.state === 'stopping') return { ...view, connected };
  if (remoteEnds(state)) return null;
  const next = state === 'reconnecting' ? 'reconnecting' : state === 'connected' || state === 'ready' ? 'on' : view.state;
  return { ...view, connected, state: next };
}
