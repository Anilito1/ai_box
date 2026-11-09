// The ideas forum: what a message is and the rules it follows, shared by the app (instant feedback) and the forum
// Worker (server/forum-worker), which alone decides.

export const KINDS = ['idea', 'like', 'dislike', 'problem'] as const;
export const AREAS = ['sessions', 'workers', 'hub', 'ui', 'providers', 'other'] as const;
export const STATUSES = ['new', 'studied', 'planned', 'done', 'declined'] as const;
export const PLATFORMS = ['win32', 'darwin', 'linux', 'other'] as const;
export type ForumKind = (typeof KINDS)[number];
export type ForumArea = (typeof AREAS)[number];
export type ForumStatus = (typeof STATUSES)[number];
export type ForumPlatform = (typeof PLATFORMS)[number];

export const LIMITS = {
  titleMin: 4,
  titleMax: 80,
  bodyMin: 10,
  bodyMax: 600,
  replyMax: 600,
  pseudoMin: 3,
  pseudoMax: 24,
  postsPerDay: 2,
  votesPerDay: 10,
  reportsPerDay: 5,
  postGapMs: 10 * 60_000,
  deleteWindowMs: 60 * 60_000,
  reportsToHide: 3,
  /** Second line of defence against a user who signs up again: per IP address and per day. */
  registrationsPerIp: 3,
  postsPerIp: 6,
} as const;

export interface ForumPost {
  id: string;
  kind: ForumKind;
  area: ForumArea;
  title: string;
  body: string;
  author: string;
  createdAt: number;
  status: ForumStatus;
  votes: number;
  voted: boolean;
  reported: boolean;
  mine: boolean;
  reply: string | null;
  replyAt: number | null;
  version: string;
  platform: ForumPlatform;
  hidden: boolean;
  /** Moderators only. */
  reports?: number;
}

export interface ForumQuota {
  posts: number;
  votes: number;
  reports: number;
  /** When the next message may be sent (0: now). */
  nextPostAt: number;
}

export interface ForumMe {
  pseudo: string;
  quota: ForumQuota;
}

export interface ForumListing {
  posts: ForumPost[];
  me: ForumMe | null;
  admin: boolean;
}

export type ForumField = 'kind' | 'area' | 'title' | 'body' | 'pseudo' | 'reply' | 'status';
export type FieldError = 'required' | 'short' | 'long' | 'link' | 'html' | 'insult' | 'invalid' | 'taken';
export type ForumError =
  | 'offline'
  | 'unavailable'
  | 'unauthorized'
  | 'banned'
  | 'invalid'
  | 'quota_posts'
  | 'quota_ip'
  | 'too_soon'
  | 'quota_votes'
  | 'quota_reports'
  | 'not_found'
  | 'too_late'
  | 'own_post'
  | 'pseudo_taken'
  | 'registrations'
  | 'rate_limited'
  | 'no_keychain'
  | 'unexpected';

export interface ForumDraft {
  kind: ForumKind;
  area: ForumArea;
  title: string;
  body: string;
}

/** Characters as a person counts them (an emoji is one). */
export const charCount = (s: string): number => [...s].length;

// Control and invisible characters (bidi overrides, zero-width), kept out of every stored text.
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F­​-‏‪-‮⁠-⁤﻿]/g;

export function cleanText(s: string): string {
  return s.normalize('NFC').replace(/\r\n?/g, '\n').replace(INVISIBLE, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export const cleanLine = (s: string): string => cleanText(s).replace(/\s+/g, ' ');

// A bare domain only in lower case and with a domain-only ending: "install.sh", "crashes.It" or "ça.me" stay text.
const LINK = /https?:\/\/|www\.|[\w.+-]+@[\w-]+\.[a-z]{2,}/i;
const DOMAIN = /\b[a-z0-9-]{2,}\.(?:com|fr|net|org|io|dev|app|ly|gg|xyz|ru|info|biz|link|site|online|eu|uk|ch|ca)\b/;
export const hasLink = (s: string): boolean => LINK.test(s) || DOMAIN.test(s);

// Real tags, numeric entities and script URLs; placeholders such as <Enter> or --model <name> stay text (the app
// shows messages as text only).
const HTML =
  /<\/?(?:a|b|i|u|p|br|hr|div|span|img|svg|script|style|iframe|object|embed|link|meta|form|input|button|video|audio|table|body|html|h[1-6])\b[^>]*>|<!--|&#x?[0-9a-f]+;|javascript:/i;
export const hasHtml = (s: string): boolean => HTML.test(s);

// A short list on purpose: reports catch the rest. Matched as whole words once accents and digit swaps are undone.
const INSULTS = new Set(
  (
    'con conne connard connards connasse connasses encule encules enculer salope salopes salaud salauds pute putes ' +
    'batard batards abruti abrutis debile debiles cretin cretins nique niquer ntm fdp pd pede pedes tapette negre negres ' +
    'fuck fucking fucker fuckers motherfucker bitch bitches cunt cunts asshole assholes retarded dickhead bastard ' +
    'bastards whore whores slut sluts nigger niggers nigga faggot faggots fag'
  ).split(' '),
);
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's' };

export function hasInsult(s: string): boolean {
  const plain = s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[013457@$]/g, (c) => LEET[c]);
  return plain.split(/[^a-z]+/).some((w) => INSULTS.has(w) || INSULTS.has(w.replace(/(.)\1+/g, '$1')));
}

const textError = (s: string, min: number, max: number): FieldError | null => {
  const n = charCount(s);
  if (n === 0) return 'required';
  if (n < min) return 'short';
  if (n > max) return 'long';
  if (hasHtml(s)) return 'html';
  if (hasLink(s)) return 'link';
  if (hasInsult(s)) return 'insult';
  return null;
};

export type Checked<T> = { ok: true; value: T } | { ok: false; fields: Partial<Record<ForumField, FieldError>> };

/** A message as it will be stored: cleaned, then checked field by field. */
export function checkPost(input: { kind?: unknown; area?: unknown; title?: unknown; body?: unknown }): Checked<ForumDraft> {
  const kind = KINDS.find((k) => k === input.kind);
  const area = AREAS.find((a) => a === input.area);
  const title = cleanLine(typeof input.title === 'string' ? input.title : '');
  const body = cleanText(typeof input.body === 'string' ? input.body : '');
  const fields: Partial<Record<ForumField, FieldError>> = {};
  if (!kind) fields.kind = 'required';
  if (!area) fields.area = 'required';
  const t = textError(title, LIMITS.titleMin, LIMITS.titleMax);
  if (t) fields.title = t;
  const b = textError(body, LIMITS.bodyMin, LIMITS.bodyMax);
  if (b) fields.body = b;
  if (!kind || !area || t || b) return { ok: false, fields };
  return { ok: true, value: { kind, area, title, body } };
}

const PSEUDO = /^[\p{L}\p{N}][\p{L}\p{N} _.-]*[\p{L}\p{N}]$/u;

export function checkPseudo(input: unknown): Checked<string> {
  const pseudo = cleanLine(typeof input === 'string' ? input : '');
  const n = charCount(pseudo);
  const error: FieldError | null =
    n === 0 ? 'required' : n < LIMITS.pseudoMin ? 'short' : n > LIMITS.pseudoMax ? 'long' : !PSEUDO.test(pseudo) ? 'invalid' : hasInsult(pseudo) ? 'insult' : null;
  return error ? { ok: false, fields: { pseudo: error } } : { ok: true, value: pseudo };
}

/** Two pseudos that read the same are the same: case and accents aside. */
export const pseudoKey = (pseudo: string): string =>
  pseudo
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[ _.-]+/g, '');

/** A developers' answer: no HTML, no insult; links are allowed (the app shows text only). */
export function checkReply(input: unknown): Checked<string> {
  const reply = cleanText(typeof input === 'string' ? input : '');
  const n = charCount(reply);
  const error: FieldError | null = n === 0 ? 'required' : n > LIMITS.replyMax ? 'long' : hasHtml(reply) ? 'html' : null;
  return error ? { ok: false, fields: { reply: error } } : { ok: true, value: reply };
}

const DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' });

/** The day quotas count in: the calendar day in Paris, where the developers are. */
export const dayKey = (ms: number): string => DAY.format(ms);

export const platformOf = (p: string): ForumPlatform => PLATFORMS.find((x) => x === p) ?? 'other';

/** Most supported first, then the newest; done and declined ones after the rest. */
export function rank(posts: ForumPost[], by: 'top' | 'new'): ForumPost[] {
  const closed = (p: ForumPost) => (p.status === 'done' || p.status === 'declined' ? 1 : 0);
  return [...posts].sort((a, b) => (by === 'top' ? closed(a) - closed(b) || b.votes - a.votes : 0) || b.createdAt - a.createdAt);
}

/** What the app knows of the forum: the last list it got (possibly from its cache) and how it can act. */
export interface ForumState {
  /** A forum address is set in this build. */
  available: boolean;
  /** The last call reached the forum. */
  online: boolean;
  listing: ForumListing | null;
  /** When the list shown was received. */
  listedAt: number | null;
  signedIn: boolean;
  /** A moderators' key is stored and the forum accepted it. */
  moderator: boolean;
  /** Secrets can be stored (the token, the key): without it, reading only. */
  secureStorage: boolean;
}

export type ForumAction =
  | { type: 'state' }
  | { type: 'refresh' }
  | { type: 'register'; pseudo: string }
  | { type: 'post'; draft: ForumDraft }
  | { type: 'delete' | 'report' | 'ban'; id: string }
  | { type: 'vote'; id: string; on: boolean }
  | { type: 'moderate'; id: string; status?: ForumStatus; reply?: string | null; hidden?: boolean }
  | { type: 'adminKey'; key: string | null };

export type ForumResult =
  | { ok: true; state: ForumState }
  | { ok: false; state: ForumState; error: ForumError; fields?: Partial<Record<ForumField, FieldError>>; retryAt?: number };

export interface ForumFilter {
  query: string;
  kind: ForumKind | 'all';
  area: ForumArea | 'all';
  mine: boolean;
}

export function filterPosts(posts: ForumPost[], f: ForumFilter): ForumPost[] {
  const q = f.query.trim().toLowerCase();
  return posts.filter(
    (p) =>
      (f.kind === 'all' || p.kind === f.kind) &&
      (f.area === 'all' || p.area === f.area) &&
      (!f.mine || p.mine) &&
      (!q || `${p.title} ${p.body} ${p.author}`.toLowerCase().includes(q)),
  );
}

/** A draft kept on this computer while it is written: type and area may not be chosen yet. */
export interface StoredDraft {
  id: string;
  kind: ForumKind | '';
  area: ForumArea | '';
  title: string;
  body: string;
  updatedAt: number;
}

export const MAX_DRAFTS = 50;

/** The drafts as stored, newest first; anything unreadable is left out rather than failing the whole list. */
export function readDrafts(raw: string | null): StoredDraft[] {
  let list: unknown;
  try {
    list = JSON.parse(raw ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter((d): d is StoredDraft => {
      const x = d as Record<string, unknown>;
      return (
        !!x &&
        typeof x.id === 'string' &&
        (x.kind === '' || KINDS.includes(x.kind as ForumKind)) &&
        (x.area === '' || AREAS.includes(x.area as ForumArea)) &&
        typeof x.title === 'string' &&
        typeof x.body === 'string' &&
        typeof x.updatedAt === 'number'
      );
    })
    .map((d) => ({ id: d.id, kind: d.kind, area: d.area, title: d.title.slice(0, 1000), body: d.body.slice(0, 5000), updatedAt: d.updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_DRAFTS);
}

export const isEmptyDraft = (d: StoredDraft): boolean => !d.title.trim() && !d.body.trim();
