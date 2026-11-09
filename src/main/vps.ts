import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RemoteWorkers } from '../shared/types';
import {
  allowedRepo,
  cleanLoginCode,
  emptyState,
  fingerprintOf,
  LAUNCHER_VERSION,
  loginUrlOf,
  parseRepos,
  parseTarget,
  remoteClone,
  scopeOf,
  serverList,
  VPS_STEPS,
  type ServerStatus,
  type VpsState,
  type VpsStepId,
  type VpsTarget,
} from '../shared/vps';
import { sshOptions, sshProgram } from './remote';

// Settings › Remote server: from an address and the administrator's name to a server ready for remote workers. Each
// step checks before it acts, so the whole runs again safely; it stops where the user has something to do (check the
// server's fingerprint, sign Claude Code in, paste deploy keys). No secret goes through it: the keys are public ones,
// the Claude sign-in code is typed into the server's own Claude Code.

export type Exec = (cmd: string, args: string[], o?: { input?: string; timeoutMs?: number; onLine?: (line: string) => void }) => Promise<{ code: number | null; out: string; err: string }>;

export interface Tty {
  write(text: string): void;
  onData(cb: (text: string) => void): void;
  exit: Promise<number | null>;
  kill(): void;
}

export interface WizardDeps {
  exec: Exec;
  /** A command run with a terminal on the server's side (ssh -tt): Claude Code's sign-in wants one. */
  tty(cmd: string, args: string[]): Tty;
  home: string;
  /** scripts/vps of this checkout. */
  scripts: string;
  platform: NodeJS.Platform;
  /** The Windows account the private keys must belong to alone. */
  user: string;
  current(): RemoteWorkers;
  save(r: RemoteWorkers): void;
  /** Main repos of the settings: the checkouts that may get a clone on the server. */
  mainRepos(): string[];
  originOf(dir: string): string;
  /** The user's own GitHub token for the server's clones (keychain), or ''. */
  token(): string;
  status(r: RemoteWorkers): Promise<ServerStatus | null>;
  latency(r: RemoteWorkers): Promise<number | null>;
  onChange(s: VpsState): void;
}

export const realExec: Exec = (cmd, args, o = {}) =>
  new Promise((done) => {
    const child = execFile(cmd, args, { timeout: o.timeoutMs ?? 60_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out, errText) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? ((err as unknown as { code: number }).code) : null) : 0;
      done({ code, out: String(out), err: String(errText) });
    });
    // Both outputs, line by line: an installation that stops says why in "Details".
    for (const stream of o.onLine ? [child.stdout, child.stderr] : []) {
      let buf = '';
      stream?.on('data', (t: string | Buffer) => {
        buf += String(t);
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const l of lines) o.onLine?.(l);
      });
    }
    child.stdin?.on('error', () => {});
    child.stdin?.end(o.input ?? '');
  });

export function realTty(cmd: string, args: string[]): Tty {
  const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stdin.on('error', () => {});
  const listeners: ((t: string) => void)[] = [];
  for (const s of [child.stdout, child.stderr]) s.on('data', (b: Buffer) => listeners.forEach((l) => l(b.toString('utf8'))));
  return {
    write: (text) => child.stdin.write(text),
    onData: (cb) => listeners.push(cb),
    exit: new Promise((done) => {
      child.on('close', (code) => done(code));
      child.on('error', () => done(null));
    }),
    kill: () => child.kill(),
  };
}

const WORKER_PUB = /^ssh-ed25519 [A-Za-z0-9+/=]+( [\w@.-]+)?$/;
const SCRIPTS = ['setup.sh', 'launch.mjs', 'repos.sh'] as const;
const LOG_MAX = 300;

export class VpsWizard {
  private s: VpsState = emptyState();
  private pendingHostLine = '';
  private login: Tty | null = null;
  private emitTimer: NodeJS.Timeout | null = null;

  constructor(private readonly d: WizardDeps) {
    const r = d.current();
    if (r.host) this.s.target = { host: r.host, admin: r.admin, port: r.port };
  }

  get adminKey(): string {
    return join(this.d.home, '.ssh', 'aibox_admin');
  }
  get workerKey(): string {
    return join(this.d.home, '.ssh', 'aibox_worker');
  }
  get knownHosts(): string {
    return join(this.d.home, '.ssh', 'aibox_known_hosts');
  }

  state(): VpsState {
    return structuredClone(this.s);
  }

  /** Runs the steps from the first, up to the end or the first one that waits for the user. */
  async run(raw?: unknown): Promise<VpsState> {
    if (this.s.running) return this.state();
    if (raw !== undefined) {
      const target = parseTarget(raw);
      if (!target) {
        this.set('local', 'fail', 'target');
        return this.state();
      }
      if (this.s.target && (this.s.target.host !== target.host || this.s.target.port !== target.port)) {
        this.s.fingerprint = '';
        this.pendingHostLine = '';
      }
      this.s.target = target;
    }
    if (!this.s.target) return this.state();
    this.s.running = true;
    for (const id of VPS_STEPS) if (this.s.steps[id].state !== 'ok') this.s.steps[id] = { state: 'todo', detail: '' };
    this.changed();
    try {
      for (const id of VPS_STEPS) {
        this.set(id, 'run');
        const [state, detail] = await this.step(id, this.s.target);
        this.set(id, state, detail);
        if (state !== 'ok') break;
      }
    } catch (err) {
      const id = VPS_STEPS.find((x) => this.s.steps[x].state === 'run');
      if (id) this.set(id, 'fail', err instanceof Error ? err.message : String(err));
    } finally {
      this.s.running = false;
      this.changed();
    }
    return this.state();
  }

  /**
   * The user compared this fingerprint and trusts the server: recorded for good, then the run goes on. Only the very
   * fingerprint shown: a key scanned again in between is not trusted on that click.
   */
  async trust(fingerprint: unknown): Promise<VpsState> {
    if (!this.pendingHostLine || this.s.running || fingerprint !== this.s.fingerprint) return this.state();
    mkdirSync(join(this.d.home, '.ssh'), { recursive: true });
    appendFileSync(this.knownHosts, `${this.pendingHostLine}\n`);
    this.pendingHostLine = '';
    return this.run();
  }

  /** The server was reinstalled: its old fingerprint is forgotten, the new one will be shown. */
  async forget(): Promise<VpsState> {
    const t = this.s.target;
    if (!t || this.s.running) return this.state();
    await this.d.exec(sshProgram('ssh-keygen'), ['-R', this.hostSpec(t), '-f', this.knownHosts]);
    this.s.fingerprint = '';
    this.s.steps.hostkey = { state: 'todo', detail: '' };
    return this.run();
  }

  /** The sign-in code shown by claude.ai, typed into the server's Claude Code. */
  code(raw: unknown): VpsState {
    const code = typeof raw === 'string' ? cleanLoginCode(raw) : null;
    if (code && this.login) this.login.write(`${code}\r`);
    return this.state();
  }

  cancel(): void {
    this.login?.kill();
  }

  // ---------- steps ----------

  private async step(id: VpsStepId, t: VpsTarget): Promise<[VpsState['steps'][VpsStepId]['state'], string]> {
    switch (id) {
      case 'local':
        return this.local();
      case 'hostkey':
        return this.hostkey(t);
      case 'admin':
        return this.admin(t);
      case 'setup':
        return this.setup(t);
      case 'worker':
        return this.worker(t);
      case 'login':
        return this.signIn(t);
      case 'repos':
        return this.repos(t);
      case 'save':
        return this.save(t);
    }
  }

  /** OpenSSH on this PC, the two keys (made if missing), private keys readable by this account only. */
  private async local(): Promise<[VpsState['steps']['local']['state'], string]> {
    const ssh = await this.d.exec(sshProgram('ssh'), ['-V']);
    if (ssh.code !== 0) return ['fail', 'no-ssh'];
    for (const [file, comment] of [
      [this.adminKey, 'aibox-admin'],
      [this.workerKey, 'aibox-worker'],
    ]) {
      if (!existsSync(file)) {
        mkdirSync(join(this.d.home, '.ssh'), { recursive: true });
        const made = await this.d.exec(sshProgram('ssh-keygen'), ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', file]);
        if (made.code !== 0) return ['fail', 'keygen'];
        this.log(`key made: ${comment}`);
      }
      if (this.d.platform === 'win32' && !(await this.ownOnly(file))) return ['fail', 'acl'];
    }
    this.s.adminKey = readFileSync(`${this.adminKey}.pub`, 'utf8').trim();
    return ['ok', ''];
  }

  /** Windows' OpenSSH refuses a private key others can read: inheritance cut, this account alone, read only. */
  private async ownOnly(file: string): Promise<boolean> {
    const others = async () => {
      const acl = await this.d.exec('icacls', [file]);
      const lines = acl.out.split('\n').map((l) => l.replace(file, '').trim()).filter((l) => /:\(/.test(l));
      return acl.code !== 0 || lines.length === 0 || lines.some((l) => !l.toLowerCase().includes(`\\${this.d.user.toLowerCase()}:`));
    };
    if (!(await others())) return true;
    await this.d.exec('icacls', [file, '/inheritance:r', '/grant:r', `${this.d.user}:R`]);
    this.log('key rights narrowed to this account');
    return !(await others());
  }

  private hostSpec(t: VpsTarget): string {
    return t.port === 22 ? t.host : `[${t.host}]:${t.port}`;
  }

  /** The server's key: known (recorded earlier), or shown once for the user to compare before it is trusted. */
  private async hostkey(t: VpsTarget): Promise<[VpsState['steps']['hostkey']['state'], string]> {
    const known = existsSync(this.knownHosts) ? await this.d.exec(sshProgram('ssh-keygen'), ['-F', this.hostSpec(t), '-f', this.knownHosts]) : null;
    const dir = mkdtempSync(join(tmpdir(), 'aibox-hostkey-'));
    try {
      if (known?.code === 0 && known.out.trim()) {
        this.s.fingerprint = await this.fingerprint(dir, known.out.split('\n').find((l) => l && !l.startsWith('#')) ?? '');
        return ['ok', ''];
      }
      // ssh itself, not ssh-keyscan (Windows' fails on recent key exchanges): the key lands in a scratch file at the
      // key exchange, before any sign-in, and is trusted for good only once the user compared it.
      const scratch = join(dir, 'scan');
      await this.d.exec(sshProgram('ssh'), ['-T', ...sshOptions(scratch, t.port).map((o) => (o === 'StrictHostKeyChecking=yes' ? 'StrictHostKeyChecking=accept-new' : o)), '-o', 'HostKeyAlgorithms=ssh-ed25519', '-o', 'PreferredAuthentications=none', `${t.admin}@${t.host}`, 'true'], { timeoutMs: 30_000 });
      const line = existsSync(scratch) ? (readFileSync(scratch, 'utf8').split('\n').find((l) => / ssh-ed25519 [A-Za-z0-9+/=]+\s*$/.test(l))?.trim() ?? '') : '';
      if (!line) return ['fail', 'unreachable'];
      const fingerprint = await this.fingerprint(dir, line);
      if (!fingerprint) return ['fail', 'unreachable'];
      this.s.fingerprint = fingerprint;
      this.pendingHostLine = line;
      return ['wait', 'fingerprint'];
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private async fingerprint(dir: string, line: string): Promise<string> {
    const file = join(dir, 'key');
    writeFileSync(file, `${line}\n`);
    return fingerprintOf((await this.d.exec(sshProgram('ssh-keygen'), ['-lf', file])).out);
  }

  private sshAs(key: string, user: string, t: VpsTarget, command: string, tty = false): [string, string[]] {
    return [sshProgram('ssh'), [...(tty ? ['-tt'] : ['-T']), '-i', key, ...sshOptions(this.knownHosts, t.port), `${user}@${t.host}`, command]];
  }

  private admin = async (t: VpsTarget): Promise<[VpsState['steps']['admin']['state'], string]> => {
    const [cmd, args] = this.sshAs(this.adminKey, t.admin, t, 'sudo -n true && . /etc/os-release && echo "os=$ID $VERSION_ID"');
    const r = await this.d.exec(cmd, args, { timeoutMs: 40_000 });
    if (r.code === 0) {
      const os = /os=(.+)/.exec(r.out)?.[1]?.trim() ?? '';
      return ['ok', os];
    }
    if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(r.err)) return ['fail', 'hostChanged'];
    if (/Permission denied/i.test(r.err)) return ['wait', 'pasteKey'];
    if (/sudo/i.test(r.err) || r.code === 1) return ['fail', 'noSudo'];
    return ['fail', 'unreachable'];
  };

  /** setup.sh once (and again only when this app brings a newer launcher); the admin must still get in after it. */
  private async setup(t: VpsTarget): Promise<[VpsState['steps']['setup']['state'], string]> {
    const st = await this.d.status(this.workerConfig(t));
    if (st && st.version === LAUNCHER_VERSION) return ['ok', 'installed'];
    const pub = readFileSync(`${this.workerKey}.pub`, 'utf8').trim();
    if (!WORKER_PUB.test(pub)) return ['fail', 'workerKey'];
    for (const f of SCRIPTS) {
      const [cmd, args] = this.sshAs(this.adminKey, t.admin, t, `install -d -m 700 ~/aibox-setup && test -O ~/aibox-setup && cat > ~/aibox-setup/${f}`);
      // LF only: a Windows checkout may have turned them into CRLF, which bash on the server does not read.
      const up = await this.d.exec(cmd, args, { input: readFileSync(join(this.d.scripts, f), 'utf8').replace(/\r\n/g, '\n'), timeoutMs: 60_000 });
      if (up.code !== 0) return ['fail', 'upload'];
    }
    const [cmd, args] = this.sshAs(this.adminKey, t.admin, t, `sudo ADMIN=${t.admin} WORKER_KEY='${pub}' bash ~/aibox-setup/setup.sh`);
    const run = await this.d.exec(cmd, args, { timeoutMs: 30 * 60_000, onLine: (l) => this.log(l) });
    if (run.code !== 0) return ['fail', 'setup'];
    // Its own SSH was narrowed: a new connection proves the administrator still gets in.
    const [c2, a2] = this.sshAs(this.adminKey, t.admin, t, 'true');
    if ((await this.d.exec(c2, a2, { timeoutMs: 40_000 })).code !== 0) return ['fail', 'lockedOut'];
    return ['ok', 'done'];
  }

  private workerConfig(t: VpsTarget): RemoteWorkers {
    return { ...this.d.current(), host: t.host, port: t.port, admin: t.admin, user: 'aibox', key: this.workerKey, knownHosts: this.knownHosts };
  }

  /** The workers' key reaches the launcher, and nothing else; Claude Code answers; memory and latency are measured. */
  private async worker(t: VpsTarget): Promise<[VpsState['steps']['worker']['state'], string]> {
    const r = this.workerConfig(t);
    const st = await this.d.status(r);
    if (!st) return ['fail', 'worker'];
    if (st.version !== LAUNCHER_VERSION) return ['fail', 'launcherVersion'];
    if (!st.claude) return ['fail', 'noClaude'];
    this.s.claude = st.claude;
    this.s.memoryMb = st.memory;
    this.s.latencyMs = (await this.d.latency(r)) ?? 0;
    return ['ok', st.claude];
  }

  /** `claude auth login` for aibox, in a terminal on the server: its address shown here, the code typed back. */
  private async signIn(t: VpsTarget): Promise<[VpsState['steps']['login']['state'], string]> {
    if ((await this.d.status(this.workerConfig(t)))?.signedIn) return ['ok', ''];
    const [cmd, args] = this.sshAs(this.adminKey, t.admin, t, 'stty cols 1000 rows 50 2>/dev/null; sudo -iu aibox /home/aibox/.local/bin/claude auth login --claudeai', true);
    const tty = this.d.tty(cmd, args);
    this.login = tty;
    let out = '';
    tty.onData((text) => {
      out = (out + text).slice(-20_000);
      const url = loginUrlOf(out);
      if (url && url !== this.s.loginUrl) {
        this.s.loginUrl = url;
        this.set('login', 'wait', 'code');
      }
    });
    const timer = setTimeout(() => tty.kill(), 15 * 60_000);
    await tty.exit;
    clearTimeout(timer);
    this.login = null;
    this.s.loginUrl = '';
    return (await this.d.status(this.workerConfig(t)))?.signedIn ? ['ok', ''] : ['fail', 'login'];
  }

  /**
   * The user's listed repos cloned on the server with their GitHub token, given on repos.sh's input (never on its
   * command line, never written there). An organisation's repos come later, with its App's token at each launch.
   */
  private async repos(t: VpsTarget): Promise<[VpsState['steps']['repos']['state'], string]> {
    const name = (await this.d.exec('git', ['config', '--global', 'user.name'])).out.trim();
    const email = (await this.d.exec('git', ['config', '--global', 'user.email'])).out.trim();
    const q = (v: string, re: RegExp) => (re.test(v) ? v : '-');
    const { allowed, denied, orgs } = this.d.current();
    const slugs = serverList(allowed, denied);
    if (slugs.length === 0) return ['wait', 'noRepos'];
    const own = slugs.filter((s) => scopeOf(s, orgs) === 'personal');
    const token = this.d.token();
    if (own.length > 0 && !token) return ['wait', 'token'];
    // The server's own list (root's file, read by the launcher and repos.sh): what the workers' key may touch.
    const list = `printf '%s\\n' ${slugs.join(' ')} | sudo tee /etc/aibox/repos >/dev/null`;
    const [cmd, args] = this.sshAs(this.adminKey, t.admin, t, `${list} && sudo -u aibox -H bash /opt/aibox/repos.sh '${q(name, /^[A-Za-z0-9 ._-]{1,80}$/)}' '${q(email, /^[A-Za-z0-9.+_-]+@[A-Za-z0-9.-]+$/)}' ${own.join(' ')}`);
    const r = await this.d.exec(cmd, args, { input: `${token}\n`, timeoutMs: 10 * 60_000, onLine: (l) => this.log(l) });
    if (r.code !== 0) return ['fail', 'repos'];
    this.s.repos = parseRepos(r.out, own);
    return this.s.repos.every((k) => k.ready) ? ['ok', ''] : ['wait', 'refused'];
  }

  /** Recorded in config.json: the server, its key, the clones of this PC's checkouts; turned on. */
  private async save(t: VpsTarget): Promise<[VpsState['steps']['save']['state'], string]> {
    const ready = new Set(this.s.repos.filter((k) => k.ready).map((k) => k.slug));
    const now = this.d.current();
    const repos: Record<string, string> = {};
    for (const dir of this.d.mainRepos()) {
      const slug = allowedRepo(this.d.originOf(dir), now.allowed, now.denied);
      if (slug && ready.has(slug)) repos[dir] = remoteClone(slug);
    }
    this.d.save({ ...this.workerConfig(t), enabled: true, repos, ntfy: now.ntfy || newTopic() });
    return ['ok', String(Object.keys(repos).length)];
  }

  // ---------- state ----------

  private set(id: VpsStepId, state: VpsState['steps'][VpsStepId]['state'], detail = ''): void {
    this.s.steps[id] = { state, detail };
    this.changed();
  }

  private log(line: string): void {
    const clean = line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trimEnd();
    if (!clean) return;
    this.s.log.push(clean.slice(0, 400));
    if (this.s.log.length > LOG_MAX) this.s.log.splice(0, this.s.log.length - LOG_MAX);
    this.changed();
  }

  /** Grouped: a setup prints hundreds of lines, the window redraws a few times a second at most. */
  private changed(): void {
    this.emitTimer ??= setTimeout(() => {
      this.emitTimer = null;
      this.d.onChange(this.state());
    }, 150);
  }
}

/** A private, random ntfy topic: whoever knows it can read and post, so it is long and never shown elsewhere. */
export function newTopic(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return `aibox-${[...randomBytes(24)].map((b) => alphabet[b % 36]).join('')}`;
}
