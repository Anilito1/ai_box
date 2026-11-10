import type { AwayView } from './types';

// The remote server (experimental): what may go there, who holds which branch, and what the server's answers mean.
// Pure: the main process runs the commands (src/main/vps.ts, src/main/remote.ts), the tests run these.

export const REMOTE_HOME = '/home/aibox';
export const REMOTE_REPOS = `${REMOTE_HOME}/repos`;
/** Workers the server runs at once, by default: ~300 MB per idle Claude Code, plus the builds, on 8 GB. */
export const REMOTE_MAX_DEFAULT = 4;
/** Version of scripts/vps/launch.mjs this app speaks to; the setup installs it again when the server's differs. */
export const LAUNCHER_VERSION = 5;

/** "owner/name" of a GitHub repo, nothing else (it is written into the server's list and into commands). */
export const isSlug = (v: unknown): v is string => typeof v === 'string' && /^[\w.-]{1,39}\/[\w.-]{1,100}$/.test(v) && !v.includes('..');
/** A GitHub account or organisation name. */
export const isOwner = (v: unknown): v is string => typeof v === 'string' && /^[\w.-]{1,39}$/.test(v);

/** An entry of the user's list: a repo, or "owner/*" for every repo of that owner. */
export const isAllowEntry = (v: unknown): v is string => isSlug(v) || (typeof v === 'string' && /^[\w.-]{1,39}\/\*$/.test(v));

const ownerOf = (slug: string) => slug.split('/')[0].toLowerCase();
const refused = (slug: string, denied: readonly string[]) => denied.some((d) => d.toLowerCase() === ownerOf(slug));

/**
 * The repo a remote ("github.com/Owner/name", "git@github.com:Owner/name.git"…) points at, as the user listed it (as
 * the remote writes it, under "owner/*"), or null: another host, an owner the user refused (even for a repo listed by
 * name), anything not listed. The lists live in the user's settings only.
 */
export function allowedRepo(remote: string, allowed: readonly string[], denied: readonly string[] = []): string | null {
  const slug = githubSlug(remote);
  if (!slug || refused(slug, denied)) return null;
  const listed = allowed.find((r) => r.toLowerCase() === slug.toLowerCase());
  if (listed) return listed;
  return allowed.some((r) => r.endsWith('/*') && ownerOf(r) === ownerOf(slug)) ? slug : null;
}

/** "Owner/name" of a GitHub remote, as written there, or null for another host. */
export function githubSlug(remote: string): string | null {
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(remote.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The owners the user listed as "owner/*". */
export const ownersOf = (allowed: readonly string[]): string[] => allowed.filter((r) => isAllowEntry(r) && r.endsWith('/*')).map((r) => r.slice(0, -2));

/**
 * The listed repos as the server's list holds them: valid, of no refused owner, one each. "owner/*" stands for the
 * repos of `available` (what GitHub gives the user's token) of that owner.
 */
export function serverList(allowed: readonly string[], denied: readonly string[], available: readonly string[] = []): string[] {
  const owners = new Set(ownersOf(allowed).map((o) => o.toLowerCase()));
  const names = new Set<string>();
  // One clone per name on the server (~/repos/<name>): a second repo of the same name under another owner is left out.
  return [...allowed, ...available.filter((s) => owners.has(ownerOf(s)))].filter((s) => {
    const name = s.split('/')[1]?.toLowerCase() ?? '';
    if (!isSlug(s) || refused(s, denied) || names.has(name)) return false;
    names.add(name);
    return true;
  });
}

/**
 * Whether the server holds an allowed repo: listed by name, or, under "owner/*", cloned there by the last setup run
 * (its clone linked to a checkout of this PC, under the very name the server gave it). A repo made since, archived,
 * or whose name another repo took there, is not.
 */
export const onServer = (slug: string, allowed: readonly string[], repos: Record<string, string>): boolean =>
  allowed.some((r) => r.toLowerCase() === slug.toLowerCase()) || Object.values(repos).includes(remoteClone(slug));

/**
 * Each local checkout whose origin is a listed repo ready on the server → that repo's clone there. The server's
 * spelling of the name wins: its clone is ~/repos/<name>, whatever case this PC's remote has.
 */
export function cloneMap(dirs: readonly string[], originOf: (dir: string) => string, allowed: readonly string[], denied: readonly string[], ready: readonly string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const dir of dirs) {
    const slug = allowedRepo(originOf(dir), allowed, denied)?.toLowerCase();
    const there = ready.find((r) => r.toLowerCase() === slug);
    if (there) map[dir] = remoteClone(there);
  }
  return map;
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
/**
 * The user's GitHub token on the server: fine-grained (github_pat_), limited to the repos they chose. Never the GitHub
 * CLI's of this PC (gho_) nor a classic one (ghp_): both reach every repo of the account, organisations included.
 */
export const isPersonalGithubToken = (v: unknown): v is string => typeof v === 'string' && /^github_pat_[A-Za-z0-9_]{20,255}$/.test(v);

/** The tokens of a personal repo's remote worker, from the keychain; 'token' when its fine-grained GitHub token is missing. */
export function personalSecrets(get: (name: RemoteSecret) => string): Record<string, string> | 'token' {
  const out: Record<string, string> = {};
  for (const name of REMOTE_SECRETS) {
    const v = get(name);
    if (v) out[name] = v;
  }
  return isPersonalGithubToken(out.GH_TOKEN) ? out : 'token';
}

/** The scope of a repo: an organisation the user named, else theirs. */
export const scopeOf = (slug: string, orgs: readonly string[]): SecretScope => (orgs.some((o) => o.toLowerCase() === slug.split('/')[0].toLowerCase()) ? 'org' : 'personal');

/** The access a worker of this repo holds on the server: the user's own, or that organisation's (its App token). */
export const accessOf = (slug: string, orgs: readonly string[]): string => (scopeOf(slug, orgs) === 'org' ? `org:${slug.split('/')[0].toLowerCase()}` : 'personal');

/** The launcher's `status` answer: what the hub needs, nothing of the account. */
export interface ServerStatus {
  version: number;
  claude: string;
  signedIn: boolean;
  memory: { total: number; available: number };
  running: number;
  /** The runner (scripts/vps/runner.mjs), null when it does not answer. */
  runner: RunnerStatus | null;
}

/** Where a conversation stands on the runner: counts only. */
export interface RunnerSession {
  id: string;
  /** Its Claude Code runs (else it ended, idle or cut, and starts again when the hub attaches). */
  live: boolean;
  state: 'idle' | 'running' | 'requires_action';
  tasks: number;
  /** Requests waiting for the hub: a permission, a question. */
  waiting: number;
  /** Messages to the master (or a lead, a peer) kept while the hub was away. */
  outbox: number;
  attached: boolean;
  /** Its turn was cut by a stop or a restart of the server. */
  interrupted: boolean;
}

export interface RunnerStatus {
  version: number;
  max: number;
  live: number;
  rssMb: number;
  sessions: RunnerSession[];
}

export const SESSION_ID = /^[0-9a-f-]{36}$/i;

/**
 * The id Claude Code gives a tool call (its MCP `_meta`), and whether a message with it was delivered already: the
 * server hands a kept call again after a cut, under the same id. '' when the call carries none.
 */
export function callOf(extra: unknown, sent: readonly string[]): { id: string; again: boolean } {
  const id = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta?.['claudecode/toolUseId'];
  if (typeof id !== 'string' || !id || id.length > 128) return { id: '', again: false };
  return { id, again: sent.includes(id) };
}

export function parseRunner(raw: unknown): RunnerStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
  if (typeof o.version !== 'number') return null;
  const sessions: RunnerSession[] = [];
  for (const x of Array.isArray(o.sessions) ? o.sessions.slice(0, 100) : []) {
    const e = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    if (typeof e.id !== 'string' || !SESSION_ID.test(e.id)) continue;
    const state = e.state === 'running' || e.state === 'requires_action' ? e.state : 'idle';
    sessions.push({ id: e.id, live: e.live === true, state, tasks: num(e.tasks), waiting: num(e.waiting), outbox: num(e.outbox), attached: e.attached === true, interrupted: e.interrupted === true });
  }
  return { version: num(o.version), max: num(o.max), live: num(o.live), rssMb: num(o.rssMb), sessions };
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
      runner: parseRunner(o.runner),
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
  power: { kind: 'always' | 'ovh'; project: string; instance: string; idleHours: number; keys: boolean; pending: boolean; selfOff: boolean };
  /** Workers on the server now (moved there, or of a post that runs there). */
  missions: number;
  /** The GitHub repos of the main repos of the settings: what the setup offers to check. */
  candidates: string[];
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

/** Branch names git and the launcher accept: no option, no path climbing, no space. */
export function isBranch(v: unknown): v is string {
  return typeof v === 'string' && /^[\w][\w./-]{0,199}$/.test(v) && !v.includes('..') && !v.endsWith('.lock') && !v.endsWith('/') && !v.includes('//');
}
