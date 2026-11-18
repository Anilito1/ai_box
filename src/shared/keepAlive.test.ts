import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keepAlive, KEEP_ALIVE_EVERY_MS, KEEP_ALIVE_MAX_PINGS, KEEP_ALIVE_MIN_TOKENS, KEEP_ALIVE_TOO_LATE_MS, pingRead, type KeepAliveState } from './keepAlive';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const master = (over: Partial<KeepAliveState> = {}): KeepAliveState => ({ role: 'master', warmAt: NOW, pings: 0, contextTokens: 400_000, ...over });

test('a ping goes out between 45 and 55 minutes after the last read', () => {
  assert.equal(keepAlive(master(), NOW + 10 * MIN), 'wait');
  assert.equal(keepAlive(master(), NOW + KEEP_ALIVE_EVERY_MS - 1), 'wait');
  assert.equal(keepAlive(master(), NOW + KEEP_ALIVE_EVERY_MS), 'ping');
  assert.equal(keepAlive(master(), NOW + KEEP_ALIVE_TOO_LATE_MS - 1), 'ping');
});

test('later than that the cache may be gone: no ping pays the full write for nothing', () => {
  assert.equal(keepAlive(master(), NOW + KEEP_ALIVE_TOO_LATE_MS), 'expired');
  assert.equal(keepAlive(master({ warmAt: 0 }), NOW), 'expired');
});

test('a pause that outlasts its pings is left to expire: the master last, a post after one ping', () => {
  const at = NOW + KEEP_ALIVE_EVERY_MS;
  assert.equal(keepAlive(master({ pings: KEEP_ALIVE_MAX_PINGS.worker }), at), 'ping');
  assert.equal(keepAlive(master({ role: 'worker', pings: KEEP_ALIVE_MAX_PINGS.worker }), at), 'spent');
  assert.equal(keepAlive(master({ pings: KEEP_ALIVE_MAX_PINGS.master }), at), 'spent');
  for (const role of ['post', 'instance'] as const) {
    assert.equal(keepAlive(master({ role }), at), 'ping');
    assert.equal(keepAlive(master({ role, pings: 1 }), at), 'spent');
  }
});

test('a small conversation is not worth a process', () => {
  assert.equal(keepAlive(master({ contextTokens: KEEP_ALIVE_MIN_TOKENS - 1 }), NOW + KEEP_ALIVE_EVERY_MS), 'small');
  assert.equal(keepAlive(master({ contextTokens: KEEP_ALIVE_MIN_TOKENS }), NOW + KEEP_ALIVE_EVERY_MS), 'ping');
});

test('a ping that wrote the context instead of reading it found the cache cold', () => {
  assert.equal(pingRead({ read: 380_000, written: 4_000 }), true);
  assert.equal(pingRead({ read: 12_800, written: 370_000 }), false);
  assert.equal(pingRead({ read: 0, written: 0 }), false);
});
