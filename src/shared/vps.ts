import type { AwayView } from './types';

// The remote server (experimental): what may go there, who holds which branch, and what the server's answers mean.
// Pure: the main process runs the commands (src/main/vps.ts, src/main/remote.ts), the tests run these.

export const REMOTE_HOME = '/home/aibox';
export const REMOTE_REPOS = `${REMOTE_HOME}/repos`;
/** Workers the server runs at once, by default: ~300 MB per idle Claude Code, plus the builds, on 8 GB. */
export const REMOTE_MAX_DEFAULT = 4;
/** Version of scripts/vps/launch.mjs this app speaks to; the setup installs it again when the server's differs. */
export const LAUNCHER_VERSION = 4;

/** "owner/name" of a GitHub repo, nothing else (it is written into the server's list and into commands). */
export const isSlug = (v: unknown): v is string => typeof v === 'string' && /^[\w.-]{1,39}\/[\w.-]{1,100}$/.test(v) && !v.includes('..');
/** A GitHub account or organisation name. */
export const isOwner = (v: unknown): v is string => typeof v === 'string' && /^[\w.-]{1,39}$/.test(v);

/**
 * The repo a remote ("github.com/Owner/name", "git@github.com:Owner/name.git"…) points at, as the user listed it, or
 * null: another host, an owner the user refused, anything not listed. The lists live in the user's settings only.
 */
export function allowedRepo(remote: string, allowed: readonly string[], denied: readonly string[] = []): string | null {
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(remote.trim());
  if (!m) return null;
  const [owner, name] = [m[1].toLowerCase(), m[2].toLowerCase()];
  if (denied.some((d) => d.toLowerCase() === owner)) return null;
  return allowed.find((r) => r.toLowerCase() === `${owner}/${name}`) ?? null;
}

/** The listed repos as the server's list holds them: valid, of no refused owner, one each. */
export function serverList(allowed: readonly string[], denied: readonly string[]): string[] {
  const names = new Set<string>();
  // One clone per name on the server (~/repos/<name>): a second repo of the same name under another owner is left out.
  return allowed.filter((s) => {
    const name = s.split('/')[1]?.toLowerCase() ?? '';
    if (!isSlug(s) || denied.some((d) => d.toLowerCase() === s.split('/')[0].toLowerCase()) || names.has(name)) return false;
    names.add(name);
    return true;
  });
}

/** The server's clone of a listed repo. */
export const remoteClone = (slug: string) => `${REMOTE_REPOS}/${slug.split('/')[1]}`;

export interface VpsTarget {
  host: string;
  /** The administrator's account (OVH: ubuntu), with sudo. */
  admin: string;
  port: number;
}

const HOST = /^(?:\d{1,3}(?:\.\d{1,3}){3}|(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)$/i;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;

/** What the user typed, checked: an IPv4 address or a host name, a Unix user name, a port. Never a shell word. */
export function parseTarget(raw: unknown): VpsTarget | null {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const host = typeof o.host === 'string' ? o.host.trim() : '';
  const admin = typeof o.admin === 'string' ? o.admin.trim() : '';
  const port = typeof o.port === 'number' ? o.port : Number(o.port ?? 22);
  if (!HOST.test(host) || (/^[\d.]+$/.test(host) && host.split('.').some((n) => Number(n) > 255))) return null;
  if (!USER.test(admin) || admin === 'root' || admin === 'aibox') return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, admin, port };
}

// ---------- the setup's steps ----------

export const VPS_STEPS = ['local', 'hostkey', 'admin', 'setup', 'worker', 'login', 'repos', 'save'] as const;
export type VpsStepId = (typeof VPS_STEPS)[number];
/** `wait`: the user has something to do (check a fingerprint, sign in, paste keys). */
export type VpsStepState = 'todo' | 'run' | 'ok' | 'wait' | 'fail';

/** A listed repo on the server: cloned and fetched with the user's token, or refused by GitHub (token without it). */
export interface RepoState {
  slug: string;
  ready: boolean;
}

export interface VpsState {
  target: VpsTarget | null;
  steps: Record<VpsStepId, { state: VpsStepState; detail: string }>;
  /** Public key of the administrator, to paste at the provider's (OVH: at order time, or in the console). */
  adminKey: string;
  /** The server's key, waiting to be trusted: its SHA256 fingerprint. */
  fingerprint: string;
  /** Claude Code's sign-in address on the server, while it waits for its code. */
  loginUrl: string;
  repos: RepoState[];
  /** Claude Code on the server, as it answers (`claude --version`). */
  claude: string;
  /** Median round trip of an event through the connection, ms; 0 = not measured. */
  latencyMs: number;
  /** Memory of the server: total and available, MB; 0 = not measured. */
  memoryMb: { total: number; available: number };
  /** The last lines of the commands, for "Details" (no keys: they are public, no secrets go through). */
  log: string[];
  running: boolean;
}

export function emptyState(): VpsState {
  const steps = Object.fromEntries(VPS_STEPS.map((id) => [id, { state: 'todo', detail: '' }])) as VpsState['steps'];
  return { target: null, steps, adminKey: '', fingerprint: '', loginUrl: '', repos: [], claude: '', latencyMs: 0, memoryMb: { total: 0, available: 0 }, log: [], running: false };
}

/** `SHA256:…` of `ssh-keygen -lf` output, or ''. */
export function fingerprintOf(out: string): string {
  return /\bSHA256:[A-Za-z0-9+/=]{20,}/.exec(out)?.[0] ?? '';
}

/** The sign-in address Claude Code prints (terminal colours and hyperlink codes removed), or ''. */
export function loginUrlOf(out: string): string {
  const plain = out.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ' ').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\r\n]+/g, '\n');
  const m = /https:\/\/(?:claude\.ai|claude\.com|console\.anthropic\.com|platform\.claude\.com)\/[^\s"'<>]*oauth[^\s"'<>]*/.exec(plain);
  return m ? m[0] : '';
}

/** The code the user pastes back: what claude.ai shows (letters, digits, - _ #), nothing that could be a command. */
export function cleanLoginCode(raw: string): string | null {
  const code = raw.trim();
  return /^[\w#.-]{8,512}$/.test(code) ? code : null;
}

/** `REPO <slug> ready|refused` lines of scripts/vps/repos.sh; anything else is log. */
export function parseRepos(out: string, listed: readonly string[]): RepoState[] {
  const repos: RepoState[] = [];
  for (const line of out.split('\n')) {
    const m = /^REPO (\S+) (ready|refused)\s*$/.exec(line.trim());
    if (m && listed.includes(m[1])) repos.push({ slug: m[1], ready: m[2] === 'ready' });
  }
  return repos;
}

// ---------- secrets a remote worker gets, by scope ----------

/**
 * The variables a remote worker may be given, in memory only (never written on the server): `personal` for the user's
 * own repos, `org` for an organisation's (GH_TOKEN there is a GitHub App's one-hour token, made at each launch).
 */
export const REMOTE_SECRETS = ['GH_TOKEN', 'SUPABASE_ACCESS_TOKEN', 'CLOUDFLARE_API_TOKEN', 'NPM_TOKEN', 'VERCEL_TOKEN'] as const;
export type RemoteSecret = (typeof REMOTE_SECRETS)[number];
export type SecretScope = 'personal' | 'org';
export const isRemoteSecret = (v: unknown): v is RemoteSecret => REMOTE_SECRETS.includes(v as RemoteSecret);
/** A token's text: printable, one line, no quote: it goes into an environment, never into a command. */
export const isSecretValue = (v: unknown): v is string => typeof v === 'string' && /^[\x21-\x7e]{8,4096}$/.test(v) && !/["'\\`$]/.test(v);

/** The scope of a repo: an organisation the user named, else theirs. */
export const scopeOf = (slug: string, orgs: readonly string[]): SecretScope => (orgs.some((o) => o.toLowerCase() === slug.split('/')[0].toLowerCase()) ? 'org' : 'personal');

/** The launcher's `status` answer: what the hub needs, nothing of the account. */
export interface ServerStatus {
  version: number;
  claude: string;
  signedIn: boolean;
  memory: { total: number; available: number };
  running: number;
}

export function parseStatus(out: string): ServerStatus | null {
  try {
    const o = JSON.parse(out.trim().split('\n').pop() ?? '') as Record<string, unknown>;
    const mem = (o.memory && typeof o.memory === 'object' ? o.memory : {}) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
    if (typeof o.version !== 'number') return null;
    return {
      version: o.version,
      claude: typeof o.claude === 'string' ? o.claude.slice(0, 80) : '',
      signedIn: o.signedIn === true,
      memory: { total: num(mem.total), available: num(mem.available) },
      running: num(o.running),
    };
  } catch {
    return null;
  }
}

// ---------- what the window shows ----------

export interface RemoteView {
  wizard: VpsState;
  enabled: boolean;
  /** The address to subscribe to on the phone (ntfy app); empty when off. */
  ntfyUrl: string;
  autoAway: boolean;
  max: number;
  power: { kind: 'always' | 'ovh'; project: string; instance: string; idleHours: number; keys: boolean; pending: boolean };
  server: AwayView['server'];
  /** The user's lists (settings only): repos the server may hold, owners it never may, organisations. */
  lists: { allowed: string[]; denied: string[]; orgs: string[] };
  /** The tokens set for each scope (names only, never values). */
  secrets: Record<SecretScope, RemoteSecret[]>;
  app: { id: string; org: string; key: boolean };
  /** The last sync of this PC's Claude environment to the server: counts and what stayed here (paths, no content). */
  env: {
    state: 'idle' | 'running' | 'done' | 'failed';
    at: number;
    sent: number;
    removed: number;
    /** What stayed on this PC, with why ("skills/x (company)"). */
    held: string[];
    /** Plugins the server could not install, or removed because they would run programs there. */
    pluginsFailed: string[];
    /** Why the last sync failed: the server out of reach, or its refusal (with its reason in `detail`). */
    reason: '' | 'unreachable' | 'refused';
    detail: string;
  };
}

export type RemoteSetting =
  | { kind: 'enabled'; on: boolean }
  | { kind: 'autoAway'; on: boolean }
  | { kind: 'max'; value: number }
  | { kind: 'ntfy'; on: boolean }
  | { kind: 'idleHours'; value: number }
  | { kind: 'repos'; allowed: string[]; denied: string[]; orgs: string[] };

// ---------- cost of a server switched on by the hour ----------

/** Euros per hour of OVHcloud Public Cloud flavours with 8 GB (d2-8 and c3-8: 4 vCPU; b3-8: 2 vCPU), excl. VAT, 2026-11-09 (d2-8 as billed, the others from the public catalogue). */
export const OVH_HOURLY: Record<string, number> = { 'd2-8': 0.0399, 'b3-8': 0.0512, 'c3-8': 0.0913 };
/** Snapshot storage while shelved, € per GB per month. */
export const OVH_SNAPSHOT_GB_MONTH = 0.011;

/** The month's estimate: hours on at the flavour's rate, plus the snapshot for the rest of the month. */
export function monthCost(hoursOn: number, hourly: number, diskGb = 50): number {
  const off = Math.max(0, 730 - hoursOn) / 730;
  return Math.round((hoursOn * hourly + off * diskGb * OVH_SNAPSHOT_GB_MONTH) * 100) / 100;
}

// ---------- notifications ----------

export const NTFY_SERVER = 'https://ntfy.sh';
const TOPIC = /^aibox-[a-z0-9]{24}$/;
export const isTopic = (v: unknown): v is string => typeof v === 'string' && TOPIC.test(v);
export const ntfyUrl = (topic: string) => `${NTFY_SERVER}/${topic}`;

// ---------- one side writes a branch ----------

export type Side = 'pc' | 'server';

/** A branch a worker writes on, and where. Held while the worker runs (or works on, detached, on the server). */
export interface Lease {
  slug: string;
  branch: string;
  side: Side;
  /** The session holding it, and its name as shown. */
  session: string;
  worker: string;
  since: number;
}

/**
 * The lease that stops `want`, or null. A branch is written from one side only; on the server, by one worker only
 * (one checkout per branch there). On this PC, several sessions in one checkout stay as they are today.
 */
export function leaseConflict(leases: Lease[], want: Omit<Lease, 'since' | 'worker'>): Lease | null {
  const same = (l: Lease) => l.session !== want.session && l.slug.toLowerCase() === want.slug.toLowerCase() && l.branch === want.branch;
  return leases.find((l) => same(l) && (l.side !== want.side || want.side === 'server')) ?? null;
}

// ---------- reports written on the server ----------

export interface TranscriptLine {
  type?: unknown;
  message?: { content?: unknown };
}

export interface PendingReport {
  id: string;
  text: string;
}

const REPORT_TOOLS = ['mcp__hub__message_master'];

/**
 * The reports a worker wrote to the master on the server that never reached it (its tool call has no result: the hub
 * was gone). Read from the transcript, in order.
 */
export function pendingReports(lines: TranscriptLine[]): PendingReport[] {
  const asked = new Map<string, string>();
  const answered = new Set<string>();
  for (const line of lines) {
    const content = line.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Record<string, unknown>[]) {
      if (line.type === 'assistant' && block.type === 'tool_use' && REPORT_TOOLS.includes(String(block.name)) && typeof block.id === 'string') {
        const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>;
        const text = typeof input.text === 'string' ? input.text : typeof input.message === 'string' ? input.message : '';
        if (text.trim()) asked.set(block.id, text);
      }
      if (line.type === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string') answered.add(block.tool_use_id);
    }
  }
  return [...asked].filter(([id]) => !answered.has(id)).map(([id, text]) => ({ id, text }));
}

/** Branch names git and the launcher accept: no option, no path climbing, no space. */
export function isBranch(v: unknown): v is string {
  return typeof v === 'string' && /^[\w][\w./-]{0,199}$/.test(v) && !v.includes('..') && !v.endsWith('.lock') && !v.endsWith('/') && !v.includes('//');
}
