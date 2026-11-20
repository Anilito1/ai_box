import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { analyze, analyzeProcesses } from './analyze.mjs';
import { scrub } from './anonymize.mjs';
import { CATALOG, commandsFor } from './catalog.mjs';
import { parseBatteryReport, parsePowerQuery } from './parse.mjs';
import { renderMarkdown } from './report.mjs';
import { normalize } from './run.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const proc = (pid, ppid, name, extra = {}) => ({ pid, ppid, name, session: 1, cpuSec: 0, totalCpuSec: 1, wsMB: 10, privateMB: 10, ioBytes: 0, gpuPct: null, hasWindow: false, system: false, hubLike: false, ...extra });

function laptop() {
  return {
    generatedAt: '2026-11-20T10:00:00.000Z',
    ps: normalize({
      system: { manufacturer: 'Vendor', model: 'Laptop 14', pcSystemType: 2, chassisTypes: 10, cpu: 'CPU', cores: 8, logicalProcessors: 4, ramGB: 16, gpus: { name: 'iGPU', refreshHz: 60 }, isAdmin: false },
      capabilities: { lidPresent: true, s3: false, s4: true, aoac: true, hiberFilePresent: true, batteriesPresent: true },
      powerMode: {},
      powerStatus: { energySaver: 'Off', battery: 'Discharging' },
      battery: { percent: 80, designMWh: 56000, fullMWh: 42000, cycles: 412, dischargeMW: 9000, onAc: false },
      processes: {
        seconds: 2,
        list: [
          proc(10, 1, 'electron', { hubLike: true, cpuSec: 0.4 }),
          proc(11, 10, 'claude', { hubLike: true }),
          proc(12, 11, 'node', { cpuSec: 0.8 }),
          proc(20, 1, 'chrome', { cpuSec: 0.16, privateMB: 400 }),
          proc(21, 20, 'chrome', { privateMB: 300 }),
          proc(30, 1, 'Teams', { hasWindow: true }),
        ],
      },
      startup: { commands: { name: 'Teams', exe: 'Teams.exe', where: 'run', scope: 'user', enabled: true }, store: null, tasks: null, services: null },
      wake: { days: 14, wakes: null, sleeps: 0, resumes: 0, unexpectedShutdowns: 0 },
      storage: [{ drive: 'C:', sizeGB: 100, freeGB: 50 }],
    }),
    plan: parsePowerQuery(fixture('powercfg-qh-en.txt')),
    wakeArmed: [],
    batteryReport: parseBatteryReport(fixture('battery-report.xml')),
    nvidia: null,
    adminOnly: ['powercfg /requests'],
  };
}

test('laptop in Modern Standby with lid = sleep: workers stop when the lid closes, and the fix is proposed', () => {
  const a = analyze(laptop());
  assert.equal(a.verdict.portable, true);
  assert.equal(a.verdict.standby, 'S0');
  assert.ok(a.verdict.lidBlockers.some((b) => b.startsWith('branché')));
  assert.equal(a.verdict.battery.healthPct, 75);
  assert.equal(a.verdict.battery.runtimeH, 3.5);
  assert.equal(a.verdict.battery.dischargeW, 9);
  const ids = a.recommendations.map((r) => r.id);
  for (const id of ['lid-nothing-ac', 'lid-nothing-dc', 'standby-idle-dc-off', 'critical-hibernate', 'cpu-boost-dc', 'browser-background', 'hibernate-idle-dc']) assert.ok(ids.includes(id), id);
  assert.ok(!ids.includes('sleep-idle-ac'), 'desktop-only entry is not proposed on a laptop');
  assert.ok(!ids.includes('cpu-epp'), 'EPP 33/50 is already in place');
  assert.ok(a.findings.some((f) => f.level === 'bloquant'));
});

test('AI Box processes and their children are set apart, never listed as background apps', () => {
  const p = analyzeProcesses(laptop().ps);
  assert.deepEqual(p.hub.map((g) => g.name).sort(), ['claude', 'electron', 'node']);
  assert.ok(!p.groups.some((g) => g.name === 'node'));
  // 0.8 s of CPU over 2 s on 4 threads = 10 % of the machine.
  assert.equal(p.hub.find((g) => g.name === 'node').cpu, 10);
  assert.deepEqual(p.background.map((b) => [b.label, b.count, b.privateMB]), [['Google Chrome', 2, 700]]);
  assert.ok(!p.background.some((b) => b.label === 'Microsoft Teams'), 'an app with a window is not "hidden"');
});

test('desktop without battery: no lid advice, idle sleep proposed, undo uses the measured values', () => {
  const d = laptop();
  d.ps.capabilities = { lidPresent: false, s3: true, s4: true, aoac: false, batteriesPresent: false };
  d.ps.system.chassisTypes = [3];
  d.ps.battery = [];
  d.batteryReport = null;
  d.plan = parsePowerQuery(fixture('powercfg-qh-fr.txt'));
  const a = analyze(d);
  assert.deepEqual([a.verdict.portable, a.verdict.standby, a.verdict.battery], [false, 'S3', null]);
  const ids = a.recommendations.map((r) => r.id);
  assert.ok(ids.includes('sleep-idle-ac') && ids.includes('cpu-min-state-ac') && ids.includes('plan-balanced'));
  assert.ok(!ids.some((id) => id.startsWith('lid-')));
  const c = commandsFor(a.recommendations.find((r) => r.id === 'cpu-min-state-ac'), { settings: a.settings });
  assert.deepEqual(c.apply, ['powercfg /setacvalueindex SCHEME_CURRENT SUB_PROCESSOR PROCTHROTTLEMIN 5', 'powercfg /setactive SCHEME_CURRENT']);
  assert.deepEqual(c.undo, ['powercfg /setacvalueindex SCHEME_CURRENT SUB_PROCESSOR PROCTHROTTLEMIN 100', 'powercfg /setactive SCHEME_CURRENT']);
  const md = renderMarkdown(d, a);
  assert.match(md, /machine de bureau/);
  assert.match(md, /sans objet \(pas de capot\)/);
});

test('an unreadable plan gives no false lid verdict; a lid set to "do nothing" with an idle timeout is not a blocker', () => {
  const d = laptop();
  d.plan = { scheme: null, settings: {} };
  const a = analyze(d);
  assert.deepEqual(a.verdict.lidBlockers, []);
  assert.ok(!a.findings.some((f) => f.level === 'bloquant'));
  assert.ok(a.findings.some((f) => f.text.includes('n’a pas pu être lu')));

  const e = laptop();
  e.ps.capabilities.aoac = false;
  for (const s of Object.values(e.plan.settings)) if (s.alias === 'LIDACTION') (s.ac = 0), (s.dc = 0);
  assert.deepEqual(analyze(e).verdict.lidBlockers, []);
});

test('normalize drops the nulls PowerShell can emit', () => {
  const ps = normalize({ startup: { commands: null, store: [null], tasks: {}, services: [{ name: 'x' }, null] }, radios: [null], battery: {} });
  assert.deepEqual([ps.startup.commands, ps.startup.store, ps.startup.tasks, ps.startup.services, ps.radios, ps.battery], [[], [], [], [{ name: 'x' }], [], []]);
});

test('the catalog only holds reversible entries with an official source, all documented', () => {
  const doc = readFileSync(new URL('../../docs/optimiseur-windows.md', import.meta.url), 'utf8');
  const ids = new Set();
  for (const c of CATALOG) {
    assert.ok(!ids.has(c.id), `duplicate ${c.id}`);
    ids.add(c.id);
    assert.match(c.source, /^https:\/\/(learn|support)\.microsoft\.com\/|^https:\/\/support\.xbox\.com\//, c.id);
    const { apply, undo } = commandsFor(c);
    assert.ok(apply.length && undo.length, `${c.id} has apply and undo`);
    assert.ok(doc.includes(`\`${c.id}\``), `${c.id} is documented`);
    for (const cmd of [...apply, ...undo]) assert.doesNotMatch(cmd, /\b(del|rd|rmdir|Remove-Item|sc(\.exe)? delete|reg delete|taskkill|Stop-Process)\b/i, `${c.id}: ${cmd}`);
  }
});

test('scrubbing removes account, machine, profile paths, SIDs and per-profile ids', () => {
  const s = scrub('C:\\Users\\jdoe\\AppData x DESKTOP-ABC12 S-1-5-21-111-222-333-1001 a@b.fr MicrosoftEdgeAutoLaunch_C00559BD99A994F6A8EFEC0D5BECBE5A 9935e61f-1661-40c5-ae2f-8495027d5d5d', {
    profile: 'C:\\Users\\jdoe',
    names: ['jdoe', 'DESKTOP-ABC12'],
  });
  assert.equal(s, '%USERPROFILE%\\AppData x <machine-ou-compte> S-1-5-21-… <e-mail> MicrosoftEdgeAutoLaunch_<id> 9935e61f-1661-40c5-ae2f-8495027d5d5d');
  assert.equal(scrub('D:\\Users\\other\\file'), 'D:\\Users\\<compte>\\file');
  assert.equal(scrub('\\Device\\HarddiskVolume3\\Users\\other\\AppData\\x.exe'), '\\Device\\HarddiskVolume3\\Users\\<compte>\\AppData\\x.exe');
});
