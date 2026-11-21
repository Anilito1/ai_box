import { randomBytes } from 'node:crypto';
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { createWriteStream } from 'node:fs';
import { open, realpath, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { get as httpsGet } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { basename, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebStream } from 'node:stream/web';
import { MEDIA_SCHEME, mediaType, remoteMedia, type MediaKind, type MediaResult, type MediaSaveResult } from '../shared/media';
import { locateLocalFile } from './localFiles';

/** What a token stands for: a checked local file, or a web address the user asked to see. */
type Entry = { name: string; kind: MediaKind; type: string } & ({ path: string; remote?: undefined } | { remote: string; path?: undefined });
/** One GET, redirects not followed. */
export type MediaGet = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

export interface MediaOptions {
  /** The web's answers (https to public addresses only, by default). */
  get?: MediaGet;
  /** The addresses a host name stands for (the system's resolver by default). */
  lookup?: (host: string) => Promise<string[]>;
  /** Tokens kept, the least recently used forgotten first. */
  max?: number;
}

const TOKEN = new RegExp(`^${MEDIA_SCHEME}://m/([0-9a-f]{32})(?:[/?#]|$)`);
const REDIRECTS = 4;
/** A site silent this long is dropped. */
const IDLE_MS = 30_000;
/** A web file saved larger than this is cut short and removed. */
const SAVE_MAX = 4 * 1024 ** 3;
/** Sites refuse a request that does not say what makes it (Wikimedia answers 403). */
const USER_AGENT = 'AI-Box (desktop app; media preview)';
const status = (code: number, headers?: HeadersInit) => new Response(null, { status: code, headers });
const samePath = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const keyOf = (e: Entry) => e.remote ?? `file:${process.platform === 'win32' ? e.path.toLowerCase() : e.path}`;
/** A site's answer of the entry's kind: served under the type of its extension, never one the site picks (no HTML, no SVG). */
const fits = (kind: MediaKind, res: Response) => {
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  return (type.startsWith(`${kind}/`) && type !== 'image/svg+xml') || type === 'application/octet-stream' || type === 'binary/octet-stream' || type === '';
};

/**
 * The byte range a request asks for, within a file of `size` bytes. null: the whole file (no header, several ranges, or
 * one this does not read). Only an impossible start is refused, as HTTP says.
 */
export function parseRange(header: string | null, size: number): [number, number] | null | 'unsatisfiable' {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!m || (!m[1] && !m[2])) return null;
  if (!m[1]) {
    const tail = Number(m[2]);
    return tail === 0 || size === 0 ? 'unsatisfiable' : [Math.max(0, size - tail), size - 1];
  }
  const start = Number(m[1]);
  if (m[2] && Number(m[2]) < start) return null;
  if (start >= size) return 'unsatisfiable';
  return [start, m[2] ? Math.min(Number(m[2]), size - 1) : size - 1];
}

/** Addresses only this computer or its network reach, or that stand for one (IPv4 in IPv6: mapped, NAT64, 6to4, Teredo). */
const PRIVATE = new BlockList();
for (const [net, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]] as const) PRIVATE.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [['::', 127], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]] as const) PRIVATE.addSubnet(net, prefix, 'ipv6');

/** Loopback, private, link-local, shared, documentation, multicast and reserved: not the web. Anything unreadable too. */
export function privateAddress(ip: string): boolean {
  const family = isIP(ip);
  return family === 0 || PRIVATE.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

/** A host main may fetch for the renderer: a public name or address, never this computer nor its network's names. */
export function publicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '').replace(/^\[(.*)\]$/, '$1');
  if (isIP(host)) return !privateAddress(host);
  return host.includes('.') && !/(?:^|\.)(?:localhost|local|internal|intranet|lan|home|corp|arpa)$/.test(host);
}

/** The system's resolver, refusing a name that leads to a private address: checked as each connection is made. */
const publicLookup = ((hostname: string, options: LookupOptions, callback: (...args: unknown[]) => void) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err);
    if (addresses.length === 0 || addresses.some((a) => privateAddress(a.address))) return callback(Object.assign(new Error(`${hostname}: not a public address`), { code: 'ENOTFOUND' }));
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}) as unknown as LookupFunction;

/** GET over https to a public address (no DNS rebinding between a check and the request), dropped when idle. */
const secureGet: MediaGet = (url, init) =>
  new Promise((done, fail) => {
    const req = httpsGet(url, { headers: init.headers, signal: init.signal, lookup: publicLookup, timeout: IDLE_MS }, (res) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(res.headers)) {
        try {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        } catch { /* A header Fetch refuses is not one this reads. */ }
      }
      const code = res.statusCode ?? 502;
      const empty = code < 200 || code > 599 || code === 204 || code === 205 || code === 304;
      if (empty) res.resume();
      done(new Response(empty ? null : (Readable.toWeb(res) as ReadableStream), { status: code < 200 || code > 599 ? 502 : code, headers }));
    });
    req.on('timeout', () => req.destroy(new Error('idle')));
    req.on('error', fail);
  });

/**
 * The file a token names, opened, while it is still the canonical file checked when the token was given: a link put in
 * its place before or while it opens is refused (path, then the opened file's identity against the path's).
 */
async function openChecked(path: string): Promise<{ fh: FileHandle; size: number } | null> {
  let fh: FileHandle | undefined;
  try {
    fh = await open(path, 'r');
    const [opened, now, real] = await Promise.all([fh.stat(), stat(path), realpath(path)]);
    if (real === path && opened.isFile() && opened.ino === now.ino && opened.dev === now.dev) return { fh, size: opened.size };
  } catch { /* Gone or unreadable: refused below. */ }
  await fh?.close().catch(() => undefined);
  return null;
}

/** Written beside the destination, then put in its place: a failed copy never leaves a cut file nor removes the old one. */
async function writeAs(dest: string, source: Readable, max = Infinity): Promise<void> {
  const part = `${dest}.part`;
  let seen = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _enc, next) {
      seen += chunk.length;
      next(seen > max ? new Error('too large') : null, chunk);
    },
  });
  try {
    await pipeline(source, cap, createWriteStream(part));
    await rename(part, dest);
  } catch (error) {
    await rm(part, { force: true });
    throw error;
  }
}

/**
 * The images and videos the conversation shows, served to the renderer on the media scheme. The renderer never names a
 * file there: main checks a path a message gives (the session's folders, the hub's own) and hands back an opaque
 * token; each request checks again that the file is still the one it checked (no link swapped in since). Videos are
 * read by range, never whole in memory. A remote one goes through main, https only, on the user's request.
 */
export class MediaFiles {
  private readonly entries = new Map<string, Entry>();
  /** The token already given for a file or an address: one URL each, so the renderer's cache keeps working. */
  private readonly tokens = new Map<string, string>();
  constructor(private readonly o: MediaOptions = {}) {}

  /** A path a message names, relative to `workspace`, allowed inside it or `also`. */
  async resolve(workspace: string | undefined, input: unknown, also: string[] = []): Promise<MediaResult> {
    const found = await locateLocalFile(workspace, input, also);
    if (!found.ok) return found;
    const type = mediaType(found.path);
    if (!type || !found.info.isFile()) return { ok: false, error: 'unsupported' };
    const name = basename(found.path);
    return { ok: true, url: this.issue({ name, ...type, path: found.path }), kind: type.kind, name, size: found.info.size };
  }

  /** A web address the user asked to see here: https, a public host, an image or video extension. */
  async remote(href: unknown): Promise<MediaResult> {
    if (typeof href !== 'string') return { ok: false, error: 'invalid' };
    const found = remoteMedia(href);
    if (!found) return { ok: false, error: 'invalid' };
    const url = new URL(href);
    url.hash = '';
    if (!found.secure || url.username || url.password || !(await this.reachable(url.hostname))) return { ok: false, error: 'unsupported' };
    const type = mediaType(found.name)!;
    return { ok: true, url: this.issue({ name: found.name, ...type, remote: url.href }), kind: type.kind, name: found.name, size: null };
  }

  /** The protocol's handler: GET and HEAD, by range. */
  async handle(req: Request): Promise<Response> {
    if (req.method !== 'GET' && req.method !== 'HEAD') return status(405);
    const entry = this.entry(req.url);
    if (!entry) return status(404);
    const head = req.method === 'HEAD';
    const range = req.headers.get('range');
    return entry.remote === undefined ? serveFile(entry.path, entry.type, range, head) : this.proxy(entry, range, head, req.signal);
  }

  /** "Save as…": a copy of the file, or the download of the address, where the user chose (`ask`). */
  async save(url: unknown, ask: (name: string) => Promise<string | undefined>): Promise<MediaSaveResult> {
    const entry = this.entry(url);
    if (!entry) return { ok: false, error: 'missing' };
    const dest = await ask(entry.name);
    if (!dest) return { ok: false, error: 'canceled' };
    try {
      if (entry.remote !== undefined) {
        const res = await this.fetchMedia(entry, null);
        if (!res?.body || res.status !== 200 || !fits(entry.kind, res) || Number(res.headers.get('content-length') ?? 0) > SAVE_MAX) {
          await res?.body?.cancel();
          return { ok: false, error: 'failed' };
        }
        await writeAs(dest, Readable.fromWeb(res.body as WebStream), SAVE_MAX);
        return { ok: true };
      }
      const file = await openChecked(entry.path);
      if (!file) return { ok: false, error: 'missing' };
      if (samePath(resolve(dest), entry.path)) {
        await file.fh.close();
        return { ok: true };
      }
      await writeAs(dest, file.fh.createReadStream());
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'failed' };
    }
  }

  /** Its folder in the file manager, for a local file that is still the one checked. */
  async reveal(url: unknown, show: (path: string) => void): Promise<boolean> {
    const entry = this.entry(url);
    const file = entry?.path === undefined ? null : await openChecked(entry.path);
    if (!file) return false;
    await file.fh.close();
    show(entry!.path!);
    return true;
  }

  /** A token's entry, now the most recently used: what is on screen is the last to be forgotten. */
  private entry(url: unknown): Entry | undefined {
    const token = typeof url === 'string' ? TOKEN.exec(url)?.[1] : undefined;
    const entry = token ? this.entries.get(token) : undefined;
    if (entry) {
      this.entries.delete(token!);
      this.entries.set(token!, entry);
    }
    return entry;
  }

  private issue(entry: Entry): string {
    const known = this.tokens.get(keyOf(entry));
    const token = known && this.entries.has(known) ? known : randomBytes(16).toString('hex');
    this.entries.delete(token);
    this.entries.set(token, entry);
    this.tokens.set(keyOf(entry), token);
    for (const [old, e] of this.entries) {
      if (this.entries.size <= (this.o.max ?? 2000)) break;
      this.entries.delete(old);
      this.tokens.delete(keyOf(e));
    }
    return `${MEDIA_SCHEME}://m/${token}`;
  }

  /** Quick refusal before any request; the connection itself checks again (secureGet). */
  private async reachable(host: string): Promise<boolean> {
    if (!publicHost(host)) return false;
    if (isIP(host.replace(/^\[(.*)\]$/, '$1'))) return true;
    try {
      const addresses = await (this.o.lookup ?? (async (h: string) => (await lookup(h, { all: true })).map((a) => a.address)))(host);
      return addresses.length > 0 && !addresses.some(privateAddress);
    } catch {
      return false;
    }
  }

  /** The address's answer, redirects followed by hand so each hop is checked; null when refused on the way. */
  private async fetchMedia(entry: Entry & { remote: string }, range: string | null, signal?: AbortSignal): Promise<Response | null> {
    let target = entry.remote;
    for (let hop = 0; hop <= REDIRECTS; hop++) {
      // Not compressed: the length and ranges it gives are the file's.
      const res = await (this.o.get ?? secureGet)(target, { headers: { 'user-agent': USER_AGENT, 'accept-encoding': 'identity', ...(range ? { range } : {}) }, signal });
      if (res.status < 300 || res.status >= 400) return res;
      await res.body?.cancel();
      let next: URL;
      try {
        next = new URL(res.headers.get('location') ?? '', target);
      } catch {
        return null;
      }
      if (next.protocol !== 'https:' || next.username || next.password || !(await this.reachable(next.hostname))) return null;
      target = next.href;
    }
    return null;
  }

  private async proxy(entry: Entry & { remote: string }, range: string | null, head: boolean, signal?: AbortSignal): Promise<Response> {
    let res: Response | null;
    try {
      res = await this.fetchMedia(entry, range, signal);
    } catch {
      return status(502);
    }
    if (!res) return status(502);
    if (res.status === 416) {
      await res.body?.cancel();
      return status(416, { 'Content-Range': res.headers.get('content-range') ?? '' });
    }
    if ((res.status !== 200 && res.status !== 206) || !fits(entry.kind, res)) {
      await res.body?.cancel();
      return status(res.status === 200 || res.status === 206 ? 415 : 502);
    }
    const headers = new Headers({ 'Content-Type': entry.type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
    for (const name of ['content-length', 'content-range', 'accept-ranges']) {
      const value = res.headers.get(name);
      if (value) headers.set(name, value);
    }
    if (head) await res.body?.cancel();
    return new Response(head ? null : res.body, { status: res.status, headers });
  }
}

/** A local file by range: 206 with the part asked, 200 whole, 416 past its end. Streamed from the file opened and checked. */
export async function serveFile(path: string, type: string, range: string | null, head: boolean): Promise<Response> {
  const file = await openChecked(path);
  if (!file) return status(404);
  const { fh, size } = file;
  const headers = new Headers({ 'Content-Type': type, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
  const part = parseRange(range, size);
  if (part === 'unsatisfiable') {
    await fh.close();
    headers.set('Content-Range', `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  const [start, end] = part ?? [0, size - 1];
  headers.set('Content-Length', String(size === 0 ? 0 : end - start + 1));
  if (part) headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  if (head || size === 0) {
    await fh.close();
    return new Response(null, { status: part ? 206 : 200, headers });
  }
  // The handle closes with its stream, at its end or when the page drops the request.
  return new Response(Readable.toWeb(fh.createReadStream({ start, end })) as ReadableStream, { status: part ? 206 : 200, headers });
}
