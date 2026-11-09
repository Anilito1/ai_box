import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPost, checkPseudo, checkReply, cleanText, dayKey, filterPosts, hasInsult, hasLink, LIMITS, pseudoKey, rank, readDrafts, type ForumPost } from './forum';

const post = (p: Partial<ForumPost>): ForumPost => ({
  id: crypto.randomUUID(),
  kind: 'idea',
  area: 'ui',
  title: 'Un titre',
  body: 'Un texte',
  author: 'Alice',
  createdAt: 0,
  status: 'new',
  votes: 0,
  voted: false,
  reported: false,
  mine: false,
  reply: null,
  replyAt: null,
  version: '0.2.0',
  platform: 'win32',
  hidden: false,
  ...p,
});

test('a valid message comes back cleaned', () => {
  const r = checkPost({ kind: 'idea', area: 'workers', title: '  Relancer​   tous les workers ', body: 'Ligne 1\r\n\r\n\r\n\r\nLigne 2  ' });
  assert.deepEqual(r, { ok: true, value: { kind: 'idea', area: 'workers', title: 'Relancer tous les workers', body: 'Ligne 1\n\nLigne 2' } });
});

test('each field reports its own problem', () => {
  const r = checkPost({ kind: 'rant', area: '', title: 'abc', body: 'x'.repeat(LIMITS.bodyMax + 1) });
  assert.deepEqual(r, { ok: false, fields: { kind: 'required', area: 'required', title: 'short', body: 'long' } });
});

test('lengths count characters as a person does', () => {
  const title = '🙂'.repeat(LIMITS.titleMax);
  assert.equal(checkPost({ kind: 'idea', area: 'ui', title, body: 'Un texte assez long.' }).ok, true);
});

test('links, HTML and insults are refused, ordinary text is not', () => {
  for (const s of ['voir https://x.y', 'www.site', 'exemple.com', 'mail moi a@b.fr']) assert.equal(hasLink(s), true, s);
  for (const s of ['app.ts plante', 'claude.ai marche', 'node.js 22', 'v0.2.0', 'install.sh fails', 'It crashes.It happens daily', 'ça.me gêne']) assert.equal(hasLink(s), false, s);
  for (const s of ['Press <Enter> twice', 'claude --model <name> ignores it', 'a < b > c']) assert.equal(checkPost({ kind: 'problem', area: 'ui', title: 'Un titre', body: s + ' depuis hier.' }).ok, true, s);
  for (const s of ['<img src=x onerror=1>', 'du &#60;script', '<!-- caché -->', '</div>']) assert.equal(checkPost({ kind: 'problem', area: 'ui', title: 'Un titre', body: s + ' depuis hier.' }).ok, false, s);
  assert.deepEqual(checkPost({ kind: 'idea', area: 'ui', title: 'Titre <b>gras</b>', body: 'Un texte assez long.' }), { ok: false, fields: { title: 'html' } });
  for (const s of ['quel c0nnard', 'ENCULÉ', 'fuuuck this']) assert.equal(hasInsult(s), true, s);
  for (const s of ['un contact', 'la console', 'ce bâtiment', 'concernant', 'il y a du retard quand je tape']) assert.equal(hasInsult(s), false, s);
});

test('pseudos: readable, unique whatever the case and accents', () => {
  assert.deepEqual(checkPseudo(' Élodie '), { ok: true, value: 'Élodie' });
  assert.equal(checkPseudo('ab').ok, false);
  assert.equal(checkPseudo('<script>').ok, false);
  assert.equal(checkPseudo('-start').ok, false);
  assert.equal(pseudoKey('Élo-Die'), pseudoKey('elo die'));
});

test('an official answer may hold a link but no HTML', () => {
  assert.equal(checkReply('Voir https://github.com/Anilito1/ai_box').ok, true);
  assert.equal(checkReply('<img src=x>').ok, false);
  assert.equal(checkReply('   ').ok, false);
});

test('invisible and control characters never get stored', () => {
  assert.equal(cleanText('a‮b\u0000c﻿'), 'abc');
});

test('the quota day is the calendar day in Paris', () => {
  assert.equal(dayKey(Date.UTC(2026, 10, 9, 22, 30)), '2026-11-09');
  assert.equal(dayKey(Date.UTC(2026, 10, 9, 23, 30)), '2026-11-10');
  assert.equal(dayKey(Date.UTC(2026, 6, 1, 21, 30)), '2026-07-01');
  assert.equal(dayKey(Date.UTC(2026, 6, 1, 22, 30)), '2026-07-02');
});

test('most supported first, closed ones after, then the newest', () => {
  const a = post({ title: 'a', votes: 5, status: 'done', createdAt: 3 });
  const b = post({ title: 'b', votes: 2, createdAt: 1 });
  const c = post({ title: 'c', votes: 2, createdAt: 2 });
  assert.deepEqual(rank([a, b, c], 'top').map((p) => p.title), ['c', 'b', 'a']);
  assert.deepEqual(rank([a, b, c], 'new').map((p) => p.title), ['a', 'c', 'b']);
});

test('filters combine type, area, mine and a search on title, text and author', () => {
  const posts = [post({ title: 'Raccourci', kind: 'idea', area: 'ui' }), post({ body: 'Lent au démarrage', kind: 'problem', area: 'sessions', mine: true }), post({ author: 'Bob', kind: 'like' })];
  const base = { query: '', kind: 'all', area: 'all', mine: false } as const;
  assert.equal(filterPosts(posts, { ...base, kind: 'problem' }).length, 1);
  assert.equal(filterPosts(posts, { ...base, area: 'ui' }).length, 2);
  assert.equal(filterPosts(posts, { ...base, mine: true }).length, 1);
  assert.equal(filterPosts(posts, { ...base, query: 'LENT' }).length, 1);
  assert.equal(filterPosts(posts, { ...base, query: 'bob' }).length, 1);
});

test('drafts: unreadable entries are dropped, the rest sorted newest first', () => {
  const ok = { id: 'a', kind: '', area: 'ui', title: 't', body: 'b', updatedAt: 1 };
  const newer = { ...ok, id: 'b', kind: 'idea', updatedAt: 2 };
  assert.deepEqual(readDrafts(JSON.stringify([ok, { ...ok, kind: 'rant' }, null, 5, newer])).map((d) => d.id), ['b', 'a']);
  assert.deepEqual(readDrafts('not json'), []);
  assert.deepEqual(readDrafts(null), []);
  assert.deepEqual(readDrafts('{"a":1}'), []);
});
