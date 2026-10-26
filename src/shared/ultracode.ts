import { versionAtLeast } from './version';

// Ultracode: Claude Code's standing "dynamic workflows" mode. With it on, the session writes and runs a workflow (many
// subagents in parallel, its work checked before it comes back) for every task of weight, at any effort level.
// Claude Code reads it from the `ultracode` key of its settings (--settings, or applyFlagSettings in a live session).
// It needs workflows (on by default except on Pro) and a model that takes the xhigh effort. No Node and no DOM.

/**
 * Where a session's Ultracode choice can be made: `allowed` Max (and the other plans on which workflows are on by
 * default); `unknown` the plan is not read (shown, off); `outdated` the Claude Code installed is older than
 * ULTRACODE_MIN_VERSION (shown, off); `hidden` a Pro plan, or an account that is not Claude Code's.
 */
export type UltracodeAccess = 'allowed' | 'unknown' | 'outdated' | 'hidden';

/** The first Claude Code with Ultracode as a switch of its own (`ultracode` setting, kept at any effort level). */
export const ULTRACODE_MIN_VERSION = '2.1.284';

/**
 * What the account's plan (the `subscriptionType` Claude Code reports: "max", "pro", "team", "enterprise") allows.
 * Pro keeps workflows off unless the user turns them on in Claude Code's own /config: not offered here. A plan that
 * is not read (API key, cloud provider, program not asked yet) leaves the choice shown but off.
 */
export function ultracodeAccess(plan: string | null | undefined, version = ''): UltracodeAccess {
  const p = (plan ?? '').trim().toLowerCase();
  if (!p) return 'unknown';
  if (p === 'pro' || p === 'free') return 'hidden';
  // A version that could not be read does not block: Claude Code itself refuses what it cannot do.
  return version && !versionAtLeast(version, ULTRACODE_MIN_VERSION) ? 'outdated' : 'allowed';
}
