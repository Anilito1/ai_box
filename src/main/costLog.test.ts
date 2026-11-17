import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CostLog } from './costLog';

const u = (cost: number) => ({ cost, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

test("today's cost: kept as turns are appended, read back at start, 0 the next day", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-costlog-'));
  try {
    const now = Date.now();
    const log = new CostLog(dir);
    assert.equal(log.today(now).cost, 0);
    log.append({ at: now, id: 'w', name: 'hub-w', role: 'worker', models: { a: u(1.5) }, repo: '/dev/shop' });
    log.append({ at: now - 2 * 86_400_000, id: 'w', name: 'hub-w', role: 'worker', models: { a: u(7) } }); // another day
    assert.equal(log.today(now).cost, 1.5);
    await log.read(0, now + 1); // the appends are on disk
    assert.equal(new CostLog(dir).today(now).cost, 1.5);
    assert.equal(log.today(now + 86_400_000).cost, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plan-limit readings: one line per change, per account, in a file of their own', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-costlog-'));
  try {
    const at = Date.UTC(2026, 10, 17, 12);
    const log = new CostLog(dir);
    const l = { fiveHourPct: 12, fiveHourResetsAt: 100, sevenDayPct: 40, sevenDayResetsAt: 200 };
    log.limits(at, 'a-1', l);
    log.limits(at + 60_000, 'a-1', l); // nothing changed
    log.limits(at + 120_000, 'a-1', { ...l, sevenDayPct: 41, fablePct: 7 });
    log.limits(at + 120_000, 'a-2', l); // another account
    await log.read(0, at + 1); // waits for the writes
    const lines = readFileSync(join(dir, 'usage', 'limits-2026-11.jsonl'), 'utf8').trim().split('\n').map((x) => JSON.parse(x));
    assert.deepEqual(lines.map((x) => [x.a, x.d7, x.fb]), [['a-1', 40, undefined], ['a-1', 41, 7], ['a-2', 40, undefined]]);
    assert.deepEqual(await log.read(0, at + 1e9), []); // not taken for turns
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
