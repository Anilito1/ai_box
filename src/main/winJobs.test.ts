import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { parseProcs, reapTrees } from './procTree';
import { WinJobs } from './winJobs';

// A tree like a session's: the program (0) starts, after `HUB_TREE_WAIT` ms, a child that stays (1) and one (2) that
// starts a detached process (3) and exits at once. That last process has no living parent: only the job still knows
// whose it is. Each one ends by itself after two minutes: no test failure leaves them running for long.
const TREE = `
const { spawn } = require('child_process');
const again = (depth, detached) => spawn(process.execPath, ['-e', process.env.HUB_TREE, depth], { stdio: 'ignore', detached, windowsHide: true });
if (process.argv[1] === '0') setTimeout(() => { again('1', false); again('2', false); }, Number(process.env.HUB_TREE_WAIT));
if (process.argv[1] === '2') { again('3', true).unref(); setTimeout(() => process.exit(0), 300); }
setTimeout(() => process.exit(0), 120000);
`;
const windows = process.platform === 'win32';
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, ms = 30_000): Promise<T> {
  for (const end = Date.now() + ms; ; ) {
    const value = await read();
    if (done(value) || Date.now() > end) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
}
const name = () => `AIBox-test-${randomUUID()}`;
const plant = (wait: number) => {
  const root = spawn(process.execPath, ['-e', TREE, '0'], { stdio: 'ignore', windowsHide: true, env: { ...process.env, HUB_TREE: TREE, HUB_TREE_WAIT: String(wait) } });
  root.unref();
  return root;
};

/** The tree, in a job of its own before it grows, once the process without a living parent is there. */
async function grown(jobs: WinJobs) {
  const job = name();
  await jobs.procs(); // The helper is up: the program is in its job before it starts anything.
  const root = plant(2000);
  const startedAt = Date.now();
  assert.equal(await jobs.assign(job, root.pid as number), true);
  // The console of a process that just ended is without a parent too, for a moment: the one looked for stays.
  const state = await until(
    async () => {
      const read = async () => {
        const pids = (await jobs.pids(job)) ?? [];
        const listed = parseProcs((await jobs.procs()) ?? '');
        return { pids, orphans: pids.filter((pid) => pid !== root.pid && listed.some((p) => p.pid === pid && !listed.some((parent) => parent.pid === p.ppid))) };
      };
      const before = await read();
      await new Promise((r) => setTimeout(r, 1000));
      const after = await read();
      return { pids: after.pids, orphan: after.orphans.find((pid) => before.orphans.includes(pid)) };
    },
    (s) => s.orphan !== undefined,
  );
  if (state.orphan === undefined) await jobs.end(job);
  assert.ok(state.orphan, 'one process of the job has no living parent');
  return { job, root, startedAt, pids: state.pids, orphan: state.orphan };
}
const allGone = (pids: number[]) => until(() => pids.filter(alive), (left) => left.length === 0);

describe('Windows jobs', () => {
  it('does nothing elsewhere', { skip: windows }, async () => {
    const jobs = new WinJobs();
    assert.equal(await jobs.assign('AIBox-x', process.pid), false);
    assert.equal(await jobs.pids('AIBox-x'), null);
    assert.equal(await jobs.procs(), null);
  });

  it('refuses a name that is not its own kind, and a job that does not exist is empty', { skip: !windows, timeout: 60_000 }, async () => {
    const jobs = new WinJobs();
    try {
      assert.equal(await jobs.assign('x y; calc', process.pid), false);
      assert.deepEqual(await jobs.pids(name()), []);
      assert.equal(await jobs.end(name()), 0);
      assert.ok(parseProcs((await jobs.procs()) ?? '').length > 20, 'the helper lists the processes of Windows');
    } finally {
      jobs.stop();
    }
  });

  it('holds a process whose parent has ended, and ends it with the rest once the program is closed', { skip: !windows, timeout: 180_000 }, async () => {
    const jobs = new WinJobs();
    try {
      const { job, root, startedAt, pids, orphan } = await grown(jobs);
      assert.ok(pids.includes(root.pid as number) && pids.length >= 3);
      // While the program runs, nothing of it is ended.
      assert.equal((await reapTrees([{ pid: root.pid as number, startedAt, job }], 0)).kept.length, 1);
      assert.equal(alive(orphan), true);
      root.kill();
      await until(() => alive(root.pid as number), (still) => !still);
      const reaped = await reapTrees([{ pid: root.pid as number, startedAt, endedAt: Date.now(), job }], 0);
      assert.deepEqual(reaped.kept, []);
      assert.ok(reaped.ended >= 1, `ended ${reaped.ended}`);
      assert.deepEqual(await allGone(pids), []);
    } finally {
      jobs.stop();
    }
  });

  it('takes in what the program had already started when it was put in its job', { skip: !windows, timeout: 180_000 }, async () => {
    const jobs = new WinJobs();
    const root = plant(0);
    try {
      const job = name();
      await new Promise((r) => setTimeout(r, 3000));
      assert.equal(await jobs.assign(job, root.pid as number), true);
      const held = (await jobs.pids(job)) ?? [];
      assert.ok(held.length >= 2, `the program and its child, at least: ${held.length}`);
      await jobs.end(job);
      assert.deepEqual(await allGone(held), []);
    } finally {
      root.kill();
      jobs.stop();
    }
  });

  it('survives its helper: another one finds the job again by its name', { skip: !windows, timeout: 180_000 }, async () => {
    const first = new WinJobs();
    const second = new WinJobs();
    try {
      const { job, root, pids, orphan } = await grown(first);
      first.stop();
      await new Promise((r) => setTimeout(r, 500));
      assert.ok(alive(root.pid as number) && alive(orphan), 'the end of the helper ends nothing');
      const held = (await second.pids(job)) ?? [];
      assert.ok(held.includes(root.pid as number) && held.includes(orphan), 'the other helper sees the same job');
      assert.ok(((await second.end(job)) ?? 0) >= 2);
      assert.deepEqual(await allGone(pids), []);
    } finally {
      first.stop();
      second.stop();
    }
  });

  it('ends what its jobs hold when the process that owns them ends, however it ends', { skip: !windows, timeout: 180_000 }, async () => {
    // Stands for the hub: the jobs are its own, the helper only makes them.
    const owner = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 120000)'], { stdio: 'ignore', windowsHide: true });
    owner.unref();
    const jobs = new WinJobs(owner.pid as number);
    try {
      const { pids } = await grown(jobs);
      jobs.stop();
      owner.kill();
      assert.deepEqual(await allGone(pids), []);
    } finally {
      owner.kill();
      jobs.stop();
    }
  });
});
