import { createHash } from 'node:crypto';

export type Label = 'A' | 'B' | 'C' | 'D';
export type Platform = 'x' | 'tiktok';
export type State = 'INGESTED' | 'VERIFIED' | 'DRAFTED' | 'RENDERED' | 'QA_PASSED' | 'SCHEDULED' | 'SUBMITTING' | 'RETRY_WAIT' | 'UNKNOWN' | 'PUBLISHED' | 'BLOCKED';
export interface Source {
  id: string; origin: string; url: string; hosts: string[]; format: 'rss' | 'atom' | 'api';
  primary: boolean; authenticated: boolean; editorialHistory: boolean;
  rights: { collect: boolean; summarize: boolean; llm: boolean; expiresAt: number; retainMs: number; reference: string };
  fixture: boolean;
}
export interface SourceItem { id: string; sourceId: string; nativeId: string; url: string; title: string; publishedAt: number | null; observedAt: number; expiresAt: number; fixture: boolean; state: 'INGESTED' }
export interface Evidence { sourceId: string; itemId: string; excerpt: string; verifiedAt: number; ownVerification: boolean }
export interface Claim { id: string; text: string; evidence: Evidence[]; contradiction: boolean; rumor: boolean }
export interface Story {
  id: string; gameId: string; revision: number; eventAt: number | null; observedAt: number;
  claims: Claim[]; novelty: 0 | 10 | 20; official: boolean; relevantEvent: boolean;
  ttlMs: number; fixture: boolean; topic: 'gaming-product' | 'excluded';
}
export interface Draft { id: string; storyId: string; revision: number; label: Label; text: string; claimIds: string[]; urls: string[]; altText: string; verifiedAt: number; expiresAt: number; fixture: boolean; state: 'DRAFTED' }
export interface Asset { id: string; draftId: string; path: string; manifestPath: string; state: 'RENDERED' | 'QA_PASSED' | 'BLOCKED'; reason: string | null }
export interface Publication { key: string; draft: Draft; platform: Platform; account: string; state: State; reason: string | null; attempts: number; nextAt: number; submittedAt: number | null; remoteId: string | null }
export const prefix: Record<Label, string> = { A: 'CONFIRMÉ ·', B: 'CROISÉ ·', C: 'À CONFIRMER ·', D: 'RADAR ·' };
export const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export function canonicalUrl(input: string): string {
  const u = new URL(input);
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) throw new Error('BLOCKED_URL');
  u.hash = '';
  for (const key of [...u.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(key)) u.searchParams.delete(key);
  u.searchParams.sort();
  return u.href;
}
export function fixtureUrl(url: string): boolean { const h = new URL(url).hostname; return h === 'invalid' || h.endsWith('.invalid'); }
export const defaultConfig = Object.freeze({ network: false, llm: false, voice: false, publishers: { x: false, tiktok: false }, maxReads: 100, discoveryFraction: 0.1, maxBytes: 1_000_000, timeoutMs: 10_000, maxPages: 5, maxAttempts: 3, maxStoredBytes: 32_000_000 });
// No endpoint or permission is inferred from a brand name. Real sources require an explicit rights review.
export const initialGames = ['gta', 'gta-vi', 'red-dead', 'fortnite', 'minecraft', 'call-of-duty', 'cs2', 'valorant', 'lol', 'dota2', 'apex', 'genshin', 'star-rail', 'pokemon', 'zelda', 'mario', 'monster-hunter', 'elden-ring', 'final-fantasy', 'ea-fc'];
export interface Game { id: string; status: 'WATCH' | 'ACTIVE' | 'COOLING' | 'EXCLUDED'; identityVerified: boolean; sourceIds: string[]; addedAt: number; expiresAt: number | null }
export function discover(games: Game[], id: string, now: number, reads: number, maxReads: number): Game {
  if (reads >= Math.floor(maxReads * 0.1) || games.filter(g => g.status === 'WATCH' && g.expiresAt !== null && g.expiresAt > now).length >= 20 || games.some(g => g.id === id)) throw new Error('BLOCKED_DISCOVERY');
  return { id, status: 'WATCH', identityVerified: false, sourceIds: [], addedAt: now, expiresAt: now + 7 * 86_400_000 };
}
