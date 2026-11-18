import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SEARCH_DEFAULTS } from '../../shared/search';
import { SearchClient, searchShownFor } from './client';
import { Engine, retryAfter } from './engine';
import { modelOf } from './models';
import { misplaced, queryEngine } from './service';

test('a question goes to the model building an index when it is on the card or idle, else to its own process', () => {
  assert.equal(queryEngine({ gpu: true, busy: true }, false), 'indexer');
  assert.equal(queryEngine({ gpu: false, busy: false }, true), 'indexer');
  // On a processor that builds an index, a question would wait for whole batches.
  assert.equal(queryEngine({ gpu: false, busy: true }, true), 'asker');
  assert.equal(queryEngine({ gpu: false, busy: true }, false), 'start');
  assert.equal(queryEngine(null, false), 'start');
});

test('models kept warm leave a card another program works on, and come back to it once it is free', () => {
  assert.deepEqual(misplaced(90, true, 'card', 'card'), ['asker', 'reranker']);
  assert.deepEqual(misplaced(90, true, 'processor', null), []);
  assert.deepEqual(misplaced(5, true, 'processor', 'card'), ['asker']);
  // No room for the model on the card: it stays on the processor.
  assert.deepEqual(misplaced(5, false, 'processor', null), []);
  assert.deepEqual(misplaced(5, true, 'card', 'card'), []);
});

/** A stand-in for search-worker.mjs: lists two devices, then says which one it found and which one it was given. */
const FAKE_WORKER = `
const init = JSON.parse(process.env.AIBOX_SEARCH_WORKER);
if (init.kind === 'devices') { process.send({ devices: ['Intel(R) UHD Graphics', 'NVIDIA GeForce RTX 4060 Laptop GPU'] }, () => process.exit(0)); }
else {
  process.send({ ready: true, gpu: true, loadMs: 1, dims: 1, device: process.env.FAKE_DEVICE ?? '' });
  process.on('message', (m) => process.send({ id: m.id, vectors: [Float32Array.of(Number(process.env.GGML_VK_VISIBLE_DEVICES ?? -1))] }));
  process.on('disconnect', () => process.exit(0));
}`;

test('the graphics device is listed once, kept on disk, and listed again when a worker finds another one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aibox-device-'));
  const script = join(dir, 'worker.mjs');
  writeFileSync(script, FAKE_WORKER);
  const kept = join(dir, 'gpu-devices.json');
  const run = async (found: string) => {
    process.env.FAKE_DEVICE = found;
    const e = new Engine({ script, runtime: dir, modelPath: '', model: modelOf('qwen3-embed-0.6b')!, device: () => 'gpu', idleMs: () => 60_000 });
    try {
      return (await e.embed(['q']))[0][0];
    } finally {
      e.stop();
    }
  };
  try {
    // The laptop's integrated chip comes first: the card is the second device.
    assert.equal(await run('NVIDIA GeForce RTX 4060 Laptop GPU'), 1);
    assert.deepEqual(JSON.parse(readFileSync(kept, 'utf8')), { index: 1, name: 'NVIDIA GeForce RTX 4060 Laptop GPU' });
    // Another card behind the same number: the kept choice goes, and the next start lists the devices again.
    assert.equal(await run('Some other card'), 1);
    assert.equal(existsSync(kept), false);
    assert.equal(await run('NVIDIA GeForce RTX 4060 Laptop GPU'), 1);
    assert.equal(existsSync(kept), true);
  } finally {
    delete process.env.FAKE_DEVICE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a model that cannot start on a device is not started again for every question', async () => {
  assert.deepEqual([1, 2, 3, 20].map(retryAfter), [30_000, 60_000, 120_000, 30 * 60_000]);
  const dir = mkdtempSync(join(tmpdir(), 'aibox-blocked-'));
  const script = join(dir, 'worker.mjs');
  const starts = join(dir, 'starts.txt');
  // The processor build refused by Windows, as Smart App Control does: the worker dies before it is ready.
  writeFileSync(script, `
import { appendFileSync } from 'node:fs';
const init = JSON.parse(process.env.AIBOX_SEARCH_WORKER);
appendFileSync(${JSON.stringify(starts)}, init.gpu ? 'g' : 'c');
if (init.gpu) { process.send({ ready: true, gpu: true, loadMs: 1, dims: 1, device: '' }); process.on('message', (m) => process.send({ id: m.id, vectors: [Float32Array.of(1)] })); process.on('disconnect', () => process.exit(0)); }
else process.send({ fatal: 'NoBinaryFoundError' }, () => process.exit(1));`);
  writeFileSync(join(dir, 'gpu-devices.json'), JSON.stringify({ index: 0, name: '' }));
  let device: 'cpu' | 'gpu' = 'cpu';
  const e = new Engine({ script, runtime: dir, modelPath: '', model: modelOf('qwen3-embed-0.6b')!, device: () => device, idleMs: () => 60_000 });
  try {
    await assert.rejects(e.embed(['q']), /NoBinaryFoundError/);
    await assert.rejects(e.embed(['q']), /NoBinaryFoundError/);
    assert.equal(readFileSync(starts, 'utf8'), 'c');
    // The card is another device: tried at once.
    device = 'gpu';
    assert.equal((await e.embed(['q']))[0][0], 1);
    assert.equal(readFileSync(starts, 'utf8'), 'cg');
  } finally {
    e.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a folder of a listed repo, or of a worktree made from it, is indexed; another folder is not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aibox-family-'));
  try {
    const repo = join(dir, 'claude-hub');
    mkdirSync(join(repo, '.git', 'worktrees', 'side'), { recursive: true });
    mkdirSync(join(repo, 'src', 'main'), { recursive: true });
    const side = join(dir, 'claude-hub-side');
    mkdirSync(join(side, 'src'), { recursive: true });
    writeFileSync(join(side, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'side')}\n`);
    writeFileSync(join(repo, '.git', 'worktrees', 'side', 'commondir'), '../..\n');
    const elsewhere = join(dir, 'notes');
    mkdirSync(elsewhere);
    const client = new SearchClient({ dataDir: dir, hostScript: '', workerScript: '', settings: () => ({ ...SEARCH_DEFAULTS, enabled: true, repos: [repo] }), env: () => ({}) });
    assert.equal(client.indexed(join(repo, 'src', 'main')), true);
    assert.equal(client.indexed(join(side, 'src')), true);
    assert.equal(client.indexed(elsewhere), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('search_code is shown whole to a new conversation in an indexed folder, and a resumed one keeps what it had', () => {
  assert.equal(searchShownFor('c1', false, [], () => true), true);
  assert.equal(searchShownFor('c1', false, ['c0'], () => false), false);
  // Started before the tool was shown, or in a folder indexed since: it stays behind the tool search.
  assert.equal(searchShownFor('c1', true, [], () => true), false);
  assert.equal(searchShownFor('c1', true, ['c0'], () => true), false);
  // Started with it: kept, even if the folder left the list since.
  assert.equal(searchShownFor('c1', true, ['c0', 'c1'], () => false), true);
});

/** A stand-in for search-host.mjs: writes down each call and answers `warm` with whether the folder is read. */
const FAKE_HOST = `
const { appendFileSync } = require('node:fs');
process.on('message', (m) => {
  appendFileSync(process.env.FAKE_LOG, m.method + ' ' + JSON.stringify(m.args) + '\\n');
  process.send({ id: m.id, result: m.method === 'warm' ? !m.args[0].includes('elsewhere') : '' });
});
process.on('disconnect', () => process.exit(0));`;

test('a turn warms the search at most once a minute per folder, and not at all while it is off', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aibox-warm-'));
  const hostScript = join(dir, 'host.cjs');
  const log = join(dir, 'calls.log');
  writeFileSync(hostScript, FAKE_HOST);
  writeFileSync(log, '');
  let enabled = true;
  const client = new SearchClient({ dataDir: dir, hostScript, workerScript: '', settings: () => ({ ...SEARCH_DEFAULTS, enabled }), env: () => ({ ...(process.env as Record<string, string>), FAKE_LOG: log }) });
  const calls = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);
  const settle = async (n: number) => {
    for (let i = 0; i < 100 && calls().length < n; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 50));
  };
  try {
    client.warm('C:/repo');
    client.warm('C:/repo');
    client.warm('C:/elsewhere');
    await settle(2);
    assert.deepEqual(calls(), ['warm ["C:/repo"]', 'warm ["C:/elsewhere"]']);
    enabled = false;
    client.warm('C:/other');
    await settle(3);
    assert.equal(calls().length, 2, 'off, nothing is started');
  } finally {
    client.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
