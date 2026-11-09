import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import type { SessionStore, SessionStoreEntry, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { RemoteWorkers } from '../shared/types';
import { isBranch, isOwner, isSlug, isTopic, ntfyUrl, parseRunner, parseStatus, REMOTE_MAX_DEFAULT, REMOTE_REPOS, SESSION_ID, type RunnerStatus, type ServerStatus } from '../shared/vps';

/**
 * Workers on the remote server (experimental). The hub runs `ssh` instead of Claude Code: on the server, its key only
 * runs /opt/aibox/launch.mjs (scripts/vps/launch.mjs, installed by setup.sh), which reads one JSON line (what to do),
 * then joins the conversation's Claude Code on the runner (scripts/vps/runner.mjs), which starts it if needed.
 * The SDK speaks to it over that pipe as to a local process, the hub's tools and permission prompts included.
 * A cut connection, or the app closed, leaves the session running on the runner: it keeps the numbered lines the hub
 * missed, the messages for the master and the requests waiting, and gives them at the next launch (`since`).
 * Nothing here runs while remote workers are off.
 */

export const REMOTE_DEFAULTS: RemoteWorkers = {
  enabled: false,
  host: '',
  user: 'aibox',
  admin: 'ubuntu',
  port: 22,
  key: '',
  knownHosts: '',
  repos: {},
  allowed: [],
  denied: [],
  orgs: [],
  app: { id: '', org: '' },
  max: REMOTE_MAX_DEFAULT,
  ntfy: '',
  autoAway: false,
  power: { kind: 'always', endpoint: 'ovh-eu', project: '', instance: '', idleHours: 2, selfOff: false },
};

const HOST = /^[a-z0-9.-]{1,253}$|^\d{1,3}(\.\d{1,3}){3}$/i;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;
/** "+" stands for "/" in the name of a branch's worktree on the server (launch.mjs prepare). */
const REMOTE_PATH = /^\/[\w.+/-]{1,500}$/;
const OVH_ID = /^[a-z0-9-]{8,64}$/i;

/** The settings as written in config.json, or the defaults (off) for anything a hand edit broke. */
export function parseRemote(raw: unknown): RemoteWorkers {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const repos: Record<string, string> = {};
  for (const [local, remote] of Object.entries((o.repos && typeof o.repos === 'object' ? o.repos : {}) as Record<string, unknown>)) {
    if (typeof remote === 'string' && REMOTE_PATH.test(remote) && !remote.includes('..') && remote.startsWith(`${REMOTE_REPOS}/`)) repos[resolve(local)] = remote;
  }
  const p = (o.power && typeof o.power === 'object' ? o.power : {}) as Record<string, unknown>;
  const r: RemoteWorkers = {
    enabled: o.enabled === true,
    host: typeof o.host === 'string' && HOST.test(o.host) ? o.host : '',
    user: typeof o.user === 'string' && USER.test(o.user) ? o.user : REMOTE_DEFAULTS.user,
    admin: typeof o.admin === 'string' && USER.test(o.admin) && o.admin !== 'root' ? o.admin : REMOTE_DEFAULTS.admin,
    port: Number.isInteger(o.port) && (o.port as number) > 0 && (o.port as number) < 65536 ? (o.port as number) : 22,
    key: typeof o.key === 'string' ? o.key : '',
    knownHosts: typeof o.knownHosts === 'string' ? o.knownHosts : '',
    repos,
    allowed: (Array.isArray(o.allowed) ? o.allowed : []).filter(isSlug).slice(0, 50),
    denied: (Array.isArray(o.denied) ? o.denied : []).filter(isOwner).slice(0, 50),
    orgs: (Array.isArray(o.orgs) ? o.orgs : []).filter(isOwner).slice(0, 20),
    app: (() => {
      const a = (o.app && typeof o.app === 'object' ? o.app : {}) as Record<string, unknown>;
      return typeof a.id === 'string' && /^\d{1,12}$/.test(a.id) && isOwner(a.org) ? { id: a.id, org: a.org } : { id: '', org: '' };
    })(),
    max: Number.isInteger(o.max) && (o.max as number) >= 1 && (o.max as number) <= 16 ? (o.max as number) : REMOTE_MAX_DEFAULT,
    ntfy: isTopic(o.ntfy) ? o.ntfy : '',
    autoAway: o.autoAway === true,
    power: {
      kind: p.kind === 'ovh' ? 'ovh' : 'always',
      endpoint: 'ovh-eu',
      project: typeof p.project === 'string' && OVH_ID.test(p.project) ? p.project : '',
      instance: typeof p.instance === 'string' && OVH_ID.test(p.instance) ? p.instance : '',
      idleHours: typeof p.idleHours === 'number' && p.idleHours >= 0.5 && p.idleHours <= 48 ? p.idleHours : 2,
      selfOff: p.selfOff === true,
    },
  };
  if (r.power.kind === 'ovh' && (!r.power.project || !r.power.instance)) r.power.kind = 'always';
  // Its own known_hosts too: the user's shared one is never trusted for the workers' key.
  if (!r.host || !r.key || !r.knownHosts) r.enabled = false;
  return r;
}

/** The server's clone of a local checkout, or null: only the checkouts listed in the settings run there. */
export function remoteCwdOf(r: RemoteWorkers, cwd: string): string | null {
  const want = resolve(cwd);
  const same = (a: string) => (process.platform === 'win32' ? a.toLowerCase() === want.toLowerCase() : a === want);
  return Object.entries(r.repos).find(([local]) => same(local))?.[1] ?? null;
}

/** The variables the SDK sets for Claude Code, and nothing of this PC: no paths, no keys, no account of here. */
export function forwardedEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || !/^(CLAUDE_CODE_|CLAUDE_AGENT_SDK_)/.test(k)) continue;
    if (/TOKEN|KEY|SECRET|PASSWORD|CONFIG_DIR|_PATH$|_DIR$/.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Windows' own OpenSSH first: it reads the Windows ACLs of the key, where Git's MSYS ssh may not. */
export function sshProgram(name: 'ssh' | 'ssh-keygen' | 'ssh-keyscan'): string {
  if (process.platform === 'win32') {
    const own = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\OpenSSH\\${name}.exe`;
    if (existsSync(own)) return own;
  }
  return name;
}

/** Options every connection of the hub uses: no question, a known server only, a dead link noticed within a minute. */
export function sshOptions(knownHosts: string, port: number): string[] {
  return [
    // None of the user's ~/.ssh/config: no agent, no forwarding, no proxy command of theirs reaches the server.
    '-F', 'none',
    '-p', String(port),
    '-o', 'BatchMode=yes',
    '-o', 'ForwardAgent=no',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'PermitLocalCommand=no',
    '-o', 'IdentitiesOnly=yes',
    // The server's key was recorded when it was set up: an unknown one is refused, never trusted on first sight.
    '-o', 'StrictHostKeyChecking=yes',
    ...(knownHosts ? ['-o', `UserKnownHostsFile=${knownHosts}`] : []),
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=4',
    '-o', 'ConnectTimeout=15',
  ];
}

export function sshArgs(r: RemoteWorkers): string[] {
  return ['-T', '-i', r.key, ...sshOptions(r.knownHosts, r.port), `${r.user}@${r.host}`];
}

/** What the hub asks the launcher (scripts/vps/launch.mjs). */
export type Header =
  | { op: 'launch'; cwd: string; args: string[]; env: Record<string, string>; notify?: RemoteNotify; texts?: RemoteTexts; secrets?: Record<string, string>; since?: number }
  | { op: 'transcript'; id: string }
  | { op: 'status' }
  | { op: 'runner' }
  | { op: 'session'; id: string }
  | { op: 'stop'; id: string }
  | { op: 'prepare'; slug: string; branch: string; secrets?: Record<string, string> }
  | { op: 'head'; cwd: string; check?: boolean; secrets?: Record<string, string> }
  | { op: 'echo' };

/** The fixed sentences the server posts on its own (a turn that ends while the hub is away, waits for it, or stops). */
export interface RemoteNotify {
  url: string;
  done: string;
  report: string;
  blocked: string;
  cut: string;
  timeout: string;
}

/** What the runner answers the worker while the hub is away, in the user's language. */
export interface RemoteTexts {
  /** A message to the master (or a lead, a peer), kept for the hub. */
  queued: string;
  /** Any other tool of the hub. */
  offline: string;
  /** The first line of a kept message, when the hub gets it; {time} is when it was written. */
  late: string;
  /** Too many messages kept already (or one too long). */
  full: string;
}

export const notifyOf = (r: RemoteWorkers, texts: Omit<RemoteNotify, 'url'>): RemoteNotify | undefined => (r.ntfy ? { url: ntfyUrl(r.ntfy), ...texts } : undefined);


function openSsh(r: RemoteWorkers, header: Header, signal?: AbortSignal, onStderr?: (text: string) => void) {
  const child = spawn(sshProgram('ssh'), sshArgs(r), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...(signal ? { signal } : {}) });
  child.stdin.write(`${JSON.stringify(header)}\n`);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text: string) => onStderr?.(text));
  // An abort or a cut connection closes the pipes: a write after that is no failure of the hub's.
  child.stdin.on('error', () => {});
  return child;
}

/** How a remote process ended, as the hub needs it: the connection (ssh: 255), the launcher's refusal, or Claude Code. */
export interface RemoteExit {
  code: number | null;
  /** The last lines ssh or the launcher wrote on stderr. */
  stderr: string;
}

/** ssh's own failure (connection refused, cut, key refused), not the program's on the server. */
export const SSH_FAILED = 255;
/** The launcher could not reach the runner (it restarts), or the server is stopping: the session is back in a moment. */
export const RUNNER_DOWN = 5;
export const SERVER_FULL = 6;
export const SERVER_STOPPING = 7;

/** A line from the runner: a message's number, a gap in what it kept, one of its own lines, or none of these. */
export function runnerLine(line: string): { seq: number } | 'gap' | 'meta' | null {
  if (line.startsWith('{"type":"aibox_gap"')) return 'gap';
  if (line.startsWith('{"type":"aibox_')) return 'meta';
  const m = /,"aibox_seq":(\d+)}$/.exec(line);
  return m ? { seq: Number(m[1]) } : null;
}

/**
 * The runner's stream as the SDK reads it: its own lines taken out, each message's number told (the last one the hub
 * got is where the next launch starts from).
 */
export function readRunner(from: NodeJS.ReadableStream, hooks: { onSeq?: (seq: number) => void; onGap?: () => void; onTooLong?: () => void }): PassThrough {
  const out = new PassThrough();
  let buf = '';
  let gap = false;
  let last = -1;
  const take = (line: string) => {
    const r = runnerLine(line);
    // Once per connection: a server repeating it would have the transcript read again and again.
    if (r === 'gap') {
      if (!gap) hooks.onGap?.();
      gap = true;
      return;
    }
    if (r === 'meta') return;
    out.write(`${line}\n`);
    // Only forward: a number that goes back, or out of range, says nothing true about what the hub got.
    if (r && Number.isSafeInteger(r.seq) && r.seq > last) {
      last = r.seq;
      hooks.onSeq?.(r.seq);
    }
  };
  from.setEncoding?.('utf8');
  from.on('data', (chunk: string) => {
    buf += chunk;
    let start = 0;
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n', start)) {
      take(buf.slice(start, nl).replace(/\r$/, ''));
      start = nl + 1;
    }
    buf = buf.slice(start);
    // A line no Claude Code writes: the connection is ended rather than this PC's memory.
    if (buf.length > LINE_MAX) {
      buf = '';
      hooks.onTooLong?.();
    }
  });
  from.on('end', () => {
    if (buf) take(buf);
    out.end();
  });
  from.on('close', () => out.end());
  return out;
}

/** The longest line taken from the server (a transcript's tool result fits many times over). */
const LINE_MAX = 64 * 2 ** 20;

/** The SDK's spawnClaudeCodeProcess for a session working in `remoteCwd` on the server. */
export function remoteSpawner(
  r: RemoteWorkers,
  remoteCwd: string,
  hooks: {
    onSpawn?: (pid: number) => void;
    onStderr?: (text: string) => void;
    onExit?: (exit: RemoteExit) => void;
    notify?: RemoteNotify;
    texts?: RemoteTexts;
    secrets?: Record<string, string>;
    /** The number of the last line the hub got from this conversation: the runner gives what follows. */
    since?: () => number;
    onSeq?: (seq: number) => void;
    onGap?: () => void;
  } = {},
): (o: SpawnOptions) => SpawnedProcess {
  // The SDK's own command is this PC's binary; the launcher runs the server's. Its arguments are flags and values.
  return (o) => {
    let tail = '';
    const header: Header = {
      op: 'launch',
      cwd: remoteCwd,
      args: o.args,
      env: forwardedEnv(o.env),
      since: hooks.since?.() ?? 0,
      ...(hooks.notify ? { notify: hooks.notify } : {}),
      ...(hooks.texts ? { texts: hooks.texts } : {}),
      ...(hooks.secrets ? { secrets: hooks.secrets } : {}),
    };
    const child = openSsh(r, header, o.signal, (text) => {
      tail = (tail + text).slice(-2000);
      hooks.onStderr?.(text);
    });
    // Registered before the SDK's: the session knows why it ended when the SDK reports the failure.
    child.on('exit', (code) => hooks.onExit?.({ code, stderr: tail }));
    // Not the hub's process reaper (src/main/procTree.ts): ssh has no children here, the runner ends those on the server.
    if (child.pid) hooks.onSpawn?.(child.pid);
    const stdout = readRunner(child.stdout, { ...hooks, onTooLong: () => child.kill() });
    return {
      stdin: child.stdin,
      stdout,
      get killed() {
        return child.killed;
      },
      get exitCode() {
        return child.exitCode;
      },
      get signalCode() {
        return child.signalCode;
      },
      kill: (signal: NodeJS.Signals) => child.kill(signal),
      on: (event: string, listener: (...a: unknown[]) => void) => void child.on(event, listener),
      once: (event: string, listener: (...a: unknown[]) => void) => void child.once(event, listener),
      off: (event: string, listener: (...a: unknown[]) => void) => void child.off(event, listener),
    } as SpawnedProcess;
  };
}

/** One request to the launcher: its output, or a failure that says whether the server could be reached at all. */
export function remoteCall(r: RemoteWorkers, header: Header, { timeoutMs = 60_000, max = 1024 * 1024 } = {}): Promise<{ code: number | null; out: Buffer; err: string }> {
  return new Promise((done) => {
    const child = openSsh(r, header);
    child.stdin.end();
    const chunks: Buffer[] = [];
    let size = 0;
    let err = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stderr.on('data', (t: string) => (err = (err + t).slice(-2000)));
    child.stdout.on('data', (b: Buffer) => {
      size += b.length;
      if (size > max) child.kill();
      else chunks.push(b);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      done({ code: null, out: Buffer.alloc(0), err: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code: size > max ? null : code, out: Buffer.concat(chunks), err });
    });
  });
}

const json = (b: Buffer): Record<string, unknown> | null => {
  try {
    const o = JSON.parse(b.toString('utf8').trim().split('\n').pop() ?? '') as unknown;
    return o && typeof o === 'object' ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** A conversation's transcript as the server stores it: its lines, or null when it has none. */
export async function remoteTranscript(r: RemoteWorkers, id: string): Promise<SessionStoreEntry[] | null> {
  if (!SESSION_ID.test(id)) return null;
  const res = await remoteCall(r, { op: 'transcript', id }, { max: 64 * 1024 * 1024 });
  // 3: no such conversation on the server (launch.mjs). Anything else unreadable is a failure, not "gone".
  if (res.code === 3) return null;
  if (res.code !== 0) throw new Error(`remote transcript: exit ${res.code}`);
  return parseJsonl(res.out.toString('utf8'));
}

export async function remoteStatus(r: RemoteWorkers): Promise<ServerStatus | null> {
  const res = await remoteCall(r, { op: 'status' });
  return res.code === 0 ? parseStatus(res.out.toString('utf8')) : null;
}

/** The runner's sessions, at once (no Claude Code started on the server to answer); null when it cannot be asked. */
export async function remoteRunner(r: RemoteWorkers): Promise<RunnerStatus | null> {
  const res = await remoteCall(r, { op: 'runner' }, { timeoutMs: 30_000 });
  return res.code === 0 ? parseRunner(json(res.out)) : null;
}

export async function remoteStop(r: RemoteWorkers, id: string): Promise<void> {
  if (SESSION_ID.test(id)) await remoteCall(r, { op: 'stop', id }, { timeoutMs: 30_000 });
}

/** A worktree of `branch` on the server, fetched from GitHub: its folder and commit, or why it could not be made. */
export async function remotePrepare(r: RemoteWorkers, slug: string, branch: string, secrets?: Record<string, string>): Promise<{ cwd: string; head: string } | { error: string }> {
  const res = await remoteCall(r, { op: 'prepare', slug, branch, ...(secrets ? { secrets } : {}) }, { timeoutMs: 180_000 });
  const o = res.code === 0 ? json(res.out) : null;
  if (o && typeof o.cwd === 'string' && REMOTE_PATH.test(o.cwd) && !o.cwd.includes('..') && o.cwd.startsWith(`${REMOTE_REPOS}/`) && typeof o.head === 'string' && /^[0-9a-f]{40}$/.test(o.head)) return { cwd: o.cwd, head: o.head };
  return { error: res.code === SSH_FAILED || res.code === null ? 'unreachable' : launcherError(res.err) || 'unexpected answer' };
}

/** The branch a folder of the server is on, or '' if it cannot be told. */
export async function remoteHead(r: RemoteWorkers, cwd: string): Promise<string> {
  const res = await remoteCall(r, { op: 'head', cwd }, { timeoutMs: 30_000 });
  const o = res.code === 0 ? json(res.out) : null;
  return isBranch(o?.branch) ? o.branch : '';
}

/** Where the server's copy of a branch stands, after a fetch: null when the server cannot be asked. */
export async function remoteTree(r: RemoteWorkers, cwd: string, secrets?: Record<string, string>): Promise<{ branch: string; head: string; clean: boolean; pushed: boolean } | null> {
  const res = await remoteCall(r, { op: 'head', cwd, check: true, ...(secrets ? { secrets } : {}) }, { timeoutMs: 120_000 });
  const o = res.code === 0 ? json(res.out) : null;
  if (!o || (o.branch !== '' && !isBranch(o.branch)) || typeof o.head !== 'string' || !/^[0-9a-f]{40}$/.test(o.head)) return null;
  return { branch: o.branch, head: o.head, clean: o.clean === true, pushed: o.pushed === true };
}

/** The launcher's own words after "aibox launcher:", else the last line ssh wrote. */
export function launcherError(stderr: string): string {
  const own = /aibox launcher: (.+)/.exec(stderr)?.[1];
  return (own ?? stderr.trim().split('\n').pop() ?? '').slice(0, 300);
}

/**
 * Median time for one line to go to the server's launcher and back over an open connection: the delay every event of
 * a remote worker gets. Null when the server cannot be reached.
 */
export function remoteLatency(r: RemoteWorkers, rounds = 7): Promise<number | null> {
  return new Promise((done) => {
    const child = openSsh(r, { op: 'echo' });
    const times: number[] = [];
    let sent = 0;
    let buf = '';
    const timer = setTimeout(() => child.kill(), 30_000);
    const ping = () => {
      sent = performance.now();
      child.stdin.write(`${times.length}\n`);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (t: string) => {
      buf += t;
      while (buf.includes('\n')) {
        buf = buf.slice(buf.indexOf('\n') + 1);
        times.push(performance.now() - sent);
        if (times.length < rounds) ping();
        else child.stdin.end();
      }
    });
    child.on('close', () => {
      clearTimeout(timer);
      // The first round also wakes the connection up: not counted.
      const kept = times.slice(1).sort((a, b) => a - b);
      done(kept.length > 0 ? Math.round(kept[Math.floor(kept.length / 2)]) : null);
    });
    ping();
  });
}

export function parseJsonl(text: string): SessionStoreEntry[] {
  const out: SessionStoreEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as SessionStoreEntry;
      if (e && typeof e === 'object' && typeof e.type === 'string') out.push(e);
    } catch {
      // A line cut by a write in progress: the next reading has it whole.
    }
  }
  return out;
}

/** The SDK's history readers, on the server's transcripts. Read-only: the server's Claude Code writes them itself. */
export function remoteStore(r: RemoteWorkers): SessionStore {
  return {
    append: async () => {},
    load: (key) => remoteTranscript(r, key.sessionId),
  };
}

/** A notification to the user's phone: fixed sentences only, never a name or a word of a conversation. */
export async function sendNtfy(topic: string, text: string): Promise<boolean> {
  if (!isTopic(topic)) return false;
  try {
    const res = await fetch(ntfyUrl(topic), { method: 'POST', body: text.slice(0, 200), headers: { Title: 'AI Box' }, signal: AbortSignal.timeout(10_000) });
    return res.ok;
  } catch {
    return false;
  }
}
