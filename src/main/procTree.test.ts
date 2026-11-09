import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';
import { leftBehind, parseProcs, reapTrees, type Proc } from './procTree';

const T = 1_800_000_000_000;
const p = (pid: number, ppid: number, created: number): Proc => ({ pid, ppid, created: T + created });
const pids = (procs: Proc[]) => procs.map((x) => x.pid).sort((a, b) => a - b);

describe('process tree of a closed program', () => {
  it('reads the Windows listing, file times turned into ms', () => {
    const out = '4 0 0\r\n1228 972 134386858224317330\r\nnoise\r\n';
    assert.deepEqual(parseProcs(out), [
      { pid: 4, ppid: 0, created: 0 },
      { pid: 1228, ppid: 972, created: 134386858224317330 / 10_000 - 11_644_473_600_000 },
    ]);
  });

  it('finds every descendant of a running program, never the program itself nor its siblings', () => {
    const procs = [p(100, 1, 0), p(200, 100, 10), p(201, 200, 20), p(202, 201, 30), p(300, 100, 40), p(400, 1, 50), p(401, 400, 60)];
    assert.deepEqual(pids(leftBehind(procs, { pid: 100, startedAt: T + 300 })), [200, 201, 202, 300]);
  });

  it('still finds them once the program has ended, through the parent PID they keep', () => {
    const procs = [p(200, 100, 10), p(201, 200, 20), p(400, 1, 50)];
    assert.deepEqual(pids(leftBehind(procs, { pid: 100, startedAt: T })), [200, 201]);
  });

  it('leaves alone the children of another process that got the PID since', () => {
    // 100 ended; its PID went to an unrelated process at +5 min, which started 500.
    const procs = [p(200, 100, 10), p(100, 1, 300_000), p(500, 100, 310_000)];
    assert.deepEqual(pids(leftBehind(procs, { pid: 100, startedAt: T })), [200]);
  });

  it('takes no child created after the program was last known to run (a PID held since by a process now gone)', () => {
    // The program's PID went to a launcher that has exited, leaving its own child: born after the program ended.
    const procs = [p(200, 100, 10), p(600, 100, 3_600_000)];
    assert.deepEqual(pids(leftBehind(procs, { pid: 100, startedAt: T }, T + 60_000)), [200]);
  });

  it('never takes a process older than the program, nor a grandchild older than its parent', () => {
    const procs = [p(100, 1, 0), p(150, 100, -60_000), p(200, 100, 10), p(250, 200, 5)];
    assert.deepEqual(pids(leftBehind(procs, { pid: 100, startedAt: T })), [200]);
  });

  it('ends what a program left behind, on Windows, and checks the tree is empty', { skip: process.platform !== 'win32', timeout: 60_000 }, async () => {
    // A program starts a long-running child that outlives it (a dev server, an MCP server), then is killed.
    const code = `const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true }); console.log(c.pid); setInterval(() => {}, 1000)`;
    const program = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const root = { pid: program.pid!, startedAt: Date.now() };
    const child = Number(await new Promise<string>((resolve) => program.stdout.once('data', (d: Buffer) => resolve(d.toString()))));
    const running = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      // Still running: kept for later, nothing of it touched.
      const early = await reapTrees([root], 0);
      assert.deepEqual(early, { ended: 0, left: 0, kept: [root] });
      assert.ok(running(child));
      program.kill();
      const result = await reapTrees([root], 5000);
      assert.equal(result.left, 0);
      assert.deepEqual(result.kept, []);
      assert.ok(result.ended >= 1);
      assert.ok(!running(child));
    } finally {
      if (running(child)) process.kill(child);
    }
  });
});
