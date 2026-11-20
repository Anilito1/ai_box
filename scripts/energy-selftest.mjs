// Checks, on this PC, what Settings › Energy relies on: the power helper, the battery reading, the lid kept awake
// through a copy of the power plan, and everything put back. Only reversible changes, each one checked; the PC is
// never put to sleep. Windows only.
//
//   node scripts/energy-selftest.mjs            the checks, about 15 seconds
//   node scripts/energy-selftest.mjs --lid 90   then 90 seconds held, lid closable: close it, wait, open it again
//
// Prints one line per check (ok / FAIL / skipped) and leaves the power plan as it found it.
//
// On a laptop, plugged in and then on battery:
//   1. node scripts/energy-selftest.mjs --lid 90, from the repo (after npm ci).
//   2. When asked, close the lid, wait a minute, open it: the "running" lines went on every 5 s, with no gap.
//   3. The last line says the plan after the test is the plan before.
//   4. In AI Box, Settings › Energy: turn on "keep working with the lid closed", give a worker a long task, close the
//      lid for 5 minutes, open it: the worker went on (its messages carry their times).
//   5. Work over, the section says the PC sleeps as usual, and powercfg /getactivescheme names the usual plan.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

if (process.platform !== 'win32') {
  console.log('energy-selftest: Windows only (the Linux adapter has its own tests).');
  process.exit(0);
}

const lidSeconds = (() => {
  const i = process.argv.indexOf('--lid');
  return i > 0 ? Math.max(10, Number(process.argv[i + 1]) || 60) : 0;
})();

const out = join('node_modules', '.energy-selftest.mjs');
await build({ entryPoints: ['src/main/energy/win32.ts'], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'warning' });
const { Win32Energy } = await import(`../${out.replace(/\\/g, '/')}`);

const powercfg = (...args) => execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'powercfg.exe'), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const active = () => /[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/i.exec(powercfg('/getactivescheme'))[0].toLowerCase();
const listed = (g) => powercfg('/list').toLowerCase().includes(g);
const lidOf = (g) => [...powercfg('/qh', g, 'SUB_BUTTONS', 'LIDACTION').matchAll(/0x([0-9a-f]{8})/gi)].slice(-2).map((m) => parseInt(m[1], 16));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// The helper is detached from Node's loop: this keeps the script alive while it waits for it.
const alive = setInterval(() => {}, 1000);

let failed = 0;
const report = (name, ok, detail = '') => {
  if (ok === false) failed++;
  console.log(`${ok === null ? 'skipped' : ok ? 'ok     ' : 'FAIL   '}  ${name}${detail ? `  (${detail})` : ''}`);
};

const dir = mkdtempSync(join(tmpdir(), 'aibox-energy-selftest-'));
const original = active();
const e = new Win32Energy({ dataDir: dir });
const ours = new Set();

/** Whatever happens, the user's plan comes back and our copies go. */
async function putBack() {
  try {
    await e.restoreLeftovers();
  } catch {
    // Done by hand below.
  }
  if (active() !== original && ours.has(active())) powercfg('/setactive', original);
  for (const g of ours) if (listed(g) && active() !== g) powercfg('/delete', g);
}
process.on('SIGINT', () => void putBack().finally(() => process.exit(130)));

try {
  console.log(`plan before: ${original}`);
  const caps = await e.caps();
  report('power helper (PowerShell) starts', caps.holdAwake);
  report('lid present, can be kept awake lid closed', caps.lidClosedAwake ? true : null, caps.notes.join(' / '));
  const b = await e.battery();
  report('battery read', caps.battery ? b.present && b.percent !== null : null, b.present ? `${b.percent} %, ${b.source === 'ac' ? 'plugged in' : 'on battery'}${b.minutesLeft !== null ? `, ${b.minutesLeft} min left` : ''}` : 'no battery');

  const userLid = lidOf(original).join('/');
  const hold = await e.hold({ reason: 'AI Box self-test', lidClosed: true, allowDisplaySleep: true });
  const copy = active();
  if (copy !== original) ours.add(copy);
  if (caps.lidClosedAwake) {
    report('a copy of the plan is active during the hold', copy !== original && hold.lidClosedEffective, copy);
    const [ac, dc] = lidOf(copy);
    report('closing the lid does nothing in the copy (mains and battery)', ac === 0 && dc === 0, `${ac}/${dc}`);
    report('your own plan is untouched', lidOf(original).join('/') === userLid, `lid on mains/battery ${userLid}`);
  } else report('the plan stays as it is without a lid', copy === original);
  try {
    const requests = powercfg('/requests');
    report('the power request is listed by Windows', /AI Box self-test/.test(requests));
  } catch {
    report('the power request is listed by Windows', null, 'powercfg /requests needs an administrator prompt');
  }

  if (lidSeconds > 0) {
    console.log(`\nHeld for ${lidSeconds} s: close the lid now, wait, then open it. A line every 5 s shows the PC kept running.`);
    const off = e.onLidChange((closed) => console.log(`  ${new Date().toLocaleTimeString()}  lid ${closed ? 'closed' : 'open'}`));
    const start = Date.now();
    let last = start;
    let gap = 0;
    while (Date.now() - start < lidSeconds * 1000) {
      await wait(5000);
      gap = Math.max(gap, Date.now() - last);
      last = Date.now();
      console.log(`  ${new Date().toLocaleTimeString()}  running`);
    }
    off();
    report('the PC kept running (no gap over 15 s between lines)', gap < 15_000, `longest gap ${Math.round(gap / 1000)} s`);
  }

  await hold.release();
  report('released: your plan is active again', active() === original);
  report('released: the copy is deleted', !listed(copy) || copy === original);

  if (caps.lidClosedAwake) {
    // AI Box dying: the helper's input closes without a release; it puts the plan back by itself.
    const crash = await e.hold({ reason: 'AI Box self-test', lidClosed: true, allowDisplaySleep: true });
    const copy2 = active();
    ours.add(copy2);
    e.helper.proc?.end();
    for (let i = 0; i < 40 && active() !== original; i++) await wait(250);
    await wait(1500);
    report('AI Box crashing: the helper puts your plan back', active() === original && !listed(copy2));
    report('next start: nothing left to undo', (await e.restoreLeftovers()) === 0);
    void crash;
  }
} catch (err) {
  report('unexpected error', false, err instanceof Error ? err.message : String(err));
} finally {
  await putBack();
  const back = active() === original;
  report('plan after the test is the plan before', back, active());
  clearInterval(alive);
  rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
  process.exit(failed ? 1 : 0);
}
