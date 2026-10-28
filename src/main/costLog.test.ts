import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
