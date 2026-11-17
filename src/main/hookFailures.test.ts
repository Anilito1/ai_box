import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOOK_FAILURES_NOTICE, HookFailures } from './hookFailures';

test('hook failures are told once, when their count across sessions reaches the threshold', () => {
  const f = new HookFailures(3);
  assert.equal(f.add('PreToolUse:Bash'), null);
  assert.equal(f.add('PostToolUse:Bash'), null);
  assert.deepEqual(f.add('PreToolUse:Bash'), { count: 3, hooks: ['PreToolUse:Bash', 'PostToolUse:Bash'] });
  assert.equal(f.add('Stop'), null); // already said: no notice on every later call
  assert.equal(HOOK_FAILURES_NOTICE, 10);
});
