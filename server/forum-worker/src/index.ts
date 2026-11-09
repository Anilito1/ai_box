// The AI Box ideas forum: one JSON API over D1. Every rule is enforced here, in single SQL statements, so that a client
// calling the API directly (or many times at once) gets no more than the app allows.
import {
  checkPost,
  checkPseudo,
  checkReply,
  dayKey,
  LIMITS,
  platformOf,
  pseudoKey,
  STATUSES,
  type ForumError,
  type ForumField,
  type FieldError,
  type ForumListing,
  type ForumPost,
  type ForumQuota,
} from '../../../src/shared/forum';

export interface Env {
  DB: D1Database;
  /** SHA-256 (hex) of the moderators' key. Absent: no one moderates. */
  ADMIN_TOKEN_HASH?: string;
  /** Salt of the IP hashes. Absent: nothing can be written. */
  IP_SALT?: string;
  RL?: RateLimit;
}

interface User {
  id: string;
  pseudo: string;
  banned: number;
}

interface Ctx {
  env: Env;
  now: number;
  day: string;
  ipHash: string | null;
  user: User | null;
  admin: boolean;
}

const MAX_BODY = 8 * 1024;
const LIST_LIMIT = 500;
/** A token the app made itself (32 random bytes, base64url). */
const TOKEN = /^[A-Za-z0-9_-]{40,100}$/;

class Fail extends Error {
  constructor(
    readonly error: ForumError,
    readonly status: number,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(error);
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });

const invalid = (fields: Partial<Record<ForumField, FieldError>>) => new Fail('invalid', 400, { fields });

async function sha256(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) throw invalid({});
  const text = await req.text();
  if (text.length > MAX_BODY) throw invalid({});
  try {
    const v: unknown = JSON.parse(text || '{}');
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // Not JSON: same answer as a malformed object.
  }
  throw invalid({});
}

async function context(req: Request, env: Env, now: number): Promise<Ctx> {
  const day = dayKey(now);
  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
  const ipHash = env.IP_SALT ? await sha256(`${env.IP_SALT}|${day}|${ip}`) : null;
  if (env.RL) {
    const { success } = await env.RL.limit({ key: ipHash ?? ip });
    if (!success) throw new Fail('rate_limited', 429);
  }
  const bearer = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.headers.get('authorization') ?? '')?.[1];
  const user = bearer ? await env.DB.prepare('SELECT id, pseudo, banned FROM users WHERE token_hash = ?').bind(await sha256(bearer)).first<User>() : null;
  if (bearer && !user) throw new Fail('unauthorized', 401, { who: 'token' });
  const key = req.headers.get('x-admin-key');
  const admin = !!key && !!env.ADMIN_TOKEN_HASH && sameHex(await sha256(key), env.ADMIN_TOKEN_HASH.toLowerCase());
  if (key && !admin) throw new Fail('unauthorized', 401, { who: 'admin' });
  return { env, now, day, ipHash, user, admin };
}

/** Writes need a known, allowed user and a configured salt. */
function writer(c: Ctx): { user: User; ipHash: string } {
  if (!c.ipHash) throw new Fail('unavailable', 503);
  if (!c.user) throw new Fail('unauthorized', 401, { who: 'token' });
  if (c.user.banned) throw new Fail('banned', 403);
  return { user: c.user, ipHash: c.ipHash };
}

async function quota(c: Ctx, userId: string): Promise<ForumQuota> {
  const q = await c.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM posts WHERE user_id = ?1 AND day = ?2) AS posts,
            (SELECT COUNT(*) FROM votes WHERE user_id = ?1 AND day = ?2) AS votes,
            (SELECT COUNT(*) FROM reports WHERE user_id = ?1 AND day = ?2) AS reports,
            (SELECT MAX(created_at) FROM posts WHERE user_id = ?1) AS last`,
  )
    .bind(userId, c.day)
    .first<{ posts: number; votes: number; reports: number; last: number | null }>();
  const next = (q?.last ?? 0) + LIMITS.postGapMs;
  return {
    posts: Math.max(0, LIMITS.postsPerDay - (q?.posts ?? 0)),
    votes: Math.max(0, LIMITS.votesPerDay - (q?.votes ?? 0)),
    reports: Math.max(0, LIMITS.reportsPerDay - (q?.reports ?? 0)),
    nextPostAt: next > c.now ? next : 0,
  };
}

interface Row {
  id: string;
  kind: ForumPost['kind'];
  area: ForumPost['area'];
  title: string;
  body: string;
  author: string;
  created_at: number;
  status: ForumPost['status'];
  reply: string | null;
  reply_at: number | null;
  version: string;
  platform: string;
  hidden: number;
  user_id: string;
  votes: number;
  reports: number;
  voted: number;
  reported: number;
}

async function listing(c: Ctx): Promise<ForumListing> {
  const me = c.user?.id ?? '';
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.kind, p.area, p.title, p.body, u.pseudo AS author, p.created_at, p.status, p.reply, p.reply_at,
            p.version, p.platform, p.hidden, p.user_id,
            (SELECT COUNT(*) FROM votes v WHERE v.post_id = p.id) AS votes,
            (SELECT COUNT(*) FROM reports r WHERE r.post_id = p.id) AS reports,
            EXISTS (SELECT 1 FROM votes v WHERE v.post_id = p.id AND v.user_id = ?1) AS voted,
            EXISTS (SELECT 1 FROM reports r WHERE r.post_id = p.id AND r.user_id = ?1) AS reported
       FROM posts p JOIN users u ON u.id = p.user_id
      WHERE p.deleted = 0 AND ((p.hidden = 0 AND u.banned = 0) OR ?2 = 1 OR p.user_id = ?1)
      ORDER BY p.created_at DESC
      LIMIT ?3`,
  )
    .bind(me, c.admin ? 1 : 0, LIST_LIMIT)
    .all<Row>();
  const posts = results.map(
    (r): ForumPost => ({
      id: r.id,
      kind: r.kind,
      area: r.area,
      title: r.title,
      body: r.body,
      author: r.author,
      createdAt: r.created_at,
      status: r.status,
      votes: r.votes,
      voted: !!r.voted,
      reported: !!r.reported,
      mine: r.user_id === me,
      reply: r.reply,
      replyAt: r.reply_at,
      version: r.version,
      platform: platformOf(r.platform),
      hidden: !!r.hidden,
      ...(c.admin ? { reports: r.reports } : {}),
    }),
  );
  return { posts, me: c.user ? { pseudo: c.user.pseudo, quota: await quota(c, c.user.id) } : null, admin: c.admin };
}

async function register(c: Ctx, body: Record<string, unknown>): Promise<Response> {
  if (!c.ipHash) throw new Fail('unavailable', 503);
  const pseudo = checkPseudo(body.pseudo);
  if (!pseudo.ok) throw invalid(pseudo.fields);
  // The app sends the token it already holds: the same request sent again after a lost answer finds its own account
  // instead of a taken pseudo.
  const token = typeof body.token === 'string' && TOKEN.test(body.token) ? body.token : randomToken();
  const tokenHash = await sha256(token);
  const key = pseudoKey(pseudo.value);
  const again = await c.env.DB.prepare('SELECT id, pseudo, banned FROM users WHERE pseudo_key = ? AND token_hash = ?').bind(key, tokenHash).first<User>();
  if (again) return json({ token, listing: await listing({ ...c, user: again }) });
  const row = await c.env.DB.prepare(
    `INSERT INTO users (id, pseudo, pseudo_key, token_hash, ip_hash, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6
      WHERE (SELECT COUNT(*) FROM users WHERE ip_hash = ?5) < ?7
        AND NOT EXISTS (SELECT 1 FROM users WHERE pseudo_key = ?3)
     RETURNING id, pseudo, banned`,
  )
    .bind(crypto.randomUUID(), pseudo.value, key, tokenHash, c.ipHash, c.now, LIMITS.registrationsPerIp)
    .first<User>();
  if (!row) {
    const taken = await c.env.DB.prepare('SELECT 1 FROM users WHERE pseudo_key = ?').bind(key).first();
    throw taken ? new Fail('pseudo_taken', 409) : new Fail('registrations', 429);
  }
  return json({ token, listing: await listing({ ...c, user: row }) });
}

const VERSION = /^[0-9A-Za-z.+-]{1,32}$/;

async function createPost(c: Ctx, body: Record<string, unknown>): Promise<Response> {
  const { user, ipHash } = writer(c);
  const post = checkPost(body);
  if (!post.ok) throw invalid(post.fields);
  const v = post.value;
  const version = typeof body.version === 'string' && VERSION.test(body.version) ? body.version : 'unknown';
  const row = await c.env.DB.prepare(
    `INSERT INTO posts (id, user_id, kind, area, title, body, version, platform, day, ip_hash, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
      WHERE (SELECT COUNT(*) FROM posts WHERE user_id = ?2 AND day = ?9) < ?12
        AND NOT EXISTS (SELECT 1 FROM posts WHERE user_id = ?2 AND created_at > ?13)
        AND (SELECT COUNT(*) FROM posts WHERE ip_hash = ?10) < ?14
        AND EXISTS (SELECT 1 FROM users WHERE id = ?2 AND banned = 0)
     RETURNING id`,
  )
    .bind(
      crypto.randomUUID(),
      user.id,
      v.kind,
      v.area,
      v.title,
      v.body,
      version,
      platformOf(String(body.platform ?? '')),
      c.day,
      ipHash,
      c.now,
      LIMITS.postsPerDay,
      c.now - LIMITS.postGapMs,
      LIMITS.postsPerIp,
    )
    .first<{ id: string }>();
  if (!row) {
    const q = await quota(c, user.id);
    if (q.posts === 0) throw new Fail('quota_posts', 429);
    if (q.nextPostAt) throw new Fail('too_soon', 429, { retryAt: q.nextPostAt });
    throw new Fail('quota_ip', 429);
  }
  return json({ id: row.id, listing: await listing(c) }, 201);
}

async function removePost(c: Ctx, id: string): Promise<Response> {
  const { user } = writer(c);
  const row = await c.env.DB.prepare('UPDATE posts SET deleted = 1 WHERE id = ? AND user_id = ? AND deleted = 0 AND created_at > ? RETURNING id')
    .bind(id, user.id, c.now - LIMITS.deleteWindowMs)
    .first();
  if (!row) {
    const mine = await c.env.DB.prepare('SELECT 1 FROM posts WHERE id = ? AND user_id = ? AND deleted = 0').bind(id, user.id).first();
    throw mine ? new Fail('too_late', 409) : new Fail('not_found', 404);
  }
  return json({ listing: await listing(c) });
}

/** Why a vote or a report was not recorded, when it was not a repeat. */
async function refusal(c: Ctx, id: string, userId: string, table: 'votes' | 'reports'): Promise<Fail | null> {
  const repeat = await c.env.DB.prepare(`SELECT 1 FROM ${table} WHERE post_id = ? AND user_id = ?`).bind(id, userId).first();
  if (repeat) return null;
  const post = await c.env.DB.prepare('SELECT user_id FROM posts WHERE id = ? AND deleted = 0 AND hidden = 0').bind(id).first<{ user_id: string }>();
  if (!post) return new Fail('not_found', 404);
  if (post.user_id === userId) return new Fail('own_post', 403);
  return new Fail(table === 'votes' ? 'quota_votes' : 'quota_reports', 429);
}

async function vote(c: Ctx, id: string, on: boolean): Promise<Response> {
  const { user } = writer(c);
  if (!on) {
    await c.env.DB.prepare('DELETE FROM votes WHERE post_id = ? AND user_id = ?').bind(id, user.id).run();
    return json({ listing: await listing(c) });
  }
  const row = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO votes (post_id, user_id, day, created_at)
     SELECT ?1, ?2, ?3, ?4
      WHERE (SELECT COUNT(*) FROM votes WHERE user_id = ?2 AND day = ?3) < ?5
        AND EXISTS (SELECT 1 FROM posts WHERE id = ?1 AND deleted = 0 AND hidden = 0 AND user_id <> ?2)
     RETURNING post_id`,
  )
    .bind(id, user.id, c.day, c.now, LIMITS.votesPerDay)
    .first();
  if (!row) {
    const why = await refusal(c, id, user.id, 'votes');
    if (why) throw why;
  }
  return json({ listing: await listing(c) });
}

async function report(c: Ctx, id: string): Promise<Response> {
  const { user, ipHash } = writer(c);
  const row = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO reports (post_id, user_id, day, created_at, ip_hash)
     SELECT ?1, ?2, ?3, ?4, ?6
      WHERE (SELECT COUNT(*) FROM reports WHERE user_id = ?2 AND day = ?3) < ?5
        AND EXISTS (SELECT 1 FROM posts WHERE id = ?1 AND deleted = 0 AND hidden = 0 AND user_id <> ?2)
     RETURNING post_id`,
  )
    .bind(id, user.id, c.day, c.now, LIMITS.reportsPerDay, ipHash)
    .first();
  if (!row) {
    const why = await refusal(c, id, user.id, 'reports');
    if (why) throw why;
  } else
    // Counted per address: pseudos made from one connection cannot hide a message on their own.
    await c.env.DB.prepare(
      'UPDATE posts SET hidden = 1 WHERE id = ?1 AND hidden = 0 AND reviewed = 0 AND (SELECT COUNT(DISTINCT ip_hash) FROM reports WHERE post_id = ?1) >= ?2',
    )
      .bind(id, LIMITS.reportsToHide)
      .run();
  return json({ listing: await listing(c) });
}

async function moderate(c: Ctx, id: string, body: Record<string, unknown>): Promise<Response> {
  if (!c.admin) throw new Fail('unauthorized', 401, { who: 'admin' });
  const sets: string[] = [];
  const values: unknown[] = [];
  if ('status' in body) {
    const status = STATUSES.find((s) => s === body.status);
    if (!status) throw invalid({ status: 'invalid' });
    sets.push('status = ?');
    values.push(status);
  }
  if ('reply' in body) {
    if (body.reply === null) sets.push('reply = NULL', 'reply_at = NULL');
    else {
      const reply = checkReply(body.reply);
      if (!reply.ok) throw invalid(reply.fields);
      sets.push('reply = ?', 'reply_at = ?');
      values.push(reply.value, c.now);
    }
  }
  if ('hidden' in body) {
    if (typeof body.hidden !== 'boolean') throw invalid({});
    sets.push('hidden = ?', 'reviewed = 1');
    values.push(body.hidden ? 1 : 0);
  }
  if (!sets.length) throw invalid({});
  const row = await c.env.DB.prepare(`UPDATE posts SET ${sets.join(', ')} WHERE id = ? AND deleted = 0 RETURNING id`)
    .bind(...values, id)
    .first();
  if (!row) throw new Fail('not_found', 404);
  return json({ listing: await listing(c) });
}

/** Blocks the author of a message: nothing more from them, and their messages leave the list. */
async function ban(c: Ctx, id: string): Promise<Response> {
  if (!c.admin) throw new Fail('unauthorized', 401, { who: 'admin' });
  const post = await c.env.DB.prepare('SELECT user_id FROM posts WHERE id = ?').bind(id).first<{ user_id: string }>();
  if (!post) throw new Fail('not_found', 404);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET banned = 1 WHERE id = ?').bind(post.user_id),
    c.env.DB.prepare('UPDATE posts SET hidden = 1, reviewed = 1 WHERE user_id = ?').bind(post.user_id),
  ]);
  return json({ listing: await listing(c) });
}

const POST_ID = '([0-9a-f-]{36})';
const ROUTES: [string, RegExp, (c: Ctx, req: Request, id: string) => Promise<Response>][] = [
  ['GET', /^\/v1\/health$/, async () => json({ ok: true })],
  ['GET', /^\/v1\/posts$/, async (c) => json({ listing: await listing(c) })],
  ['POST', /^\/v1\/register$/, async (c, req) => register(c, await readJson(req))],
  ['POST', /^\/v1\/posts$/, async (c, req) => createPost(c, await readJson(req))],
  ['DELETE', new RegExp(`^/v1/posts/${POST_ID}$`), (c, _req, id) => removePost(c, id)],
  ['PUT', new RegExp(`^/v1/posts/${POST_ID}/vote$`), (c, _req, id) => vote(c, id, true)],
  ['DELETE', new RegExp(`^/v1/posts/${POST_ID}/vote$`), (c, _req, id) => vote(c, id, false)],
  ['POST', new RegExp(`^/v1/posts/${POST_ID}/report$`), (c, _req, id) => report(c, id)],
  ['PATCH', new RegExp(`^/v1/admin/posts/${POST_ID}$`), async (c, req, id) => moderate(c, id, await readJson(req))],
  ['POST', new RegExp(`^/v1/admin/posts/${POST_ID}/ban$`), (c, _req, id) => ban(c, id)],
];

export async function handle(req: Request, env: Env, now = Date.now()): Promise<Response> {
  try {
    const path = new URL(req.url).pathname;
    for (const [method, pattern, run] of ROUTES) {
      const m = pattern.exec(path);
      if (m && req.method === method) return await run(await context(req, env, now), req, m[1] ?? '');
    }
    return json({ error: 'not_found' }, 404);
  } catch (e) {
    if (e instanceof Fail) return json({ error: e.error, ...e.extra }, e.status);
    console.error('forum: unexpected', e instanceof Error ? e.message : String(e));
    return json({ error: 'unexpected' }, 500);
  }
}

export default {
  fetch: (req, env) => handle(req, env),
} satisfies ExportedHandler<Env>;
