import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTopicId, parseTopicCall, TopicTracker, type ReplayStep, type TopicCall } from './topics';

/** A tracker on a fake clock, with the topic of each item as the hub would set it. */
function setup() {
  const filed = new Map<string, string>();
  let clock = 1000;
  const tracker = new TopicTracker(
    (ids, topic) => ids.forEach((id) => filed.set(id, topic)),
    () => ++clock,
  );
  /** The item's own topic, as the hub sets it (a call answers one topic, or several with the item's own first). */
  const file = (id: string, topic: string | string[] | null) => {
    const own = Array.isArray(topic) ? topic[0] : topic;
    if (own) filed.set(id, own);
  };
  return { tracker, filed, file };
}

const call = (id: string, more: Partial<TopicCall> = {}): TopicCall => ({ id, title: '', awaiting: false, question: '', workers: [], ...more });

test('parseTopicCall keeps a clean id, one line of title and question, and worker session names', () => {
  const parsed = parseTopicCall({
    id: '  Paiements Niveau A ',
    title: 'Paiements\u202e · niveau\nA\u0007',
    awaiting_user: true,
    question: 'Go pour la migration ?',
    workers: ['db-audit', 'hub-brain', 'HUB-Brain', '', 42],
  });
  assert.deepEqual(parsed, {
    id: 'paiements-niveau-a',
    title: 'Paiements · niveau A',
    awaiting: true,
    question: 'Go pour la migration ?',
    workers: ['hub-db-audit', 'hub-brain'],
  });
  assert.equal(parseTopicCall({ id: '!!!' }), null);
  assert.equal(parseTopicCall(null), null);
  assert.equal(parseTopicCall({ id: 'x', title: 'y'.repeat(200) })?.title.length, 60);
  // A question only counts while the master waits.
  assert.equal(parseTopicCall({ id: 'x', question: 'ignored' })?.question, '');
});

test('isTopicId accepts slugs and worker topics only', () => {
  assert.ok(isTopicId('paiements-niveau-a'));
  assert.ok(isTopicId('worker:hub-brain'));
  assert.ok(!isTopicId('worker:brain'));
  assert.ok(!isTopicId('a"><img'));
  assert.ok(!isTopicId(''));
  assert.ok(!isTopicId(3));
});

test('a reply that names its topic files the message before it, the reply and the workers it writes to', () => {
  const { tracker, filed, file } = setup();
  file('u1', tracker.shown('u1', { user: true }, true));
  tracker.taken();
  file('t1', tracker.reply('t1'));
  tracker.declare(call('colis', { title: 'Colis découverte · power dialer' }));
  tracker.wrote('hub-brain');
  file('a1', tracker.reply('a1'));
  tracker.end();
  assert.deepEqual(Object.fromEntries(filed), { u1: 'colis', t1: 'colis', a1: 'colis' });
  assert.equal(tracker.linkOf('hub-brain'), 'colis');
  assert.deepEqual(tracker.get('colis')?.workers, ['hub-brain']);
  // Its report then goes to that topic at once.
  assert.equal(tracker.shown('p1', { worker: 'hub-brain' }, true), 'colis');
});

test('the badge stays until the user answers on that topic', () => {
  const { tracker } = setup();
  tracker.shown('u1', { user: true }, false);
  tracker.declare(call('pay', { title: 'Paiements · niveau A', awaiting: true, question: 'Go ?' }));
  tracker.end();
  assert.equal(tracker.get('pay')?.awaiting, true);
  assert.equal(tracker.get('pay')?.question, 'Go ?');
  // A worker's message on it does not clear it.
  tracker.declare(call('other', { title: 'Other' }));
  tracker.end();
  tracker.shown('p1', { worker: 'hub-x', topic: 'pay' }, false);
  tracker.end();
  assert.equal(tracker.get('pay')?.awaiting, true);
  // The user's answer in that topic does.
  assert.equal(tracker.shown('u2', { user: true, topic: 'pay' }, true), 'pay');
  assert.equal(tracker.get('pay')?.awaiting, false);
  assert.equal(tracker.get('pay')?.question, '');
});

test('an answer written in "All" clears the badge of the topic the reply files it under', () => {
  const { tracker, filed } = setup();
  tracker.shown('u1', { user: true }, false);
  tracker.declare(call('pay', { title: 'Pay', awaiting: true }));
  tracker.end();
  tracker.shown('u2', { user: true }, false);
  tracker.declare(call('pay'));
  tracker.end();
  assert.equal(filed.get('u2'), 'pay');
  assert.equal(tracker.get('pay')?.awaiting, false);
  // The title is kept when the call leaves it out.
  assert.equal(tracker.get('pay')?.title, 'Pay');
});

test('a reply that names no topic goes to the one worker it is about', () => {
  const { tracker, filed, file } = setup();
  tracker.shown('u1', { user: true }, false);
  tracker.declare(call('pay', { title: 'Pay' }));
  tracker.wrote('hub-db-audit');
  tracker.end();
  // The worker reports; the master answers without naming a topic.
  file('p1', tracker.shown('p1', { worker: 'hub-db-audit' }, true));
  tracker.taken();
  file('a1', tracker.reply('a1'));
  tracker.end();
  assert.equal(filed.get('p1'), 'pay');
  assert.equal(filed.get('a1'), 'pay');
});

test('a worker no topic was named for gets its own, made from its name', () => {
  const { tracker, filed, file } = setup();
  file('u1', tracker.shown('u1', { user: true }, false));
  tracker.reply('a1');
  tracker.wrote('hub-brain');
  tracker.end();
  assert.equal(filed.get('u1'), 'worker:hub-brain');
  assert.equal(filed.get('a1'), 'worker:hub-brain');
  assert.equal(tracker.get('worker:hub-brain')?.title, 'brain');
});

test('a general reply, or one about several workers, stays in All', () => {
  const { tracker, filed } = setup();
  tracker.shown('u1', { user: true }, false);
  tracker.reply('a1');
  tracker.end();
  tracker.shown('u2', { user: true }, false);
  tracker.reply('a2');
  tracker.wrote('hub-a');
  tracker.wrote('hub-b');
  tracker.end();
  assert.equal(filed.size, 0);
  assert.equal(tracker.list().length, 0);
});

test('a message sent while the master replies belongs to the next turn', () => {
  const { tracker, filed, file } = setup();
  tracker.shown('u1', { user: true }, true);
  tracker.taken();
  tracker.declare(call('a', { title: 'A' }));
  tracker.reply('a1');
  // Typed during the reply: shown at once, taken by the model after it.
  file('u2', tracker.shown('u2', { user: true }, true));
  tracker.reply('a2');
  tracker.end();
  tracker.taken();
  tracker.declare(call('b', { title: 'B' }));
  file('b1', tracker.reply('b1'));
  tracker.end();
  assert.equal(filed.get('u1'), 'a');
  assert.equal(filed.get('u2'), 'b');
  assert.equal(filed.get('b1'), 'b');
});

test('messages taken without a replay join the turn that ends', () => {
  const { tracker, filed } = setup();
  tracker.shown('u1', { user: true }, true);
  tracker.declare(call('a', { title: 'A' }));
  tracker.end(true);
  assert.equal(filed.get('u1'), 'a');
});

test("a worker's own topic gives way to the topic the master names for it", () => {
  const { tracker, filed, file } = setup();
  tracker.shown('u0', { user: true }, false);
  tracker.wrote('hub-brain');
  tracker.end();
  assert.equal(tracker.linkOf('hub-brain'), 'worker:hub-brain');
  file('p1', tracker.shown('p1', { worker: 'hub-brain' }, false));
  assert.equal(filed.get('p1'), 'worker:hub-brain');
  tracker.declare(call('colis', { title: 'Colis' }));
  tracker.end();
  assert.equal(filed.get('p1'), 'colis');
  assert.equal(tracker.linkOf('hub-brain'), 'colis');
  assert.deepEqual(tracker.get('worker:hub-brain')?.workers, []);
});

test('notices follow the topic of the reply in progress', () => {
  const { tracker } = setup();
  assert.equal(tracker.note(), null);
  tracker.shown('u1', { user: true }, false);
  tracker.declare(call('a', { title: 'A' }));
  assert.equal(tracker.note(), 'a');
  tracker.end();
  assert.equal(tracker.note(), null);
});

test('most recent activity comes first', () => {
  const { tracker } = setup();
  tracker.declare(call('a', { title: 'A' }));
  tracker.end();
  tracker.declare(call('b', { title: 'B' }));
  tracker.end();
  tracker.shown('p1', { topic: 'a' }, false);
  tracker.end();
  assert.deepEqual(
    tracker.list().map((t) => t.id),
    ['a', 'b'],
  );
});

test('the replay of a transcript files it as the live run did, and keeps the links it cannot see', () => {
  const live = setup();
  const steps: ReplayStep[] = [
    { kind: 'input', id: 'u1', input: { user: true } },
    { kind: 'topic', call: call('pay', { title: 'Pay', awaiting: true }) },
    { kind: 'wrote', worker: 'hub-db-audit' },
    { kind: 'item', id: 'a1' },
    { kind: 'input', id: 'p1', input: { worker: 'hub-db-audit' } },
    { kind: 'item', id: 'a2' },
    { kind: 'input', id: 'u2', input: { user: true, topic: 'pay' } },
    { kind: 'item', id: 'a3' },
    { kind: 'input', id: 'u3', input: { user: true } },
    { kind: 'item', id: 'a4' },
  ];
  // Live run.
  for (const s of steps) {
    if (s.kind === 'input') live.file(s.id, live.tracker.shown(s.id, s.input, false));
    else if (s.kind === 'topic') live.tracker.declare(s.call);
    else if (s.kind === 'wrote') live.tracker.wrote(s.worker);
    else live.file(s.id, live.tracker.reply(s.id));
  }
  live.tracker.end();
  live.tracker.wrote('hub-elsewhere');

  // Restart: the saved state, then the transcript.
  const again = setup();
  again.tracker.restore(JSON.parse(JSON.stringify(live.tracker.state('conv-1'))), 'conv-1');
  const filed = new Map([...again.tracker.replay(steps)].map(([id, [topic]]) => [id, topic]));
  assert.deepEqual(Object.fromEntries(filed), Object.fromEntries(live.filed));
  assert.deepEqual(Object.fromEntries(filed), { u1: 'pay', a1: 'pay', p1: 'pay', a2: 'pay', u2: 'pay', a3: 'pay' });
  assert.equal(again.tracker.get('pay')?.awaiting, false);
  assert.equal(again.tracker.get('pay')?.title, 'Pay');
  // The saved time is kept: the replay's order never makes a topic newer than it was.
  assert.equal(again.tracker.get('pay')?.at, live.tracker.get('pay')?.at);
});

test('restore drops another conversation and anything malformed', () => {
  const { tracker } = setup();
  tracker.restore({ conversation: 'old', topics: [{ id: 'a', title: 'A', awaiting: true, question: '', workers: [], at: 1 }], links: [] }, 'new');
  assert.equal(tracker.list().length, 0);
  tracker.restore(
    {
      conversation: 'c',
      topics: [
        { id: 'ok', title: 'Fine\u202e', awaiting: true, question: 'Q', workers: ['hub-a', '<b>', 3], at: 5 },
        { id: '<img>', title: 'x', at: 1 },
        { id: 'no-time', title: 'x' },
        null,
      ],
      links: [['hub-a', 'ok'], ['hub-b', 'missing'], 'junk'],
    },
    'c',
  );
  assert.deepEqual(tracker.list(), [{ id: 'ok', title: 'Fine', awaiting: true, question: 'Q', workers: ['hub-a'], at: 5 }]);
  assert.equal(tracker.linkOf('hub-a'), 'ok');
  assert.equal(tracker.linkOf('hub-b'), undefined);
  tracker.restore('garbage', 'c');
  assert.equal(tracker.list().length, 0);
});

test('reset forgets everything, the queue included', () => {
  const { tracker, filed } = setup();
  tracker.shown('u1', { user: true }, true);
  tracker.declare(call('a', { title: 'A' }));
  tracker.reset();
  tracker.taken();
  tracker.end();
  assert.equal(tracker.list().length, 0);
  assert.equal(filed.size, 0);
});

test('several topic calls in one reply file each worker under the topic that named it', () => {
  const { tracker } = setup();
  const filed = tracker.replay([
    { kind: 'input', id: 'u1', input: { user: true } },
    { kind: 'item', id: 'think' },
    { kind: 'topic', call: call('alpha', { title: 'Alpha', workers: ['hub-alpha'] }) },
    { kind: 'topic', call: call('gamma', { title: 'Gamma', awaiting: true, question: 'Blue or green?' }) },
    { kind: 'topic', call: call('beta', { title: 'Beta', workers: ['hub-beta'] }) },
    { kind: 'wrote', worker: 'hub-alpha' },
    { kind: 'item', id: 'spawn-a', tool: true, worker: 'hub-alpha' },
    { kind: 'wrote', worker: 'hub-beta' },
    { kind: 'item', id: 'spawn-b', tool: true, worker: 'hub-beta' },
    { kind: 'item', id: 'list', tool: true },
    { kind: 'input', id: 'pa', input: { worker: 'hub-alpha' } },
    { kind: 'input', id: 'pb', input: { worker: 'hub-beta' } },
  ]);
  // The request belongs to each job its reply named; everything else to one topic.
  assert.deepEqual(Object.fromEntries(filed), {
    u1: ['alpha', 'gamma', 'beta'],
    think: ['alpha'],
    'spawn-a': ['alpha'],
    'spawn-b': ['beta'],
    list: ['beta'],
    pa: ['alpha'],
    pb: ['beta'],
  });
  assert.equal(tracker.get('gamma')?.awaiting, true);
  assert.equal(tracker.linkOf('hub-alpha'), 'alpha');
});

test('a new topic needs a title; a known one keeps its own', () => {
  const { tracker } = setup();
  assert.equal(tracker.declare(call('nameless')), null);
  assert.equal(tracker.has('nameless'), false);
  assert.ok(tracker.declare(call('named', { title: 'Named' })));
  assert.ok(tracker.createdNow('named'));
  assert.equal(tracker.declare(call('named'))?.title, 'Named');
  tracker.end();
  assert.equal(tracker.createdNow('named'), false);
});

test('a worker started under a name already taken follows its reply, the other one keeps its topic', () => {
  const { tracker } = setup();
  tracker.declare(call('x', { title: 'X' }));
  tracker.wrote('hub-alpha');
  tracker.end();
  tracker.declare(call('a', { title: 'A' }));
  tracker.expect('hub-alpha');
  tracker.alias('hub-alpha', 'hub-alpha-2');
  tracker.end();
  assert.equal(tracker.linkOf('hub-alpha'), 'x');
  assert.equal(tracker.linkOf('hub-alpha-2'), 'a');
  assert.equal(tracker.shown('p', { worker: 'hub-alpha-2' }, false), 'a');
  // Started before its reply named a topic: it follows the one named next.
  tracker.expect('hub-beta');
  tracker.alias('hub-beta', 'hub-beta-2');
  tracker.declare(call('b', { title: 'B' }));
  assert.equal(tracker.linkOf('hub-beta-2'), 'b');
});

test('the replay of a queued prompt says which one the model took; commands taken without one go with it', () => {
  const { tracker, filed, file } = setup();
  file('c1', tracker.shown('c1', { user: true }, true, '/context'));
  file('u1', tracker.shown('u1', { user: true }, true, 'go alpha'));
  file('u2', tracker.shown('u2', { user: true }, true, 'go beta'));
  tracker.taken('go alpha');
  tracker.declare(call('alpha', { title: 'Alpha' }));
  tracker.reply('a1');
  tracker.end();
  tracker.taken('go beta');
  tracker.declare(call('beta', { title: 'Beta' }));
  tracker.end();
  assert.deepEqual(Object.fromEntries(filed), { c1: 'alpha', u1: 'alpha', u2: 'beta' });
});

test("a reply about several jobs: its words go to each topic it names, a tool to its own, an approval to its call's", () => {
  const calls: [string[], string, boolean][] = [];
  const tracker = new TopicTracker((ids, topic, also) => calls.push([ids, topic, !!also]));
  tracker.shown('u1', { user: true }, false);
  tracker.declare(call('gamma', { title: 'Gamma', awaiting: true }));
  tracker.declare(call('alpha', { title: 'Alpha', workers: ['hub-alpha'] }));
  assert.deepEqual(tracker.tool('t1', 'hub-alpha'), ['alpha']);
  assert.equal(tracker.note(), 'alpha');
  tracker.declare(call('beta', { title: 'Beta' }));
  assert.deepEqual(tracker.reply('text', true), ['beta', 'gamma', 'alpha']);
  assert.deepEqual(tracker.reply('thinking'), ['beta']);
  tracker.declare(call('delta', { title: 'Delta' }));
  assert.deepEqual(calls.at(-1), [['u1', 'text'], 'delta', true]);
});

test('over the limit after a replay, the oldest topics go, and nothing stays filed under one that went', () => {
  const { tracker } = setup();
  const topics = Array.from({ length: 80 }, (_, i) => ({ id: `t${i}`, title: `T${i}`, awaiting: false, question: '', workers: [], at: 1_000_000 + i }));
  tracker.restore({ conversation: 'c', topics, links: [] }, 'c');
  const filed = tracker.replay([
    { kind: 'input', id: 'u1', input: { user: true } },
    { kind: 'topic', call: call('new-one', { title: 'New' }) },
    { kind: 'item', id: 'a1', text: true },
  ]);
  assert.equal(tracker.list().length, 80);
  // Pruned after the replay, the oldest first: the window's own topic (no real time) goes, and nothing is filed under it.
  assert.equal(tracker.has('new-one'), false);
  assert.equal(filed.size, 0);
});

test('live, a request about several jobs is added to each topic its reply names, its own topic kept', () => {
  const calls: [string[], string, boolean][] = [];
  const tracker = new TopicTracker((ids, topic, also) => calls.push([ids, topic, !!also]));
  tracker.shown('u1', { user: true }, true);
  tracker.taken();
  tracker.declare(call('a', { title: 'A' }));
  tracker.declare(call('b', { title: 'B' }));
  tracker.declare(call('b'));
  tracker.end();
  assert.deepEqual(calls, [
    [['u1'], 'a', false],
    [['u1'], 'b', true],
  ]);
  // A message the user filed themselves stays where they put it.
  calls.length = 0;
  tracker.shown('u2', { user: true, topic: 'a' }, false);
  tracker.declare(call('a'));
  tracker.declare(call('b'));
  tracker.end();
  assert.deepEqual(calls, []);
});
