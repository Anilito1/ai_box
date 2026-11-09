import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

// scripts/vps/launch.mjs is the only program the hub's key runs on the server: what it refuses is the lock. Run here
// with a temporary home; the parts that need Linux (process groups, Claude Code) are covered on the server itself.

const LAUNCHER = resolve('scripts/vps/launch.mjs');

function run(input: string, home: string) {
  const r = spawnSync(process.execPath, [LAUNCHER], { input, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 20_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('the launcher refuses anything but its own requests, and logs the refusals', () => {
  const home = mkdtempSync(join(tmpdir(), 'hub-launcher-'));
  assert.equal(run('not json\n', home).code, 2);
  assert.equal(run('{"op":"shell","cmd":"id"}\n', home).code, 2);
  assert.equal(run('', home).code, 2);
  // Outside ~/repos, or a folder that does not exist: refused before anything runs.
  assert.match(run(`${JSON.stringify({ op: 'launch', cwd: home, args: ['--version'], env: {} })}\n`, home).err, /folder outside ~\/repos/);
  assert.match(run(`${JSON.stringify({ op: 'launch', cwd: '/etc', args: [], env: {} })}\n`, home).err, /folder outside|no such folder/);
  assert.match(run(`${JSON.stringify({ op: 'head', cwd: join(home, 'repos', '..', '.ssh') })}\n`, home).err, /no such folder|outside/);
  // Only the listed repos, only plain branch names.
  assert.match(run(`${JSON.stringify({ op: 'prepare', slug: 'acme-corp/crm', branch: 'main' })}\n`, home).err, /repo not listed/);
  assert.match(run(`${JSON.stringify({ op: 'prepare', slug: 'octo/site', branch: '--upload-pack=x' })}\n`, home).err, /repo not listed|bad branch/);
  assert.match(run(`${JSON.stringify({ op: 'transcript', id: '../../etc/passwd' })}\n`, home).err, /bad id/);
  assert.match(readFileSync(join(home, '.aibox', 'launch.log'), 'utf8'), /refused: unknown op/);
});

test('where a conversation stands is the runner’s answer: without it, “unreachable”, never a guess', () => {
  const home = mkdtempSync(join(tmpdir(), 'hub-launcher-'));
  const id = '0f8e2c4a-1111-2222-3333-444455556666';
  // No runner listens here (it runs on the server, under systemd): the hub hears that it cannot know.
  assert.deepEqual(JSON.parse(run(`${JSON.stringify({ op: 'session', id })}\n`, home).out), { state: 'unreachable' });
  assert.deepEqual(JSON.parse(run(`${JSON.stringify({ op: 'stop', id })}\n`, home).out), { state: 'unreachable' });
  assert.match(run(`${JSON.stringify({ op: 'session', id: 'x; rm -rf ~' })}\n`, home).err, /bad id/);
  assert.match(readFileSync(join(home, '.aibox', 'launch.log'), 'utf8'), /session 0f8e2c4a/);
});

test('the launcher echoes lines back, so the hub can time an event through the connection', () => {
  const home = mkdtempSync(join(tmpdir(), 'hub-launcher-'));
  assert.equal(run('{"op":"echo"}\n1\n2\n', home).out, '1\n2\n');
});
