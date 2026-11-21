import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import type { NetworkInterfaceInfo } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { NETWORK_POLL_MS, NetworkWatch, networkSignature, powerBoxSwitch } from './networkWatch';

// The network is looked at only while work is under way; a new address or Power Box's note of a switch is a change.

const v4 = (address: string, internal = false) => ({ address, family: 'IPv4', internal }) as NetworkInterfaceInfo;
const v6 = (address: string) => ({ address, family: 'IPv6', internal: false }) as NetworkInterfaceInfo;

test('the signature keeps the IPv4 addresses that reach out, whatever their order', () => {
  const a = networkSignature({ 'Wi-Fi': [v4('192.168.1.20'), v6('2a01::1')], Loopback: [v4('127.0.0.1', true)], Other: [v4('169.254.3.4')] });
  assert.equal(a, 'Wi-Fi=192.168.1.20');
  assert.equal(networkSignature({ B: [v4('10.0.0.2')], A: [v4('10.0.0.1')] }), networkSignature({ A: [v4('10.0.0.1')], B: [v4('10.0.0.2')] }));
  // IPv6 temporary addresses rotate: no change.
  assert.equal(networkSignature({ 'Wi-Fi': [v4('192.168.1.20'), v6('2a01::2')] }), a);
});

test('a switch of network is seen while work is under way, and nothing runs once it is over', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let ifs: NodeJS.Dict<NetworkInterfaceInfo[]> = { 'Wi-Fi': [v4('192.168.1.20')] };
  let active = true;
  let changes = 0;
  const watch = new NetworkWatch({ interfaces: () => ifs, online: () => true }, () => active, () => changes++);
  assert.equal(watch.watching, false, 'nothing before work starts');
  watch.wake();
  watch.wake();
  t.mock.timers.tick(NETWORK_POLL_MS * 3);
  assert.equal(changes, 0);
  ifs = {}; // The Wi-Fi drops.
  t.mock.timers.tick(NETWORK_POLL_MS);
  ifs = { 'Wi-Fi': [v4('172.20.10.3')] }; // The phone's hotspot.
  t.mock.timers.tick(NETWORK_POLL_MS);
  assert.equal(changes, 2);
  active = false;
  t.mock.timers.tick(NETWORK_POLL_MS);
  assert.equal(watch.watching, false);
  t.mock.timers.reset();
});

test("Power Box's note of a switch counts as a change; its file is optional and of any shape", (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'power-box-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'network-state.json');
  const read = powerBoxSwitch(file);
  assert.equal(read(), 0, 'no file: nothing');
  writeFileSync(file, JSON.stringify({ lastSwitchAt: '2026-11-21T10:00:00Z', interface: 'X' }));
  assert.equal(read(), Date.parse('2026-11-21T10:00:00Z'));
  writeFileSync(file, 'not json');
  utimesSync(file, new Date(5_000_000), new Date(5_000_000));
  assert.equal(read(), 5_000_000, 'unreadable: its time');

  t.mock.timers.enable({ apis: ['setInterval'] });
  let at = 1;
  let changes = 0;
  const watch = new NetworkWatch({ interfaces: () => ({}), online: () => true, switchedAt: () => at }, () => true, () => changes++);
  watch.wake();
  t.mock.timers.tick(NETWORK_POLL_MS);
  at = 2;
  t.mock.timers.tick(NETWORK_POLL_MS);
  t.mock.timers.tick(NETWORK_POLL_MS);
  assert.equal(changes, 1);
  watch.stop();
  t.mock.timers.reset();
});
