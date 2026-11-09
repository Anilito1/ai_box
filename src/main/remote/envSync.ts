import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

/**
 * This PC's Claude environment, copied to the remote server's worker user so a remote worker works as a local one:
 * skills, agents, the user settings (plugins), the global CLAUDE.md and the memory of the repos that run there.
 * One way only, PC → server; the server never writes back. What is sent is filtered here, and checked again on the
 * server by scripts/vps/envsync.mjs (paths only under ~/.claude, it removes only what it wrote itself).
 *
 * Filtering rule (docs/vps-guide.md):
 * - never: ~/.claude.json (local MCP servers), credentials, .env, keys, .wrangler, .cloudflare-profiles, the skills
 *   synced by the Claude account (the server's own sign-in brings them), local-only tools (Blender, Unity, computer
 *   use, the PC's visible browser), anything about the company (COMPANY terms), any project not in the remote repos;
 * - CLAUDE.md: a section whose heading names a COMPANY or PC_ONLY term is dropped whole, and so is any paragraph,
 *   list item (with its sub-items) or code block that names one; the rest is kept as written;
 * - settings.json: only the keys of SETTINGS_KEPT; plugins and marketplaces minus the excluded ones;
 * - last, every file is scanned for anything shaped like a secret or an account id (LEAKS) and for the caller's own
 *   terms (the server's address, ids from the settings): a file that has one is not sent at all.
 */

/** Words of the company's world: a file or a CLAUDE.md block that names one stays on the PC. */
const COMPANY = /coiffissimo|mastertools|masterbase|ringover/i;
/** The company's plugin: in CLAUDE.md only, where "brain" is its name and not the word. */
const COMPANY_PLUGIN = /\bbrain\b/i;
/** Services and tools whose accounts and ids live on this PC only (deploys, production databases). */
const PC_ONLY = /cloudflare|wrangler|supabase/i;
/** In CLAUDE.md, what holds on this PC only: its system and its local programs. The server note says what holds there. */
const PC_PROGRAMS = /\bwindows\b|\bwsl\b|\bunity\b|blender|playwright mcp/i;

/** An account id's shape (Cloudflare and others). Blocks the user's own text; in a skill, only the known ones. */
const HEX_ID = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gi;
/** A Supabase project ref, as the user's notes give it after the word. */
const SUPABASE_REF = /(?:supabase|project-ref|projet)[^\n]{0,80}?\b([a-z]{20})\b/gi;

/** Shapes of secrets: none may leave this PC, whatever the file. */
const LEAKS: Array<[string, RegExp]> = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Supabase token', /\bsbp_[A-Za-z0-9]{20,}/],
  ['Anthropic or OpenAI key', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ['AWS key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\./],
];

/** Names (files or folders) never sent, wherever they are. */
const NEVER = /^(\.env(\..*)?|\.wrangler|\.cloudflare-profiles|\.git|node_modules|\.credentials\.json|credentials(\..*)?|.*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)(\.pub)?|\.bucket-.*)$/i;
/** Skills folders that stay here: account-synced (the server's sign-in has them) or tied to this PC's programs. */
const SKILLS_LOCAL = /^(synced|.*unity.*|.*blender.*|.*computer-use.*|.*chrome.*)$/i;
/** Plugins that stay here: the company's, deploy accounts, and MCP servers driving this PC (its visible browser). */
const PLUGINS_LOCAL = /^(brain|cloudflare|playwright|blender|unity|computer-use|chrome.*|claude-in-chrome)$/i;
const MARKETPLACES_LOCAL = /coiffissimo|cloudflare/i;

const SETTINGS_KEPT = ['model', 'effortLevel', 'alwaysThinkingEnabled', 'outputStyle', 'language', 'includeCoAuthoredBy', 'enabledPlugins', 'extraKnownMarketplaces'];

const MAX_FILES = 5000;
const MAX_BYTES = 100 * 1024 * 1024;

export interface EnvFile {
  /** Relative to the home folder, with forward slashes ('.claude/skills/taste/SKILL.md'). */
  path: string;
  data: Buffer;
  sha: string;
}

export interface EnvSkip {
  path: string;
  why: string;
}

/**
 * The name of the first leak in a text, or null. `extra` are literal terms of this PC (an address, known ids).
 * `own`: the user's own text (CLAUDE.md, settings, memory), where any id-shaped string is refused; third-party
 * skills quote public ids (a voice, a sample), so there only the known ones are.
 */
export function findLeak(text: string, extra: string[] = [], own = false): string | null {
  for (const [name, re] of LEAKS) if (re.test(text)) return name;
  if (own && new RegExp(HEX_ID.source, 'i').test(text)) return 'hex id';
  if (COMPANY.test(text)) return 'company';
  const lower = text.toLowerCase();
  for (const term of extra) if (term.length >= 4 && lower.includes(term.toLowerCase())) return 'local term';
  return null;
}

const named = (text: string) => COMPANY.test(text) || COMPANY_PLUGIN.test(text) || PC_ONLY.test(text) || PC_PROGRAMS.test(text);

/** The ids a CLAUDE.md gives (account ids, project refs): never sent, wherever they appear. */
export function knownIds(text: string): string[] {
  const ids = new Set<string>();
  for (const m of text.matchAll(HEX_ID)) ids.add(m[0].toLowerCase());
  for (const m of text.matchAll(SUPABASE_REF)) ids.add(m[1].toLowerCase());
  return [...ids];
}
const HEADING = /^(#{1,6})\s/;
const ITEM = /^([-*+]|\d+[.)])\s/;
const FENCE = /^\s*(```|~~~)/;

/** Top-level blocks of a section's body: a paragraph, a list item with what is indented under it, a code block. */
function blocks(lines: string[]): string[][] {
  const out: string[][] = [];
  let cur: string[] | null = null;
  let fence = false;
  for (const line of lines) {
    if (fence) {
      cur!.push(line);
      if (FENCE.test(line)) fence = false;
      continue;
    }
    if (!line.trim()) {
      if (cur) out.push(cur);
      out.push([line]);
      cur = null;
      continue;
    }
    // Indented lines and a paragraph's next lines belong to the block above; an item or a fence at the margin starts one.
    if (!cur || (!/^\s/.test(line) && (ITEM.test(line) || FENCE.test(line)))) {
      if (cur) out.push(cur);
      cur = [line];
    } else cur.push(line);
    if (FENCE.test(line)) fence = true;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * The server's CLAUDE.md, made from this PC's: the generic rules kept as written, every section and block that names
 * the company or a PC-only service removed, and headings left empty by that removed too.
 */
export function filterClaudeMd(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const kept: string[] = [];
  let skipLevel = 0;
  let body: string[] = [];
  const flush = () => {
    for (const b of blocks(body)) if (!named(b.join('\n'))) kept.push(...b);
    body = [];
  };
  let fence = false;
  for (const line of lines) {
    if (FENCE.test(line)) fence = !fence;
    const h = !fence && HEADING.exec(line);
    if (!h) {
      if (!skipLevel) body.push(line);
      continue;
    }
    const level = h[1].length;
    if (skipLevel && level > skipLevel) continue;
    skipLevel = 0;
    flush();
    if (named(line)) skipLevel = level;
    else kept.push(line);
  }
  flush();
  return dropEmptyHeadings(kept).join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function dropEmptyHeadings(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const h = HEADING.exec(lines[i]);
    if (h) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      const next = j < lines.length ? HEADING.exec(lines[j]) : null;
      // Nothing under it before the next heading of its level or above, or the end: an empty section.
      if (j >= lines.length || (next && next[1].length <= h[1].length)) continue;
    }
    out.push(lines[i]);
  }
  return out;
}

const pluginName = (id: string) => id.split('@')[0];
const marketplaceOf = (id: string) => id.split('@')[1] ?? '';

/** The server's settings.json: SETTINGS_KEPT only, plugins and marketplaces of this PC's programs or company out. */
export function filterSettings(raw: unknown): Record<string, unknown> {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of SETTINGS_KEPT) if (k in s && k !== 'enabledPlugins' && k !== 'extraKnownMarketplaces') out[k] = s[k];
  const plugins: Record<string, boolean> = {};
  for (const [id, on] of Object.entries((s.enabledPlugins ?? {}) as Record<string, unknown>)) {
    if (on === true && !PLUGINS_LOCAL.test(pluginName(id)) && !MARKETPLACES_LOCAL.test(marketplaceOf(id))) plugins[id] = true;
  }
  out.enabledPlugins = plugins;
  const used = new Set(Object.keys(plugins).map(marketplaceOf));
  const markets: Record<string, unknown> = {};
  for (const [name, m] of Object.entries((s.extraKnownMarketplaces ?? {}) as Record<string, { source?: { source?: string } }>)) {
    // A marketplace in a folder of this PC does not exist on the server: only GitHub, git and URL sources travel.
    const kind = m?.source?.source;
    if (used.has(name) && !MARKETPLACES_LOCAL.test(name) && (kind === 'github' || kind === 'git' || kind === 'url')) markets[name] = m;
  }
  if (Object.keys(markets).length) out.extraKnownMarketplaces = markets;
  return out;
}

/** Claude Code's folder name for a project ('C:\\a\\b' → 'C--a-b', '/home/x/r' → '-home-x-r'). */
export function projectKey(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-');
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const file = (path: string, data: Buffer): EnvFile => ({ path, data, sha: sha(data) });

/** Every file under a folder, symbolic links followed (a skill may be a link to elsewhere), NEVER names left out. */
function walk(dir: string, rel: string, out: Array<[string, string]>, depth = 0): void {
  if (depth > 12 || out.length > MAX_FILES) return;
  for (const name of readdirSync(dir)) {
    if (NEVER.test(name)) continue;
    const abs = join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(abs, `${rel}/${name}`, out, depth + 1);
    else if (st.isFile()) out.push([abs, `${rel}/${name}`]);
  }
}

export interface EnvSource {
  /** The home folder whose ~/.claude is read (the user's, or a test's). */
  home?: string;
  /** Local checkout → its clone on the server: their memory is sent, under the server's project name. */
  repos: Record<string, string>;
  /** Literal terms that must not leave this PC (the server's address, ids from the settings). */
  forbid?: string[];
}

/** What would be sent, and what was held back and why. Reads only; nothing leaves this PC here. */
export function collectEnvironment(src: EnvSource): { files: EnvFile[]; skipped: EnvSkip[] } {
  const home = src.home ?? homedir();
  const claude = join(home, '.claude');
  const md = join(claude, 'CLAUDE.md');
  const mdText = existsSync(md) ? readFileSync(md, 'utf8') : null;
  const forbid = [...(src.forbid ?? []), ...(mdText ? knownIds(mdText) : [])];
  const files: EnvFile[] = [];
  const skipped: EnvSkip[] = [];
  let bytes = 0;
  const add = (path: string, data: Buffer, own: boolean) => {
    const leak = findLeak(data.toString('latin1'), forbid, own);
    if (leak) return skipped.push({ path, why: leak });
    bytes += data.length;
    if (bytes > MAX_BYTES || files.length >= MAX_FILES) return skipped.push({ path, why: 'too large' });
    files.push(file(path, data));
  };

  // design-md: the brand library the design-md skill reads, outside the skills folder.
  for (const kind of ['skills', 'agents', 'design-md']) {
    const dir = join(claude, kind);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const rel = `.claude/${kind}/${name}`;
      if (NEVER.test(name) || (kind === 'skills' && SKILLS_LOCAL.test(name)) || COMPANY.test(name)) {
        skipped.push({ path: rel, why: 'local only' });
        continue;
      }
      const found: Array<[string, string]> = [];
      try {
        if (statSync(join(dir, name)).isDirectory()) walk(join(dir, name), rel, found);
        else found.push([join(dir, name), rel]);
      } catch {
        continue;
      }
      // A skill is sent whole or not at all: one file that names the company or holds a secret keeps it all here.
      // Agents are the user's own writing; skills mostly third-party.
      const own = kind === 'agents';
      const read = found.map(([abs, path]) => [path, readFileSync(abs)] as const);
      const bad = read.map(([path, data]) => [path, findLeak(data.toString('latin1'), forbid, own)] as const).find(([, leak]) => leak);
      if (bad) skipped.push({ path: rel, why: `${bad[1]} in ${basename(bad[0])}` });
      else for (const [path, data] of read) add(path, data, own);
    }
  }

  const settingsFile = join(claude, 'settings.json');
  if (existsSync(settingsFile)) {
    try {
      add('.claude/settings.json', Buffer.from(`${JSON.stringify(filterSettings(JSON.parse(readFileSync(settingsFile, 'utf8'))), null, 2)}\n`), true);
    } catch {
      skipped.push({ path: '.claude/settings.json', why: 'unreadable' });
    }
  }
  if (mdText !== null) add('.claude/CLAUDE.md', Buffer.from(serverClaudeMd(mdText)), true);

  for (const [local, remote] of Object.entries(src.repos)) {
    const dir = join(claude, 'projects', projectKey(local), 'memory');
    if (!existsSync(dir)) continue;
    const found: Array<[string, string]> = [];
    walk(dir, `.claude/projects/${projectKey(remote)}/memory`, found);
    for (const [abs, path] of found) add(path, readFileSync(abs), true);
  }
  return { files, skipped };
}

const SERVER_NOTE = '> Version serveur de ce fichier, faite par l’AI Box depuis celui du PC : les parties propres au PC et à l’entreprise en sont retirées. Ici : Linux, utilisateur sans sudo, navigateur sans écran.';

export function serverClaudeMd(text: string): string {
  const filtered = filterClaudeMd(text);
  const lines = filtered.split('\n');
  const at = lines[0]?.startsWith('# ') ? 1 : 0;
  lines.splice(at, 0, ...(at ? ['', SERVER_NOTE] : [SERVER_NOTE, '']));
  return lines.join('\n');
}

export interface SyncPlan {
  put: EnvFile[];
  del: string[];
}

/** What to write and remove on the server, given what it holds from the last sync (path → sha256). */
export function planSync(files: EnvFile[], remote: Record<string, string>): SyncPlan {
  const want = new Set(files.map((f) => f.path));
  return {
    put: files.filter((f) => remote[f.path] !== f.sha),
    del: Object.keys(remote).filter((p) => !want.has(p)),
  };
}

/** One request to the server's envsync.mjs: a JSON header line, then `body`; resolves with its exit code and output. */
export type EnvExec = (header: object, body?: Buffer) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export interface EnvSyncReport {
  sent: number;
  removed: number;
  unchanged: number;
  /** Held back on this PC, and why (company, secret, local only…). Paths, never contents. */
  skipped: EnvSkip[];
}

/** Under launch.mjs's header limit (1 MB), with room: a sync of thousands of files goes in several requests. */
const BATCH = 1500;

function answer(r: Awaited<ReturnType<EnvExec>>, what: string): Record<string, unknown> {
  if (r.code !== 0) throw new Error(`${what}: ${r.stderr.trim().split('\n').pop() || `exit ${r.code}`}`);
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

/** Brings the server's copy of this PC's environment up to date: only what changed travels, PC → server only. */
export async function syncEnvironment(exec: EnvExec, src: EnvSource): Promise<EnvSyncReport> {
  const { files, skipped } = collectEnvironment(src);
  const state = answer(await exec({ op: 'env-state' }), 'server state');
  const plan = planSync(files, (state.files ?? {}) as Record<string, string>);
  const batches: EnvFile[][] = [];
  for (let i = 0; i < plan.put.length; i += BATCH) batches.push(plan.put.slice(i, i + BATCH));
  if (!batches.length && plan.del.length) batches.push([]);
  let removed = 0;
  for (const [i, put] of batches.entries()) {
    // The removals ride with the first request.
    const header = { op: 'env-apply', put: put.map((f) => ({ path: f.path, size: f.data.length, sha: f.sha })), del: i === 0 ? plan.del : [] };
    const out = answer(await exec(header, Buffer.concat(put.map((f) => f.data))), 'server write');
    removed += Number(out.removed) || 0;
  }
  return { sent: plan.put.length, removed, unchanged: files.length - plan.put.length, skipped };
}
