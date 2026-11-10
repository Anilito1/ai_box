import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OperationLifecycle } from './lifecycle';

test('a terminal wins over late replies, duplicate terminals and callbacks of an old generation', () => {
  const state = new OperationLifecycle();
  const first = state.begin('turn');
  assert.ok(state.matches('first'));
  assert.ok(state.finish(first, 'success'));
  assert.equal(state.finish(first, 'failed'), false);
  assert.equal(state.bind(first, 'first'), false);
  const second = state.begin('turn');
  assert.equal(state.matches('first'), false);
  assert.equal(second.turnId, null);
  assert.ok(state.matches('second'));
  assert.equal(state.matches('unrelated'), false);
  state.invalidate();
  assert.equal(state.finish(second, 'success'), false);
  assert.equal(state.bind(second, 'second'), false);
  const third = state.begin('compact');
  assert.notEqual(third.generation, second.generation);
  assert.notEqual(third.opId, second.opId);
});
