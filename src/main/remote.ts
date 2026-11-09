import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { SessionStore, SessionStoreEntry, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { RemoteWorkers } from '../shared/types';

/**
 * Workers on the remote server (experimental). The hub runs `ssh` instead of Claude Code: on the server, its key only
 * runs /opt/aibox/launch.mjs (scripts/vps/launch.mjs, installed by setup.sh), which reads one JSON line (what to do) then gives the rest of stdin to Claude Code.
 * The SDK speaks to it over that pipe as to a local process, the hub's tools and permission prompts included.
 * The session lives as long as the SSH connection: a cut ends it (phase 1).
 */

export const REMOTE_DEFAULTS: RemoteWorkers = { enabled: false, host: '', user: 'aibox', port: 22, key: '', repos: {} };

const HOST = /^[a-z0-9.-]{1,253}$|^\d{1,3}(\.\d{1,3}){3}$/i;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const REMOTE_PATH = /^\/[\w./-]{1,500}$/;

/** The settings as written in config.json, or the defaults (off) for anything a hand edit broke. */
export function parseRemote(raw: unknown): RemoteWorkers {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const repos: Record<string, string> = {};
  for (const [local, remote] of Object.entries((o.repos && typeof o.repos === 'object' ? o.repos : {}) as Record<string, unknown>)) {
    if (typeof remote === 'string' && REMOTE_PATH.test(remote) && !remote.includes('..')) repos[resolve(local)] = remote;
  }
  const r: RemoteWorkers = {
    enabled: o.enabled === true,
    host: typeof o.host === 'string' && HOST.test(o.host) ? o.host : '',
    user: typeof o.user === 'string' && USER.test(o.user) ? o.user : REMOTE_DEFAULTS.user,
    port: Number.isInteger(o.port) && (o.port as number) > 0 && (o.port as number) < 65536 ? (o.port as number) : 22,
    key: typeof o.key === 'string' ? o.key : '',
    repos,
  };
  if (!r.host || !r.key) r.enabled = false;
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

export function sshArgs(r: RemoteWorkers): string[] {
  return [
    '-T',
    '-i', r.key,
    '-p', String(r.port),
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    // The server's key was recorded when it was set up: an unknown one is refused, never trusted on first sight.
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=4',
    '-o', 'ConnectTimeout=15',
    `${r.user}@${r.host}`,
  ];
}

type Header = { op: 'launch'; cwd: string; args: string[]; env: Record<string, string> } | { op: 'transcript'; id: string };

const SESSION_ID = /^[0-9a-f-]{36}$/i;

function openSsh(r: RemoteWorkers, header: Header, signal?: AbortSignal, onStderr?: (text: string) => void) {
  const child = spawn('ssh', sshArgs(r), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...(signal ? { signal } : {}) });
  child.stdin.write(`${JSON.stringify(header)}\n`);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text: string) => onStderr?.(text));
  // An abort or a cut connection closes the pipes: a write after that is no failure of the hub's.
  child.stdin.on('error', () => {});
  return child;
}

/** The SDK's spawnClaudeCodeProcess for a session working in `remoteCwd` on the server. */
export function remoteSpawner(r: RemoteWorkers, remoteCwd: string, onSpawn?: (pid: number) => void, onStderr?: (text: string) => void): (o: SpawnOptions) => SpawnedProcess {
  // The SDK's own command is this PC's binary; the launcher runs the server's. Its arguments are flags and values.
  return (o) => {
    const child = openSsh(r, { op: 'launch', cwd: remoteCwd, args: o.args, env: forwardedEnv(o.env) }, o.signal, onStderr);
    // Not the hub's process reaper (src/main/procTree.ts): ssh has no children here, the launcher ends those on the server.
    if (child.pid) onSpawn?.(child.pid);
    return child;
  };
}

const TRANSCRIPT_MAX = 64 * 1024 * 1024;

/** A conversation's transcript as the server stores it: its lines, or null when it has none. */
export function remoteTranscript(r: RemoteWorkers, id: string): Promise<SessionStoreEntry[] | null> {
  if (!SESSION_ID.test(id)) return Promise.resolve(null);
  return new Promise((done, fail) => {
    const child = openSsh(r, { op: 'transcript', id });
    child.stdin.end();
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill(), 60_000);
    child.stdout.on('data', (b: Buffer) => {
      size += b.length;
      if (size > TRANSCRIPT_MAX) child.kill();
      else chunks.push(b);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      fail(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // 3: no such conversation on the server (launch.mjs). Anything else unreadable is a failure, not "gone".
      if (code === 3) return done(null);
      if (code !== 0 || size > TRANSCRIPT_MAX) return fail(new Error(`remote transcript: exit ${code}`));
      done(parseJsonl(Buffer.concat(chunks).toString('utf8')));
    });
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
