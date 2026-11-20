#!/usr/bin/env node
// Windows energy audit, read-only: node scripts/energy-audit/run.mjs [--json] [--out <file.md>] [--sample <seconds>]
// Prints a Markdown report (or JSON with --json); --out writes <file>.md and <file>.json. Nothing is changed on the
// machine, nothing leaves it; temporary files (collector output, battery report) are removed at the end.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { analyze } from './analyze.mjs';
import { localSecrets, scrub } from './anonymize.mjs';
import { collect, nvidiaSmi } from './exec.mjs';
import { parseBatteryReport, parseDeviceList, parseLastWake, parsePowerQuery, parseRequests } from './parse.mjs';
import { renderMarkdown } from './report.mjs';

const USAGE = 'Usage : node scripts/energy-audit/run.mjs [--json] [--out <rapport.md>] [--sample <secondes>]';

function args(argv) {
  const o = { json: false, out: null, sample: 5 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--sample') o.sample = Math.max(1, Math.min(60, Number(argv[++i]) || 5));
    else if (a === '--apply') {
      console.error('--apply n’existe pas dans cette version : l’audit ne modifie rien. Les commandes à lancer soi-même sont dans le rapport et dans docs/optimiseur-windows.md.');
      process.exit(2);
    } else if (a === '-h' || a === '--help') {
      console.log(USAGE);
      process.exit(0);
    } else {
      console.error(`Option inconnue : ${a}\n${USAGE}`);
      process.exit(2);
    }
  }
  if (o.out === undefined) (console.error(USAGE), process.exit(2));
  return o;
}

const asArray = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' && !Object.keys(v).length ? [] : v ? [v] : []).filter((x) => x !== null && x !== undefined);

/** PowerShell turns empty arrays into null or {} and one-item arrays into the item. */
export function normalize(ps) {
  for (const k of ['battery', 'storage', 'network', 'radios']) if (!ps[k]?.error) ps[k] = asArray(ps[k]);
  if (ps.display && !ps.display.error) ps.display.brightness = asArray(ps.display.brightness);
  if (ps.startup && !ps.startup.error) for (const k of ['commands', 'store', 'tasks', 'services']) ps.startup[k] = asArray(ps.startup[k]);
  if (ps.startup?.tasks) for (const t of ps.startup.tasks) t.triggers = asArray(t.triggers);
  if (ps.wake && !ps.wake.error) ps.wake.wakes = asArray(ps.wake.wakes);
  if (ps.processes?.list) ps.processes.list = asArray(ps.processes.list);
  if (ps.system?.gpus) ps.system.gpus = asArray(ps.system.gpus);
  if (ps.system?.chassisTypes) ps.system.chassisTypes = asArray(ps.system.chassisTypes);
  // RemainingDischargeTime is "infinite" without a battery.
  if (ps.powerStatus && ps.powerStatus.battery === 'NotPresent') ps.powerStatus.dischargeMinutes = null;
  return ps;
}

async function main() {
  const o = args(process.argv.slice(2));
  if (process.platform !== 'win32') {
    console.error('Cet audit lit les réglages de Windows : il ne tourne que sous Windows.');
    process.exit(1);
  }
  const ps = normalize(await collect(o.sample));
  const nvidia = await nvidiaSmi(ps.system?.gpus);
  const admin = !!ps.system?.isAdmin;
  const pc = ps.powercfg?.error ? {} : (ps.powercfg ?? {});
  const text = (r) => (r && r.status === 0 ? r.text : '');
  delete ps.powercfg; // the raw battery report names the machine: it never reaches the output
  const data = {
    generatedAt: new Date().toISOString(),
    ps,
    plan: parsePowerQuery(text(pc.query)),
    sleepStatesText: text(pc.states),
    lastWake: parseLastWake(text(pc.lastWake)),
    wakeArmed: parseDeviceList(text(pc.wakeArmed)),
    requests: admin && pc.requests?.status === 0 ? parseRequests(pc.requests.text) : null,
    wakeTimers: admin && pc.wakeTimers?.status === 0 ? pc.wakeTimers.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : null,
    batteryReport: pc.battery?.xml ? parseBatteryReport(pc.battery.xml) : null,
    nvidia,
    adminOnly: admin
      ? ['powercfg /sleepstudy /output <fichier>.html (rapport HTML à ouvrir soi-même, surtout utile en veille S0)']
      : ['powercfg /requests', 'powercfg /waketimers', 'powercfg /sleepstudy', 'Get-NetAdapterPowerManagement (réveil par le réseau)'],
  };
  // The registry keeps the name in Unicode; built-in plans store a resource reference (@powrprof.dll,...) instead.
  const regName = ps.powerMode?.activePlanName;
  if (data.plan.scheme && regName && !regName.startsWith('@')) data.plan.scheme.name = regName;
  const a = analyze(data);
  const secrets = localSecrets();
  const md = scrub(renderMarkdown(data, a), secrets);
  // Every string is scrubbed before serialization: in JSON text, paths have doubled backslashes.
  const json = JSON.stringify(
    {
      generatedAt: data.generatedAt,
      verdict: a.verdict,
      findings: a.findings,
      recommendations: a.recommendations.map(({ id, title, gain, risk, rights, why, source }) => ({ id, title, gain, risk, rights, why, source })),
      plan: { scheme: data.plan.scheme, settings: data.plan.settings },
      processes: a.processes,
      startup: a.startup,
      wake: { lastWake: data.lastWake, armed: data.wakeArmed, events: ps.wake, requests: data.requests, wakeTimers: data.wakeTimers },
      system: ps.system,
      capabilities: ps.capabilities,
      misc: { powerMode: ps.powerMode, powerStatus: ps.powerStatus, network: ps.network, radios: ps.radios, display: ps.display, background: ps.background, storage: ps.storage, nvidia },
      adminOnly: data.adminOnly,
      timingsMs: ps._ms,
    },
    (_, v) => (typeof v === 'string' ? scrub(v, secrets) : v),
    2,
  );
  if (o.out) {
    const base = o.out.replace(/\.(md|json)$/i, '');
    writeFileSync(`${base}.md`, md);
    writeFileSync(`${base}.json`, json);
    console.error(`Rapport écrit : ${base}.md et ${base}.json`);
  }
  if (!o.out || o.json) process.stdout.write(o.json ? json : md);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e?.stack ?? String(e));
    process.exit(1);
  });
}
