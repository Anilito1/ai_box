// The remote server's power end to end, outside the app, through the app's own RemoteServer: wake() as "I'm stepping
// away" calls it (switched on, then SSH answers), idle() as "I'm back" and the idle guard do (shelved). Each cycle
// starts from a running instance: off, then on again. Timed.
//
//   npx esbuild scripts/vps/power-e2e.ts --bundle --platform=node --format=esm --packages=external --outfile=node_modules/.power-e2e.mjs
//   <OVH keys as JSON on stdin> | node node_modules/.power-e2e.mjs <config.json from vps:connect> [cycles]
//
// stdin: {"project", "instance", "appKey", "appSecret", "consumerKey"}, read from the keychain by the caller: never a
// file of the repo, never printed. Prints one line per state change.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/main/config';
import { ovhPower } from '../../src/main/power';
import { parseRemote } from '../../src/main/remote';
import { RemoteServer } from '../../src/main/remoteServer';
import type { Secrets } from '../../src/main/secrets';
import type { SessionManager } from '../../src/main/sessions';

const [configFile, cyclesArg] = process.argv.slice(2);
if (!configFile) throw new Error('usage: power-e2e <config.json> [cycles]');
const k = JSON.parse(readFileSync(0, 'utf8')) as Record<string, string>;
const t0 = performance.now();
let mark = t0;
const at = () => `${Math.round((performance.now() - t0) / 1000)}s`;
const say = (what: string) => console.log(`[${at()}] ${what}`);
const lap = () => {
  const s = Math.round((performance.now() - mark) / 1000);
  mark = performance.now();
  return `${s}s`;
};

const cfg = loadConfig(mkdtempSync(join(tmpdir(), 'aibox-power-')), 'fr');
cfg.remoteWorkers = parseRemote((JSON.parse(readFileSync(configFile, 'utf8')) as { remoteWorkers: unknown }).remoteWorkers);
cfg.remoteWorkers.power = { ...cfg.remoteWorkers.power, kind: 'ovh', endpoint: 'ovh-eu', project: k.project, instance: k.instance };
const values: Record<string, string> = { ovhAppKey: k.appKey, ovhAppSecret: k.appSecret, ovhConsumerKey: k.consumerKey };
const secrets = { get: (n: string) => values[n] ?? '', has: (n: string) => !!values[n] } as unknown as Secrets;
let shown = '';
const rs = new RemoteServer({
  cfg,
  secrets,
  scripts: '',
  save: () => undefined,
  send: (v) => {
    if (v.server !== shown) say(`server: ${(shown = v.server)}`);
  },
  openExternal: () => undefined,
  keepAwake: () => () => undefined,
  idleSeconds: () => 0,
  confirmHost: async () => false,
});
rs.mgr = { remoteBusy: () => false } as unknown as SessionManager;

const power = ovhPower(cfg.remoteWorkers.power, { appKey: k.appKey, appSecret: k.appSecret, consumerKey: k.consumerKey });
/** idle() returns at once; the shelve is done when OVH reports the instance off (or after 15 min). */
const off = async () => {
  rs.idle();
  const until = Date.now() + 15 * 60_000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 10_000));
    if ((await power.state()) === 'off') return true;
  }
  return false;
};

say(`instance: ${await power.state()}`);
for (let i = 1; i <= Number(cyclesArg ?? 2); i++) {
  mark = performance.now();
  say(`cycle ${i}: switch off (idle)`);
  const down = await off();
  say(`cycle ${i}: ${down ? 'off' : 'still not off'} in ${lap()}`);
  if (!down) process.exit(1);
  say(`cycle ${i}: switch on (wake)`);
  const woke = await rs.wake();
  say(`cycle ${i}: wake -> ${woke ?? 'ready'} in ${lap()}`);
  if (woke) process.exit(1);
}
process.exit(0);
