import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forumUrl, toAction, toListing } from './forum';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

test('the forum address: https, or http on this computer only', () => {
  assert.equal(forumUrl('https://ai-box-forum.x.workers.dev/'), 'https://ai-box-forum.x.workers.dev');
  assert.equal(forumUrl('http://127.0.0.1:8789'), 'http://127.0.0.1:8789');
  assert.equal(forumUrl('http://example.com'), '');
  assert.equal(forumUrl('https://user:pw@example.com'), '');
  assert.equal(forumUrl('file:///etc/passwd'), '');
});

test('actions from the page are checked before anything leaves the app', () => {
  assert.deepEqual(toAction({ type: 'vote', id: ID, on: true }), { type: 'vote', id: ID, on: true });
  assert.equal(toAction({ type: 'vote', id: '../admin', on: true }), null);
  assert.equal(toAction({ type: 'vote', id: ID, on: 'yes' }), null);
  assert.equal(toAction({ type: 'post', draft: { kind: 'idea', area: 'ui', title: 'x'.repeat(2000), body: '' } }), null);
  assert.deepEqual(toAction({ type: 'post', draft: { kind: 'idea', area: 'ui', title: 't', body: 'b', extra: 1 } }), { type: 'post', draft: { kind: 'idea', area: 'ui', title: 't', body: 'b' } });
  assert.deepEqual(toAction({ type: 'moderate', id: ID, status: 'planned', reply: null }), { type: 'moderate', id: ID, status: 'planned', reply: null });
  assert.equal(toAction({ type: 'moderate', id: ID, status: 'shipped' }), null);
  assert.deepEqual(toAction({ type: 'adminKey', key: null }), { type: 'adminKey', key: null });
  assert.equal(toAction({ type: 'adminKey', key: 'short' }), null);
  assert.equal(toAction({ type: 'drop-tables' }), null);
  assert.equal(toAction(null), null);
});

test('the forum answer is kept to what the app shows', () => {
  const good = { id: ID, kind: 'idea', area: 'ui', status: 'new', title: 'T', body: 'B', author: 'A', createdAt: 1, votes: 2, voted: true, platform: 'darwin', html: '<b>' };
  const l = toListing({ posts: [good, { ...good, id: 'x' }, { ...good, kind: 'rant' }], me: { pseudo: 'A', quota: { posts: 1, votes: 'many' } }, admin: false });
  assert.equal(l?.posts.length, 1);
  assert.equal(l?.posts[0].voted, true);
  assert.equal(l?.posts[0].platform, 'darwin');
  assert.equal('html' in (l?.posts[0] ?? {}), false);
  assert.deepEqual(l?.me, { pseudo: 'A', quota: { posts: 1, votes: 0, reports: 0, nextPostAt: 0 } });
  assert.equal(toListing({ posts: 'nope' }), null);
});
