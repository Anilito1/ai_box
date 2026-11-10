import { fixtureUrl, hash, type Draft, type Platform, type Publication } from './model';
import { retryAt } from './collect';
import { LocalStore } from './store';
export interface PublisherConfig { enabled: boolean; authorized: boolean; oauth: { account: string; scopes: string[]; expiresAt: number } | null; quotaRemaining: number; costAuthorized: boolean; internalAccount: boolean }
export type SubmitResult = { state: 'PUBLISHED'; remoteId: string } | { state: 'RETRY'; status: 429 | 503; retryAfter?: string } | { state: 'UNKNOWN' } | { state: 'BLOCKED'; reason: string };
// No production HTTP adapter in this foundation. Implementations must use official APIs only.
export interface Publisher { readonly simulation: boolean; submit(job: Readonly<Publication>): Promise<SubmitResult>; reconcile(job: Readonly<Publication>): Promise<{ remoteId: string } | null> }
export function publication(draft: Draft, platform: Platform, account: string): Publication {
  return { key: hash(`${platform}:${account}:${draft.storyId}:${draft.revision}`), draft, platform, account, state: 'SCHEDULED', reason: null, attempts: 0, nextAt: 0, submittedAt: null, remoteId: null };
}
export function platformGate(p: Publication, config: PublisherConfig, now: number): string | null {
  if (p.platform === 'tiktok' && config.internalAccount) return 'BLOCKED_POLICY';
  if (!config.enabled) return 'BLOCKED_PUBLISHER_DISABLED';
  if (!config.authorized || (p.platform === 'tiktok')) return 'BLOCKED_POLICY';
  if (!config.oauth || config.oauth.account !== p.account || config.oauth.expiresAt <= now || !config.oauth.scopes.includes('tweet.write')) return 'BLOCKED_OAUTH';
  if (!config.costAuthorized) return 'BLOCKED_COST';
  if (config.quotaRemaining <= 0) return 'BLOCKED_QUOTA';
  if (p.draft.fixture || p.draft.urls.some(fixtureUrl)) return 'BLOCKED_FIXTURE';
  if (!p.draft.urls.length || p.draft.label === 'D' || !Number.isFinite(p.draft.expiresAt) || p.draft.expiresAt <= now) return 'BLOCKED_EVIDENCE_STALE';
  // Conservative subset, excludes Unicode weighted-count ambiguities. Longer drafts remain local.
  const weighted = p.draft.text.replace(/https:\/\/[^\s]+/g, 'x'.repeat(23));
  if (/[^\u0000-\u10ff\u2000-\u200d\u2010-\u201f\u2032-\u2037]/u.test(weighted) || weighted.length > 280) return 'BLOCKED_TEXT_LENGTH';
  return null;
}
export async function dispatch(store: LocalStore, key: string, adapter: Publisher, config: PublisherConfig, now: number, revalidate: (draft: Draft) => string | null): Promise<Publication> {
  const job = store.transaction(() => {
    const p = store.publication(key); if (!p) throw new Error('UNKNOWN_JOB');
    if (!['SCHEDULED', 'RETRY_WAIT'].includes(p.state) || p.nextAt > now) return null;
    if (store.publications().some(other => other.key !== p.key && other.account === p.account && other.platform === p.platform && other.state === 'SUBMITTING')) return null;
    const gate = store.killed() ? 'BLOCKED_KILL_SWITCH' : platformGate(p, config, now) ?? revalidate(p.draft);
    if (gate) { store.savePublication({ ...p, state: 'BLOCKED', reason: gate }); return null; }
    if (!adapter.simulation) { store.savePublication({ ...p, state: 'BLOCKED', reason: 'BLOCKED_LIVE_ADAPTER' }); return null; }
    if (p.attempts >= 3 || !store.spend(`submit:${p.account}:${new Date(now).toISOString().slice(0, 10)}`, Math.max(0, config.quotaRemaining))) { store.savePublication({ ...p, state: 'BLOCKED', reason: 'BLOCKED_BUDGET' }); return null; }
    const submitting: Publication = { ...p, state: 'SUBMITTING', submittedAt: now, attempts: p.attempts + 1 }; store.savePublication(submitting); return submitting;
  });
  if (!job) return store.publication(key)!;
  let result: SubmitResult;
  try { result = await adapter.submit(structuredClone(job)); } catch { result = { state: 'UNKNOWN' }; }
  const next: Publication = result.state === 'PUBLISHED' ? { ...job, state: 'PUBLISHED', remoteId: result.remoteId } : result.state === 'RETRY' ? { ...job, state: job.attempts >= 3 ? 'BLOCKED' : 'RETRY_WAIT', reason: job.attempts >= 3 ? 'BLOCKED_RETRY_EXHAUSTED' : String(result.status), nextAt: Math.max(retryAt(result.retryAfter, now), now + 1000 * 2 ** job.attempts) } : { ...job, state: result.state, reason: result.state === 'BLOCKED' ? result.reason : 'AMBIGUOUS_SUBMISSION' };
  store.savePublication(next); return next;
}
export async function reconcile(store: LocalStore, key: string, adapter: Publisher, now: number): Promise<Publication> {
  const p = store.publication(key); if (!p) throw new Error('UNKNOWN_JOB');
  if (p.state !== 'UNKNOWN') return p;
  let match: { remoteId: string } | null = null;
  try { match = await adapter.reconcile(structuredClone(p)); } catch { /* Absence is never proof of failure. */ }
  const next: Publication = match ? { ...p, state: 'PUBLISHED', remoteId: match.remoteId, reason: null } : { ...p, reason: now - (p.submittedAt ?? now) >= 900_000 ? 'INCIDENT_UNRESOLVED_UNKNOWN' : 'RECONCILIATION_PENDING' };
  store.savePublication(next); return next;
}
