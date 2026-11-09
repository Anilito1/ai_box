// The server's side of the environment sync (src/main/remote/envSync.ts): /opt/aibox/envsync.mjs, owned by root,
// run by launch.mjs for the worker user. Two requests, one JSON line each:
//   {"op":"env-state"}                                   prints {"files":{path:sha256}}: what the last syncs wrote
//                                                        and is still as written;
//   {"op":"env-apply","put":[{path,size,sha}],"del":[]}  then the bytes of each `put` file, one after the other:
//                                                        writes them, removes the `del` ones; prints what it did.
// Only under ~/.claude: CLAUDE.md, settings.json, skills/, agents/, design-md/, projects/<name>/memory/. It removes
// only files it wrote itself (~/.aibox/env-manifest.json), follows no symbolic link, and never sends a file back.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = homedir();
const MANIFEST = join(HOME, '.aibox', 'env-manifest.json');
const CLAUDE = join(HOME, '.local', 'bin', 'claude');
const MAX_FILES = 10000;
const MAX_FILE = 20 * 1024 * 1024;
const MAX_BYTES = 200 * 1024 * 1024;

// The workers' key gives Claude Code, never a shell: nothing synced may make the server run a program by itself.
// settings.json may hold these keys only (no hooks, env, apiKeyHelper, statusLine, credential or OTel helpers...),
// and turn on these plugins only: none with hooks, a local MCP server or a language server, none of the company's.
// The marketplaces are the server's own list: a source sent by the PC is never followed.
export const SETTINGS_KEPT = ['model', 'effortLevel', 'alwaysThinkingEnabled', 'outputStyle', 'language', 'includeCoAuthoredBy', 'enabledPlugins'];
export const SERVER_MARKETPLACES = {
  'claude-plugins-official': 'anthropics/claude-plugins-official',
  'anthropic-agent-skills': 'anthropics/skills',
  hyperframes: 'heygen-com/hyperframes',
};
export const SERVER_PLUGINS = [
  'frontend-design@claude-plugins-official',
  'code-review@claude-plugins-official',
  'feature-dev@claude-plugins-official',
  'pr-review-toolkit@claude-plugins-official',
  'claude-md-management@claude-plugins-official',
  'claude-api@anthropic-agent-skills',
  'document-skills@anthropic-agent-skills',
  'hyperframes@hyperframes',
];

/** Why these settings may not be written on the server, or null. */
export function settingsProblem(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return 'not an object';
  const extra = Object.keys(s).find((k) => !SETTINGS_KEPT.includes(k));
  if (extra) return `key not allowed: ${extra.slice(0, 60)}`;
  const plugins = s.enabledPlugins ?? {};
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return 'bad plugins';
  const bad = Object.entries(plugins).find(([id, on]) => on !== true || !SERVER_PLUGINS.includes(id));
  return bad ? `plugin not allowed: ${String(bad[0]).slice(0, 80)}` : null;
}
export const ALLOWED = /^\.claude\/(CLAUDE\.md|settings\.json|(skills|agents|design-md)\/.+|projects\/[A-Za-z0-9-]{1,200}\/memory\/.+)$/;
const NEVER = /^(\.env(\..*)?|\.wrangler|\.cloudflare-profiles|\.git|\.credentials\.json|credentials(\..*)?|.*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)(\.pub)?)$/i;

const sha = (b) => createHash('sha256').update(b).digest('hex');

/** Why a path may not be written, or null. Relative to the home folder, forward slashes. */
export function badPath(path) {
  if (typeof path !== 'string' || path.length > 1000 || !ALLOWED.test(path)) return 'outside the allowed folders';
  const parts = path.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.includes('\\') || p.includes('\0'))) return 'bad path';
  if (parts.some((p) => NEVER.test(p))) return 'excluded name';
  return null;
}

/** A symbolic link anywhere from ~/.claude down to the file would write outside: refused. */
function throughLink(path) {
  const parts = path.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const p = join(HOME, ...parts.slice(0, i));
    if (!existsSync(p)) return false;
    if (lstatSync(p).isSymbolicLink()) return true;
  }
  return false;
}

function readManifest() {
  try {
    const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
  } catch {
    return {};
  }
}

function writeManifest(m) {
  mkdirSync(dirname(MANIFEST), { recursive: true, mode: 0o700 });
  writeFileSync(`${MANIFEST}.tmp`, JSON.stringify(m), { mode: 0o600 });
  renameSync(`${MANIFEST}.tmp`, MANIFEST);
}

function readBody(rest, total) {
  return new Promise((done, fail) => {
    const chunks = [rest];
    let size = rest.length;
    if (size >= total) return done(Buffer.concat(chunks));
    process.stdin.on('data', (c) => {
      chunks.push(c);
      size += c.length;
      if (size >= total) {
        process.stdin.pause();
        done(Buffer.concat(chunks));
      }
    });
    process.stdin.on('end', () => (size >= total ? done(Buffer.concat(chunks)) : fail(new Error('input cut short'))));
    process.stdin.resume();
  });
}

/** Removes the folders a removal left empty, up to the kind's folder (~/.claude/skills). */
function pruneDirs(path) {
  let dir = dirname(path);
  while (dir.split('/').length > 2) {
    try {
      rmdirSync(join(HOME, dir));
    } catch {
      return;
    }
    dir = dirname(dir);
  }
}

/** A skill's or an agent's front matter that runs programs by itself (hooks, MCP servers): refused like settings. */
export function frontMatterProblem(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const key = m && /^(hooks|mcpServers)\s*:/m.exec(m[1]);
  return key ? `${key[1]} in front matter` : null;
}

/** One at a time: a request the PC gave up on may still run here while the next one comes. */
function lock(name) {
  const file = join(HOME, '.aibox', name);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  for (let i = 0; i < 2; i++) {
    try {
      writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
      process.on('exit', () => {
        try {
          unlinkSync(file);
        } catch {
          // Already gone.
        }
      });
      return true;
    } catch {
      const pid = Number(readFileSync(file, 'utf8'));
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        // Its holder is gone: taken over.
        unlinkSync(file);
      }
    }
  }
  return false;
}

const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) ?? fallback;
  } catch {
    return fallback;
  }
};
const PLUGINS_DIR = join(HOME, '.claude', 'plugins');
const PLUGINS_REPORT = join(HOME, '.aibox', 'plugins.json');

/** The synced settings, if a sync wrote them and they pass the check: the plugins to have. */
function wantedPlugins() {
  if (!Object.hasOwn(readManifest(), '.claude/settings.json')) return [];
  const s = readJson(join(HOME, '.claude', 'settings.json'), null);
  return s && !settingsProblem(s) ? Object.keys(s.enabledPlugins ?? {}) : [];
}

/** What an installed plugin brings that runs programs (hooks, MCP or language servers), or null. */
function pluginProblem(dir) {
  if (typeof dir !== 'string' || !existsSync(dir)) return null;
  for (const f of ['hooks/hooks.json', '.mcp.json', '.lsp.json']) if (existsSync(join(dir, f))) return f;
  const manifest = readJson(join(dir, '.claude-plugin', 'plugin.json'), {});
  return ['hooks', 'mcpServers', 'lspServers'].find((k) => k in manifest) ?? null;
}

/**
 * Installs the wanted plugins it misses, from the server's own marketplaces, by Claude Code's own installer. One that
 * turns out to bring hooks or a server (a later release may) is uninstalled at once. Run in the background (below):
 * a sync never waits for it; its report comes with the next env-state.
 */
function installPlugins() {
  if (!lock('plugins.lock')) return;
  const claude = (args) => spawnSync(CLAUDE, args, { stdio: 'ignore', timeout: 180_000 }).status === 0;
  const report = { at: Date.now(), installed: [], failed: [] };
  const known = readJson(join(PLUGINS_DIR, 'known_marketplaces.json'), {});
  const entryOf = (id) => readJson(join(PLUGINS_DIR, 'installed_plugins.json'), {}).plugins?.[id];
  for (const id of wantedPlugins()) {
    if (!entryOf(id)) {
      const market = id.split('@')[1];
      if (!known[market] && !claude(['plugin', 'marketplace', 'add', SERVER_MARKETPLACES[market]])) {
        report.failed.push({ id, why: 'marketplace' });
        continue;
      }
      known[market] = true;
      if (!claude(['plugin', 'install', id, '--scope', 'user'])) {
        report.failed.push({ id, why: 'install' });
        continue;
      }
    }
    const why = [].concat(entryOf(id) ?? []).map((e) => pluginProblem(e?.installPath)).find(Boolean);
    if (why) {
      claude(['plugin', 'uninstall', id, '--scope', 'user']);
      report.failed.push({ id, why: `runs programs (${why})` });
    } else report.installed.push(id);
  }
  writeFileSync(PLUGINS_REPORT, JSON.stringify(report), { mode: 0o600 });
}

function startPluginInstall() {
  if (!existsSync(CLAUDE) || wantedPlugins().length === 0) return;
  spawn(process.execPath, [fileURLToPath(import.meta.url), '--plugins'], { detached: true, stdio: 'ignore' }).unref();
}

function state() {
  const files = {};
  for (const path of Object.keys(readManifest())) {
    if (badPath(path) || throughLink(path)) continue;
    try {
      files[path] = sha(readFileSync(join(HOME, path)));
    } catch {
      // Gone since: the next apply writes it again.
    }
  }
  const plugins = readJson(PLUGINS_REPORT, null);
  return { files, ...(plugins ? { plugins } : {}) };
}

async function apply(h, rest) {
  if (!lock('envsync.lock')) throw new Error('busy: another sync is running');
  const put = Array.isArray(h.put) ? h.put : [];
  const del = Array.isArray(h.del) ? h.del : [];
  if (put.length + del.length > MAX_FILES) throw new Error('too many files');
  let total = 0;
  for (const f of put) {
    const why = badPath(f?.path) ?? (Number.isInteger(f.size) && f.size >= 0 ? null : 'bad size') ?? (/^[0-9a-f]{64}$/.test(f.sha) ? null : 'bad sha');
    if (why) throw new Error(`${why}: ${String(f?.path).slice(0, 200)}`);
    if (throughLink(f.path)) throw new Error(`symbolic link on the way: ${f.path}`);
    if (f.size > MAX_FILE) throw new Error(`too large: ${f.path}`);
    total += f.size;
  }
  if (total > MAX_BYTES) throw new Error('too large');
  const body = await readBody(rest, total);
  let at = 0;
  const datas = put.map((f) => body.subarray(at, (at += f.size)));
  // All checked before the first write: a damaged transfer, or a file that would run a program, changes nothing.
  put.forEach((f, i) => {
    if (sha(datas[i]) !== f.sha) throw new Error(`damaged on the way: ${f.path}`);
    if (/^\.claude\/(skills|agents)\/.+\.md$/i.test(f.path)) {
      const why = frontMatterProblem(datas[i].toString('utf8'));
      if (why) throw new Error(`${f.path}: ${why}`);
    }
    if (f.path !== '.claude/settings.json') return;
    let parsed;
    try {
      parsed = JSON.parse(datas[i].toString('utf8'));
    } catch {
      throw new Error('settings: not JSON');
    }
    const why = settingsProblem(parsed);
    if (why) throw new Error(`settings: ${why}`);
  });
  const manifest = readManifest();
  let removed = 0;
  // Saved whatever happens: a file written before a failure is still known as ours.
  try {
    for (const [i, f] of put.entries()) {
      const data = datas[i];
      const abs = join(HOME, f.path);
      mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
      // After the links refused above, the real folder must still be ~/.claude's.
      const real = realpathSync(dirname(abs));
      const root = realpathSync(join(HOME, '.claude'));
      if (real !== root && !real.startsWith(root + sep)) throw new Error(`outside ~/.claude: ${f.path}`);
      // A script (a skill's, starting with #!) stays runnable; Windows has no such bit to send.
      writeFileSync(`${abs}.aibox-tmp`, data, { mode: data.subarray(0, 2).toString() === '#!' ? 0o700 : 0o600 });
      renameSync(`${abs}.aibox-tmp`, abs);
      manifest[f.path] = f.sha;
    }
    for (const path of del) {
      // Only what a sync wrote: what the server's Claude Code or its user made stays.
      if (typeof path !== 'string' || !Object.hasOwn(manifest, path) || badPath(path) || throughLink(path)) continue;
      try {
        unlinkSync(join(HOME, path));
        removed++;
      } catch {
        // Already gone.
      }
      delete manifest[path];
      pruneDirs(path);
    }
  } finally {
    writeManifest(manifest);
  }
  // At each sync: a plugin that failed to install is tried again.
  startPluginInstall();
  return { written: put.length, removed };
}

export async function run(header, rest, log = () => {}) {
  try {
    const out = header.op === 'env-state' ? state() : await apply(header, rest);
    log(`${header.op} ${'files' in out ? `${Object.keys(out.files).length} files` : `wrote ${out.written}, removed ${out.removed}`}`);
    process.stdout.write(`${JSON.stringify(out)}\n`, () => process.exit(0));
  } catch (err) {
    log(`${header.op} refused: ${err.message}`);
    process.stderr.write(`aibox envsync: ${err.message}\n`);
    process.exit(2);
  }
}

// Started by startPluginInstall, detached: it outlives the request and its SSH connection.
if (process.argv[2] === '--plugins' && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) installPlugins();
