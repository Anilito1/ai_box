import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeTrees, retireTree } from './worktrees';

function repository(path: string) {
  mkdirSync(join(path, 'sub'), { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'main'); writeFileSync(join(path, 'sub', 'fixture.txt'), 'SYNTHETIC_FIXTURE');
  git('add', '.'); git('-c', 'user.name=FIXTURE', '-c', 'user.email=fixture@invalid.test', 'commit', '-m', 'Create fixture');
  return git;
}

test('all writable folders use isolated checkouts, sharing one new tree within each source checkout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'worktree-isolation-'));
  try {
    const a = join(dir, 'repo-a'), b = join(dir, 'repo-b'); repository(a); repository(b);
    const bundle = await makeTrees([a, join(a, 'sub'), b], 'fixture-post', 'fixture-task');
    assert.equal(bundle.trees.length, 2);
    assert.notEqual(bundle.primary.cwd, a);
    assert.equal(bundle.extraDirs[0], join(bundle.primary.tree.path, 'sub'));
    assert.equal(bundle.extraDirs[1], bundle.trees[1].path);
    assert.ok(bundle.extraDirs.every(path => !path.startsWith(`${a}/`) && path !== b));
    for (const tree of bundle.trees) assert.equal((await retireTree(tree, () => true)).removed, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('secondary folders that cannot be isolated fail closed and clean up the unused primary tree', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'worktree-isolation-'));
  try {
    const a = join(dir, 'repo-a'), plain = join(dir, 'plain'); const git = repository(a); mkdirSync(plain);
    await assert.rejects(makeTrees([a, plain], 'fixture-post', 'fixture-task'), /outside a Git checkout/);
    assert.equal(git('worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
