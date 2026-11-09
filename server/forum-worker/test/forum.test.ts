import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { LIMITS, type ForumListing } from '../../../src/shared/forum';
import { handle } from '../src/index';
import { TEST_ADMIN_KEY } from './credentials';

// 10:00 in Paris: the whole test stays within one quota day unless it says otherwise.
const T0 = Date.UTC(2026, 10, 9, 9, 0);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

interface Answer {
  status: number;
  data: { error?: string; token?: string; id?: string; retryAt?: number; fields?: Record<string, string>; listing?: ForumListing };
}

interface Opts {
  token?: string;
  admin?: string;
  body?: unknown;
  ip?: string;
  now?: number;
  envOverride?: Partial<typeof env>;
}

async function call(method: string, path: string, o: Opts = {}): Promise<Answer> {
  const headers: Record<string, string> = { 'cf-connecting-ip': o.ip ?? '203.0.113.1' };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.admin) headers['x-admin-key'] = o.admin;
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  const req = new Request(`https://forum.test${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const res = await handle(req, { ...env, ...o.envOverride }, o.now ?? T0);
  return { status: res.status, data: await res.json() };
}

let ips = 0;
async function user(pseudo: string, ip = `198.51.100.${++ips}`): Promise<{ token: string; ip: string }> {
  const r = await call('POST', '/v1/register', { body: { pseudo }, ip });
  expect(r.status).toBe(200);
  return { token: r.data.token as string, ip };
}

const idea = (n = 1) => ({ kind: 'idea', area: 'ui', title: `Idée numéro ${n}`, body: 'Un texte assez long pour passer.', version: '0.2.0', platform: 'win32' });

async function post(u: { token: string; ip: string }, now = T0, n = 1): Promise<Answer> {
  return call('POST', '/v1/posts', { token: u.token, ip: u.ip, body: idea(n), now });
}

/** Messages written straight into the database, to vote on many without the posting quota. */
async function seedPosts(pseudo: string, count: number): Promise<string[]> {
  const author = await env.DB.prepare('SELECT id FROM users WHERE pseudo = ?').bind(pseudo).first<{ id: string }>();
  const ids = Array.from({ length: count }, () => crypto.randomUUID());
  await env.DB.batch(
    ids.map((id, i) =>
      env.DB.prepare(
        `INSERT INTO posts (id, user_id, kind, area, title, body, version, platform, day, ip_hash, created_at)
         VALUES (?, ?, 'idea', 'ui', ?, 'Un texte assez long.', '0.2.0', 'win32', '2026-11-08', 'seed', ?)`,
      ).bind(id, author!.id, `Seed ${i}`, T0 - DAY),
    ),
  );
  return ids;
}

beforeEach(async () => {
  await env.DB.batch(['DELETE FROM votes', 'DELETE FROM reports', 'DELETE FROM posts', 'DELETE FROM users'].map((q) => env.DB.prepare(q)));
});

describe('the HTTP surface', () => {
  it('answers its health check and unknown paths', async () => {
    const ok = await SELF.fetch('https://forum.test/v1/health');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect((await SELF.fetch('https://forum.test/v1/nope')).status).toBe(404);
  });

  it('refuses writes when the salt is missing, and admin when its hash is', async () => {
    expect((await call('POST', '/v1/register', { body: { pseudo: 'Alice' }, envOverride: { IP_SALT: undefined } })).status).toBe(503);
    const r = await call('GET', '/v1/posts', { admin: TEST_ADMIN_KEY, envOverride: { ADMIN_TOKEN_HASH: undefined } });
    expect(r.status).toBe(401);
  });

  it('rejects bodies that are too large or not JSON objects', async () => {
    const u = await user('Bigbody');
    expect((await call('POST', '/v1/posts', { token: u.token, ip: u.ip, body: { ...idea(), body: 'x'.repeat(9000) } })).status).toBe(400);
    expect((await call('POST', '/v1/posts', { token: u.token, ip: u.ip, body: [1, 2] })).status).toBe(400);
  });
});

describe('identity', () => {
  it('gives a token for a free pseudo, never twice the same pseudo', async () => {
    const a = await call('POST', '/v1/register', { body: { pseudo: 'Élodie' }, ip: '192.0.2.1' });
    expect(a.status).toBe(200);
    expect(a.data.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(a.data.listing?.me?.pseudo).toBe('Élodie');
    const b = await call('POST', '/v1/register', { body: { pseudo: 'elodie' }, ip: '192.0.2.2' });
    expect([b.status, b.data.error]).toEqual([409, 'pseudo_taken']);
    const bad = await call('POST', '/v1/register', { body: { pseudo: '<b>' }, ip: '192.0.2.3' });
    expect([bad.status, bad.data.fields?.pseudo]).toEqual([400, 'invalid']);
  });

  it('limits sign-ups per address and per day', async () => {
    for (const p of ['Un1', 'Deux', 'Trois']) expect((await call('POST', '/v1/register', { body: { pseudo: p }, ip: '192.0.2.9' })).status).toBe(200);
    const fourth = await call('POST', '/v1/register', { body: { pseudo: 'Quatre' }, ip: '192.0.2.9' });
    expect([fourth.status, fourth.data.error]).toEqual([429, 'registrations']);
    expect((await call('POST', '/v1/register', { body: { pseudo: 'Quatre' }, ip: '192.0.2.9', now: T0 + DAY })).status).toBe(200);
  });

  it('answers a repeated sign-up with the same account, so a lost answer does not lose the pseudo', async () => {
    const token = 'k'.repeat(43);
    const first = await call('POST', '/v1/register', { body: { pseudo: 'Retry', token }, ip: '192.0.2.20' });
    const again = await call('POST', '/v1/register', { body: { pseudo: 'Retry', token }, ip: '192.0.2.20' });
    expect([first.status, again.status, again.data.token]).toEqual([200, 200, token]);
    const other = await call('POST', '/v1/register', { body: { pseudo: 'Retry', token: 'z'.repeat(43) }, ip: '192.0.2.21' });
    expect([other.status, other.data.error]).toEqual([409, 'pseudo_taken']);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE pseudo = 'Retry'").first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it('refuses an unknown token', async () => {
    const r = await call('POST', '/v1/posts', { token: 'x'.repeat(43), body: idea() });
    expect([r.status, r.data.error]).toEqual([401, 'unauthorized']);
    expect((await call('POST', '/v1/posts', { body: idea() })).status).toBe(401);
  });
});

describe('a message', () => {
  it('is checked by the server whatever the client sends', async () => {
    const u = await user('Checker');
    const cases: [Record<string, unknown>, string, string][] = [
      [{ title: 'Voir https://exemple.com' }, 'title', 'link'],
      [{ body: 'Un <script>alert(1)</script> ici' }, 'body', 'html'],
      [{ body: 'Ce truc est pour les connards.' }, 'body', 'insult'],
      [{ title: 'x'.repeat(LIMITS.titleMax + 1) }, 'title', 'long'],
      [{ body: 'court' }, 'body', 'short'],
      [{ kind: 'rant' }, 'kind', 'required'],
      [{ area: 'billing' }, 'area', 'required'],
    ];
    for (const [patch, field, error] of cases) {
      const r = await call('POST', '/v1/posts', { token: u.token, ip: u.ip, body: { ...idea(), ...patch } });
      expect([r.status, r.data.fields?.[field]]).toEqual([400, error]);
    }
  });

  it('is stored cleaned, with the version and platform', async () => {
    const u = await user('Cleaner');
    const r = await call('POST', '/v1/posts', { token: u.token, ip: u.ip, body: { ...idea(), title: '  Un   titre​ propre ', platform: 'beos', version: '<x>' } });
    expect(r.status).toBe(201);
    const p = r.data.listing!.posts[0];
    expect([p.title, p.platform, p.version, p.mine, p.status, p.author]).toEqual(['Un titre propre', 'other', 'unknown', true, 'new', 'Cleaner']);
  });

  it('can be removed by its author within the hour only, without giving the quota back', async () => {
    const u = await user('Remover');
    const other = await user('Stranger');
    const first = await post(u);
    const id = first.data.id as string;
    expect((await call('DELETE', `/v1/posts/${id}`, { token: other.token, ip: other.ip })).status).toBe(404);
    const gone = await call('DELETE', `/v1/posts/${id}`, { token: u.token, ip: u.ip, now: T0 + 30 * MIN });
    expect(gone.status).toBe(200);
    expect(gone.data.listing!.posts).toHaveLength(0);
    expect(gone.data.listing!.me!.quota.posts).toBe(LIMITS.postsPerDay - 1);
    const late = await post(u, T0 + 31 * MIN, 2);
    const r = await call('DELETE', `/v1/posts/${late.data.id}`, { token: u.token, ip: u.ip, now: T0 + 31 * MIN + 61 * MIN });
    expect([r.status, r.data.error]).toEqual([409, 'too_late']);
  });
});

describe('quotas, enforced on the server even when the API is called directly', () => {
  it('waits between two messages, then stops at the daily limit, then resets the next day', async () => {
    const u = await user('Daily');
    expect((await post(u, T0)).status).toBe(201);
    const soon = await post(u, T0 + MIN, 2);
    expect([soon.status, soon.data.error, soon.data.retryAt]).toEqual([429, 'too_soon', T0 + LIMITS.postGapMs]);
    expect((await post(u, T0 + 11 * MIN, 2)).status).toBe(201);
    const over = await post(u, T0 + 30 * MIN, 3);
    expect([over.status, over.data.error]).toEqual([429, 'quota_posts']);
    const list = await call('GET', '/v1/posts', { token: u.token, ip: u.ip, now: T0 + 30 * MIN });
    expect(list.data.listing!.me!.quota).toMatchObject({ posts: 0, votes: LIMITS.votesPerDay });
    expect((await post(u, T0 + DAY, 4)).status).toBe(201);
  });

  it('lets only one of many simultaneous messages through', async () => {
    const u = await user('Racer');
    const answers = await Promise.all(Array.from({ length: 8 }, (_, i) => post(u, T0, i)));
    expect(answers.filter((a) => a.status === 201)).toHaveLength(1);
    expect(answers.filter((a) => a.status === 429)).toHaveLength(7);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM posts').first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it('records no more than the daily +1s, even sent all at once', async () => {
    await user('Author');
    const ids = await seedPosts('Author', LIMITS.votesPerDay + 5);
    const voter = await user('Voter');
    const answers = await Promise.all(ids.map((id) => call('PUT', `/v1/posts/${id}/vote`, { token: voter.token, ip: voter.ip })));
    expect(answers.filter((a) => a.status === 200)).toHaveLength(LIMITS.votesPerDay);
    expect(answers.filter((a) => a.data.error === 'quota_votes')).toHaveLength(5);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM votes').first<{ n: number }>();
    expect(n?.n).toBe(LIMITS.votesPerDay);
  });

  it('caps messages per address, whatever the number of pseudos', async () => {
    const ip = '192.0.2.50';
    const users = [await user('Ip1', ip), await user('Ip2', ip), await user('Ip3', ip)];
    for (const u of users) {
      expect((await post(u, T0)).status).toBe(201);
      expect((await post(u, T0 + 11 * MIN, 2)).status).toBe(201);
    }
    const elsewhere = await user('Ip4', '192.0.2.51');
    const r = await call('POST', '/v1/posts', { token: elsewhere.token, ip, body: idea() });
    expect([r.status, r.data.error]).toEqual([429, 'quota_ip']);
  });
});

describe('+1 and reports', () => {
  it('counts one +1 per person, never on their own message, and can be taken back', async () => {
    const author = await user('Writer');
    const id = (await post(author)).data.id as string;
    const own = await call('PUT', `/v1/posts/${id}/vote`, { token: author.token, ip: author.ip });
    expect([own.status, own.data.error]).toEqual([403, 'own_post']);
    const fan = await user('Fan');
    await call('PUT', `/v1/posts/${id}/vote`, { token: fan.token, ip: fan.ip });
    const again = await call('PUT', `/v1/posts/${id}/vote`, { token: fan.token, ip: fan.ip });
    expect(again.status).toBe(200);
    expect(again.data.listing!.posts[0]).toMatchObject({ votes: 1, voted: true });
    expect(again.data.listing!.me!.quota.votes).toBe(LIMITS.votesPerDay - 1);
    const back = await call('DELETE', `/v1/posts/${id}/vote`, { token: fan.token, ip: fan.ip });
    expect(back.data.listing!.posts[0]).toMatchObject({ votes: 0, voted: false });
    expect((await call('PUT', `/v1/posts/${crypto.randomUUID()}/vote`, { token: fan.token, ip: fan.ip })).status).toBe(404);
  });

  it('hides a message reported by enough people until a moderator decides', async () => {
    const author = await user('Reported');
    const id = (await post(author)).data.id as string;
    for (let i = 0; i < LIMITS.reportsToHide; i++) {
      const r = await user(`Reporter${i}`);
      expect((await call('POST', `/v1/posts/${id}/report`, { token: r.token, ip: r.ip })).status).toBe(200);
    }
    const reader = await user('Reader');
    expect((await call('GET', '/v1/posts', { token: reader.token, ip: reader.ip })).data.listing!.posts).toHaveLength(0);
    const mine = await call('GET', '/v1/posts', { token: author.token, ip: author.ip });
    expect(mine.data.listing!.posts[0]).toMatchObject({ hidden: true });
    const admin = await call('GET', '/v1/posts', { admin: TEST_ADMIN_KEY });
    expect(admin.data.listing).toMatchObject({ admin: true, posts: [{ hidden: true, reports: LIMITS.reportsToHide }] });
    expect((await call('PATCH', `/v1/admin/posts/${id}`, { admin: TEST_ADMIN_KEY, body: { hidden: false } })).status).toBe(200);
    const late = await user('LateReporter');
    await call('POST', `/v1/posts/${id}/report`, { token: late.token, ip: late.ip });
    expect((await call('GET', '/v1/posts', { token: reader.token, ip: reader.ip })).data.listing!.posts).toHaveLength(1);
  });

  it('does not hide a message reported by pseudos from a single connection', async () => {
    const author = await user('Target');
    const id = (await post(author)).data.id as string;
    const ip = '192.0.2.60';
    for (const p of ['Sock1', 'Sock2', 'Sock3']) {
      const r = await user(p, ip);
      expect((await call('POST', `/v1/posts/${id}/report`, { token: r.token, ip })).status).toBe(200);
    }
    const reader = await user('Bystander');
    expect((await call('GET', '/v1/posts', { token: reader.token, ip: reader.ip })).data.listing!.posts).toHaveLength(1);
  });

  it('limits reports per day', async () => {
    await user('Many');
    const ids = await seedPosts('Many', LIMITS.reportsPerDay + 1);
    const r = await user('Snitch');
    const answers = await Promise.all(ids.map((id) => call('POST', `/v1/posts/${id}/report`, { token: r.token, ip: r.ip })));
    expect(answers.filter((a) => a.status === 200)).toHaveLength(LIMITS.reportsPerDay);
    expect(answers.filter((a) => a.data.error === 'quota_reports')).toHaveLength(1);
  });
});

describe('moderation', () => {
  it('needs the key, then sets the status and the official reply', async () => {
    const u = await user('Asker');
    const id = (await post(u)).data.id as string;
    expect((await call('PATCH', `/v1/admin/posts/${id}`, { token: u.token, ip: u.ip, body: { status: 'done' } })).status).toBe(401);
    expect((await call('PATCH', `/v1/admin/posts/${id}`, { admin: 'wrong-key', body: { status: 'done' } })).status).toBe(401);
    expect((await call('PATCH', `/v1/admin/posts/${id}`, { admin: TEST_ADMIN_KEY, body: { status: 'shipped' } })).status).toBe(400);
    const r = await call('PATCH', `/v1/admin/posts/${id}`, { admin: TEST_ADMIN_KEY, body: { status: 'planned', reply: 'Prévu pour la prochaine version.' }, now: T0 + MIN });
    expect(r.data.listing!.posts[0]).toMatchObject({ status: 'planned', reply: 'Prévu pour la prochaine version.', replyAt: T0 + MIN });
    const cleared = await call('PATCH', `/v1/admin/posts/${id}`, { admin: TEST_ADMIN_KEY, body: { reply: null } });
    expect(cleared.data.listing!.posts[0]).toMatchObject({ reply: null, replyAt: null });
  });

  it('blocks an author: their messages leave the list and they can no longer write', async () => {
    const u = await user('Spammer');
    const id = (await post(u)).data.id as string;
    expect((await call('POST', `/v1/admin/posts/${id}/ban`, { admin: TEST_ADMIN_KEY })).status).toBe(200);
    const reader = await user('Witness');
    expect((await call('GET', '/v1/posts', { token: reader.token, ip: reader.ip })).data.listing!.posts).toHaveLength(0);
    const r = await post(u, T0 + DAY, 2);
    expect([r.status, r.data.error]).toEqual([403, 'banned']);
  });
});
