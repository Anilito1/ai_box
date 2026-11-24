import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { ChatItem } from '../shared/types';
import { Unshown } from './unshown';

const reply = (id: string, text: string): ChatItem => ({ kind: 'assistant', id, text, live: true });

describe('items waiting for the screen', () => {
  it('keeps the latest state of each item, in the order they first came', () => {
    const u = new Unshown();
    u.add('w1', [reply('a', 'Bon')], false);
    u.add('w1', [reply('b', 'x')], false);
    u.add('w1', [reply('a', 'Bonjour')], false);
    assert.deepEqual(u.take(), [['w1', [reply('a', 'Bonjour'), reply('b', 'x')]]]);
  });

  it('shows a new conversation whole, whatever comes after it before the screen does', () => {
    const u = new Unshown();
    u.add('w1', [reply('a', 'x')], false);
    u.add('w1', [reply('a', 'y')], true);
    u.add('w1', [reply('b', 'z')], false);
    assert.deepEqual(u.take(), [['w1', 'reset']]);
  });

  it('keeps sessions apart and empties once taken', () => {
    const u = new Unshown();
    u.add('w1', [reply('a', 'x')], false);
    u.add('w2', [reply('a', 'y')], false);
    assert.equal(u.size, 2);
    assert.deepEqual(u.take(), [
      ['w1', [reply('a', 'x')]],
      ['w2', [reply('a', 'y')]],
    ]);
    assert.equal(u.size, 0);
    assert.deepEqual(u.take(), []);
  });
});
