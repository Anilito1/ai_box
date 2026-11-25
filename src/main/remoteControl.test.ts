import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from './config';
import type { CostLog } from './costLog';
import type { McpHub } from './mcpHub';
import { SessionManager } from './sessions';

// Remote Control: only the user turns it on, it says what Claude Code says of it, and nothing of the hub's ends a
// session that is driven from elsewhere.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Internal = any;
const never = () => new Promise<never>(() => undefined);
const URL = 'https://claude.ai/code/session_01FIXTURE';

function hub(provider: 'claude-code' | 'api-key' = 'claude-code') {
  const dir = mkdtempSync(join(tmpdir(), 'hub-remote-'));
  const work = join(dir, 'work');
  mkdirSync(work);
  const cfg = loadConfig(dir, 'en');
  cfg.workspaces = [work];
  cfg.provider = provider;
  const m = new SessionManager({
    cfg,
    dataDir: dir,
    executable: () => '',
    codexExecutable: () => '',
    geminiExecutable: () => '',
    mcpHub: {} as McpHub,
    sessionEnv: () => ({ set: {}, unset: [] }),
    persist: () => undefined,
    costLog: { today: () => 0, append: () => undefined } as unknown as CostLog,
    capabilities: async () => '',
  });
  const inner: Internal = m;
  const launches: string[] = [];
  inner.launch = async (s: Internal) => void launches.push(s.id);
  const s = inner.create('w-remote01', 'worker', 'phone', 'A mission', work, '', null);
  return { m, inner, s, launches };
}

/** A running Claude Code whose Remote Control answers when the test says. */
function claude(inner: Internal, s: Internal) {
  const calls: { on: boolean; name: string; settle: (url: string) => void; fail: (err: Error) => void }[] = [];
  const q = {
    close: () => undefined,
    interrupt: async () => undefined,
    context: never,
    totals: never,
    rateLimits: never,
    remoteControl: (on: boolean, name: string) =>
      new Promise<string>((settle, fail) => {
        calls.push({ on, name, settle, fail });
      }),
  };
  s.query = q;
  s.inbox = { close: () => undefined, pause: () => undefined, resume: () => undefined };
  s.status = 'idle';
  inner.readyProcs.add(q);
  return { q, calls };
}

const view = (m: SessionManager, id: string) => m.snapshot().sessions.find((x) => x.id === id)!;
const notices = (s: Internal) => [...s.items.values()].filter((i: Internal) => i.kind === 'notice').map((i: Internal) => i.text);
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('turned on by the user: asked of Claude Code under the session name, its link shown once it answers', async () => {
  const { m, inner, s } = hub();
  const { calls } = claude(inner, s);
  assert.equal(view(m, s.id).remoteCapable, true);
  m.setRemote(s.id, true);
  assert.equal(view(m, s.id).remote?.state, 'starting');
  await tick();
  assert.deepEqual(calls.map((c) => [c.on, c.name]), [[true, 'phone']]);
  // Asked again while it is on its way: one request only.
  m.setRemote(s.id, true);
  assert.equal(calls.length, 1);
  calls[0].settle(URL);
  await tick();
  assert.deepEqual({ ...view(m, s.id).remote, since: 0 }, { state: 'on', connected: false, url: URL, since: 0 });
  assert.equal(notices(s).length, 1);
  inner.onEvent(s, s.query, { type: 'remote', state: 'connected', detail: '' });
  assert.equal(view(m, s.id).remote?.connected, true);
});

test('what Claude Code says when it ends is shown, and the switch goes off', async () => {
  const { m, inner, s } = hub();
  const { calls } = claude(inner, s);
  m.setRemote(s.id, true);
  await tick();
  calls[0].settle(URL);
  await tick();
  inner.onEvent(s, s.query, { type: 'remote', state: 'failed', detail: 'could not reach the Remote Control server' });
  assert.equal(view(m, s.id).remote, null);
  const last = [...s.items.values()].at(-1) as Internal;
  assert.equal(last.tone, 'error');
  assert.equal(last.detail, 'could not reach the Remote Control server');
});

test('a state Claude Code reports of a Remote Control nobody asked for changes nothing', () => {
  const { m, inner, s } = hub();
  claude(inner, s);
  inner.onEvent(s, s.query, { type: 'remote', state: 'connected', detail: '' });
  assert.equal(view(m, s.id).remote, null);
});

test('refused (an API key, a plan without it): nothing stays on, the reason is in the details', async () => {
  const { m, inner, s } = hub();
  const { calls } = claude(inner, s);
  m.setRemote(s.id, true);
  await tick();
  // Claude Code says "failed" before it answers the request: the answer says how it ended.
  inner.onEvent(s, s.query, { type: 'remote', state: 'failed', detail: 'requires claude.ai subscription auth' });
  assert.equal(view(m, s.id).remote?.state, 'starting');
  calls[0].fail(new Error('Remote Control requires claude.ai subscription auth.'));
  await tick();
  assert.equal(view(m, s.id).remote, null);
  assert.equal(([...s.items.values()].at(-1) as Internal).detail, 'Remote Control requires claude.ai subscription auth.');
});

test('turned off while it is being turned on: the request that ends it goes after the first answer', async () => {
  const { m, inner, s } = hub();
  const { calls } = claude(inner, s);
  m.setRemote(s.id, true);
  m.setRemote(s.id, false);
  assert.equal(view(m, s.id).remote?.state, 'stopping');
  await tick();
  await tick();
  assert.equal(calls.length, 1, 'not before the first request is answered');
  calls[0].settle(URL);
  await tick();
  await tick();
  assert.deepEqual(calls.map((c) => c.on), [true, false]);
  assert.equal(view(m, s.id).remote?.state, 'stopping');
  calls[1].settle('');
  await tick();
  assert.equal(view(m, s.id).remote, null);
});

test('a session that is not running is started for it, and asked once it is ready', async () => {
  const { m, inner, s, launches } = hub();
  s.status = 'exited';
  m.setRemote(s.id, true);
  assert.deepEqual(launches, [s.id]);
  assert.equal(view(m, s.id).remote?.state, 'starting');
  const { q, calls } = claude(inner, s);
  inner.readyProcs.delete(q);
  Object.assign(q, { ready: async () => ({ models: [], commands: [] }) });
  inner.refreshContext = async () => undefined;
  inner.refreshUsage = async () => undefined;
  await inner.onReady(s, q);
  await tick();
  assert.deepEqual(calls.map((c) => c.on), [true]);
});

test('it ends with the process, said once, and is never turned back on by the hub', async () => {
  const { m, inner, s } = hub();
  const { calls } = claude(inner, s);
  m.setRemote(s.id, true);
  await tick();
  calls[0].settle(URL);
  await tick();
  const before = notices(s).length;
  inner.teardown(s);
  assert.equal(view(m, s.id).remote, null);
  assert.equal(notices(s).length, before + 1);
});

test('a session driven from elsewhere is not put to sleep, nor closed by the master', async () => {
  const { m, inner, s } = hub();
  const { calls } = claude(inner, s);
  m.setRemote(s.id, true);
  await tick();
  calls[0].settle(URL);
  await tick();
  s.activeAt = 0;
  let stopped = false;
  inner.stop = () => void (stopped = true);
  inner.closeIdle();
  assert.equal(stopped, false);
  s.closeWhenDone = true;
  inner.closeIfDone(s, s.query);
  assert.equal(stopped, false);
});

test('a message written on claude.ai shows in the conversation as the user’s, marked so', () => {
  const { m, inner, s } = hub();
  claude(inner, s);
  inner.onEvent(s, s.query, { type: 'remotePrompt', id: 'u1', blocks: [{ type: 'text', text: 'Depuis le téléphone' }] });
  const item = s.items.get('remote-u1');
  assert.deepEqual({ kind: item.kind, text: item.text, remote: item.remote }, { kind: 'user', text: 'Depuis le téléphone', remote: true });
  assert.equal(view(m, s.id).status, 'busy');
});

test('not on an API key: said, nothing asked', () => {
  const { m, inner, s } = hub('api-key');
  const { calls } = claude(inner, s);
  assert.equal(view(m, s.id).remoteCapable, false);
  m.setRemote(s.id, true);
  assert.equal(calls.length, 0);
  assert.equal(view(m, s.id).remote, null);
  assert.equal(notices(s).length, 1);
});

test('ended before Claude Code answered the request: no link is shown for a connection that is gone', async () => {
  const { m, inner, s } = hub();
  const { calls } = claude(inner, s);
  m.setRemote(s.id, true);
  await tick();
  inner.onEvent(s, s.query, { type: 'remote', state: 'failed', detail: 'could not verify the signed-in account' });
  calls[0].settle(URL);
  await tick();
  assert.equal(view(m, s.id).remote, null);
  assert.equal(([...s.items.values()].at(-1) as Internal).detail, 'could not verify the signed-in account');
});

test('a worker the master closed meanwhile closes once Remote Control is off', async () => {
  const { m, inner, s } = hub();
  const { calls } = claude(inner, s);
  m.setRemote(s.id, true);
  await tick();
  calls[0].settle(URL);
  await tick();
  s.closeWhenDone = true;
  s.activeAt = 0;
  let stopped = false;
  inner.stop = () => void (stopped = true);
  inner.closeIfDone(s, s.query);
  assert.equal(stopped, false);
  m.setRemote(s.id, false);
  await tick();
  await tick();
  calls[1].settle('');
  await tick();
  assert.equal(view(m, s.id).remote, null);
  assert.equal(stopped, true);
});
