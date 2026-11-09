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
