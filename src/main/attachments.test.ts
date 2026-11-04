import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { ImageInput } from '../shared/types';
import { SessionManager } from './sessions';
import { FILE_LIMITS } from '../shared/attachments';
import { ATTACHMENT_STORAGE, AttachmentLimitError, AttachmentStore } from './attachments';
import { attachedFiles, fileLine, userTextItem } from './transcript';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'hub-attachments-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, dir: join(root, 'attachments'), store: new AttachmentStore(join(root, 'attachments')) };
}
const quota = (e: unknown) => e instanceof AttachmentLimitError && e.reason === 'quota';
const sizeLimit = (e: unknown) => e instanceof AttachmentLimitError && e.reason === 'size';

test('copied bytes and transcript paths survive source deletion, restart, and the former 30-day expiry', (t) => {
  const { root, dir, store } = fixture(t);
  const source = join(root, 'original.pdf');
  writeFileSync(source, 'original');
  const saved = store.save({ name: 'original.pdf', path: source, size: 0 });
  assert.equal(saved.size, 8); // Never trust renderer sizes.
  writeFileSync(source, 'changed');
  rmSync(source);
  const old = new Date(0);
  utimesSync(saved.path, old, old);
  utimesSync(dirname(saved.path), old, old);
  const restarted = new AttachmentStore(dir);
  restarted.prune(Date.now() + 365 * 86_400_000);
  const text = fileLine(saved.path);
  const replayed = userTextItem([{ type: 'text', text }], 'restart');
  assert.equal(replayed?.kind, 'user');
  assert.equal(readFileSync(attachedFiles(text)[0].path!, 'utf8'), 'original');
  assert.ok(replayed && 'files' in replayed && replayed.files?.[0].path === saved.path);
});

test('pasted bytes, safe names and duplicate names get distinct durable copies', (t) => {
  const { dir, store } = fixture(t);
  const file = { name: '../../notes.txt', size: 999, data: new Uint8Array([1, 2]) };
  const a = store.save(file);
  const b = store.save(file);
  assert.notEqual(a.path, b.path);
  assert.equal(dirname(dirname(a.path)), dir);
  assert.equal(a.size, 2);
  file.data[0] = 9;
  assert.deepEqual([...readFileSync(a.path)], [1, 2]);
});

test('only expired unpublished staging folders are purged; legacy files/folders remain', (t) => {
  const { dir, store } = fixture(t);
  mkdirSync(dir);
  const stale = join(dir, '.pending-11111111-1111-4111-8111-111111111111');
  const recent = join(dir, '.pending-22222222-2222-4222-8222-222222222222');
  const legacy = join(dir, 'legacy');
  for (const folder of [stale, recent, legacy]) mkdirSync(folder);
  writeFileSync(join(legacy, 'a.pdf'), 'keep');
  const capture = join(dir, 'capture-old.png');
  writeFileSync(capture, 'keep');
  for (const path of [stale, legacy, capture]) utimesSync(path, new Date(0), new Date(0));
  store.prune();
  assert.equal(existsSync(stale), false);
  for (const path of [recent, legacy, capture]) assert.equal(existsSync(path), true);
});

test('existing/legacy bytes count toward quota across restart, with no eviction', (t) => {
  const { dir, store } = fixture(t);
  mkdirSync(dir);
  const legacy = join(dir, 'capture-legacy.png');
  writeFileSync(legacy, '');
  truncateSync(legacy, ATTACHMENT_STORAGE.bytes - 2);
  const saved = store.save({ name: 'exact', size: 0, data: new Uint8Array(2) });
  const restarted = new AttachmentStore(dir);
  assert.throws(() => restarted.save({ name: 'full', size: 0, data: new Uint8Array(1) }), quota);
  assert.equal(existsSync(legacy), true);
  assert.equal(existsSync(saved.path), true);
  // Already-over-quota installations remain intact and refuse even empty additions.
  truncateSync(legacy, ATTACHMENT_STORAGE.bytes + 1);
  assert.throws(() => restarted.save({ name: 'empty', size: 0, data: new Uint8Array() }), quota);
});

test('entry quota bounds even zero-byte attachments', (t) => {
  const { dir, store } = fixture(t);
  mkdirSync(dir);
  for (let i = 0; i < ATTACHMENT_STORAGE.entries - 1; i++) writeFileSync(join(dir, String(i)), '');
  assert.throws(() => store.save({ name: 'empty', size: 0, data: new Uint8Array() }), quota);
  assert.equal(readdirSync(dir).length, ATTACHMENT_STORAGE.entries - 1);
});

test('actual disk size enforces the existing copy budget with no external fallback', (t) => {
  const { root, dir, store } = fixture(t);
  const source = join(root, 'large');
  writeFileSync(source, '');
  truncateSync(source, FILE_LIMITS.copyBytes + 1);
  assert.throws(() => store.save({ name: 'large', size: 1, path: source }), sizeLimit);
  assert.deepEqual(readdirSync(dir), []);
  truncateSync(source, 4);
  const saved = store.save({ name: 'first', size: 0, path: source }, 4);
  assert.throws(() => store.save({ name: 'next', size: 0, path: source }, 0), sizeLimit);
  assert.equal(readFileSync(saved.path).length, 4);
  assert.throws(() => store.save({ name: 'paste', size: 0, data: new Uint8Array(3) }, 2), sizeLimit);
});

test('missing sources, directories and invalid data publish no copy', (t) => {
  const { root, dir, store } = fixture(t);
  assert.throws(() => store.save({ name: 'missing', size: 0, path: join(root, 'missing') }));
  assert.throws(() => store.save({ name: 'directory', size: 0, path: root }));
  assert.throws(() => store.save({ name: 'no bytes', size: 0 }));
  assert.deepEqual(readdirSync(dir), []);
});

test('write errors remove partial copies and do not consume quota', (t) => {
  const { dir, store } = fixture(t);
  const original = fs.writeSync;
  t.mock.method(fs, 'writeSync', () => { throw new Error('disk full'); });
  syncBuiltinESMExports();
  try {
    assert.throws(() => store.save({ name: 'broken', size: 1, data: new Uint8Array(1) }), /disk full/);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    fs.writeSync = original;
    syncBuiltinESMExports();
  }
  assert.ok(store.save({ name: 'retry', size: 1, data: new Uint8Array(1) }).path);
});

test('a source growing during a copy is rejected and its staging bytes are removed', (t) => {
  const { root, dir, store } = fixture(t);
  const source = join(root, 'changing');
  writeFileSync(source, 'original');
  const original = fs.readSync;
  let changed = false;
  t.mock.method(fs, 'readSync', (fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null) => {
    const n = original(fd, buffer, offset, length, position);
    if (!changed) {
      changed = true;
      writeFileSync(source, 'original with more bytes');
    }
    return n;
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => store.save({ name: 'changing', size: 0, path: source }), /changed while copying/);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    fs.readSync = original;
    syncBuiltinESMExports();
  }
});

test('an unreadable storage root fails closed without deleting existing data', (t) => {
  const { dir, store } = fixture(t);
  writeFileSync(dir, 'not a folder');
  assert.throws(() => store.save({ name: 'new', size: 0, data: new Uint8Array(1) }));
  assert.equal(readFileSync(dir, 'utf8'), 'not a folder');
});


test('FIFO without a writer is refused without blocking, including a stat-open race', { skip: process.platform === 'win32' }, (t) => {
  if (!process.env.HUB_ATTACHMENT_FIFO_CHILD) {
    // A process timeout can stop a blocked synchronous open; a node:test timer cannot.
    const env = { ...process.env, HUB_ATTACHMENT_FIFO_CHILD: '1' };
    delete (env as NodeJS.ProcessEnv).NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ['--test', '--test-name-pattern=^FIFO without a writer', fileURLToPath(import.meta.url)], {
      env, timeout: 5000, encoding: 'utf8',
    });
    assert.equal(child.error, undefined, String(child.error));
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.match(child.stdout, /FIFO checks completed/);
    return;
  }
  const { root, dir, store } = fixture(t);
  const fifo = join(root, 'fifo');
  const made = spawnSync('mkfifo', [fifo], { timeout: 1000 });
  assert.equal(made.status, 0);
  assert.throws(() => store.save({ path: fifo, name: 'fifo', size: 0 }), /regular file/);
  // Simulate a regular file replaced by a FIFO after the preliminary stat.
  const mockedStat = t.mock.method(fs, 'statSync', () => ({ isFile: () => true }));
  syncBuiltinESMExports();
  try {
    assert.throws(() => store.save({ path: fifo, name: 'raced', size: 0 }), /regular file/);
    assert.deepEqual(readdirSync(dir), []);
  } finally { mockedStat.mock.restore(); syncBuiltinESMExports(); }
  process.stdout.write('FIFO checks completed\n');
});

test('fsync and rename failures never publish a successful path and clean up the new copy', (t) => {
  const { dir, store } = fixture(t);
  const file = { name: 'new', size: 1, data: new Uint8Array(1) };
  for (const failedCall of [1, 2, 3, 4]) {
    if (process.platform === 'win32' && failedCall !== 1) continue;
    let calls = 0;
    const original = fs.fsyncSync;
    t.mock.method(fs, 'fsyncSync', (fd: number) => {
      if (++calls === failedCall) throw Object.assign(new Error('sync failed'), { code: 'EIO' });
      original(fd);
    });
    syncBuiltinESMExports();
    try {
      assert.throws(() => store.save(file), /sync failed/);
      assert.deepEqual(readdirSync(dir), [], `cleanup after sync call ${failedCall}`);
    } finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
  }
  const original = fs.renameSync;
  t.mock.method(fs, 'renameSync', () => { throw new Error('rename failed'); });
  syncBuiltinESMExports();
  try {
    assert.throws(() => store.save(file), /rename failed/);
    assert.deepEqual(readdirSync(dir), []);
  } finally { fs.renameSync = original; syncBuiltinESMExports(); }
  assert.ok(existsSync(store.save(file).path));
});

test('unsupported directory sync is tolerated only after the file itself was synced', { skip: process.platform === 'win32' }, (t) => {
  const { store } = fixture(t);
  const original = fs.fsyncSync;
  let calls = 0;
  t.mock.method(fs, 'fsyncSync', (fd: number) => {
    calls++;
    if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('unsupported'), { code: 'EINVAL' });
    original(fd);
  });
  syncBuiltinESMExports();
  try {
    assert.ok(existsSync(store.save({ name: 'new', size: 1, data: new Uint8Array(1) }).path));
    assert.equal(calls, 4);
  } finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
});

test('send excludes quota-refused captures from delivery and refuses image-only messages', (t) => {
  const { dir } = fixture(t);
  mkdirSync(dir);
  const legacy = join(dir, 'legacy');
  writeFileSync(legacy, '');
  truncateSync(legacy, ATTACHMENT_STORAGE.bytes);
  const notices: string[] = [];
  const delivered: { images: ImageInput[]; text: string }[] = [];
  // Exercise the real send/saveImages admission path without starting sessions or providers.
  const manager = Object.assign(Object.create(SessionManager.prototype), {
    attachDir: dir,
    sessions: new Map([['worker', { id: 'worker', inbox: {} }]]),
    ended: () => false,
    notice: (_s: unknown, text: string) => notices.push(text),
    deliver: (_s: unknown, prompt: { images: ImageInput[]; text: string }) => delivered.push(prompt),
  }) as SessionManager;
  const image: ImageInput = { mediaType: 'image/png', data: Buffer.from('capture').toString('base64') };
  manager.send('worker', '', [image]);
  assert.equal(delivered.length, 0);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /1 GiB|1 Gio/);
  manager.send('worker', 'text still sent', [image]);
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0].images, []);
  assert.equal(delivered[0].text, 'text still sent');
  assert.deepEqual(readdirSync(dir), ['legacy']);
  assert.equal(existsSync(legacy), true);
});
