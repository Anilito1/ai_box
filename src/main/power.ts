import { createHash } from 'node:crypto';
import type { ServerPower } from '../shared/types';

// Switching the remote server on and off. "Always on" (any VPS) does nothing; an OVHcloud Public Cloud instance is
// shelved when unused (a stopped instance is still billed there; a shelved one only for its snapshot) and unshelved
// before a move. The application key and secret and the consumer key live in the OS keychain (secrets.ts).

export type PowerState = 'off' | 'starting' | 'on' | 'stopping' | 'unknown';

export interface PowerControl {
  kind: ServerPower['kind'];
  state(): Promise<PowerState>;
  /** Asks for it to start; resolves once asked, not once up (the caller waits for SSH). */
  start(): Promise<void>;
  stop(): Promise<void>;
}

export const alwaysOn: PowerControl = {
  kind: 'always',
  state: async () => 'on',
  start: async () => {},
  stop: async () => {},
};

export interface OvhKeys {
  appKey: string;
  appSecret: string;
  consumerKey: string;
}

const API = 'https://eu.api.ovh.com/1.0';

/** OVH's request signature: "$1$" + SHA1(secret+consumer+METHOD+URL+BODY+TIMESTAMP joined by "+"). */
export function ovhSignature(appSecret: string, consumerKey: string, method: string, url: string, body: string, timestamp: number): string {
  return `$1$${createHash('sha1').update([appSecret, consumerKey, method.toUpperCase(), url, body, String(timestamp)].join('+')).digest('hex')}`;
}

/** An instance's OpenStack status, as the hub tells it. */
export function powerOf(status: string): PowerState {
  if (status === 'ACTIVE') return 'on';
  if (['SHELVED', 'SHELVED_OFFLOADED', 'SHUTOFF', 'STOPPED'].includes(status)) return 'off';
  if (['SHELVING', 'SNAPSHOTTING'].includes(status)) return 'stopping';
  if (['UNSHELVING', 'BUILD', 'BUILDING', 'REBOOT', 'HARD_REBOOT', 'RESUMING'].includes(status)) return 'starting';
  return 'unknown';
}

type Fetch = typeof fetch;

/** A signed call to OVH's API: its JSON, or an error carrying the status. */
async function ovhCall(keys: OvhKeys, method: 'GET' | 'POST', path: string, body: unknown, f: Fetch): Promise<unknown> {
  const url = `${API}${path}`;
  const text = body === undefined ? '' : JSON.stringify(body);
  const server = await f(`${API}/auth/time`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json() as Promise<number>);
  const headers: Record<string, string> = {
    'X-Ovh-Application': keys.appKey,
    'X-Ovh-Consumer': keys.consumerKey,
    'X-Ovh-Timestamp': String(server),
    'X-Ovh-Signature': ovhSignature(keys.appSecret, keys.consumerKey, method, url, text, server),
    ...(text ? { 'Content-Type': 'application/json' } : {}),
  };
  const res = await f(url, { method, headers, ...(text ? { body: text } : {}), signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`ovh ${method} ${path.replace(/\/instance\/[^/]+/, '/instance/…')}: HTTP ${res.status}`);
  const raw = await res.text();
  return raw ? (JSON.parse(raw) as unknown) : null;
}

const ID = /^[a-z0-9-]{8,64}$/i;

export function ovhPower(p: ServerPower, keys: OvhKeys, f: Fetch = fetch): PowerControl {
  if (!ID.test(p.project) || !ID.test(p.instance)) throw new Error('ovh: bad project or instance id');
  const base = `/cloud/project/${p.project}/instance/${p.instance}`;
  const status = async () => {
    const o = (await ovhCall(keys, 'GET', base, undefined, f)) as { status?: unknown } | null;
    return typeof o?.status === 'string' ? o.status : '';
  };
  return {
    kind: 'ovh',
    state: async () => {
      try {
        return powerOf(await status());
      } catch {
        return 'unknown';
      }
    },
    start: async () => {
      const s = await status();
      if (s === 'SHELVED' || s === 'SHELVED_OFFLOADED') await ovhCall(keys, 'POST', `${base}/unshelve`, undefined, f);
      else if (s === 'SHUTOFF' || s === 'STOPPED') await ovhCall(keys, 'POST', `${base}/start`, undefined, f);
    },
    stop: async () => {
      const s = await status();
      if (s === 'ACTIVE' || s === 'SHUTOFF' || s === 'STOPPED') await ovhCall(keys, 'POST', `${base}/shelve`, undefined, f);
    },
  };
}

export interface SwitchOn<T> {
  /** The server's own answer once the instance runs (SSH): a value ends the wait. */
  answer(): Promise<T | null>;
  /** Every state read, for the window. */
  seen(s: PowerState): void;
  timeoutMs: number;
  everyMs?: number;
  askAgainMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Switches the instance on and waits for the server's answer. OVH answers an unshelve with 200 and can still leave the
 * instance shelved, or start it and let it fall back (seen on GRA11): while it is, or is again, off it is asked again.
 * `off`: OVH never switched it on; `silent`: on, or on its way, but the server did not answer in time.
 */
export async function switchOn<T>(c: PowerControl, o: SwitchOn<T>): Promise<{ answer: T } | { why: 'off' | 'silent' }> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const until = now() + o.timeoutMs;
  let askedAt = -Infinity;
  let last: PowerState = 'unknown';
  while (now() < until) {
    try {
      last = await c.state();
      if (last === 'off' && now() - askedAt >= (o.askAgainMs ?? 60_000)) {
        await c.start();
        askedAt = now();
        last = 'starting';
      }
    } catch {
      // A refused or failed call: asked again at the next turn.
      last = 'unknown';
    }
    o.seen(last);
    const a = last === 'on' ? await o.answer() : null;
    if (a !== null) return { answer: a };
    await sleep(o.everyMs ?? 10_000);
  }
  return { why: last === 'off' ? 'off' : 'silent' };
}

/**
 * A consumer key for the hub, limited to this one instance (read, start, unshelve, shelve): the user validates it at
 * `validationUrl`, signed in to OVH. Asked with the application key only, as OVH wants it.
 */
export async function askConsumerKey(appKey: string, p: ServerPower, f: Fetch = fetch): Promise<{ validationUrl: string; consumerKey: string }> {
  if (!ID.test(p.project) || !ID.test(p.instance)) throw new Error('ovh: bad project or instance id');
  const base = `/cloud/project/${p.project}/instance/${p.instance}`;
  const accessRules = [
    { method: 'GET', path: base },
    ...['start', 'stop', 'shelve', 'unshelve'].map((a) => ({ method: 'POST', path: `${base}/${a}` })),
  ];
  const res = await f(`${API}/auth/credential`, {
    method: 'POST',
    headers: { 'X-Ovh-Application': appKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessRules }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`ovh credential: HTTP ${res.status}`);
  const o = (await res.json()) as { validationUrl?: unknown; consumerKey?: unknown };
  const url = typeof o.validationUrl === 'string' ? o.validationUrl : '';
  // Only OVH's own sign-in page is opened.
  if (!/^https:\/\/(www\.)?ovh\.com\/|^https:\/\/[a-z.]*\.ovh\.com\/|^https:\/\/[a-z.]*\.ovhcloud\.com\//.test(url) || typeof o.consumerKey !== 'string') throw new Error('ovh credential: unexpected answer');
  return { validationUrl: url, consumerKey: o.consumerKey };
}
