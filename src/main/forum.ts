import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AREAS,
  KINDS,
  PLATFORMS,
  STATUSES,
  type FieldError,
  type ForumAction,
  type ForumError,
  type ForumField,
  type ForumListing,
  type ForumPost,
  type ForumResult,
  type ForumState,
} from '../shared/forum';
import { FORUM_URL } from '../shared/forumEndpoint';
import type { Secrets } from './secrets';

const TIMEOUT_MS = 10_000;
const MAX_ANSWER = 2 * 1024 * 1024;
const ERRORS = new Set<ForumError>([
  'unavailable',
  'unauthorized',
  'banned',
  'invalid',
  'quota_posts',
  'quota_ip',
  'too_soon',
  'quota_votes',
  'quota_reports',
  'not_found',
  'too_late',
  'own_post',
  'pseudo_taken',
  'registrations',
  'rate_limited',
]);
const FIELDS = new Set<ForumField>(['kind', 'area', 'title', 'body', 'pseudo', 'reply', 'status']);
const FIELD_ERRORS = new Set<FieldError>(['required', 'short', 'long', 'link', 'html', 'insult', 'invalid']);
const ID = /^[0-9a-f-]{36}$/;

/** The forum's address: the build's, or AIBOX_FORUM_URL for a local Worker (https, or http on this computer only). */
export function forumUrl(fromEnv = process.env.AIBOX_FORUM_URL): string {
  const raw = fromEnv || FORUM_URL;
  try {
    const u = new URL(raw);
    const local = u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
    return (u.protocol === 'https:' || local) && !u.username && !u.password ? u.origin : '';
  } catch {
    return '';
  }
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => list.includes(v as T);

function toPost(v: unknown): ForumPost | null {
  const p = v as Record<string, unknown>;
  if (!p || typeof p !== 'object' || !isStr(p.id) || !ID.test(p.id) || !oneOf(KINDS, p.kind) || !oneOf(AREAS, p.area) || !oneOf(STATUSES, p.status)) return null;
  if (!isStr(p.title) || !isStr(p.body) || !isStr(p.author) || !isNum(p.createdAt) || !isNum(p.votes)) return null;
  return {
    id: p.id,
    kind: p.kind,
    area: p.area,
    title: p.title,
    body: p.body,
    author: p.author,
    createdAt: p.createdAt,
    status: p.status,
    votes: p.votes,
    voted: p.voted === true,
    reported: p.reported === true,
    mine: p.mine === true,
    reply: isStr(p.reply) ? p.reply : null,
    replyAt: isNum(p.replyAt) ? p.replyAt : null,
    version: isStr(p.version) ? p.version : '',
    platform: oneOf(PLATFORMS, p.platform) ? p.platform : 'other',
    hidden: p.hidden === true,
    ...(isNum(p.reports) ? { reports: p.reports } : {}),
  };
}

/** The forum's answer, kept to what the app shows: anything else it sends is dropped. */
export function toListing(v: unknown): ForumListing | null {
  const l = v as Record<string, unknown>;
  if (!l || typeof l !== 'object' || !Array.isArray(l.posts)) return null;
  const me = l.me as Record<string, unknown> | null;
  const q = (me?.quota ?? {}) as Record<string, unknown>;
  return {
    posts: l.posts.map(toPost).filter((p): p is ForumPost => p !== null),
    me:
      me && isStr(me.pseudo)
        ? { pseudo: me.pseudo, quota: { posts: isNum(q.posts) ? q.posts : 0, votes: isNum(q.votes) ? q.votes : 0, reports: isNum(q.reports) ? q.reports : 0, nextPostAt: isNum(q.nextPostAt) ? q.nextPostAt : 0 } }
        : null,
    admin: l.admin === true,
  };
}

/** An action as the renderer sent it, checked before anything leaves the app. */
export function toAction(v: unknown): ForumAction | null {
  const a = v as Record<string, unknown>;
  if (!a || typeof a !== 'object') return null;
  const id = isStr(a.id) && ID.test(a.id) ? a.id : null;
  switch (a.type) {
    case 'state':
    case 'refresh':
      return { type: a.type };
    case 'register':
      return isStr(a.pseudo) && a.pseudo.length <= 200 ? { type: 'register', pseudo: a.pseudo } : null;
    case 'post': {
      const d = a.draft as Record<string, unknown>;
      if (!d || !oneOf(KINDS, d.kind) || !oneOf(AREAS, d.area) || !isStr(d.title) || !isStr(d.body) || d.title.length > 1000 || d.body.length > 5000) return null;
      return { type: 'post', draft: { kind: d.kind, area: d.area, title: d.title, body: d.body } };
    }
    case 'delete':
    case 'report':
    case 'ban':
      return id ? { type: a.type, id } : null;
    case 'vote':
      return id && typeof a.on === 'boolean' ? { type: 'vote', id, on: a.on } : null;
    case 'moderate': {
      if (!id) return null;
      const m: Extract<ForumAction, { type: 'moderate' }> = { type: 'moderate', id };
      if (a.status !== undefined) {
        if (!oneOf(STATUSES, a.status)) return null;
        m.status = a.status;
      }
      if (a.reply !== undefined) {
        if (a.reply !== null && (!isStr(a.reply) || a.reply.length > 5000)) return null;
        m.reply = a.reply;
      }
      if (a.hidden !== undefined) {
        if (typeof a.hidden !== 'boolean') return null;
        m.hidden = a.hidden;
      }
      return m;
    }
    case 'adminKey':
      return a.key === null || (isStr(a.key) && a.key.length >= 20 && a.key.length <= 200) ? { type: 'adminKey', key: a.key === null ? null : a.key.trim() } : null;
  }
  return null;
}

type Answer = { status: number; body: Record<string, unknown> } | null;

/**
 * The app's side of the ideas forum: calls its Worker from the main process (the token and the moderators' key never
 * reach the page), keeps the last list for reading offline, and answers every action with the forum's state.
 */
export class Forum {
  private readonly cacheFile: string;
  private listing: ForumListing | null = null;
  private listedAt: number | null = null;
  private online = false;
  private loaded = false;

  constructor(
    dataDir: string,
    private readonly secrets: Secrets,
    private readonly version: string,
    private readonly url = forumUrl(),
  ) {
    this.cacheFile = join(dataDir, 'forum-cache.json');
  }

  async run(raw: unknown): Promise<ForumResult> {
    const action = toAction(raw);
    if (!action) return this.fail('unexpected');
    this.loadCache();
    if (action.type === 'state') return { ok: true, state: this.state() };
    if (!this.url) return this.fail('unavailable');
    switch (action.type) {
      case 'refresh':
        return this.call('GET', '/v1/posts');
      case 'register':
        return this.register(action.pseudo);
      case 'post':
        return this.call('POST', '/v1/posts', { ...action.draft, version: this.version, platform: process.platform });
      case 'delete':
        return this.call('DELETE', `/v1/posts/${action.id}`);
      case 'vote':
        return this.call(action.on ? 'PUT' : 'DELETE', `/v1/posts/${action.id}/vote`);
      case 'report':
        return this.call('POST', `/v1/posts/${action.id}/report`);
      case 'ban':
        return this.call('POST', `/v1/admin/posts/${action.id}/ban`);
      case 'moderate':
        return this.call('PATCH', `/v1/admin/posts/${action.id}`, { status: action.status, reply: action.reply, hidden: action.hidden });
      case 'adminKey':
        return this.setAdminKey(action.key);
    }
  }

  private state(): ForumState {
    return {
      available: !!this.url,
      online: this.online,
      listing: this.listing,
      listedAt: this.listedAt,
      signedIn: this.secrets.has('forumToken'),
      moderator: this.secrets.has('forumAdminKey') && this.listing?.admin === true,
      secureStorage: this.secrets.available(),
    };
  }

  private fail(error: ForumError, extra: Partial<Extract<ForumResult, { ok: false }>> = {}): ForumResult {
    return { ok: false, state: this.state(), error, ...extra };
  }

  private async register(pseudo: string): Promise<ForumResult> {
    if (!this.secrets.available()) return this.fail('no_keychain');
    const r = await this.request('POST', '/v1/register', { pseudo }, false);
    if (r?.status === 200 && isStr(r.body.token)) {
      await this.secrets.set('forumToken', r.body.token);
      this.keep(r.body.listing);
      return { ok: true, state: this.state() };
    }
    return this.refused(r);
  }

  /** A key is kept only once the forum has accepted it. */
  private async setAdminKey(key: string | null): Promise<ForumResult> {
    if (key === null) {
      await this.secrets.set('forumAdminKey', null);
      return this.call('GET', '/v1/posts');
    }
    if (!this.secrets.available()) return this.fail('no_keychain');
    const r = await this.request('GET', '/v1/posts', undefined, true, key);
    if (r?.status !== 200) return this.refused(r);
    await this.secrets.set('forumAdminKey', key);
    this.keep(r.body.listing);
    return { ok: true, state: this.state() };
  }

  private async call(method: string, path: string, body?: unknown): Promise<ForumResult> {
    let r = await this.request(method, path, body, true);
    // A key the forum no longer accepts (changed on the server) must not lock its owner out: dropped, then again.
    if (r?.status === 401 && r.body.who === 'admin' && this.secrets.has('forumAdminKey')) {
      await this.secrets.set('forumAdminKey', null);
      r = await this.request(method, path, body, true);
    }
    // A token the forum does not know any more (its database was reset): forgotten, the pseudo is asked again.
    if (r?.status === 401 && r.body.who === 'token') await this.secrets.set('forumToken', null);
    if (r && r.status >= 200 && r.status < 300) {
      this.keep(r.body.listing);
      return { ok: true, state: this.state() };
    }
    return this.refused(r);
  }

  private refused(r: Answer): ForumResult {
    if (!r) return this.fail('offline');
    const error = isStr(r.body.error) && ERRORS.has(r.body.error as ForumError) ? (r.body.error as ForumError) : r.status >= 500 ? 'unavailable' : 'unexpected';
    const raw = (r.body.fields ?? {}) as Record<string, unknown>;
    const fields: Partial<Record<ForumField, FieldError>> = {};
    for (const [k, v] of Object.entries(raw)) if (FIELDS.has(k as ForumField) && FIELD_ERRORS.has(v as FieldError)) fields[k as ForumField] = v as FieldError;
    return this.fail(error, { fields, ...(isNum(r.body.retryAt) ? { retryAt: r.body.retryAt } : {}) });
  }

  private async request(method: string, path: string, body: unknown, auth: boolean, adminKey = this.secrets.get('forumAdminKey')): Promise<Answer> {
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': `ai-box/${this.version}` };
    const token = this.secrets.get('forumToken');
    if (auth && token) headers.authorization = `Bearer ${token}`;
    if (adminKey) headers['x-admin-key'] = adminKey;
    if (body !== undefined) headers['content-type'] = 'application/json';
    try {
      const res = await fetch(`${this.url}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await res.text();
      this.online = true;
      let parsed: unknown = {};
      try {
        parsed = text.length <= MAX_ANSWER ? JSON.parse(text) : {};
      } catch {
        // Not the forum answering (a proxy page): an empty body, judged by its status.
      }
      return { status: res.status, body: parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {} };
    } catch {
      this.online = false;
      return null;
    }
  }

  private keep(raw: unknown): void {
    const listing = toListing(raw);
    if (!listing) return;
    this.listing = listing;
    this.listedAt = Date.now();
    try {
      const tmp = `${this.cacheFile}.tmp`;
      writeFileSync(tmp, JSON.stringify({ listing, listedAt: this.listedAt }));
      renameSync(tmp, this.cacheFile);
    } catch {
      // The cache only serves reading offline: the forum works without it.
    }
  }

  private loadCache(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!existsSync(this.cacheFile)) return;
      const c = JSON.parse(readFileSync(this.cacheFile, 'utf8')) as { listing?: unknown; listedAt?: unknown };
      this.listing = toListing(c.listing);
      this.listedAt = this.listing && isNum(c.listedAt) ? c.listedAt : null;
    } catch {
      this.listing = null;
    }
  }
}
