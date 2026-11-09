import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openLocalFile, type LocalFileShell } from './localFiles';

test('local-file boundary: five types, source lines, reveal, deleted files and shell errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-files-'));
  const opened: string[] = [];
  const revealed: string[] = [];
  const shell: LocalFileShell = { openPath: async (p) => { opened.push(p); return ''; }, showItemInFolder: (p) => { revealed.push(p); } };
  try {
    for (const name of ['read me.md', 'image.png', 'paper.pdf', 'video.mp4']) {
      await writeFile(join(root, name), 'synthetic fixture');
      assert.deepEqual(await openLocalFile(root, name, 'open', shell), { ok: true });
    }
    await mkdir(join(root, 'samples'));
    assert.deepEqual(await openLocalFile(root, 'samples', 'open', shell), { ok: true });
    assert.equal(opened.length, 5);
    assert.deepEqual(await openLocalFile(root, 'read me.md:12:3', 'reveal', shell), { ok: true });
    assert.equal(revealed.length, 1);
    const desktop = join(root, 'Desktop');
    await mkdir(desktop);
    const correction = join(desktop, 'TD01-correction.md');
    await writeFile(correction, 'synthetic correction fixture');
    // Both a home workspace and a Desktop workspace authorize the same absolute document.
    for (const workspace of [root, desktop]) {
      assert.deepEqual(await openLocalFile(workspace, correction, 'open', shell), { ok: true });
      assert.deepEqual(await openLocalFile(workspace, correction, 'reveal', shell), { ok: true });
    }
    assert.deepEqual(await openLocalFile(root, 'gone.pdf', 'open', shell), { ok: false, error: 'missing' });
    assert.deepEqual(await openLocalFile(root, 'paper.pdf', 'open', { ...shell, openPath: async () => 'OS details never returned' }), { ok: false, error: 'failed' });
    assert.deepEqual(await openLocalFile(root, 'paper.pdf', 'open', { ...shell, openPath: async () => { throw new Error('secret'); } }), { ok: false, error: 'failed' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('malicious local-file requests never reach the shell', async () => {
  const outer = await mkdtemp(join(tmpdir(), 'local-file-security-'));
  const root = join(outer, 'workspace');
  let calls = 0;
  const shell: LocalFileShell = { openPath: async () => { calls++; return ''; }, showItemInFolder: () => { calls++; } };
  try {
    await mkdir(root);
    await mkdir(join(outer, 'workspace-other'));
    await writeFile(join(outer, 'outside.txt'), 'synthetic');
    await symlink(join(outer, 'outside.txt'), join(root, 'escape.txt'));
    await symlink(outer, join(root, 'escape-dir'));
    await mkdir(join(root, 'Danger.app'));
    await writeFile(join(root, '.env'), 'synthetic');
    await writeFile(join(root, 'run.command'), 'synthetic');
    await writeFile(join(root, 'launch.desktop'), 'synthetic');
    for (const input of ['../outside.txt', join(outer, 'outside.txt'), join(outer, 'workspace-other', 'x.txt'), 'escape.txt', 'escape-dir/outside.txt']) {
      assert.deepEqual(await openLocalFile(root, input, 'open', shell), { ok: false, error: 'outside' });
    }
    for (const input of ['.env', 'run.command', 'launch.desktop', 'Danger.app']) assert.deepEqual(await openLocalFile(root, input, 'open', shell), { ok: false, error: 'unsupported' });
    for (const input of ['https://example.invalid', 'file:///etc/passwd', 'javascript:alert(1)', '//server/share', '\\\\server\\share', '%2e%2e/outside.txt', 'a\0.txt', 'C:secret.txt', {}, null]) {
      assert.deepEqual(await openLocalFile(root, input, 'open', shell), { ok: false, error: 'invalid' });
    }
    assert.deepEqual(await openLocalFile(undefined, 'file.txt', 'open', shell), { ok: false, error: 'invalid' });
    assert.deepEqual(await openLocalFile(root, 'file.txt', 'execute', shell), { ok: false, error: 'invalid' });
    assert.deepEqual(await openLocalFile(join(root, 'Danger.app'), '.', 'open', shell), { ok: false, error: 'unsupported' });
    assert.equal(calls, 0);
  } finally { await rm(outer, { recursive: true, force: true }); }
});
