import assert from 'node:assert/strict';
import { test } from 'node:test';
import { remoteAfter, remoteCapable, remoteLink } from './remote';
import type { RemoteView } from './types';

const view = (state: RemoteView['state'], connected = false): RemoteView => ({ state, connected, url: 'https://claude.ai/code/session_01abc', since: 1 });

test('remoteCapable: only Claude Code signed in to claude.ai', () => {
  assert.equal(remoteCapable('claude', 'api-key'), true);
  assert.equal(remoteCapable('default', 'claude-code'), true);
  assert.equal(remoteCapable('default', 'api-key'), false);
  for (const kind of ['anthropic-key', 'anthropic-compatible', 'openai', 'codex', 'gemini', 'gemini-key'] as const) assert.equal(remoteCapable(kind, 'claude-code'), false, kind);
});

test('remoteLink keeps claude.ai pages only', () => {
  assert.equal(remoteLink('https://claude.ai/code/session_01AbC'), 'https://claude.ai/code/session_01AbC');
  assert.equal(remoteLink('https://staging.claude.ai/code/session_1'), 'https://staging.claude.ai/code/session_1');
  for (const bad of ['http://claude.ai/code/x', 'https://claude.ai.evil.com/x', 'https://evilclaude.ai/x', 'https://user:pw@claude.ai/x', 'https://claude.ai:8443/x', 'javascript:alert(1)', 'claude.ai/code', '', 42, null, `https://claude.ai/${'a'.repeat(600)}`]) {
    assert.equal(remoteLink(bad), '', String(bad));
  }
});

test('remoteAfter follows the connection while it is on', () => {
  assert.deepEqual(remoteAfter(view('on'), 'connected'), view('on', true));
  assert.deepEqual(remoteAfter(view('on', true), 'reconnecting'), view('reconnecting', false));
  assert.deepEqual(remoteAfter(view('reconnecting'), 'connected'), view('on', true));
  assert.deepEqual(remoteAfter(view('on', true), 'something_new'), view('on', true));
  assert.equal(remoteAfter(view('on', true), 'failed'), null);
  assert.equal(remoteAfter(view('reconnecting'), 'policy_disabled'), null);
});

test('remoteAfter leaves a request under way to its answer', () => {
  // Claude Code says "ready" (and "failed" for a refusal) before it answers the request that turns it on.
  assert.deepEqual(remoteAfter(view('starting'), 'ready'), view('starting'));
  assert.deepEqual(remoteAfter(view('starting'), 'failed'), view('starting'));
  assert.deepEqual(remoteAfter(view('starting'), 'connected'), view('starting', true));
  assert.deepEqual(remoteAfter(view('stopping', true), 'failed'), view('stopping', false));
});
