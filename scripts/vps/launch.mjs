#!/usr/bin/env node
// The only program the AI Box's SSH key may run on the server: /opt/aibox/launch.mjs, owned by root (setup.sh).
// It reads one JSON line, then does one of:
//   {"op":"launch","cwd":"/home/aibox/repos/x","args":[...],"env":{...},"notify":{...},"texts":{...},"since":N}
//        joins the conversation's Claude Code on the runner (runner.mjs), started there first if it does not run; the
//        rest of stdin is its input, its output goes back. The hub leaving (PC off, network cut) ends this connection
//        only: the session goes on on the runner, which keeps what the hub missed for the next launch;
//   {"op":"transcript","id":"<uuid>"}   prints a conversation's transcript (exit 3: none);
//   {"op":"status"}                     this launcher's version, Claude Code's, signed in or not, memory, the runner;
//   {"op":"session","id":"<uuid>"}      where that conversation stands on the runner;
//   {"op":"stop","id":"<uuid>"}         ends it;
//   {"op":"prepare","slug":"Owner/name","branch":"b"}   fetches the branch and gives it its own worktree in ~/repos;
//   {"op":"head","cwd":"…","check":true} the branch a folder of ~/repos is on (check: committed and pushed?);
//   {"op":"echo"}                       sends each input line back (the hub measures the round trip of an event).
// Nothing else: no shell, no other program than claude and git, no folder outside ~/repos. Each request is logged in
// ~/.aibox/launch.log (what, where, exit code; never the variables nor the content).
// Exit codes the hub reads: 2 refused, 3 no transcript, 5 the runner does not answer, 6 the server is full, 7 it stops.
import { spawnSync } from 'node:child_process';
import { appendFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { connect } from 'node:net';
import { freemem, homedir, totalmem } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const VERSION = 5;
const HOME = homedir();
const REPOS = join(HOME, 'repos');
const CLAUDE = join(HOME, '.local', 'bin', 'claude');
const STATE = join(HOME, '.aibox');
const SOCKET = join(STATE, 'runner.sock');
const LOG = join(STATE, 'launch.log');
const HEADER_MAX = 1024 * 1024;
const SESSION_ID = /^[0-9a-f-]{36}$/i;
const SAFE_ENV = (k, v) =>
  /^(CLAUDE_CODE_|CLAUDE_AGENT_SDK_)/.test(k) && !/TOKEN|KEY|SECRET|PASSWORD|CONFIG_DIR|SHELL|HELPER|_PATH$|_DIR$/.test(k) && typeof v === 'string';
/** The repos the user listed (root's file, written by the AI Box's setup): "owner/name" per line. */
const listed = () => {
  try {
    return readFileSync('/etc/aibox/repos', 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^[\w.-]+\/[\w.-]+$/.test(l));
  } catch {
    return [];
  }
};

const log = (text) => {
  try {
    appendFileSync(LOG, `${new Date().toISOString()} ${text}\n`);
  } catch {
    // A full disk must not stop the session.
  }
};
const refuse = (why) => {
  log(`refused: ${why}`);
  process.stderr.write(`aibox launcher: ${why}\n`);
  process.exit(2);
};
const answer = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

function readHeader() {
  return new Promise((done) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(10);
      if (nl < 0) {
        if (buf.length > HEADER_MAX) refuse('header too long');
        return;
      }
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.pause();
      done({ line: buf.subarray(0, nl).toString('utf8'), rest: buf.subarray(nl + 1) });
    };
    const onEnd = () => refuse('no header');
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
  });
}

// ---------- the runner ----------

/** The conversation Claude Code is asked to run: `--resume <id>` or `--session-id <id>`, the SDK writes `--flag=<id>`. */
const conversationOf = (args) => {
  for (let i = 0; i < args.length; i++) {
    const m = /^--(?:resume|session-id)(?:=(.*))?$/.exec(args[i]);
    if (!m) continue;
    const id = m[1] ?? args[i + 1] ?? '';
    return SESSION_ID.test(id) ? id : '';
  }
  return '';
};

/** One question to the runner: its answer, or null when it does not answer. */
function askRunner(o) {
  return new Promise((done) => {
    const sock = connect(SOCKET);
    let out = '';
    const timer = setTimeout(() => sock.destroy(), 60_000);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(`${JSON.stringify(o)}\n`));
    sock.on('data', (t) => (out += t));
    sock.on('error', () => {});
    sock.on('close', () => {
      clearTimeout(timer);
      try {
        done(JSON.parse(out.trim().split('\n').pop() ?? ''));
      } catch {
        done(null);
      }
    });
  });
}

// ---------- ops ----------

function transcript(id) {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) refuse('bad id');
  const projects = join(HOME, '.claude', 'projects');
  const dirs = existsSync(projects) ? readdirSync(projects) : [];
  const file = dirs.map((d) => join(projects, d, `${id}.jsonl`)).find((f) => existsSync(f));
  log(`transcript ${id} ${file ? 'found' : 'none'}`);
  if (!file) process.exit(3);
  createReadStream(file).pipe(process.stdout);
}

async function status() {
  const v = spawnSync(CLAUDE, ['--version'], { encoding: 'utf8', timeout: 30_000 });
  const a = spawnSync(CLAUDE, ['auth', 'status', '--json'], { encoding: 'utf8', timeout: 30_000 });
  let signedIn = false;
  try {
    // Only whether it is signed in: the account's address stays here.
    signedIn = JSON.parse(a.stdout).loggedIn === true;
  } catch {
    signedIn = false;
  }
  let available = freemem();
  try {
    available = Number(/MemAvailable:\s+(\d+)/.exec(readFileSync('/proc/meminfo', 'utf8'))?.[1] ?? 0) * 1024 || available;
  } catch {
    // Not Linux: what the system says is free.
  }
  const r = await askRunner({ op: 'status' });
  // Where each conversation stands: ids and counts only, never a word of it.
  const runner = r && { version: r.version, max: r.max, live: r.live, rssMb: r.rssMb, sessions: (r.sessions ?? []).slice(0, 100).map((x) => ({ id: x.id, live: x.live, state: x.state, tasks: x.tasks, waiting: x.waiting, outbox: x.outbox, attached: x.attached })) };
  answer({ version: VERSION, claude: (v.stdout ?? '').trim().slice(0, 80), signedIn, memory: { total: Math.round(totalmem() / 2 ** 20), available: Math.round(available / 2 ** 20) }, running: r?.live ?? 0, runner });
}

/**
 * The tokens the hub gives for this request (GH_TOKEN…), checked: known names, one printable line each. Kept in memory
 * for the processes of this request, never written, never logged.
 */
const SECRET_NAMES = ['GH_TOKEN', 'SUPABASE_ACCESS_TOKEN', 'CLOUDFLARE_API_TOKEN', 'NPM_TOKEN', 'VERCEL_TOKEN'];
let secrets = {};
const takeSecrets = (raw) => {
  secrets = {};
  for (const [k, v] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    if (SECRET_NAMES.includes(k) && typeof v === 'string' && /^[\x21-\x7e]{8,4096}$/.test(v)) secrets[k] = v;
  }
};
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120_000, env: { ...process.env, ...secrets, GIT_TERMINAL_PROMPT: '0' } });
const isBranch = (b) => typeof b === 'string' && /^[\w][\w./-]{0,199}$/.test(b) && !b.includes('..') && !b.endsWith('.lock') && !b.endsWith('/') && !b.includes('//');

function inRepos(path) {
  let real;
  try {
    real = realpathSync(String(path));
  } catch {
    refuse('no such folder');
  }
  if (!real.startsWith(`${REPOS}/`)) refuse('folder outside ~/repos');
  return real;
}

function prepare(slug, branch) {
  if (!listed().includes(slug)) refuse('repo not listed');
  if (!isBranch(branch)) refuse('bad branch');
  const clone = join(REPOS, slug.split('/')[1]);
  if (!existsSync(join(clone, '.git'))) refuse('no clone of this repo: run the repos step of the setup');
  const fetched = git(clone, ['fetch', '--prune', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  if (fetched.status !== 0) refuse(`fetch failed: ${(fetched.stderr ?? '').trim().split('\n').pop()}`);
  // "+" never appears in a branch name: one folder per branch, never two branches in one.
  const tree = join(REPOS, `${slug.split('/')[1]}.wt`, branch.replace(/\//g, '+'));
  if (existsSync(tree)) {
    if (git(tree, ['symbolic-ref', '-q', '--short', 'HEAD']).stdout.trim() !== branch) refuse('the server copy of this branch is on another branch');
    const dirty = git(tree, ['status', '--porcelain']).stdout.trim();
    // Work of an earlier stay that never reached GitHub: kept, never overwritten.
    if (dirty) refuse('the server copy of this branch has changes that were not pushed');
    const ff = git(tree, ['merge', '--ff-only', `origin/${branch}`]);
    if (ff.status !== 0) refuse('the server copy of this branch has commits that were not pushed');
  } else {
    const local = git(clone, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
    // The clone itself sits on its default branch: it lets the worktree have it (no work is ever done in the clone).
    if (local && git(clone, ['symbolic-ref', '-q', '--short', 'HEAD']).stdout.trim() === branch) git(clone, ['checkout', '-q', '--detach']);
    const add = local ? git(clone, ['worktree', 'add', tree, branch]) : git(clone, ['worktree', 'add', '--track', '-b', branch, tree, `origin/${branch}`]);
    if (add.status !== 0) refuse(`worktree failed: ${(add.stderr ?? '').trim().split('\n').pop()}`);
    if (local && git(tree, ['merge', '--ff-only', `origin/${branch}`]).status !== 0) refuse('the server copy of this branch has commits that were not pushed');
  }
  const head = git(tree, ['rev-parse', 'HEAD']).stdout.trim();
  log(`prepare ${slug} ${branch} ${head.slice(0, 12)}`);
  answer({ cwd: tree, head });
}

/** The branch a folder is on; with `check`, after a fetch, whether all of it is committed and on GitHub. */
function head(cwd, check) {
  const dir = inRepos(cwd);
  if (!repoOfFolder(dir)) refuse('folder of a repo that is not listed');
  const b = git(dir, ['symbolic-ref', '-q', '--short', 'HEAD']);
  const branch = b.status === 0 ? b.stdout.trim() : '';
  if (!check) return answer({ branch });
  if (branch) git(dir, ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  const commit = git(dir, ['rev-parse', 'HEAD']).stdout.trim();
  const upstream = branch ? git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]).stdout.trim() : '';
  const status = git(dir, ['status', '--porcelain']);
  answer({ branch, head: commit, clean: status.status === 0 && status.stdout.trim() === '', pushed: !!commit && commit === upstream });
}

/** `rest`: what came with the header line, already read. */
function echo(rest) {
  if (rest.length > 0) process.stdin.unshift(rest);
  createInterface({ input: process.stdin }).on('line', (line) => process.stdout.write(`${line.slice(0, 200)}\n`));
  process.stdin.resume();
}

/** The listed repo a folder of ~/repos belongs to (its clone or one of its worktrees), else ''. */
function repoOfFolder(dir) {
  const top = dir.slice(REPOS.length + 1).split('/')[0].replace(/\.wt$/, '');
  return listed().find((s) => s.split('/')[1] === top) ?? '';
}

/**
 * Claude Code flags that would run a program, or read a file, of the caller's choosing: the hub never sends them, so a
 * request that does is refused (the workers' key gives Claude Code, not a shell).
 */
const PROGRAM_SETTINGS = ['hooks', 'env', 'apiKeyHelper', 'statusLine', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper', 'fileSuggestion', 'enabledPlugins', 'extraKnownMarketplaces'];
const parsed = (value) => {
  try {
    const o = JSON.parse(value);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
};
/** Settings given inline, as the SDK does, and none that runs a program: a file path, or one of those keys, is refused. */
const badSettings = (value) => {
  const o = parsed(value);
  return !o || Object.keys(o).some((k) => PROGRAM_SETTINGS.includes(k));
};
const badMcp = (value) => {
  const o = parsed(value);
  return !o || !Object.values(o.mcpServers ?? {}).every((s) => s && s.type === 'sdk');
};
const outside = (value) => {
  try {
    return !realpathSync(value).startsWith(`${REPOS}/`);
  } catch {
    return true;
  }
};

function unsafeArg(args) {
  // Flags only, as the SDK writes them: no subcommand (mcp add, plugin install, config…) before them.
  if (args.length > 0 && !args[0].startsWith('--')) return args[0].slice(0, 40);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    const flag = eq > 0 ? a.slice(0, eq) : a;
    // Every value up to the next flag: --mcp-config and --add-dir take several, each one is looked at.
    const values = eq > 0 ? [a.slice(eq + 1)] : [];
    for (let j = i + 1; eq < 0 && j < args.length && !args[j].startsWith('--'); j++) values.push(args[j]);
    if (['--plugin-dir', '--debug-file', '--settings-file', '--ide'].includes(flag)) return flag;
    if (flag === '--settings' && values.some(badSettings)) return flag;
    if (flag === '--mcp-config' && values.some(badMcp)) return flag;
    if (flag === '--add-dir' && values.some(outside)) return flag;
  }
  return '';
}

function launch(h, rest) {
  const cwd = inRepos(h.cwd);
  if (!repoOfFolder(cwd)) refuse('folder of a repo that is not listed');
  if (!Array.isArray(h.args) || !h.args.every((a) => typeof a === 'string')) refuse('bad args');
  const unsafe = unsafeArg(h.args);
  if (unsafe) refuse(`flag not allowed: ${unsafe}`);
  const id = conversationOf(h.args);
  if (!id) refuse('no conversation id');
  const env = {};
  for (const [k, v] of Object.entries(h.env && typeof h.env === 'object' ? h.env : {})) if (SAFE_ENV(k, v)) env[k] = v;
  const strings = (o) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, v.slice(0, 500)]));
  const since = Number.isInteger(h.since) && h.since >= 0 ? h.since : 0;
  const sock = connect(SOCKET);
  let code = null;
  sock.on('error', () => {
    log(`runner unreachable ${id.slice(0, 8)}`);
    process.stderr.write('aibox launcher: the runner does not answer\n');
    process.exit(5);
  });
  sock.on('connect', () => {
    log(`launch ${id.slice(0, 8)} cwd=${cwd} since=${since}`);
    sock.write(`${JSON.stringify({ op: 'open', id, cwd, args: h.args, env, secrets, notify: strings(h.notify), texts: strings(h.texts), since })}\n`);
    if (rest.length > 0) sock.write(rest);
    process.stdin.pipe(sock);
    process.stdin.resume();
  });
  // The runner's own lines: how the process ended, and what it wrote on stderr. The rest is the session's stream.
  createInterface({ input: sock, crlfDelay: Infinity }).on('line', (line) => {
    if (line.startsWith('{"type":"aibox_exit"')) {
      code = Number(/"code":(-?\d+)/.exec(line)?.[1] ?? 1);
      return;
    }
    if (line.startsWith('{"type":"aibox_stderr"')) {
      try {
        process.stderr.write(String(JSON.parse(line).text ?? ''));
      } catch {
        // A cut line: nothing to tell.
      }
      return;
    }
    process.stdout.write(`${line}\n`);
  });
  // The hub left: only this connection ends, the session goes on on the runner.
  let left = false;
  const leave = () => {
    left = true;
    sock.destroy();
  };
  process.stdout.on('error', leave);
  process.on('SIGHUP', leave);
  process.on('SIGPIPE', leave);
  process.on('SIGTERM', leave);
  process.stdin.on('end', () => (left = true));
  sock.on('close', () => {
    log(`left ${id.slice(0, 8)} code=${code ?? ''}`);
    // Ended without a word of the runner and not by the hub: the runner went away (restart, crash), the session may not.
    process.exit(code ?? (left ? 0 : 5));
  });
}

mkdirSync(STATE, { recursive: true, mode: 0o700 });
const { line, rest } = await readHeader();
let header;
try {
  header = JSON.parse(line);
} catch {
  refuse('bad header');
}
switch (header?.op) {
  case 'transcript':
    transcript(header.id);
    break;
  case 'launch':
    takeSecrets(header.secrets);
    launch(header, rest);
    break;
  case 'runner':
    // The runner's sessions only, at once: no Claude Code started to ask its version.
    answer((await askRunner({ op: 'status' })) ?? { error: 'unreachable' });
    break;
  case 'status':
    await status();
    break;
  case 'session':
  case 'stop':
    if (typeof header.id !== 'string' || !SESSION_ID.test(header.id)) refuse('bad id');
    log(`${header.op} ${header.id.slice(0, 8)}`);
    answer((await askRunner({ op: header.op, id: header.id })) ?? { state: 'unreachable' });
    break;
  case 'prepare':
    takeSecrets(header.secrets);
    prepare(header.slug, header.branch);
    break;
  case 'head':
    takeSecrets(header.secrets);
    head(header.cwd, header.check === true);
    break;
  case 'echo':
    echo(rest);
    break;
  case 'env-state':
  case 'env-apply':
    // The environment sync (src/main/remote/envSync.ts): writes only under ~/.claude, next to this file and root's too.
    (await import('./envsync.mjs')).run(header, rest, log);
    break;
  default:
    refuse('unknown op');
}
