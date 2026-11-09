#!/usr/bin/env node
// The only program the AI Box's SSH key may run on the server: /opt/aibox/launch.mjs, owned by root (setup.sh).
// It reads one JSON line, then does one of:
//   {"op":"launch","cwd":"/home/aibox/repos/x","args":[...],"env":{...},"notify":{...}}
//        runs Claude Code there; the rest of stdin is its input, its output goes back. If the hub goes away in the middle
//        of a turn (PC asleep, network cut), the turn goes on alone until it ends or needs the hub, then stops (see below);
//   {"op":"transcript","id":"<uuid>"}   prints a conversation's transcript (exit 3: none);
//   {"op":"status"}                     this launcher's version, Claude Code's, signed in or not, memory, workers;
//   {"op":"session","id":"<uuid>"}      whether that conversation still runs here (detached or not);
//   {"op":"stop","id":"<uuid>"}         ends it;
//   {"op":"prepare","slug":"Owner/name","branch":"b"}   fetches the branch and gives it its own worktree in ~/repos;
//   {"op":"head","cwd":"…","check":true} the branch a folder of ~/repos is on (check: committed and pushed?);
//   {"op":"echo"}                       sends each input line back (the hub measures the round trip of an event).
// Nothing else: no shell, no other program than claude and git, no folder outside ~/repos. Each request is logged in
// ~/.aibox/launch.log (what, where, exit code; never the variables nor the content).
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { freemem, homedir, totalmem } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const VERSION = 3;
const HOME = homedir();
const REPOS = join(HOME, 'repos');
const CLAUDE = join(HOME, '.local', 'bin', 'claude');
const STATE = join(HOME, '.aibox');
const RUN = join(STATE, 'run');
const LOG = join(STATE, 'launch.log');
const HEADER_MAX = 1024 * 1024;
const SESSION_ID = /^[0-9a-f-]{36}$/i;
/** A detached turn is given this long, at most, to end on its own. */
const DETACHED_MAX_MS = 4 * 60 * 60_000;
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

// ---------- the conversations running here ----------

const runFile = (id) => join(RUN, `${id}.json`);
const readRun = (id) => {
  try {
    return JSON.parse(readFileSync(runFile(id), 'utf8'));
  } catch {
    return null;
  }
};
const writeRun = (id, o) => {
  mkdirSync(RUN, { recursive: true, mode: 0o700 });
  writeFileSync(`${runFile(id)}.tmp`, JSON.stringify(o));
  renameSync(`${runFile(id)}.tmp`, runFile(id));
};
/** A Claude Code process of ours, not a pid the system gave to another program since. */
const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('claude');
  } catch {
    // No /proc (not Linux): the signal's answer is all there is.
    return !existsSync('/proc');
  }
};
/** The conversation Claude Code is asked to run: `--resume <id>` or `--session-id <id>`. */
const conversationOf = (args) => {
  const i = args.findIndex((a) => a === '--resume' || a === '--session-id');
  return i >= 0 && SESSION_ID.test(args[i + 1] ?? '') ? args[i + 1] : '';
};

function sessionState(id) {
  const r = readRun(id);
  if (!r) return { state: 'none' };
  if (r.state !== 'done' && alive(r.pid)) return { state: 'running', detached: r.detached === true, blocked: r.blocked === true, since: r.since };
  return { state: 'done', reason: r.reason ?? '', endedAt: r.endedAt ?? 0 };
}

// ---------- notifications (ntfy) ----------

function notify(n, kind) {
  const text = n && typeof n[kind] === 'string' ? n[kind].slice(0, 200) : '';
  if (!text || typeof n.url !== 'string' || !/^https:\/\/ntfy\.sh\/aibox-[a-z0-9]{24}$/.test(n.url)) return Promise.resolve();
  // Only the hub's fixed sentences: no name, no content of the conversation.
  return fetch(n.url, { method: 'POST', body: text, headers: { Title: 'AI Box', Tags: kind === 'done' ? 'white_check_mark' : 'warning' }, signal: AbortSignal.timeout(10_000) })
    .then(() => log(`notified ${kind}`))
    .catch(() => log(`notify failed ${kind}`));
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

function status() {
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
  const files = existsSync(RUN) ? readdirSync(RUN).filter((f) => f.endsWith('.json')) : [];
  const states = files.map((f) => [f, sessionState(f.slice(0, -5))]);
  // What ended a week ago is no news any more.
  for (const [f, st] of states) if (st.state === 'done' && Date.now() - (st.endedAt || 0) > 7 * 86_400_000) rmSync(join(RUN, f), { force: true });
  const running = states.filter(([, st]) => st.state === 'running').length;
  answer({ version: VERSION, claude: (v.stdout ?? '').trim().slice(0, 80), signedIn, memory: { total: Math.round(totalmem() / 2 ** 20), available: Math.round(available / 2 ** 20) }, running });
}

function stop(id) {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) refuse('bad id');
  const r = readRun(id);
  if (r && r.state !== 'done' && alive(r.pid)) {
    try {
      process.kill(-r.pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
    log(`stop ${id}`);
  }
  answer(sessionState(id));
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
function unsafeArg(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const value = eq > 0 ? a.slice(eq + 1) : (args[i + 1] ?? '');
    if (['--plugin-dir', '--debug-file', '--settings-file', '--ide'].includes(flag)) return flag;
    if (flag === '--settings' && /"(hooks|env|apiKeyHelper|statusLine|awsAuthRefresh|awsCredentialExport|otelHeadersHelper|fileSuggestion)"/.test(value)) return flag;
    if (flag === '--mcp-config') {
      try {
        if (!Object.values(JSON.parse(value).mcpServers ?? {}).every((s) => s && s.type === 'sdk')) return flag;
      } catch {
        return flag;
      }
    }
    if (flag === '--add-dir') {
      try {
        if (!realpathSync(value).startsWith(`${REPOS}/`)) return flag;
      } catch {
        return flag;
      }
    }
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
  // One process per conversation: two would write the same transcript.
  if (id && sessionState(id).state === 'running') {
    log(`busy ${id}`);
    process.stderr.write('aibox launcher: this conversation still runs on the server\n');
    process.exit(4);
  }
  const env = { ...process.env, ...secrets };
  for (const [k, v] of Object.entries(h.env && typeof h.env === 'object' ? h.env : {})) if (SAFE_ENV(k, v)) env[k] = v;
  const n = h.notify && typeof h.notify === 'object' ? h.notify : null;
  // Its own process group: what it starts (shells, dev servers) ends with the session.
  const child = spawn(CLAUDE, h.args, { cwd, env, stdio: ['pipe', 'pipe', 'inherit'], detached: true });
  const since = Date.now();
  const run = { pid: child.pid, since, detached: false, blocked: false, state: 'running' };
  if (id) writeRun(id, run);
  const save = () => id && writeRun(id, run);
  log(`launch pid=${child.pid} cwd=${cwd}`);
  const endGroup = () => {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  };

  let busy = false;
  let hubGone = false;
  let stopping = false;
  /** The hub left in the middle of a turn: the turn goes on until it ends or needs the hub. */
  const detach = () => {
    if (hubGone) return;
    hubGone = true;
    if (!busy) {
      log(`hub gone pid=${child.pid}, idle: ending`);
      stopping = true;
      return child.stdin.end();
    }
    log(`hub gone pid=${child.pid}, mid-turn: going on alone`);
    run.detached = true;
    save();
    // It was already waiting for the hub: nobody will answer.
    if (asked.size > 0) return finish('blocked');
    setTimeout(() => finish('timeout'), DETACHED_MAX_MS).unref();
  };
  const finish = (kind) => {
    if (stopping) return;
    stopping = true;
    run.reason = kind;
    save();
    void notify(n, kind).finally(() => {
      child.stdin.end();
      // Claude Code ends on the end of its input; a stuck one is ended after a while.
      setTimeout(endGroup, 20_000).unref();
    });
  };

  /** Requests of Claude Code waiting for the hub's answer. */
  const asked = new Set();
  const parse = (line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  };
  // What the hub writes: a user message starts a turn; an answer settles a request.
  if (rest.length > 0) process.stdin.unshift(rest);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', (line) => {
    const m = parse(line);
    if (m?.type === 'user') busy = true;
    if (m?.type === 'control_response') asked.delete(m.response?.request_id);
    if (!hubGone) child.stdin.write(`${line}\n`);
  });
  input.on('close', detach);
  process.stdin.resume();
  child.stdin.on('error', () => {});

  // What Claude Code says goes to the hub as long as it is there; a turn's end and a call for the hub are watched.
  let out = true;
  process.stdout.on('error', () => {
    out = false;
    detach();
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (out && !hubGone) process.stdout.write(`${line}\n`);
    const m = parse(line);
    if (m?.type === 'result') {
      busy = false;
      if (hubGone) finish('done');
    } else if (m?.type === 'control_request') {
      if (!hubGone) return void asked.add(m.request_id);
      // A permission, one of the hub's tools, a question: nobody to answer it. What it was about is in the transcript.
      run.blocked = true;
      finish('blocked');
    }
  });

  // The connection's end: sshd hangs up. An explicit stop (op stop, the hub closing the session) is SIGTERM.
  process.on('SIGHUP', detach);
  process.on('SIGPIPE', detach);
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, endGroup);
  child.on('error', (err) => refuse(`claude: ${err.message}`));
  child.on('exit', (code, signal) => {
    log(`exit pid=${child.pid} code=${code} signal=${signal ?? ''}`);
    Object.assign(run, { state: 'done', endedAt: Date.now(), reason: run.reason ?? (hubGone ? 'cut' : 'ended') });
    save();
    endGroup();
    const end = () => process.exit(code ?? 1);
    // A detached turn that died on its own still says so; one ended by the hub (op stop: SIGTERM) does not.
    if (hubGone && !stopping && signal !== 'SIGTERM') void notify(n, 'cut').finally(end);
    else end();
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
  case 'status':
    status();
    break;
  case 'session':
    if (typeof header.id !== 'string' || !SESSION_ID.test(header.id)) refuse('bad id');
    answer(sessionState(header.id));
    break;
  case 'stop':
    stop(header.id);
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
  default:
    refuse('unknown op');
}
