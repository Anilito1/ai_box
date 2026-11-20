import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseNvidiaSmi } from './exec.mjs';
import { batteryDrain, isoDurationSeconds, parseBatteryReport, parseDeviceList, parseLastWake, parsePowerQuery, parseRequests, usageSummary } from './parse.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('reads a French plan dump (real output, trimmed) by GUID and indentation', () => {
  const q = parsePowerQuery(fixture('powercfg-qh-fr.txt'));
  assert.equal(q.scheme.guid, '11111111-2222-4333-8444-555555555555');
  assert.match(q.scheme.name, /High Performance/);
  const lid = q.settings['5ca83367-6e45-459f-a27b-476b1d01c936'];
  assert.deepEqual([lid.alias, lid.subgroupAlias, lid.ac, lid.dc], ['LIDACTION', 'SUB_BUTTONS', 1, 1]);
  const video = q.settings['3c0bc021-c8a8-4e07-a973-6b14cbcb2b7e'];
  assert.deepEqual([video.alias, video.ac, video.dc], ['VIDEOIDLE', 900, 600]);
  const min = q.settings['893dee8e-2bef-41e0-89c6-b55d0929964c'];
  assert.deepEqual([min.alias, min.ac, min.dc], ['PROCTHROTTLEMIN', 100, 5]);
  // A setting without alias keeps null and still gets its values.
  const usb = q.settings['48e6b7a6-50f5-4782-a5d4-53bb8f07e226'];
  assert.deepEqual([usb.alias, usb.subgroup, usb.ac, usb.dc], [null, '2a737441-1930-4402-8d77-b2bebba308a3', 0, 1]);
  for (const s of Object.values(q.settings)) assert.ok(s.ac !== null && s.dc !== null);
});

test('reads the same layout in English', () => {
  const q = parsePowerQuery(fixture('powercfg-qh-en.txt'));
  assert.deepEqual(q.scheme, { guid: '381b4222-f694-41f0-9685-ff5bb260df2e', name: 'Balanced' });
  const s = q.settings;
  assert.deepEqual([s['29f6c1db-86da-48c5-9fdb-f2b67b1f44da'].ac, s['29f6c1db-86da-48c5-9fdb-f2b67b1f44da'].dc], [1800, 900]);
  assert.deepEqual([s['36687f9e-e3a5-4dbf-b1dc-15eb381c6863'].alias, s['36687f9e-e3a5-4dbf-b1dc-15eb381c6863'].ac], ['PERFEPP', 33]);
  assert.equal(s['637ea02f-bbcb-4015-8e2c-a1c7b9c0b546'].dc, 3);
  assert.equal(s['48e6b7a6-50f5-4782-a5d4-53bb8f07e226'].alias, null);
});

test('lists power requests by category, keeping only the executable name', () => {
  const r = parseRequests(fixture('powercfg-requests-en.txt'));
  assert.deepEqual(r.DISPLAY, []);
  assert.equal(r.SYSTEM.length, 2);
  assert.equal(r.SYSTEM[0].kind, 'DRIVER');
  assert.equal(r.SYSTEM[0].reason, 'An audio stream is currently in use.');
  assert.deepEqual(r.SYSTEM[1], { kind: 'PROCESS', what: 'example.exe', reason: 'Download in progress' });
  assert.deepEqual(r.EXECUTION, [{ kind: 'PROCESS', what: 'worker.exe', reason: null }]);
  assert.ok(!JSON.stringify(r).includes('someone'), 'paths are cut to the file name');
});

test('wake history and wake-armed devices', () => {
  assert.deepEqual(parseLastWake('Compteur d’historique des sorties de veille - 0\r\n'), { count: 0, details: [] });
  assert.equal(parseLastWake('Wake History Count - 1\nWake History [0]\n  Wake Source Count - 1\n').count, 1);
  assert.deepEqual(parseDeviceList('Souris HID (001)\r\nRealtek PCIe GbE Family Controller\r\n\r\n'), ['Souris HID (001)', 'Realtek PCIe GbE Family Controller']);
  assert.deepEqual(parseDeviceList('NONE\r\n'), []);
});

test('ISO durations', () => {
  assert.equal(isoDurationSeconds('P2DT19H44M34S'), 2 * 86400 + 19 * 3600 + 44 * 60 + 34);
  assert.equal(isoDurationSeconds('PT0S'), 0);
  assert.equal(isoDurationSeconds('P5D'), 5 * 86400);
  assert.equal(isoDurationSeconds('nope'), null);
});

test('battery report: capacity, cycles, drain on battery and in standby, no serial', () => {
  const r = parseBatteryReport(fixture('battery-report.xml'));
  assert.equal(r.platformRole, 'Mobile');
  assert.equal(r.connectedStandby, true);
  assert.deepEqual(r.batteries, [{ manufacturer: 'Maker', chemistry: 'LiP', designMWh: 56000, fullMWh: 42000, cycles: 412 }]);
  assert.equal(r.usage.length, 4);
  assert.equal(r.usage[0].seconds, 3600);
  assert.equal(r.history[0].activeDcSec, 36000);
  const d = batteryDrain(r);
  assert.equal(d.activeW, 12); // 144 Wh over 12 h on battery
  assert.equal(d.standbyW, 1.5); // 30 Wh over 20 h
  assert.equal(d.recentActiveW, 11); // 11 Wh dropped during the first hour
  assert.deepEqual(usageSummary(r), { activeH: 1.5, suspendH: 0, standbyH: 2, hibernateH: 0, otherH: 0 });
  assert.ok(!JSON.stringify(r).includes('MACHINE') && !JSON.stringify(r).includes('0000"'));
});

test('a desktop battery report has no battery and no drain', () => {
  const xml = '<BatteryReport><SystemInformation><PlatformRole>Desktop</PlatformRole><ConnectedStandby>0</ConnectedStandby></SystemInformation><Batteries>\n</Batteries><History></History></BatteryReport>';
  const r = parseBatteryReport(xml);
  assert.deepEqual([r.platformRole, r.connectedStandby, r.batteries], ['Desktop', false, []]);
  assert.deepEqual(batteryDrain(r), { activeW: null, activeHours: 0, standbyW: null, standbyHours: 0, recentActiveW: null });
});

test('nvidia-smi CSV', () => {
  assert.deepEqual(parseNvidiaSmi('NVIDIA GeForce RTX 3060 Ti, P0, 47.98, 220.00, 1, 50, 7001\r\n'), [
    { name: 'NVIDIA GeForce RTX 3060 Ti', pstate: 'P0', powerW: 47.98, limitW: 220, util: 1, tempC: 50, memMHz: 7001 },
  ]);
  assert.equal(parseNvidiaSmi('Laptop GPU, P8, [N/A], [N/A], 0, 40, 405\n')[0].powerW, null);
});
