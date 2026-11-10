import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { canonicalUrl, defaultConfig, fixtureUrl, hash, type Source, type SourceItem } from './model';
import { LocalStore } from './store';
export interface Page { status: number; body: string; etag?: string; modified?: string; retryAfter?: string }
export type Transport = (url: string, headers: Record<string, string>) => Promise<Page>;
export function publicAddress(address: string): boolean {
  if (isIP(address) === 6) return /^2[0-9a-f]{3}:/i.test(address) && !/^200[012]:/i.test(address);
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 2))) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0 && c === 113));
}
/** DNS answer is pinned in lookup, redirects and compression are refused. Timeout covers DNS and body. */
export const secureTransport: Transport = async (input, headers) => {
  const url = canonicalUrl(input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), defaultConfig.timeoutMs);
  try {
    const addresses = await Promise.race([lookup(new URL(url).hostname, { all: true }), new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('BLOCKED_TIMEOUT')), { once: true }))]);
    if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error('BLOCKED_SSRF');
    const pinned = addresses[0];
    return await new Promise<Page>((resolve, reject) => {
      const req = request(url, { headers: { ...headers, 'accept-encoding': 'identity' }, signal: controller.signal, family: pinned.family, lookup: (_host, _options, cb) => cb(null, pinned.address, pinned.family) }, res => {
        const status = res.statusCode ?? 0;
        if (![200, 304, 429].includes(status) || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) { res.destroy(); reject(new Error('BLOCKED_HTTP')); return; }
        const chunks: Buffer[] = []; let bytes = 0;
        res.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > defaultConfig.maxBytes) { res.destroy(new Error('BLOCKED_SIZE')); } else chunks.push(chunk); });
        res.on('error', reject);
        res.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8'), etag: res.headers.etag, modified: res.headers['last-modified'], retryAfter: res.headers['retry-after'] }));
      });
      req.on('error', reject); req.end();
    });
  } finally { clearTimeout(timer); }
};
function text(value: string): string {
  const clean = value.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1');
  if (/<|>/.test(clean)) throw new Error('BLOCKED_XML_MARKUP');
  return clean.replace(/&(?:amp|lt|gt|quot|apos);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[entity]!).trim();
}
const tag = (xml: string, name: string) => text(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i').exec(xml)?.[1] ?? '');
/** Conservative RSS 2 / Atom subset. No DTD, entities, HTML, media fetching or script execution. */
export function parseFeed(xml: string, source: Source, now: number): { items: SourceItem[]; next: string | null } {
  if (Buffer.byteLength(xml) > defaultConfig.maxBytes || /<!DOCTYPE|<!ENTITY/i.test(xml) || !/<(?:rss|feed)(?:\s|>)/i.test(xml) || !/<\/(?:rss|feed)>\s*$/i.test(xml)) throw new Error('BLOCKED_XML');
  const entries = [...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)];
  if (entries.length > 200) throw new Error('BLOCKED_ITEM_LIMIT');
  const items = entries.map(([, , entry]) => {
    const title = tag(entry, 'title');
    const atomLink = [...entry.matchAll(/<link\s+([^>]+)\/?\s*>/gi)].find(m => !/rel=["'](?:next|self)["']/i.test(m[1]));
    const rawLink = tag(entry, 'link') || (atomLink ? /href=["']([^"']+)["']/i.exec(atomLink[1])?.[1] : '') || '';
    const url = canonicalUrl(new URL(text(rawLink), source.url).href);
    if (!title || title.length > 500 || !rawLink || !source.hosts.includes(new URL(url).hostname)) throw new Error('BLOCKED_ITEM');
    const nativeId = tag(entry, 'guid') || tag(entry, 'id') || url;
    const date = tag(entry, 'pubDate') || tag(entry, 'published') || tag(entry, 'updated');
    const publishedAt = date && Number.isFinite(Date.parse(date)) ? Date.parse(date) : null;
    return { id: hash(url), sourceId: source.id, nativeId, url, title, publishedAt, observedAt: now, expiresAt: Math.min(now + source.rights.retainMs, source.rights.expiresAt), fixture: source.fixture || fixtureUrl(url), state: 'INGESTED' as const };
  });
  const header = xml.split(/<(?:item|entry)(?:\s|>)/i)[0];
  const nextTag = [...header.matchAll(/<(?:atom:)?link\s+([^>]+)\/?\s*>/gi)].find(m => /rel=["']next["']/i.test(m[1]));
  const next = nextTag ? /href=["']([^"']+)["']/i.exec(nextTag[1])?.[1] ?? null : null;
  return { items, next: next ? new URL(text(next), source.url).href : null };
}
export interface ApiAdapter { parse(body: string, source: Source, now: number): { items: SourceItem[]; next: string | null } }
export async function collect(store: LocalStore, source: Source, now: number, transport: Transport = secureTransport, network = false, api?: ApiAdapter): Promise<number> {
  if (!network) throw new Error('BLOCKED_NETWORK_DISABLED');
  if (!source.authenticated || !source.rights.collect || !source.rights.reference || source.rights.expiresAt <= now || source.rights.retainMs <= 0) throw new Error('BLOCKED_RIGHTS');
  if (source.format === 'api' && !api) throw new Error('BLOCKED_API_ADAPTER');
  let url: string | null = store.get<{ next: string | null }>('crawl', source.id)?.next ?? source.url; let count = 0; const seen = new Set<string>();
  for (let page = 0; url && page < defaultConfig.maxPages; page++) {
    url = canonicalUrl(url);
    if (!source.hosts.includes(new URL(url).hostname) || /(^|\.)(x\.com|twitter\.com|tiktok\.com)$/.test(new URL(url).hostname)) throw new Error('BLOCKED_HOST');
    if (seen.has(url)) throw new Error('BLOCKED_CURSOR_LOOP'); seen.add(url);
    const current: string = url;
    const saved = store.get<{ etag?: string; modified?: string; next: string | null; nextAt?: number }>('cursor', current);
    if (saved?.nextAt && saved.nextAt > now) throw new Error('RETRY_WAIT');
    store.transaction(() => { if (store.killed()) throw new Error('BLOCKED_KILL_SWITCH'); if (!store.spend(`reads:${new Date(now).toISOString().slice(0, 10)}`, defaultConfig.maxReads)) throw new Error('BLOCKED_BUDGET'); });
    const response = await transport(current, { ...(saved?.etag ? { 'If-None-Match': saved.etag } : {}), ...(saved?.modified ? { 'If-Modified-Since': saved.modified } : {}) });
    if (response.status === 429) { store.put('cursor', current, { ...saved, nextAt: retryAt(response.retryAfter, now) }, Math.min(now + source.rights.retainMs, source.rights.expiresAt)); throw new Error('RETRY_WAIT'); }
    if (response.status === 304) { url = saved?.next ?? null; store.put('crawl', source.id, { next: url }, Math.min(now + source.rights.retainMs, source.rights.expiresAt)); continue; }
    if (response.status !== 200 || Buffer.byteLength(response.body) > defaultConfig.maxBytes) throw new Error('BLOCKED_HTTP');
    const parsed = source.format === 'api' ? api!.parse(response.body, source, now) : parseFeed(response.body, source, now);
    store.transaction(() => {
      for (const item of parsed.items) { if (item.sourceId !== source.id || !source.hosts.includes(new URL(canonicalUrl(item.url)).hostname)) throw new Error('BLOCKED_ITEM'); const safeItem: SourceItem = { ...item, id: hash(canonicalUrl(item.url)), url: canonicalUrl(item.url), expiresAt: Math.min(now + source.rights.retainMs, source.rights.expiresAt), fixture: source.fixture || fixtureUrl(item.url), observedAt: now, state: 'INGESTED' }; if (store.ingest(safeItem)) count++; }
      store.put('crawl', source.id, { next: parsed.next }, Math.min(now + source.rights.retainMs, source.rights.expiresAt));
      store.put('cursor', current, { etag: response.etag, modified: response.modified, next: parsed.next }, Math.min(now + source.rights.retainMs, source.rights.expiresAt));
    });
    url = parsed.next;
  }
  return count;
}
export function retryAt(value: string | undefined, now: number): number {
  const seconds = value && /^\d+$/.test(value) ? Number(value) : NaN;
  const parsed = Number.isFinite(seconds) ? now + seconds * 1000 : value ? Date.parse(value) : NaN;
  return Math.max(now + 1000, Number.isFinite(parsed) ? parsed : now + 60_000);
}
