#!/usr/bin/env node
// Shelves this server when nothing has run on it for the user's delay, the PC being away (the app does it itself while
// it is open). /opt/aibox/power.mjs, owned by root, run by aibox-power.service (setup.sh) as the user aibox-power, when
// the runner asks (/run/aibox/shelve-request). It checks again what the runner wrote (/run/aibox/idle.json), then asks
// OVHcloud to shelve this instance.
//
// The OVHcloud key is a consumer key the user validated for this one instance and two calls only (read it, shelve it):
// whoever holds it can switch this server off, nothing else. It is stored encrypted by systemd-creds with this host's
// key (/etc/aibox/ovh.cred, root's) and given to this service alone, in memory ($CREDENTIALS_DIRECTORY): neither aibox,
// the user the workers run as, nor any file in the clear has it. The log says what was decided, never the key.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const API = 'https://eu.api.ovh.com/1.0';
const ID = /^[a-z0-9-]{8,64}$/i;

/**
 * Shelve only after the delay, on a fresh word of the runner that nothing runs, and with no Claude Code of aibox
 * running: that file is aibox's, so a worker could write it; the processes it cannot hide.
 */
export function shouldShelve(idle, settings, now, claudes = 0) {
  if (!idle || !settings) return 'no-state';
  if (typeof idle.at !== 'number' || now - idle.at > 3 * 60_000) return 'stale';
  if (idle.busy !== false || claudes > 0) return 'busy';
  if (typeof idle.idleSince !== 'number' || now - idle.idleSince < settings.idleHours * 3_600_000) return 'not-yet';
  return 'shelve';
}

/** Claude Code processes of this user id, read from /proc (the runner ends a session's process once it rests). */
export function claudesOf(uid, proc = '/proc') {
  let n = 0;
  for (const pid of readdirSync(proc).filter((d) => /^\d+$/.test(d))) {
    try {
      if (statSync(join(proc, pid)).uid !== uid) continue;
      const argv0 = readFileSync(join(proc, pid, 'cmdline'), 'utf8').split('\0')[0] ?? '';
      if (/(^|\/)claude$/.test(argv0)) n++;
    } catch {
      // Gone meanwhile.
    }
  }
  return n;
}

/** A regular file, read: a pipe or a link left in its place by a worker would block or mislead the check. */
const readRegular = (file) => {
  try {
    return lstatSync(file).isFile() ? JSON.parse(readFileSync(file, 'utf8')) : null;
  } catch {
    return null;
  }
};

/** OVH's request signature: "$1$" + SHA1(secret+consumer+METHOD+URL+BODY+TIMESTAMP joined by "+"). */
export const signature = (appSecret, consumerKey, method, url, body, timestamp) =>
  `$1$${createHash('sha1').update([appSecret, consumerKey, method, url, body, String(timestamp)].join('+')).digest('hex')}`;

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

async function call(keys, method, path) {
  const url = `${API}${path}`;
  const time = await fetch(`${API}/auth/time`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json());
  const res = await fetch(url, {
    method,
    headers: {
      'X-Ovh-Application': keys.appKey,
      'X-Ovh-Consumer': keys.consumerKey,
      'X-Ovh-Timestamp': String(time),
      'X-Ovh-Signature': signature(keys.appSecret, keys.consumerKey, method, url, '', time),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function main() {
  const p = readJson('/etc/aibox/power.json');
  const settings = p && typeof p.idleHours === 'number' && p.idleHours >= 0.5 && p.idleHours <= 48 ? { idleHours: p.idleHours } : null;
  const uid = Number(/^aibox:[^:]*:(\d+):/m.exec(readFileSync('/etc/passwd', 'utf8'))?.[1] ?? NaN);
  if (!Number.isInteger(uid)) return console.log('not shelving: no user aibox');
  const why = shouldShelve(readRegular('/run/aibox/idle.json'), settings, Date.now(), claudesOf(uid));
  if (why !== 'shelve') return console.log(`not shelving: ${why}`);
  const keys = readJson(join(process.env.CREDENTIALS_DIRECTORY ?? '/nonexistent', 'ovh'));
  if (!keys || !ID.test(keys.project ?? '') || !ID.test(keys.instance ?? '') || ![keys.appKey, keys.appSecret, keys.consumerKey].every((k) => typeof k === 'string' && /^[A-Za-z0-9]{8,64}$/.test(k))) {
    return console.log('not shelving: no OVHcloud key on this server');
  }
  const base = `/cloud/project/${keys.project}/instance/${keys.instance}`;
  try {
    const st = await call(keys, 'GET', base);
    if (st?.status !== 'ACTIVE') return console.log(`not shelving: instance ${String(st?.status ?? 'unknown').slice(0, 30)}`);
    await call(keys, 'POST', `${base}/shelve`);
    console.log('shelve asked');
  } catch (e) {
    console.log(`shelve failed: ${e instanceof Error ? e.message : 'error'}`);
    process.exitCode = 1;
  }
}

// Run by systemd as /opt/aibox/power.mjs; imported (tests), it does nothing.
if (process.argv[1]?.endsWith('/power.mjs')) await main();
