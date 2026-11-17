import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setLang } from './i18n';
import { SessionManager } from './sessions';

// A worker's report that says a commit is pushed: the hub checks the remote, and tells the master what it does not hold.

test('a commit announced as pushed but on no remote branch is named for the master; a pushed one is not', async () => {
  setLang('en');
  const dir = mkdtempSync(join(tmpdir(), 'hub-pushcheck-'));
  const run = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  try {
    const remote = join(dir, 'remote.git');
    const work = join(dir, 'work');
    execFileSync('git', ['init', '--bare', '-q', remote]);
    execFileSync('git', ['clone', '-q', remote, work]);
    run(work, 'config', 'user.email', 'test@example.com');
    run(work, 'config', 'user.name', 'Test');
    writeFileSync(join(work, 'a.txt'), 'a');
    run(work, 'add', '.');
    run(work, 'commit', '-q', '-m', 'pushed');
    run(work, 'push', '-q', 'origin', 'HEAD:main');
    const pushed = run(work, 'rev-parse', 'HEAD');
    writeFileSync(join(work, 'b.txt'), 'b');
    run(work, 'add', '.');
    run(work, 'commit', '-q', '-m', 'local only');
    const local = run(work, 'rev-parse', 'HEAD');
    const hub = Object.create(SessionManager.prototype) as { pushCheck(s: { cwd: string }, shas: string[]): Promise<string> };
    assert.equal(await hub.pushCheck({ cwd: work }, [pushed.slice(0, 7)]), '');
    const said = await hub.pushCheck({ cwd: work }, [pushed.slice(0, 7), local.slice(0, 7)]);
    assert.match(said, new RegExp(local.slice(0, 7)));
    assert.doesNotMatch(said, new RegExp(pushed.slice(0, 7)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
