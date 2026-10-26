import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { repoOf } from './repos';

test('a worktree and a subfolder of a repo belong to the main folder of that repo', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hub-repos-')));
  try {
    const main = join(root, 'claude-hub');
    mkdirSync(join(main, '.git', 'worktrees', 'notif'), { recursive: true });
    mkdirSync(join(main, 'src'));
    writeFileSync(join(main, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(main, '.git', 'worktrees', 'notif', 'commondir'), '../..\n');
    writeFileSync(join(main, '.git', 'worktrees', 'notif', 'HEAD'), 'ref: refs/heads/hub/notif\n');
    const tree = join(root, 'claude-hub-notif');
    mkdirSync(tree);
    writeFileSync(join(tree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'notif')}\n`);
    assert.equal(repoOf(main)?.main, main);
    assert.equal(repoOf(join(main, 'src'))?.main, main);
    assert.equal(repoOf(tree)?.main, main);
    assert.equal(repoOf(tree)?.checkout, tree);
    assert.equal(repoOf(join(root, 'elsewhere')), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
