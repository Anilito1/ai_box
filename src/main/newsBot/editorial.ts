import { hash, prefix, type Claim, type Draft, type Game, type Label, type Source, type SourceItem, type Story } from './model';
export interface WindowMetric { hours: 1 | 6 | 24; count: number | null; baseline: number | null; baselineWindows: number; complete: boolean; origins: number; comparable: boolean }
export interface Traction {
  windows: WindowMetric[];
  engagement: { q: number | null; posts: number; origins: number; minimumHistory: number };
  activity: { previous: number; current: number; observedAt: number; previousAt: number; comparable: boolean; unit: string; period: string; sourceId: string } | null;
}
export function selection(story: Story, traction: Traction, sources: Source[], now: number) {
  const age = Math.max(0, (now - (story.eventAt ?? story.observedAt)) / 3_600_000);
  const ratios = [1, 6, 24].map(hours => {
    const w = traction.windows.find(x => x.hours === hours);
    const valid = w && w.complete && w.comparable && w.baselineWindows >= 7 && w.count !== null && w.count >= 0 && w.baseline !== null && w.baseline >= 0;
    return { hours, count: valid ? w.count : null, ratio: valid ? w.count! / Math.max(w.baseline!, 10) : null, origins: valid ? w.origins : 0 };
  });
  const one = ratios[0];
  const V = one.count !== null && one.count >= 40 && one.ratio! >= 3 && one.origins >= 10 ? 20 : ratios.slice(1).some(w => w.count !== null && w.count >= (w.hours === 6 ? 80 : 160) && w.ratio! >= 2 && w.origins >= 5) ? 10 : 0;
  const e = traction.engagement;
  const q = e.posts >= 3 && e.origins >= 2 && e.minimumHistory >= 10 && e.q !== null && e.q >= 0 ? e.q : null;
  const E = q !== null && q >= 2 ? 20 : q !== null && q >= 1.25 ? 10 : 0;
  const O = story.official && age <= 1 ? 30 : story.official && age <= 24 ? 20 : 0;
  const H = story.relevantEvent ? 10 : 0;
  const total = O + V + E + story.novelty + H;
  const a = traction.activity; const s = sources.find(s => s.id === a?.sourceId);
  const activity = !!(a && s?.primary && s.authenticated && s.rights.collect && s.rights.expiresAt > now && a.comparable && a.unit && a.period && a.previous > 0 && a.current >= a.previous && a.previousAt < a.observedAt && a.observedAt <= now && now - a.previousAt < 30 * 86_400_000);
  return { version: 'x-gaming-1', O, V, E, N: story.novelty, H, total, effective: Math.floor(total * 2 ** (-age / 12)), ratios, q, missing: [...ratios.filter(r => r.ratio === null).map(r => `M${r.hours}:NA`), ...(q === null ? ['Q:NA'] : [])], traction: V >= 10 || E >= 10 || activity, eventDateUnknown: story.eventAt === null };
}
const normalized = (s: string) => s.normalize('NFC').trim().toLocaleLowerCase('fr').replace(/[.!?]+$/, '');
export function claimLabel(claim: Claim, sources: Source[], items: SourceItem[], now: number, ttl: number): Label {
  if (claim.contradiction || !claim.text.trim()) return 'D';
  const evidence = claim.evidence.filter(e => {
    const s = sources.find(s => s.id === e.sourceId); const item = items.find(i => i.id === e.itemId && i.sourceId === e.sourceId);
    return s?.authenticated && s.rights.collect && s.rights.summarize && s.rights.reference && s.rights.expiresAt > now && item && item.expiresAt > now && normalized(item.title).includes(normalized(e.excerpt)) && normalized(e.excerpt).includes(normalized(claim.text)) && normalized(e.excerpt).length > 0 && e.verifiedAt <= now && now - e.verifiedAt <= ttl;
  });
  if (evidence.some(e => sources.find(s => s.id === e.sourceId)!.primary) && !claim.rumor) return 'A';
  if (!claim.rumor && new Set(evidence.filter(e => e.ownVerification).map(e => sources.find(s => s.id === e.sourceId)!.origin)).size >= 2) return 'B';
  if (claim.rumor && evidence.some(e => sources.find(s => s.id === e.sourceId)!.editorialHistory)) return 'C';
  return 'D';
}
export function draftStory(story: Story, game: Game, sources: Source[], items: SourceItem[], traction: Traction, now: number): { draft: Draft; gate: string | null; score: ReturnType<typeof selection> } {
  const labels = story.claims.map(c => claimLabel(c, sources, items, now, story.ttlMs));
  const label = labels.length ? labels.reduce((a, b) => a > b ? a : b) : 'D';
  const score = selection({ ...story, official: label === 'A' && story.official }, traction, sources, now);
  const references = story.claims.flatMap(c => c.evidence).map(e => items.find(i => i.id === e.itemId && i.sourceId === e.sourceId)).filter((i): i is SourceItem => !!i);
  const urls = [...new Set(references.map(i => i.url))];
  const verifiedAt = Math.min(...story.claims.flatMap(c => c.evidence.map(e => e.verifiedAt)));
  const expiresAt = Math.min(verifiedAt + story.ttlMs, ...references.map(i => i.expiresAt), ...sources.filter(s => references.some(i => i.sourceId === s.id)).map(s => s.rights.expiresAt));
  const attribution = [...new Set(references.map(i => i.sourceId))].join(', ');
  const reserve = label === 'B' ? 'Absence de confirmation officielle. ' : label === 'C' ? 'Signal rapporté, non confirmé par l’éditeur. ' : '';
  const text = `${prefix[label]} ${story.claims.map(c => c.text).join(' ')}\n${reserve}Source : ${attribution}. Vérifié le ${Number.isFinite(verifiedAt) ? new Date(verifiedAt).toISOString() : 'inconnu'}.\n${urls.join('\n')}`;
  const draft: Draft = { id: hash(`${story.id}:${story.revision}:${text}`), storyId: story.id, revision: story.revision, label, text, claimIds: story.claims.map(c => c.id), urls, altText: `${prefix[label]} Carte typographique originale. ${story.claims.map(c => c.text).join(' ')} ${reserve}`, verifiedAt, expiresAt, fixture: story.fixture || references.some(i => i.fixture), state: 'DRAFTED' };
  const gate = !Number.isFinite(story.observedAt) || story.observedAt > now || (story.eventAt !== null && (!Number.isFinite(story.eventAt) || story.eventAt > now)) || !Number.isFinite(story.ttlMs) || story.ttlMs <= 0 || story.ttlMs > 7_200_000 ? 'BLOCKED_EVENT_TIME' : story.topic !== 'gaming-product' ? 'BLOCKED_TOPIC' : game.id !== story.gameId || game.status !== 'ACTIVE' || !game.identityVerified || !references.length || references.some(i => !game.sourceIds.includes(i.sourceId)) ? 'BLOCKED_GAME_QUARANTINE' : label === 'D' ? 'BLOCKED_EVIDENCE' : !score.traction ? 'BLOCKED_TRACTION_UNKNOWN' : score.N === 0 || score.effective < (label === 'C' ? 60 : 45) || (label === 'C' && (score.V < 10 || score.E < 10)) ? 'BLOCKED_SELECTION' : !Number.isFinite(expiresAt) || expiresAt <= now ? 'BLOCKED_EVIDENCE_STALE' : null;
  return { draft, gate, score };
}
/** Optional proposal only: generated text must never replace verified claims automatically. */
export interface LlmAdapter { propose(claims: readonly Claim[]): Promise<string> }
export async function optionalProposal(enabled: boolean, adapter: LlmAdapter | undefined, claims: Claim[], sources: Source[]): Promise<string | null> {
  if (!enabled) return null;
  if (!adapter || claims.some(c => c.evidence.some(e => !sources.find(s => s.id === e.sourceId)?.rights.llm))) throw new Error('BLOCKED_LLM_RIGHTS');
  return adapter.propose(claims);
}
