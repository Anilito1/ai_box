import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CodexClient } from './client';

function fake(script: string, run: (client: CodexClient, exits: number[]) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-client-'));
    const executable = join(dir, 'codex');
    writeFileSync(executable, `#!/bin/sh\n${script}\n`);
    chmodSync(executable, 0o755);
    const client = new CodexClient({ executable, env: { PATH: process.env.PATH ?? '' }, version: 'test' });
    const exits: number[] = [];
    client.onExit = () => exits.push(1);
    const uncaught: Error[] = [];
    const onUncaught = (e: Error) => uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    try {
      await run(client, exits);
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(uncaught, [], 'no uncaught exception');
    } finally {
      process.off('uncaughtException', onUncaught);
      client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('a server that exits before the handshake rejects start() with its message', fake('echo "not signed in" >&2; exit 1', async (client, exits) => {
  await assert.rejects(client.start(), /not signed in/);
  assert.equal(exits.length, 1);
}));

test('a broken pipe under a write rejects start() instead of an uncaught EPIPE', fake('cat >/dev/null', async (client, exits) => {
  const started = client.start();
  const stdin = (client as unknown as { child: { stdin: NodeJS.WritableStream } }).child.stdin;
  stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  await assert.rejects(started, /EPIPE/);
  assert.equal(exits.length, 1);
  await assert.rejects(client.request('x'), /closed/);
}));

/** Deterministic pipe fixture: no executable, wall-clock timeout or real provider. */
function pipeClient() {
  const client = new CodexClient({ executable: '', env: {}, version: 'test' });
  const writes: string[] = [];
  const stdin = { writable: true, destroyed: false, writableEnded: false, write: (message: string) => { writes.push(message); return true; } };
  let killed = 0;
  const internals = client as unknown as { child: unknown; receive(line: string): void; waiting: Map<number, unknown> };
  internals.child = { stdin, kill: () => killed++ };
  return { client, stdin, writes, internals, killed: () => killed };
}

test('RPC timeout rejects and removes its pending request, ignoring its late reply', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = pipeClient();
  const request = f.client.request('turn/start', {}, { timeoutMs: 100 });
  const rejection = assert.rejects(request, /turn\/start timed out/);
  t.mock.timers.tick(100);
  await rejection;
  assert.equal(f.internals.waiting.size, 0);
  f.internals.receive(JSON.stringify({ id: 1, result: { late: true } }));
  assert.equal(f.internals.waiting.size, 0);
  f.client.close();
});

test('abort rejects once, cleans the pending entry, and an already aborted request is not sent', async () => {
  const f = pipeClient();
  const controller = new AbortController();
  const request = f.client.request('turn/start', {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(request, /aborted/);
  await assert.rejects(f.client.request('turn/start', {}, { signal: controller.signal }), /aborted/);
  assert.equal(f.internals.waiting.size, 0);
  assert.equal(f.writes.length, 1);
  f.client.close();
});

test('a non-writable or ended pipe rejects immediately instead of dropping its RPC', async () => {
  const f = pipeClient();
  f.stdin.writable = false;
  await assert.rejects(f.client.request('turn/start'), /not writable/);
  assert.equal(f.internals.waiting.size, 0);
  f.stdin.writable = true;
  f.stdin.writableEnded = true;
  await assert.rejects(f.client.request('thread/read'), /not writable/);
  assert.equal(f.internals.waiting.size, 0);
  f.client.close();
});

test('close immediately rejects pending RPCs and ignores old process callbacks', async () => {
  const f = pipeClient();
  const request = f.client.request('thread/read');
  let notifications = 0;
  f.client.onNotification = () => notifications++;
  f.client.close();
  f.client.close();
  await assert.rejects(request, /closed/);
  assert.equal(f.internals.waiting.size, 0);
  assert.equal(f.killed(), 1);
  f.internals.receive(JSON.stringify({ method: 'turn/completed', params: {} }));
  assert.equal(notifications, 0);
});

test('a delayed server request answer after closure cannot write to the old pipe', async () => {
  const f = pipeClient();
  let resolve!: (value: unknown) => void;
  f.client.onRequest = () => new Promise((yes) => { resolve = yes; });
  f.internals.receive(JSON.stringify({ id: 'approval', method: 'request', params: {} }));
  await Promise.resolve();
  f.client.close();
  resolve({ accepted: true });
  await new Promise((yes) => setImmediate(yes));
  assert.equal(f.writes.length, 0);
});

test('closure before a queued request callback prevents invoking the old adapter', async () => {
  const f = pipeClient();
  let asks = 0;
  f.client.onRequest = async () => { asks++; return {}; };
  f.internals.receive(JSON.stringify({ id: 'approval', method: 'request', params: {} }));
  f.client.close();
  await new Promise((yes) => setImmediate(yes));
  assert.equal(asks, 0);
  assert.equal(f.writes.length, 0);
});
