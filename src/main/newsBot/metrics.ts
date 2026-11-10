import type { WindowMetric, Traction } from './editorial';
/** Inputs are authorized aggregate observations, never scraped profiles or inferred impressions. */
export interface MetricObservation {
  contentHash: string; nativeHash: string; origin: string; publishedAt: number; observedAt: number;
  repost: boolean; likes: number | null; reposts: number | null; quotes: number | null; replies: number | null;
  historicalEngagement: number[]; historyComparable: boolean;
}
export interface Coverage { hours: 1 | 6 | 24; start: number; end: number; endpoint: string; queryVersion: string; complete: boolean; baselineCounts: number[]; baselineComparable: boolean }
const median = (numbers: number[]): number => { const a = [...numbers].sort((a, b) => a - b); const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const validNumber = (n: number | null): n is number => n !== null && Number.isFinite(n) && n >= 0;
export function measuredTraction(observations: MetricObservation[], coverage: Coverage[], now: number, activity: Traction['activity'] = null): Traction {
  const unique = new Map<string, MetricObservation>(); const native = new Set<string>();
  // Keep the latest counters for an observed post, not the sum of repeated snapshots.
  for (const o of [...observations].sort((a, b) => b.observedAt - a.observedAt)) {
    if (!o.repost && o.publishedAt <= now && o.observedAt <= now && now - o.publishedAt < 24 * 3_600_000 && !unique.has(o.contentHash) && !native.has(o.nativeHash)) { unique.set(o.contentHash, o); native.add(o.nativeHash); }
  }
  const current = [...unique.values()];
  const windows: WindowMetric[] = ([1, 6, 24] as const).map(hours => {
    const c = coverage.find(c => c.hours === hours);
    const complete = !!c && c.complete && c.end === now && c.start === now - hours * 3_600_000 && !!c.endpoint && !!c.queryVersion;
    const matches = current.filter(o => o.publishedAt >= now - hours * 3_600_000);
    const history = c?.baselineCounts.filter(validNumber) ?? [];
    return { hours, count: complete ? matches.length : null, complete, baseline: c?.baselineComparable && history.length >= 7 ? median(history) : null, baselineWindows: history.length, comparable: !!c?.baselineComparable, origins: complete ? new Set(matches.map(o => o.origin)).size : 0 };
  });
  const engagementSamples = current.filter(o => o.historyComparable && o.historicalEngagement.length >= 10 && o.historicalEngagement.every(validNumber) && [o.likes, o.reposts, o.quotes, o.replies].every(validNumber));
  const origins = new Set(engagementSamples.map(o => o.origin)).size;
  const completeEngagement = coverage.some(c => c.hours === 24 && c.complete && c.end === now && c.start === now - 24 * 3_600_000);
  const q = completeEngagement && engagementSamples.length >= 3 && origins >= 2 ? median(engagementSamples.map(o => (o.likes! + o.reposts! + o.quotes! + o.replies!) / Math.max(median(o.historicalEngagement), 5))) : null;
  return { windows, engagement: { q, posts: engagementSamples.length, origins, minimumHistory: engagementSamples.length ? Math.min(...engagementSamples.map(o => o.historicalEngagement.length)) : 0 }, activity };
}
