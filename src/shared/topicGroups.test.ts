import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupKeyOf, groupName, groupTopics, isGroupPrefs, reorderGroups, resolveTopicRepo, toggled } from './topicGroups';
import { TopicTracker, type Topic } from './topics';

const topic = (id: string, at: number, extra: Partial<Topic> = {}): Topic => ({ id, title: id, awaiting: false, question: '', workers: [], at, ...extra });
const keys = (topics: Topic[], order: string[] = []) => groupTopics(topics, order).map((g) => g.key);

test('the repo of a topic is the one of its last worker', () => {
  const repos: Record<string, string> = { 'hub-a': '/dev/lbc', 'hub-b': '/dev/claude-hub' };
  const of = (w: string) => repos[w] ?? null;
  assert.equal(resolveTopicRepo(['hub-a', 'hub-b'], of), '/dev/claude-hub');
  assert.equal(resolveTopicRepo(['hub-b', 'hub-a'], of), '/dev/lbc');
});

test('a worktree is the repo of its origin: two workers, one group', () => {
  // The hub resolves a worker's folder to the main folder of its repo (repoOf().main), worktrees included.
  const main = (cwd: string) => (cwd.startsWith('/dev/claude-hub') ? '/dev/claude-hub' : null);
  const cwds: Record<string, string> = { 'hub-a': '/dev/claude-hub', 'hub-b': '/dev/claude-hub-notif-maj' };
  assert.equal(resolveTopicRepo(['hub-a'], (w) => main(cwds[w] ?? '')), resolveTopicRepo(['hub-b'], (w) => main(cwds[w] ?? '')));
});

test('a topic keeps its repo when its workers are gone, and with no worker nor repo it is General', () => {
  assert.equal(resolveTopicRepo(['hub-a'], () => null, '/dev/lbc'), '/dev/lbc');
  assert.equal(resolveTopicRepo([], () => null, '/dev/lbc'), '/dev/lbc');
  assert.equal(resolveTopicRepo([], () => null), '');
  assert.equal(resolveTopicRepo(['hub-a'], () => null), '');
});

test('the last worker unknown: the remembered repo wins over an earlier worker, which serves otherwise', () => {
  const of = (w: string) => (w === 'hub-a' ? '/dev/lbc' : null);
  assert.equal(resolveTopicRepo(['hub-a', 'hub-b'], of, '/dev/claude-hub'), '/dev/claude-hub');
  assert.equal(resolveTopicRepo(['hub-a', 'hub-b'], of), '/dev/lbc');
});

test('a topic the user moved stays in its group, "" being General', () => {
  assert.equal(groupKeyOf({ repo: '/dev/a' }), '/dev/a');
  assert.equal(groupKeyOf({ repo: '/dev/a', moved: '/dev/b' }), '/dev/b');
  assert.equal(groupKeyOf({ repo: '/dev/a', moved: '' }), '');
  assert.equal(groupKeyOf({}), '');
});

test('groups are named after their folder', () => {
  assert.equal(groupName('/Users/me/dev/claude-hub'), 'claude-hub');
  assert.equal(groupName('C:\\dev\\DASHSALES\\'), 'DASHSALES');
  assert.equal(groupName(''), '');
});

test('groups keep the topics in their order; the unplaced ones come by recency, General last', () => {
  const topics = [topic('t1', 50, { repo: '/dev/a' }), topic('t2', 40), topic('t3', 30, { repo: '/dev/b' }), topic('t4', 20, { repo: '/dev/a' })];
  const groups = groupTopics(topics, []);
  assert.deepEqual(groups.map((g) => g.key), ['/dev/a', '/dev/b', '']);
  assert.deepEqual(groups[0]?.topics.map((x) => x.id), ['t1', 't4']);
});

test('the saved order rules, a group not placed yet comes first and General stays last', () => {
  const topics = [topic('t1', 50, { repo: '/dev/a' }), topic('t2', 40, { repo: '/dev/b' }), topic('t3', 30, { repo: '/dev/c' }), topic('t4', 10)];
  assert.deepEqual(keys(topics, ['/dev/c', '/dev/a', '/dev/b']), ['/dev/c', '/dev/a', '/dev/b', '']);
  assert.deepEqual(keys(topics, ['/dev/b', '/dev/gone']), ['/dev/a', '/dev/c', '/dev/b', '']);
  assert.deepEqual(keys(topics, ['', '/dev/b']), ['/dev/a', '/dev/c', '', '/dev/b']);
});

test('moving a group takes the place of the target and keeps the groups not shown', () => {
  const shown = ['/dev/a', '/dev/b', '/dev/c'];
  assert.deepEqual(reorderGroups(shown, [], '/dev/c', '/dev/a'), ['/dev/c', '/dev/a', '/dev/b']);
  assert.deepEqual(reorderGroups(shown, [], '/dev/a', '/dev/c'), ['/dev/b', '/dev/c', '/dev/a']);
  assert.deepEqual(reorderGroups(shown, ['/dev/x'], '/dev/b', '/dev/a'), ['/dev/b', '/dev/a', '/dev/c', '/dev/x']);
  const saved = ['/dev/a'];
  assert.equal(reorderGroups(shown, saved, '/dev/a', '/dev/a'), saved);
  assert.equal(reorderGroups(shown, saved, '/dev/zzz', '/dev/a'), saved);
});

test('folded groups are a set of keys', () => {
  assert.deepEqual(toggled(['/dev/a'], '/dev/b', true), ['/dev/a', '/dev/b']);
  assert.deepEqual(toggled(['/dev/a', '/dev/b'], '/dev/a', false), ['/dev/b']);
  assert.deepEqual(toggled(['/dev/a'], '/dev/a', true), ['/dev/a']);
});

test('the saved order and folded groups are checked', () => {
  assert.ok(isGroupPrefs({ order: ['/dev/a', ''], collapsed: [] }));
  assert.ok(!isGroupPrefs({ order: 'x', collapsed: [] }));
  assert.ok(!isGroupPrefs({ order: [1], collapsed: [] }));
  assert.ok(!isGroupPrefs({ order: [], collapsed: ['a'.repeat(1001)] }));
  assert.ok(!isGroupPrefs(null));
});

test('the repo and the group a topic was moved to survive a restart', () => {
  const tracker = new TopicTracker(() => {});
  tracker.restore({ conversation: 'c', topics: [topic('a', 1), topic('b', 2), topic('c', 3)], links: [] }, 'c');
  assert.ok(tracker.setRepo('a', '/dev/lbc'));
  assert.ok(!tracker.setRepo('a', '/dev/lbc'));
  assert.ok(tracker.setMoved('b', ''));
  assert.ok(tracker.setMoved('c', '/dev/x'));
  assert.ok(tracker.setMoved('c', undefined));
  const again = new TopicTracker(() => {});
  again.restore(JSON.parse(JSON.stringify(tracker.state('c'))), 'c');
  assert.equal(again.get('a')?.repo, '/dev/lbc');
  assert.equal(again.get('b')?.moved, '');
  assert.equal(again.get('c')?.moved, undefined);
  assert.ok(!again.setRepo('nope', '/x'));
});
