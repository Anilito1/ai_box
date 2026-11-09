#!/usr/bin/env node
// The AI Box's runner: it holds the remote workers' Claude Code sessions, so that they go on while the PC is off.
// /opt/aibox/runner.mjs, owned by root, run by systemd as aibox (aibox-runner.service, setup.sh). It listens on a Unix
// socket in ~/.aibox, which only aibox reaches; the hub comes through SSH, where its key runs launch.mjs, which checks the
// request and joins this socket: no port, no other way in.
//
// One Claude Code process per conversation, started here, in its own process group. The hub attaches to it and leaves
// at will (relay.mjs: numbered journal, outbox of the hub's tools, requests kept for it). Per conversation, in
// ~/.aibox/sessions/<id>/: meta.json, journal.jsonl, outbox.json. Never on disk: the tokens a launch brings (in the
// process's memory only) and the address the phone is notified at. The log (journald) says what happened, where and
// when, never a word of a conversation.
//
// Requests on the socket, one JSON line, then:
//   {"op":"open","id","cwd","args","env","secrets","notify","texts","since"}  attaches to the conversation, started
//        first if it does not run; the rest of the connection is its stream;
//   {"op":"status"}   the runner and its sessions; {"op":"session","id"}   one of them;
//   {"op":"stop","id"}   ends it (its journal and outbox are kept).
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, totalmem } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Relay } from './relay.mjs';

export const RUNNER_VERSION = 1;
const HOME = homedir();
const REPOS = join(HOME, 'repos');
const CLAUDE = join(HOME, '.local', 'bin', 'claude');
const STATE = join(HOME, '.aibox');
const SESSIONS = join(STATE, 'sessions');
export const SOCKET = join(STATE, 'runner.sock');
/** Written for aibox-power (another user): whether anything runs, and since when nothing has. */
const IDLE_FILE = '/run/aibox/idle.json';
const SHELVE_REQUEST = '/run/aibox/shelve-request';
const POWER_SETTINGS = '/etc/aibox/power.json';
const SESSION_ID = /^[0-9a-f-]{36}$/i;
/** One Claude Code needs about 300 MB, more with a build: what this server holds, at most 16. */
const MAX = Math.max(1, Math.min(16, Number(process.env.AIBOX_RUNNER_MAX) || Math.floor((totalmem() / 2 ** 20 - 1536) / 700)));
/** A session nobody watches, idle and with nothing in the background, is ended after this: its conversation stays. */
const IDLE_END_MS = 15 * 60_000;
/** A turn the hub does not watch is stopped after this long. */
const TURN_MAX_MS = 8 * 60 * 60_000;
/** An ended conversation is forgotten after a week, or four if it still keeps messages nobody came for. */
const KEEP_MS = 7 * 86_400_000;
const JOURNAL_MEMORY = 8 * 2 ** 20;
const JOURNAL_FILE_MAX = 16 * 2 ** 20;
const HEADER_MAX = 4 * 2 ** 20;
const NOTIFY_EVERY_MS = 30 * 60_000;
const NOTIFY_PER_HOUR = 12;

const DEFAULT_TEXTS = {
  queued: 'Saved: the hub is offline (the PC is off). It will be delivered when the hub is back; go on with your mission meanwhile.',
  offline: 'The hub is offline (the PC is off): this tool is back when it is. Go on without it.',
  late: '[Written while the hub was offline, at {time}]',
  full: 'Not saved: too many messages already wait for the hub. Keep the essentials for one last report when it is back.',
};

const log = (text) => process.stdout.write(`${text}\n`);
const short = (id) => String(id).slice(0, 8);

// ---------- files ----------

const dirOf = (id) => join(SESSIONS, id);
function writeJson(file, o) {
  writeFileSync(`${file}.tmp`, JSON.stringify(o), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** The numbered lines of one conversation: the last ones in memory, all that fit on disk. */
class Journal {
  constructor(file) {
    this.file = file;
    this.lines = [];
    this.bytes = 0;
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      text = '';
    }
    for (const line of text.split('\n')) {
      const m = /,"aibox_seq":(\d+)}$/.exec(line);
      if (m) this.keep(Number(m[1]), line);
    }
  }

  keep(seq, line) {
    this.lines.push({ seq, line });
    this.bytes += line.length;
    while (this.bytes > JOURNAL_MEMORY && this.lines.length > 1) this.bytes -= this.lines.shift().line.length;
  }

  last() {
    return this.lines.at(-1)?.seq ?? 0;
  }

  append(seq, line) {
    this.keep(seq, line);
    try {
      appendFileSync(this.file, `${line}\n`, { mode: 0o600 });
      if (statSync(this.file).size > JOURNAL_FILE_MAX) {
        writeFileSync(`${this.file}.tmp`, this.lines.map((l) => `${l.line}\n`).join(''), { mode: 0o600 });
        renameSync(`${this.file}.tmp`, this.file);
      }
    } catch {
      // A full disk must not stop the session: the memory keeps the journal for this run.
    }
  }

  since(seq) {
    const i = this.lines.findIndex((l) => l.seq > seq);
    return i < 0 ? [] : this.lines.slice(i);
  }
}

// ---------- sessions ----------

/** @type {Map<string, any>} */
const sessions = new Map();
let stopping = false;
const started = Date.now();
const notified = [];

function notify(s, kind) {
  const n = s.notify;
  const text = n && typeof n[kind] === 'string' ? n[kind].slice(0, 200) : '';
  if (!text || typeof n.url !== 'string' || !/^https:\/\/ntfy\.sh\/aibox-[a-z0-9]{24}$/.test(n.url)) return;
  const now = Date.now();
  // Once per kind and conversation in a while, a few an hour in all: a phone is not a log.
  if (now - (s.notifiedAt[kind] ?? 0) < NOTIFY_EVERY_MS) return;
  while (notified.length > 0 && now - notified[0] > 3_600_000) notified.shift();
  if (notified.length >= NOTIFY_PER_HOUR) return;
  s.notifiedAt[kind] = now;
  notified.push(now);
  fetch(n.url, { method: 'POST', body: text, headers: { Title: 'AI Box', Tags: kind === 'done' || kind === 'report' ? 'white_check_mark' : 'warning' }, signal: AbortSignal.timeout(10_000) })
    .then((res) => log(`${res.ok ? 'notified' : `notify refused (${res.status})`} ${kind} ${short(s.id)}`))
    .catch(() => log(`notify failed ${kind} ${short(s.id)}`));
}

function saveMeta(s) {
  writeJson(join(dirOf(s.id), 'meta.json'), { id: s.id, cwd: s.cwd, createdAt: s.createdAt, endedAt: s.endedAt, reason: s.reason, texts: s.texts });
}

function sessionOf(id, cwd) {
  let s = sessions.get(id);
  if (s) return s;
  mkdirSync(dirOf(id), { recursive: true, mode: 0o700 });
  const meta = readJson(join(dirOf(id), 'meta.json'), {});
  const journal = new Journal(join(dirOf(id), 'journal.jsonl'));
  s = {
    id,
    cwd: typeof meta.cwd === 'string' ? meta.cwd : cwd,
    createdAt: meta.createdAt ?? Date.now(),
    endedAt: meta.endedAt ?? 0,
    reason: meta.reason ?? '',
    texts: meta.texts && typeof meta.texts === 'object' ? meta.texts : null,
    notify: null,
    notifiedAt: {},
    child: null,
    sock: null,
    ending: '',
    timedOut: false,
    stderr: '',
    /** What its process was started with, and what the last connection brought (memory only: tokens in it). */
    args: [],
    next: null,
    /** Its process is being started again with new settings: the hub's `initialize`, given to the new one. */
    restartSend: null,
  };
  const outbox = readJson(join(dirOf(id), 'outbox.json'), []);
  s.relay = new Relay({
    seq: journal.last(),
    outbox: Array.isArray(outbox) ? outbox : [],
    journal,
    toCli: (line) => {
      if (s.child && s.child.stdin.writable) s.child.stdin.write(`${line}\n`);
    },
    saveOutbox: (items) => writeJson(join(dirOf(id), 'outbox.json'), items),
    notify: (kind) => notify(s, kind),
    texts: () => ({ ...DEFAULT_TEXTS, ...(s.texts ?? {}) }),
    newId: () => randomUUID(),
    restart: (sameInit, sendInit) => {
      if (!s.child || !s.next || (sameInit && sameArgs(s.args, s.next.args))) return false;
      log(`settings changed ${short(s.id)}, at rest: starting it again`);
      s.restartSend = sendInit;
      endProcess(s, 'restart');
      return true;
    },
  });
  sessions.set(id, s);
  return s;
}

/** The same launch, whether it starts the conversation or resumes it. */
const sameArgs = (a, b) => {
  const plain = (args) => args.filter((x, i) => !/^--(resume|session-id)(=|$)/.test(x) && !/^--(resume|session-id)$/.test(args[i - 1] ?? ''));
  return JSON.stringify(plain(a)) === JSON.stringify(plain(b));
};

const live = () => [...sessions.values()].filter((s) => s.child);

function spawnFor(s, h) {
  const env = { ...process.env, ...h.secrets, ...h.env };
  // Its own process group: what it starts (shells, dev servers, browsers) ends with it.
  const child = spawn(CLAUDE, h.args, { cwd: s.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  s.child = child;
  s.args = h.args;
  s.ending = '';
  s.timedOut = false;
  s.reason = '';
  s.endedAt = 0;
  saveMeta(s);
  log(`start ${short(s.id)} pid=${child.pid} cwd=${s.cwd}`);
  child.stdin.on('error', () => {});
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => s.relay.fromCli(line));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text) => {
    s.stderr = (s.stderr + text).slice(-4000);
    if (s.sock) s.sock.write(`${JSON.stringify({ type: 'aibox_stderr', text: text.slice(-2000) })}\n`);
  });
  const ended = (code, signal) => {
    if (s.child !== child) return;
    s.child = null;
    if (child.pid) endGroup(child.pid, 'SIGTERM');
    s.reason = s.ending || (code === 0 ? 'ended' : 'cut');
    s.endedAt = Date.now();
    saveMeta(s);
    log(`exit ${short(s.id)} pid=${child.pid ?? ''} code=${code} signal=${signal ?? ''} reason=${s.reason}`);
    const r = s.relay;
    r.setState('idle');
    r.tasks = 0;
    r.pending.clear();
    r.initResponse = null;
    // Started again with the settings of the connection waiting for it: it keeps that connection.
    const send = s.restartSend;
    s.restartSend = null;
    if (send && s.next && s.sock && !stopping) {
      spawnFor(s, s.next);
      return send();
    }
    // A turn that died while nobody watched: the phone hears it. Ended on purpose (idle, stop, shutdown): not news.
    if (!s.sock && s.reason === 'cut') notify(s, 'cut');
    r.detach();
    if (s.sock) {
      const sock = s.sock;
      s.sock = null;
      sock.end(`${JSON.stringify({ type: 'aibox_exit', code: code ?? 1 })}\n`);
    }
  };
  // Not started at all (no Claude Code there): told as an exit, the connection waiting for it ends.
  child.on('error', (err) => {
    log(`spawn failed ${short(s.id)}: ${err.code ?? 'error'}`);
    if (!child.pid) ended(1, null);
  });
  child.on('exit', ended);
}

function endGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

/** Ends its process the way Claude Code ends on its own (the end of its input), then by signal if it lingers. */
function endProcess(s, reason) {
  const child = s.child;
  if (!child || s.ending) return;
  s.ending = reason;
  log(`ending ${short(s.id)} reason=${reason}`);
  child.stdin.end();
  setTimeout(() => s.child === child && endGroup(child.pid, 'SIGTERM'), 20_000).unref();
  setTimeout(() => s.child === child && endGroup(child.pid, 'SIGKILL'), 40_000).unref();
}

// ---------- the socket ----------

const answer = (sock, o) => sock.end(`${JSON.stringify(o)}\n`);
const refuse = (sock, why, code) => {
  log(`refused: ${why}`);
  sock.end(`${JSON.stringify({ type: 'aibox_stderr', text: `aibox runner: ${why}\n` })}\n${JSON.stringify({ type: 'aibox_exit', code })}\n`);
};

function sessionView(s) {
  return { id: s.id, live: s.child !== null, reason: s.reason, endedAt: s.endedAt, ...s.relay.view() };
}

const strings = (v) => Array.isArray(v) && v.every((a) => typeof a === 'string');
const stringMap = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string')) : {});

function open(h, sock, lines) {
  if (stopping) return refuse(sock, 'the server is stopping', 7);
  if (typeof h.id !== 'string' || !SESSION_ID.test(h.id)) return refuse(sock, 'bad id', 2);
  if (typeof h.cwd !== 'string' || !h.cwd.startsWith(`${REPOS}/`) || h.cwd.includes('/../')) return refuse(sock, 'folder outside ~/repos', 2);
  if (!strings(h.args)) return refuse(sock, 'bad args', 2);
  const s = sessionOf(h.id, h.cwd);
  if (s.cwd !== h.cwd) return refuse(sock, 'this conversation runs in another folder', 2);
  if (h.notify && typeof h.notify === 'object') s.notify = stringMap(h.notify);
  if (h.texts && typeof h.texts === 'object') {
    s.texts = stringMap(h.texts);
    saveMeta(s);
  }
  // The tokens of this connection are the ones a start of the process (now, or with new settings) gets.
  s.next = { args: h.args, env: stringMap(h.env), secrets: stringMap(h.secrets) };
  if (!s.child) {
    if (live().length >= MAX) return refuse(sock, `the server runs ${MAX} workers already`, 6);
    spawnFor(s, s.next);
  }
  // The last one in wins: a connection cut without the server noticing yet is let go.
  const previous = s.sock;
  s.sock = sock;
  if (previous) previous.destroy();
  s.relay.attach({ send: (line) => sock.write(`${line}\n`) }, Number(h.since));
  log(`attach ${short(s.id)} since=${Number(h.since) || 0} seq=${s.relay.seq} outbox=${s.relay.outbox.length}`);
  lines.on('line', (line) => {
    if (s.sock === sock) s.relay.fromHub(line);
  });
  sock.on('close', () => {
    if (s.sock !== sock) return;
    s.sock = null;
    s.relay.detach();
    log(`detach ${short(s.id)} seq=${s.relay.seq}`);
  });
}

function stop(id, sock) {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) return answer(sock, { error: 'bad id' });
  const s = sessions.get(id);
  if (!s?.child) return answer(sock, { state: s ? 'done' : 'none' });
  const child = s.child;
  if (s.sock) s.sock.destroy();
  if (s.relay.state !== 'idle') s.relay.ask({ subtype: 'interrupt' }, () => {});
  endProcess(s, 'stopped');
  const timer = setTimeout(() => answer(sock, { state: 'running' }), 45_000);
  child.once('exit', () => {
    clearTimeout(timer);
    answer(sock, { state: 'done' });
  });
}

function status() {
  return {
    version: RUNNER_VERSION,
    max: MAX,
    live: live().length,
    rssMb: Math.round(process.memoryUsage().rss / 2 ** 20),
    since: started,
    sessions: [...sessions.values()].map(sessionView),
  };
}

const server = createServer((sock) => {
  sock.setEncoding('utf8');
  sock.on('error', () => {});
  const lines = createInterface({ input: sock, crlfDelay: Infinity });
  let header = null;
  let size = 0;
  const onData = (chunk) => {
    size += chunk.length;
    if (header === null && size > HEADER_MAX) sock.destroy();
  };
  sock.on('data', onData);
  lines.once('line', (line) => {
    sock.off('data', onData);
    try {
      header = JSON.parse(line);
    } catch {
      header = {};
    }
    if (header?.op === 'open') return open(header, sock, lines);
    lines.close();
    if (header?.op === 'status') return answer(sock, status());
    if (header?.op === 'session') {
      const s = typeof header.id === 'string' ? sessions.get(header.id) : undefined;
      if (!s) return answer(sock, { state: 'none' });
      return answer(sock, { state: s.child ? 'running' : 'done', detached: !s.sock, blocked: s.relay.waiting() > 0, ...sessionView(s) });
    }
    if (header?.op === 'stop') return stop(header.id, sock);
    answer(sock, { error: 'unknown op' });
  });
});

// ---------- the watch: idle sessions, long turns, power, updates ----------

let lastBusy = Date.now();
/** When the shelve was last asked: asked again every half hour while it has not happened (refused, failed). */
let shelveAskedAt = 0;
const ownFiles = ['runner.mjs', 'relay.mjs'].map((f) => join(import.meta.dirname, f));
const stamps = ownFiles.map((f) => (existsSync(f) ? statSync(f).mtimeMs : 0));

function powerSettings() {
  const o = readJson(POWER_SETTINGS, null);
  return o && typeof o.idleHours === 'number' && o.idleHours >= 0.5 && o.idleHours <= 48 ? { idleHours: o.idleHours } : null;
}

function watch() {
  const now = Date.now();
  for (const s of live()) {
    if (s.sock) continue;
    const r = s.relay;
    if (!r.busy() && now - r.activeAt > IDLE_END_MS) endProcess(s, 'idle');
    if (r.runningSince !== null && now - r.runningSince > TURN_MAX_MS && !s.timedOut) {
      s.timedOut = true;
      log(`turn too long ${short(s.id)}: interrupted`);
      r.ask({ subtype: 'interrupt' }, () => {});
      notify(s, 'timeout');
    }
  }
  for (const s of [...sessions.values()]) {
    if (!s.child && !s.sock && s.endedAt && (now - s.endedAt > KEEP_MS * (s.relay.outbox.length === 0 ? 1 : 4))) {
      sessions.delete(s.id);
      rmSync(dirOf(s.id), { recursive: true, force: true });
    }
  }
  const busy = live().some((s) => s.sock || s.relay.busy());
  if (busy) {
    lastBusy = now;
    shelveAskedAt = 0;
  }
  try {
    writeFileSync(`${IDLE_FILE}.tmp`, JSON.stringify({ at: now, busy, idleSince: lastBusy, live: live().length }), { mode: 0o644 });
    renameSync(`${IDLE_FILE}.tmp`, IDLE_FILE);
  } catch {
    // No /run/aibox (not started by systemd): no power guard either.
  }
  // Nothing ran for the user's delay, the PC away: aibox-power (setup.sh) checks it again, then shelves the server.
  const p = powerSettings();
  if (p && !busy && now - shelveAskedAt > 30 * 60_000 && now - lastBusy > p.idleHours * 3_600_000) {
    shelveAskedAt = now;
    log('idle: asking for the server to be shelved');
    try {
      writeFileSync(SHELVE_REQUEST, String(now), { mode: 0o644 });
    } catch {
      log('shelve request failed');
    }
  }
  // A new version installed (setup.sh): taken up once nothing runs; systemd starts it again.
  if (live().length === 0 && ownFiles.some((f, i) => existsSync(f) && statSync(f).mtimeMs !== stamps[i])) {
    log('new version installed: restarting');
    process.exit(0);
  }
}

// ---------- start and stop ----------

async function shutdown() {
  if (stopping) return;
  stopping = true;
  log(`stopping: ${live().length} sessions`);
  server.close();
  // A turn in progress is interrupted first: its transcript ends cleanly, and a resume takes it up.
  for (const s of live()) if (s.relay.state !== 'idle') s.relay.ask({ subtype: 'interrupt' }, () => {});
  const until = Date.now() + 30_000;
  while (Date.now() < until && live().some((s) => s.relay.state !== 'idle')) await new Promise((r) => setTimeout(r, 500));
  for (const s of live()) {
    if (s.sock) s.sock.destroy();
    endProcess(s, 'shutdown');
  }
  const end = Date.now() + 45_000;
  while (Date.now() < end && live().length > 0) await new Promise((r) => setTimeout(r, 500));
  log('stopped');
  process.exit(0);
}

// Run by systemd as /opt/aibox/runner.mjs; imported, it only defines.
if (process.argv[1]?.endsWith('/runner.mjs')) {
  mkdirSync(SESSIONS, { recursive: true, mode: 0o700 });
  // What ran before this start ended with it (systemd stops the whole group): known, ended, journal and outbox kept.
  for (const id of readdirSync(SESSIONS).filter((d) => SESSION_ID.test(d))) {
    const s = sessionOf(id, '');
    if (!s.endedAt) {
      s.reason = 'restart';
      s.endedAt = Date.now();
      saveMeta(s);
    }
  }
  try {
    unlinkSync(SOCKET);
  } catch {
    // None yet.
  }
  const mask = process.umask(0o077);
  server.listen(SOCKET, () => {
    process.umask(mask);
    log(`runner ${RUNNER_VERSION} listening, ${sessions.size} conversations known, max ${MAX}`);
  });
  setInterval(watch, 60_000).unref();
  watch();
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  // Keeps running while the socket listens.
}
