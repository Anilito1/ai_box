#!/usr/bin/env node
// The only program the AI Box's SSH key may run on the server: /opt/aibox/launch.mjs, owned by root (setup.sh).
// It reads one JSON line, then:
//   {"op":"launch","cwd":"/home/aibox/repos/x","args":[...],"env":{...}}  runs Claude Code there, the rest of stdin
//                                                                         is its input, its output goes back as is;
//   {"op":"transcript","id":"<uuid>"}                                     prints a conversation's transcript (exit 3:
//                                                                         none).
// Nothing else: no shell, no other program, no folder outside ~/repos. Each request is logged in ~/.aibox/launch.log
// (what, where, exit code; never the variables).
import { spawn } from 'node:child_process';
import { appendFileSync, createReadStream, existsSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const REPOS = join(HOME, 'repos');
const CLAUDE = join(HOME, '.local', 'bin', 'claude');
const LOG = join(HOME, '.aibox', 'launch.log');
const HEADER_MAX = 1024 * 1024;

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
      process.stdin.pause();
      done({ line: buf.subarray(0, nl).toString('utf8'), rest: buf.subarray(nl + 1) });
    };
    process.stdin.on('data', onData);
    process.stdin.on('end', () => refuse('no header'));
  });
}

function transcript(id) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) refuse('bad id');
  const projects = join(HOME, '.claude', 'projects');
  const dirs = existsSync(projects) ? readdirSync(projects) : [];
  const file = dirs.map((d) => join(projects, d, `${id}.jsonl`)).find((f) => existsSync(f));
  log(`transcript ${id} ${file ? 'found' : 'none'}`);
  if (!file) process.exit(3);
  createReadStream(file).pipe(process.stdout);
}

function launch(h, rest) {
  let cwd;
  try {
    cwd = realpathSync(String(h.cwd));
  } catch {
    refuse('no such folder');
  }
  if (!cwd.startsWith(`${REPOS}/`)) refuse('folder outside ~/repos');
  if (!Array.isArray(h.args) || !h.args.every((a) => typeof a === 'string')) refuse('bad args');
  const env = { ...process.env };
  for (const [k, v] of Object.entries(h.env && typeof h.env === 'object' ? h.env : {})) {
    // The hub sends only these (src/main/remote.ts forwardedEnv); checked again here.
    if (/^(CLAUDE_CODE_|CLAUDE_AGENT_SDK_)/.test(k) && !/TOKEN|KEY|SECRET|PASSWORD|CONFIG_DIR|_PATH$|_DIR$/.test(k) && typeof v === 'string') env[k] = v;
  }
  // Its own process group: what it starts (shells, dev servers) ends with the session.
  const child = spawn(CLAUDE, h.args, { cwd, env, stdio: ['pipe', 'inherit', 'inherit'], detached: true });
  const endGroup = () => {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  };
  log(`launch pid=${child.pid} cwd=${cwd}`);
  child.stdin.on('error', () => {});
  if (rest.length > 0) child.stdin.write(rest);
  process.stdin.pipe(child.stdin);
  process.stdin.resume();
  // The hub went away (PC closed, network cut): Claude Code reads the end of its input and stops by itself.
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(sig, endGroup);
  child.on('error', (err) => refuse(`claude: ${err.message}`));
  child.on('exit', (code, signal) => {
    log(`exit pid=${child.pid} code=${code} signal=${signal ?? ''}`);
    endGroup();
    process.exit(code ?? 1);
  });
}

const { line, rest } = await readHeader();
let header;
try {
  header = JSON.parse(line);
} catch {
  refuse('bad header');
}
if (header?.op === 'transcript') transcript(header.id);
else if (header?.op === 'launch') launch(header, rest);
else refuse('unknown op');
