import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  draftError,
  draftJson,
  GITHUB_URL,
  mcpReach,
  parseMcpGet,
  parseMcpList,
  PLUGIN_ID,
  SKILL_NAME,
  maskTarget,
  targetOf,
  transportOf,
  type Capabilities,
  type CapResult,
  type McpDraft,
  type McpEntry,
  type McpSource,
  type McpState,
  type PluginEntry,
  type SkillEntry,
} from '../shared/capabilities';
import { parseAgentFile } from '../shared/team';
import { masterCwd, type HubConfig } from './config';
import { findRepos } from './repos';

// What Claude Code has installed for the user's own account: MCP servers (~/.claude.json, the repos' .mcp.json,
// plugins, claude.ai connectors) and skills (~/.claude/skills, the repos', plugins'). Files are read for the list,
// Claude Code itself (`claude mcp list`) says each server's state, adds and removes servers. Every program runs from an
// argument list, never a shell.

const HOME = homedir();
const CLAUDE_DIR = join(HOME, '.claude');
const DIRS = {
  skills: join(CLAUDE_DIR, 'skills'),
  skillsOff: join(CLAUDE_DIR, 'skills-disabled'),
};
const SETTINGS = join(CLAUDE_DIR, 'settings.json');
const LIST_MS = 120_000;
const GET_MS = 60_000;
const INSTALL_MS = 5 * 60_000;
const FILE_BYTES_MAX = 256 * 1024;
const SKILL_BYTES_MAX = 100 * 1024;
const PER_DIR_MAX = 300;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

function readJson(path: string): Obj | null {
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size > 64 * 1024 * 1024) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
    return isObj(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** ~/.claude.json keys its projects by path with forward slashes; Windows paths compare without case. */
const pathKey = (p: string) => {
  const k = resolve(p).replace(/\\/g, '/');
  return process.platform === 'win32' ? k.toLowerCase() : k;
};
const samePath = (a: string, b: string) => pathKey(a) === pathKey(b);

/** `path` is `root` or inside it: a plugin's manifest may not point out of its folder. */
const under = (root: string, path: string) => {
  const r = relative(resolve(root), resolve(path));
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};

const listDir = (dir: string) => {
  try {
    return readdirSync(dir).slice(0, PER_DIR_MAX);
  } catch {
    return [];
  }
};

/** A SKILL.md read for its name and description; null when absent, too big or unreadable. */
function frontmatter(file: string): { name: string; description: string } | null {
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.size > FILE_BYTES_MAX) return null;
    const fields = parseAgentFile(readFileSync(file, 'utf8'))?.fields ?? {};
    return { name: fields.name ?? '', description: fields.description ?? '' };
  } catch {
    return null;
  }
}

/** Skill folders of a place: each child holding a SKILL.md. */
function skillsIn(dir: string): { dir: string; name: string; description: string }[] {
  const found = [];
  for (const name of listDir(dir)) {
    const meta = frontmatter(join(dir, name, 'SKILL.md'));
    if (meta) found.push({ dir: name, name: meta.name || name, description: meta.description });
  }
  return found;
}

function serversOf(json: Obj | null): [string, Obj][] {
  if (!json) return [];
  const servers = isObj(json.mcpServers) ? json.mcpServers : json;
  return Object.entries(servers).filter((e): e is [string, Obj] => isObj(e[1]) && (isStr(e[1].command) || isStr(e[1].url)));
}

function entry(name: string, cfg: Obj, source: McpSource, extra: Partial<McpEntry> = {}): McpEntry {
  return {
    name,
    source,
    transport: transportOf(cfg),
    target: targetOf(cfg),
    project: '',
    plugin: '',
    state: 'unknown',
    reach: 'everywhere',
    ...extra,
  };
}

interface Plugin {
  id: string;
  name: string;
  path: string;
  enabled: boolean;
}

function plugins(): Plugin[] {
  const installed = readJson(join(CLAUDE_DIR, 'plugins', 'installed_plugins.json'));
  const enabled = readJson(SETTINGS)?.enabledPlugins;
  const list = isObj(installed?.plugins) ? installed.plugins : {};
  return Object.entries(list).flatMap(([id, raw]) => {
    const installs = (Array.isArray(raw) ? raw : [raw]).filter(isObj);
    const path = installs.map((i) => i.installPath).find(isStr);
    if (!path || !PLUGIN_ID.test(id)) return [];
    return [{ id, name: id.split('@')[0], path, enabled: isObj(enabled) && enabled[id] === true }];
  });
}

/** A plugin's skills: the folders its plugin.json or marketplace entry names, else its skills/ folder. */
function pluginSkills(p: Plugin): ReturnType<typeof skillsIn> {
  const manifest = readJson(join(p.path, '.claude-plugin', 'plugin.json'));
  const market = readJson(join(p.path, '.claude-plugin', 'marketplace.json'));
  const listed = Array.isArray(market?.plugins) ? market.plugins.filter(isObj).find((e) => e.name === p.name)?.skills : undefined;
  const named = manifest?.skills ?? listed;
  const paths = (Array.isArray(named) ? named : [named]).filter(isStr);
  const dirs = paths.map((rel) => resolve(p.path, rel)).filter((abs) => under(p.path, abs));
  if (dirs.length === 0) return skillsIn(join(p.path, 'skills'));
  return dirs.flatMap((dir) => {
    const own = frontmatter(join(dir, 'SKILL.md'));
    if (!own) return skillsIn(dir);
    const name = dir.split(/[\\/]/).pop() ?? dir;
    return [{ dir: name, name: own.name || name, description: own.description }];
  });
}

function pluginServers(p: Plugin): [string, Obj][] {
  const manifest = readJson(join(p.path, '.claude-plugin', 'plugin.json'));
  const declared = manifest?.mcpServers;
  if (isObj(declared)) return serversOf({ mcpServers: declared });
  const file = isStr(declared) ? resolve(p.path, declared) : join(p.path, '.mcp.json');
  return under(p.path, file) ? serversOf(readJson(file)) : [];
}

function run(exe: string, args: string[], cwd: string, env: Record<string, string>, timeout: number): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    execFile(exe, args, { cwd, env, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : -1) : 0;
      done({ code, out: `${stdout}${stderr}`.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '') });
    });
  });
}

/** What a failed command printed, without the values the user typed (an env value, a header) and kept short. */
function scrub(out: string, secrets: string[]): string {
  let text = out;
  for (const s of secrets) if (s.length >= 4) text = text.split(s).join('•••');
  return text.trim().slice(-2000);
}

export interface CapabilityDeps {
  cfg: HubConfig;
  /** Claude Code's executable; empty when none was found. */
  executable(): string;
  /** Environment of a Claude Code process on the user's own account. */
  env(): Record<string, string>;
  /** The same without any access or sign-in added: for npx. */
  toolEnv(): Record<string, string>;
}

export class CapabilityStore {
  /** State of each server by name, from `claude mcp list` in the master's folder. */
  private states = new Map<string, McpState>();
  /** Servers only Claude Code knows of (claude.ai connectors, managed ones): name and masked URL. */
  private listed: { name: string; target: string; state: McpState }[] = [];
  /** State of a repo's own server: key `repo path key\nname`. */
  private repoStates = new Map<string, McpState>();
  private checkedAt = 0;
  /** A failed check is not run again on every call either. */
  private triedAt = 0;
  private checkError = '';
  private checking: Promise<void> | null = null;
  private added = false;

  constructor(private readonly deps: CapabilityDeps) {}

  /** Repos whose own servers and skills are listed: the followed ones, the master's folder and those under the working folders. */
  private repos(): string[] {
    const { cfg } = this.deps;
    const all = [masterCwd(cfg), ...cfg.mainRepos, ...cfg.workspaces.flatMap((w) => findRepos(w).filter((r) => !r.worktreeOf).map((r) => r.path))];
    const seen = new Set<string>();
    return all.filter((p) => !seen.has(pathKey(p)) && seen.add(pathKey(p)));
  }

  /** The list, from the files, with the states of the last check. Fast: no program is run. */
  inventory(): Capabilities {
    const { cfg } = this.deps;
    const home = readJson(join(HOME, '.claude.json'));
    const projects = isObj(home?.projects) ? home.projects : {};
    const projectOf = (repo: string): Obj => {
      const key = Object.keys(projects).find((k) => samePath(k, repo));
      const p = key ? projects[key] : null;
      return isObj(p) ? p : {};
    };
    const master = masterCwd(cfg);
    const mcp: McpEntry[] = [];
    const known = new Set<string>();
    const stateIn = (name: string, repo: string) =>
      (samePath(repo, master) ? this.states.get(name) : this.repoStates.get(`${pathKey(repo)}\n${name}`)) ?? 'unknown';

    for (const [name, c] of serversOf(isObj(home?.mcpServers) ? { mcpServers: home.mcpServers } : null)) {
      mcp.push(entry(name, c, 'user', { state: this.states.get(name) ?? 'unknown', reach: mcpReach('user', name, true) }));
      known.add(name);
    }
    const repos = this.repos();
    for (const [key, raw] of Object.entries(projects)) {
      if (!isObj(raw) || !isObj(raw.mcpServers)) continue;
      for (const [name, c] of serversOf({ mcpServers: raw.mcpServers })) {
        mcp.push(entry(name, c, 'local', { project: key, state: stateIn(name, key), reach: 'repo' }));
        if (samePath(key, master)) known.add(name);
      }
    }
    for (const repo of repos) {
      const off = projectOf(repo).disabledMcpjsonServers;
      for (const [name, c] of serversOf(readJson(join(repo, '.mcp.json')))) {
        const disabled = Array.isArray(off) && off.includes(name);
        mcp.push(entry(name, c, 'project', { project: repo, state: disabled ? 'disabled' : stateIn(name, repo), reach: disabled ? 'nowhere' : 'repo' }));
        if (samePath(repo, master)) known.add(name);
      }
    }

    const skills: SkillEntry[] = [];
    const pluginRows: PluginEntry[] = [];
    for (const p of plugins()) {
      const servers = pluginServers(p);
      for (const [server, c] of servers) {
        const name = `plugin:${p.name}:${server}`;
        known.add(name);
        mcp.push(entry(name, c, 'plugin', { plugin: p.id, state: p.enabled ? (this.states.get(name) ?? 'unknown') : 'disabled', reach: mcpReach('plugin', name, p.enabled) }));
      }
      const own = pluginSkills(p);
      for (const s of own) {
        skills.push({ name: `${p.name}:${s.name}`, dir: s.dir, description: s.description, source: 'plugin', project: '', plugin: p.id, reach: p.enabled ? 'everywhere' : 'nowhere' });
      }
      pluginRows.push({ id: p.id, name: p.name, enabled: p.enabled, skills: own.length, mcp: servers.length });
    }
    for (const row of this.listed) {
      if (known.has(row.name)) continue;
      const source: McpSource = row.name.startsWith('claude.ai ') ? 'claude.ai' : 'other';
      mcp.push(entry(row.name, {}, source, { target: row.target, state: row.state, reach: mcpReach(source, row.name, true) }));
    }

    const add = (source: SkillEntry['source'], dir: string, project = '') => {
      const reach = source === 'disabled' ? 'nowhere' : source === 'project' ? 'repo' : 'everywhere';
      for (const s of skillsIn(dir)) skills.push({ name: s.name, dir: s.dir, description: s.description, source, project, plugin: '', reach });
    };
    add('user', DIRS.skills);
    add('disabled', DIRS.skillsOff);
    for (const repo of repos) add('project', join(repo, '.claude', 'skills'), repo);

    return { mcp, skills, plugins: pluginRows, repos: [...cfg.mainRepos], checkedAt: this.checkedAt, checkError: this.checkError };
  }

  /**
   * Asks Claude Code for each server's state (it starts or calls each one: some seconds). One check at a time; a
   * server added during a check gets a fresh one after it.
   */
  check(): Promise<void> {
    if (this.checking) return this.added ? this.checking.then(() => this.check()) : this.checking;
    this.added = false;
    this.checking = this.runCheck().finally(() => (this.checking = null));
    return this.checking;
  }

  /** The inventory, checked first when the last check is older than `maxAge`. */
  async fresh(maxAge: number): Promise<Capabilities> {
    if (Date.now() - Math.max(this.checkedAt, this.triedAt) > maxAge) await this.check();
    return this.inventory();
  }

  private async runCheck(): Promise<void> {
    this.triedAt = Date.now();
    const exe = this.deps.executable();
    if (!exe) {
      this.checkError = 'no-claude';
      return;
    }
    const env = this.deps.env();
    const master = masterCwd(this.deps.cfg);
    const r = await run(exe, ['mcp', 'list'], master, env, LIST_MS);
    const rows = parseMcpList(r.out);
    if (r.code !== 0 && rows.length === 0) {
      this.checkError = 'failed';
      return;
    }
    this.states = new Map(rows.map((row) => [row.name, row.state]));
    this.listed = rows.map((row) => ({ ...row, target: maskTarget(row.target) }));
    // A repo's own servers outside the master's folder: one `claude mcp get` each, in that repo, a few at a time.
    const others = this.inventory().mcp.filter((m) => (m.source === 'project' || m.source === 'local') && m.state !== 'disabled' && !samePath(m.project, master) && existsSync(m.project));
    const states = new Map<string, McpState>();
    for (let i = 0; i < others.length; i += 4) {
      await Promise.all(
        others.slice(i, i + 4).map(async (m) => {
          if (m.name.startsWith('-')) return;
          const got = await run(exe, ['mcp', 'get', m.name], m.project, env, GET_MS);
          states.set(`${pathKey(m.project)}\n${m.name}`, parseMcpGet(got.out));
        }),
      );
    }
    this.repoStates = states;
    this.checkedAt = Date.now();
    this.checkError = '';
  }

  private result(error = '', detail = ''): CapResult {
    return { ...this.inventory(), ok: error === '', error, detail };
  }

  async addMcp(raw: unknown): Promise<CapResult> {
    const d = parseDraft(raw);
    if (!d) return this.result('format');
    const bad = draftError(d, this.deps.cfg.mainRepos);
    if (bad) return this.result(bad);
    const exe = this.deps.executable();
    if (!exe) return this.result('no-claude');
    const cwd = d.scope === 'project' ? d.project : masterCwd(this.deps.cfg);
    const r = await run(exe, ['mcp', 'add-json', '-s', d.scope, d.name, draftJson(d)], cwd, this.deps.env(), GET_MS);
    if (r.code !== 0) return this.result('cli', scrub(r.out, [...Object.values(d.env), ...Object.values(d.headers), d.url, ...d.args]));
    this.added = true;
    void this.check();
    return this.result();
  }

  /** Only a server of the user's, a repo's .mcp.json or a repo's private list: plugins and claude.ai are managed elsewhere. */
  async removeMcp(name: unknown, source: unknown, project: unknown): Promise<CapResult> {
    const m = this.inventory().mcp.find((e) => e.name === name && e.source === source && (e.source === 'user' || (isStr(project) && samePath(e.project, project))));
    if (!m || !['user', 'project', 'local'].includes(m.source) || m.name.startsWith('-')) return this.result('missing');
    const exe = this.deps.executable();
    if (!exe) return this.result('no-claude');
    const cwd = m.source === 'user' ? masterCwd(this.deps.cfg) : m.project;
    if (!existsSync(cwd)) return this.result('missing');
    const r = await run(exe, ['mcp', 'remove', m.name, '-s', m.source], cwd, this.deps.env(), GET_MS);
    if (r.code !== 0) return this.result('cli', scrub(r.out, []));
    this.states.delete(m.name);
    this.listed = this.listed.filter((row) => row.name !== m.name);
    return this.result();
  }

  /** Disables (to ~/.claude/skills-disabled, reversible) or enables back a skill of the user's. */
  moveSkill(dir: unknown, enable: unknown): CapResult {
    if (typeof enable !== 'boolean') return this.result('format');
    const [from, to] = enable ? [DIRS.skillsOff, DIRS.skills] : [DIRS.skills, DIRS.skillsOff];
    const src = within(from, dir);
    const dest = within(to, dir);
    if (!src || !dest) return this.result('format');
    if (!exists(src)) return this.result('missing');
    if (exists(dest)) return this.result('exists');
    try {
      mkdirSync(to, { recursive: true });
      renameSync(src, dest);
    } catch (err) {
      return this.result('fs', err instanceof Error ? err.message : String(err));
    }
    return this.result();
  }

  /** Deletes a skill of the user's for good, active or disabled. */
  deleteSkill(dir: unknown, disabled: unknown): CapResult {
    if (typeof disabled !== 'boolean') return this.result('format');
    const path = within(disabled ? DIRS.skillsOff : DIRS.skills, dir);
    if (!path) return this.result('format');
    if (!exists(path)) return this.result('missing');
    try {
      // A link (an install that links its copy) goes, never what it points to.
      rmSync(path, { recursive: !lstatSync(path).isSymbolicLink(), force: false });
    } catch (err) {
      return this.result('fs', err instanceof Error ? err.message : String(err));
    }
    return this.result();
  }

  /**
   * A pasted SKILL.md becomes ~/.claude/skills/<name>/SKILL.md. Its header needs a description, and its own name, if
   * it gives one, must be this one; a name already taken (active or disabled) is refused.
   */
  pasteSkill(name: unknown, text: unknown): CapResult {
    if (!isStr(text) || Buffer.byteLength(text) > SKILL_BYTES_MAX || !isStr(name)) return this.result('format');
    const fields = parseAgentFile(text)?.fields;
    if (!SKILL_NAME.test(name)) return this.result('skill-name');
    if (!fields?.description || (fields.name && fields.name !== name)) return this.result('skill-format');
    const dest = within(DIRS.skills, name);
    const off = within(DIRS.skillsOff, name);
    if (!dest || !off) return this.result('skill-name');
    if (exists(dest) || exists(off)) return this.result('exists');
    try {
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, 'SKILL.md'), text, { flag: 'wx' });
    } catch (err) {
      rmSync(dest, { recursive: true, force: true });
      return this.result('fs', err instanceof Error ? err.message : String(err));
    }
    return this.result();
  }

  /** `npx skills add <repo> --skill <name>`, for the user (global), copied into ~/.claude/skills. */
  async githubSkill(url: unknown, skill: unknown): Promise<CapResult> {
    if (!isStr(url) || !GITHUB_URL.test(url) || !isStr(skill) || !SKILL_NAME.test(skill)) return this.result('format');
    const dest = within(DIRS.skills, skill);
    if (!dest) return this.result('format');
    if (exists(dest) || exists(within(DIRS.skillsOff, skill) || dest)) return this.result('exists');
    const env = this.deps.toolEnv();
    const npx = await npxCli(env);
    if (!npx) return this.result('no-node');
    const r = await run(npx.node, [npx.cli, '--yes', 'skills', 'add', url, '--skill', skill, '--global', '--agent', 'claude-code', '--yes', '--copy'], HOME, env, INSTALL_MS);
    if (r.code !== 0 || !existsSync(join(dest, 'SKILL.md'))) return this.result('install', scrub(r.out, []));
    return this.result();
  }

  /** Turns a plugin on or off in ~/.claude/settings.json, every other setting kept as it was. */
  setPlugin(id: unknown, on: unknown): CapResult {
    if (!isStr(id) || !PLUGIN_ID.test(id) || typeof on !== 'boolean' || !plugins().some((p) => p.id === id)) return this.result('format');
    let settings: Obj;
    try {
      const parsed: unknown = JSON.parse(readFileSync(SETTINGS, 'utf8').replace(/^﻿/, ''));
      if (!isObj(parsed)) return this.result('settings');
      settings = parsed;
    } catch (err) {
      // An unreadable file is never overwritten.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return this.result('settings');
      settings = {};
    }
    settings.enabledPlugins = { ...(isObj(settings.enabledPlugins) ? settings.enabledPlugins : {}), [id]: on };
    try {
      writeAtomic(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
    } catch (err) {
      return this.result('fs', err instanceof Error ? err.message : String(err));
    }
    return this.result();
  }
}

/** `base/<name>`, only when the name is a plain one and the path stays right inside `base`. */
function within(base: string, name: unknown): string {
  if (!isStr(name) || !SKILL_NAME.test(name) || name.includes('..')) return '';
  const path = resolve(base, name);
  return dirname(path) === resolve(base) ? path : '';
}

const exists = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** Written beside, then renamed over: a reader never sees half a file, a failed write leaves the old one. */
function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, text, { flag: 'wx' });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** The user's Node.js and its npx script (npx's own .cmd needs a shell on Windows). */
async function npxCli(env: Record<string, string>): Promise<{ node: string; cli: string } | null> {
  const r = await run('node', ['-p', 'process.execPath'], HOME, env, 15_000);
  const node = r.code === 0 ? r.out.trim().split(/\r?\n/)[0] : '';
  if (!node) return null;
  const dir = dirname(node);
  const cli = process.platform === 'win32' ? join(dir, 'node_modules', 'npm', 'bin', 'npx-cli.js') : join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js');
  return existsSync(cli) ? { node, cli } : null;
}

function parseDraft(raw: unknown): McpDraft | null {
  if (!isObj(raw)) return null;
  const strMap = (v: unknown): Record<string, string> | null =>
    isObj(v) && Object.values(v).every(isStr) && Object.keys(v).length <= 50 ? (v as Record<string, string>) : null;
  const env = strMap(raw.env);
  const headers = strMap(raw.headers);
  const args = Array.isArray(raw.args) && raw.args.length <= 100 && raw.args.every(isStr) ? raw.args : null;
  const fields = [raw.name, raw.scope, raw.project, raw.transport, raw.command, raw.url];
  if (!env || !headers || !args || !fields.every((f) => isStr(f) && f.length <= 2000)) return null;
  return {
    name: raw.name as string,
    scope: raw.scope as McpDraft['scope'],
    project: raw.project as string,
    transport: raw.transport as McpDraft['transport'],
    command: raw.command as string,
    args,
    url: raw.url as string,
    env,
    headers,
  };
}
