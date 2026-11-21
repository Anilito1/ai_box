import { safeFileName } from './attachments';

/** Images and videos a conversation shows in place, by their extension: the ones Chromium plays. No SVG (scripts). */
export type MediaKind = 'image' | 'video';
export const MEDIA_SCHEME = 'aibox-media';

const TYPES: Record<string, [MediaKind, string]> = {
  png: ['image', 'image/png'],
  jpg: ['image', 'image/jpeg'],
  jpeg: ['image', 'image/jpeg'],
  gif: ['image', 'image/gif'],
  webp: ['image', 'image/webp'],
  avif: ['image', 'image/avif'],
  bmp: ['image', 'image/bmp'],
  mp4: ['video', 'video/mp4'],
  m4v: ['video', 'video/mp4'],
  // QuickTime is the MP4 family: Chromium plays its H.264 files under that type.
  mov: ['video', 'video/mp4'],
  webm: ['video', 'video/webm'],
  ogv: ['video', 'video/ogg'],
};

/** Its kind and the type it is served with, or null for anything else (a document, an unknown extension). */
export function mediaType(name: string): { kind: MediaKind; type: string } | null {
  const m = /\.([a-z0-9]{2,5})$/i.exec(name);
  const found = m ? TYPES[m[1].toLowerCase()] : undefined;
  return found ? { kind: found[0], type: found[1] } : null;
}

/** A local file once main allowed it (`url` on the media scheme), a remote one once the user asked for it. */
export type MediaResult =
  | { ok: true; url: string; kind: MediaKind; name: string; size: number | null }
  | { ok: false; error: 'invalid' | 'outside' | 'missing' | 'unsupported' | 'failed' };
export type MediaSaveResult = { ok: true } | { ok: false; error: 'canceled' | 'missing' | 'failed' };

/** A web address naming an image or a video by its extension: shown as a card, loaded only on a click. */
export function remoteMedia(href: string): { kind: MediaKind; host: string; name: string; secure: boolean } | null {
  if (!/^https?:\/\//i.test(href) || href.length > 4096) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  let name = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
  try {
    name = decodeURIComponent(name);
  } catch { /* Shown as written. */ }
  // A file name, whatever the address encodes (no folder, no character Windows refuses): the one "Save as" offers.
  name = safeFileName(name);
  const type = mediaType(name);
  return type ? { kind: type.kind, host: url.host, name, secure: url.protocol === 'https:' } : null;
}
