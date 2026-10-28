import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HISTORY_LIMIT, HistoryCursor, sentMessages, wantsHistory, type KeyState } from './inputHistory';

const key = (k: string, over: Partial<KeyState> = {}): KeyState => ({ key: k, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, ...over });

test('sentMessages keeps the user messages, oldest first, without empty or repeated ones', () => {
  const items = [
    { kind: 'user', text: 'one' },
    { kind: 'assistant', text: 'reply' },
    { kind: 'user', text: 'one' },
    { kind: 'user', text: '   ' },
    { kind: 'user', text: '' },
    { kind: 'user', text: 'two' },
    { kind: 'tool' },
    { kind: 'user', text: 'one' },
  ];
  assert.deepEqual(sentMessages(items), ['one', 'two', 'one']);
});

test('sentMessages is bounded to the latest messages', () => {
  const items = Array.from({ length: HISTORY_LIMIT + 20 }, (_, i) => ({ kind: 'user', text: `m${i}` }));
  const out = sentMessages(items);
  assert.equal(out.length, HISTORY_LIMIT);
  assert.equal(out[out.length - 1], `m${HISTORY_LIMIT + 19}`);
});

test('up and down only fire on the first and last line', () => {
  assert.equal(wantsHistory(key('ArrowUp'), '', 0, 0), 'up');
  assert.equal(wantsHistory(key('ArrowUp'), 'hello', 5, 5), 'up');
  assert.equal(wantsHistory(key('ArrowUp'), 'a\nb', 3, 3), null);
  assert.equal(wantsHistory(key('ArrowUp'), 'a\nb', 1, 1), 'up');
  assert.equal(wantsHistory(key('ArrowUp'), '\nb', 0, 0), 'up');
  assert.equal(wantsHistory(key('ArrowDown'), 'a\nb', 1, 1), null);
  assert.equal(wantsHistory(key('ArrowDown'), 'a\nb', 3, 3), 'down');
  assert.equal(wantsHistory(key('ArrowDown'), 'a\n', 2, 2), 'down');
  assert.equal(wantsHistory(key('ArrowDown'), 'a\n', 1, 1), null);
  assert.equal(wantsHistory(key('ArrowDown'), 'a\nb', 0, 0), null);
});

test('modifiers, composition, a selection and other keys never fire', () => {
  for (const over of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }]) {
    assert.equal(wantsHistory(key('ArrowUp', over), 'x', 1, 1), null);
    assert.equal(wantsHistory(key('ArrowDown', over), 'x', 1, 1), null);
  }
  assert.equal(wantsHistory(key('ArrowUp'), 'hello', 0, 5), null);
  assert.equal(wantsHistory(key('ArrowLeft'), 'x', 1, 1), null);
});

test('up walks back from the newest, down returns to the draft', () => {
  const history = ['first', 'second', 'third'];
  const c = new HistoryCursor();
  assert.equal(c.step('down', 'draft', history), null);
  assert.equal(c.step('up', 'my draft', history), 'third');
  assert.equal(c.step('up', 'third', history), 'second');
  assert.equal(c.step('up', 'second', history), 'first');
  assert.equal(c.step('up', 'first', history), null);
  assert.equal(c.step('down', 'first', history), 'second');
  assert.equal(c.step('down', 'second', history), 'third');
  assert.equal(c.step('down', 'third', history), 'my draft');
  assert.equal(c.browsing, false);
  assert.equal(c.step('down', 'my draft', history), null);
});

test('the draft is taken again each time the history is entered', () => {
  const history = ['a', 'b'];
  const c = new HistoryCursor();
  c.step('up', 'one', history);
  assert.equal(c.step('down', 'b', history), 'one');
  assert.equal(c.step('up', 'two', history), 'b');
  assert.equal(c.step('down', 'b', history), 'two');
});

test('reset forgets the position and the draft; an empty history goes nowhere', () => {
  const c = new HistoryCursor();
  assert.equal(c.step('up', 'draft', []), null);
  c.step('up', 'draft', ['a', 'b']);
  assert.equal(c.browsing, true);
  c.reset();
  assert.equal(c.browsing, false);
  assert.equal(c.step('up', 'new draft', ['a', 'b']), 'b');
  assert.equal(c.step('down', 'b', ['a', 'b']), 'new draft');
});
