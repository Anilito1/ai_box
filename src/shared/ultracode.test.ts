import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ultracodeAccess } from './ultracode';

test('Max, Team and Enterprise can choose Ultracode', () => {
  for (const plan of ['max', 'Max', ' MAX ', 'team', 'enterprise']) assert.equal(ultracodeAccess(plan), 'allowed', plan);
});

test('a Pro plan does not see it', () => {
  for (const plan of ['pro', 'Pro', 'free']) assert.equal(ultracodeAccess(plan), 'hidden', plan);
});

test('a plan that is not known leaves it shown but off', () => {
  for (const plan of ['', '  ', null, undefined]) assert.equal(ultracodeAccess(plan), 'unknown', String(plan));
});

test('a Claude Code older than the switch offers it off', () => {
  assert.equal(ultracodeAccess('max', '2.1.283'), 'outdated');
  assert.equal(ultracodeAccess('max', '2.1.284'), 'allowed');
  assert.equal(ultracodeAccess('max', '2.1.311'), 'allowed');
  assert.equal(ultracodeAccess('max', '2.0.999'), 'outdated');
  assert.equal(ultracodeAccess('max', ''), 'allowed');
});

test('the plan comes first: Pro stays hidden on an old Claude Code, an unknown plan stays unknown', () => {
  assert.equal(ultracodeAccess('pro', '2.1.100'), 'hidden');
  assert.equal(ultracodeAccess('', '2.1.100'), 'unknown');
});
