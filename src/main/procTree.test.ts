import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, test } from 'node:test';
import { cgroupOf, endJobs, JOB_ENV, jobOf, jobPids, leftBehind, markedProcs, parseProcs, reapTrees, type Proc } from './procTree';
import { alive } from './updateExec';

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

test('Linux job mark: a whole entry of the environment, never part of another', () => {
  const env = (...entries: string[]) => Buffer.from(entries.map((e) => `${e}\0`).join(''));
  assert.equal(jobOf(env('PATH=/usr/bin', 'AIBOX_JOB=AIBox-1')), 'AIBox-1');
  assert.equal(jobOf(env('AIBOX_JOB=AIBox-1', 'HOME=/h')), 'AIBox-1');
  assert.equal(jobOf(Buffer.from('AIBOX_JOB=AIBox-1')), 'AIBox-1', 'last entry without its NUL');
  assert.equal(jobOf(env('XAIBOX_JOB=AIBox-1')), '');
  assert.equal(jobOf(env('NOTE=AIBOX_JOB=AIBox-1')), '');
  assert.equal(jobOf(Buffer.alloc(0)), '');
});

test('Linux job: its marked processes in the control group it started in, never the hub itself', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proc-'));
  const hub = '0::/user.slice/app-claude-hub-1.scope\n';
  try {
    const proc = (pid: number | string, environ: string | null, cgroup = hub) => {
      mkdirSync(join(dir, String(pid)));
      if (environ !== null) writeFileSync(join(dir, String(pid), 'environ'), environ);
      writeFileSync(join(dir, String(pid), 'cgroup'), cgroup);
    };
    proc(101, 'A=1\0AIBOX_JOB=AIBox-x\0');
    proc(102, 'AIBOX_JOB=AIBox-y\0');
    proc(103, null); // Unreadable (ended, another account's).
    // An app a desktop service started after a session's shell exported its environment there.
    proc(104, 'AIBOX_JOB=AIBox-x\0', '0::/user.slice/app.slice/other.service\n');
    proc(process.pid, 'AIBOX_JOB=AIBox-x\0'); // The hub, started from a session's shell.
    proc('self', 'AIBOX_JOB=AIBox-x\0');
    const marked = markedProcs(dir);
    const root = { pid: 100, startedAt: 0, job: 'AIBox-x', cgroup: hub };
    assert.deepEqual(jobPids(marked, root), [101]);
    assert.deepEqual(jobPids(marked, { ...root, cgroup: undefined }).sort(), [101, 104], 'no control group known: the mark alone');
    assert.deepEqual(jobPids(marked, { ...root, job: undefined }), []);
    assert.equal(markedProcs(join(dir, 'none')).size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A real tree under a job's mark: the program `root` (a sh), and what it leaves behind, one of them in a session of its own. */
function markedTree(job: string, rootStays: boolean) {
  const script = `setsid sleep 60 </dev/null >/dev/null 2>&1 & sleep 60 </dev/null >/dev/null 2>&1 & ${rootStays ? 'wait' : 'exit 0'}`;
  const root = spawn('sh', ['-c', script], { env: { ...process.env, [JOB_ENV]: job }, stdio: 'ignore' });
  return { pid: root.pid as number, startedAt: Date.now(), job, cgroup: cgroupOf('self') };
}
const count = (job: string) => jobPids(markedProcs(), { pid: 0, startedAt: 0, job, cgroup: cgroupOf('self') }).length;
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 60 && !ok(); i++) await new Promise((r) => setTimeout(r, 50));
};

test('Linux: a closed program\'s leftovers end, even one whose parent is gone or that left its session', { skip: process.platform !== 'linux' }, async () => {
  const job = `AIBox-test-${process.pid}-a`;
  const root = markedTree(job, false);
  await until(() => !alive(root.pid) && count(job) === 2);
  assert.equal(count(job), 2, 'two sleeps left behind');
  const reaped = await reapTrees([{ ...root, endedAt: Date.now() }], 1000);
  assert.deepEqual([reaped.ended, reaped.left, reaped.kept], [2, 0, []]);
  assert.equal(count(job), 0);
});

test('Linux: a job is kept while one of its programs runs; the last run\'s (orphans) ends with its tree; the hub\'s quit asks all to end', { skip: process.platform !== 'linux' }, async () => {
  const job = `AIBox-test-${process.pid}-b`;
  const root = markedTree(job, true);
  await until(() => count(job) === 3);
  // An earlier program of the same launch, ended: its job still holds the running one.
  const before = { pid: 999_999_999, startedAt: 0, job, cgroup: root.cgroup, endedAt: Date.now() };
  const kept = await reapTrees([before, root], 0);
  assert.deepEqual([kept.ended, kept.kept], [0, [before, root]]);
  assert.equal(count(job), 3);
  const orphans = await reapTrees([root], 0, true);
  assert.deepEqual([orphans.ended, orphans.left, orphans.kept], [3, 0, []]);
  const quit = `AIBox-test-${process.pid}-c`;
  const other = markedTree(quit, true);
  await until(() => count(quit) === 3);
  endJobs([other]);
  await until(() => count(quit) === 0);
  assert.equal(count(quit), 0);
});
