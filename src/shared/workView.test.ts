import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workView } from './workView';

const tasks = ['Serveur 8821', 'Point 1 : Équipement seul'];

test('background tasks alone: no turn, so nothing animated', () => {
  assert.deepEqual(workView({ status: 'idle', background: tasks }), { turn: false, tasks });
});

test('a turn alone: animated, no list', () => {
  assert.deepEqual(workView({ status: 'busy', background: [] }), { turn: true, tasks: [] });
});

test('a turn and background tasks: both', () => {
  assert.deepEqual(workView({ status: 'busy', background: tasks }), { turn: true, tasks });
});

test('waiting for an approval is still a turn', () => {
  assert.equal(workView({ status: 'attention', background: [] }).turn, true);
});

test('a closed session or none: nothing', () => {
  assert.deepEqual(workView({ status: 'exited', background: tasks }), { turn: false, tasks: [] });
  assert.deepEqual(workView(undefined), { turn: false, tasks: [] });
});
