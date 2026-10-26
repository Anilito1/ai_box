import { execFile, spawn } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, dialog, powerMonitor, shell, type BrowserWindow } from 'electron';
import type { HubSnapshot } from '../shared/types';
import type { UpdateChoice, UpdateResult, UpdateState } from '../shared/update';
import type { HubConfig } from './config';
import { git, GitError } from './git';
import { t } from './i18n';
import { inspect, type Inspection } from './updateCheck';
import { cleanEnv, lockHeld, npmCli, run } from './updateExec';
import { backupBranch, parseJob, parseResult, readyToInstall, redact, sessionsAtWork, sessionsQuiet, type UpdateJob } from './updateLogic';

const here = dirname(fileURLToPath(import.meta.url));
const FIRST_CHECK_MS = 20_000;
const CHECK_EVERY_MS = 4 * 3600_000;
const TICK_MS = 30_000;
/** Countdown before a restart nobody asked for just now, and before one asked while sessions worked. */
const UNATTENDED_MS = 30_000;
const ASKED_MS = 10_000;
/** A window that never answers a countdown: the install waits for the hub to close. */
// Generous: a hidden window runs its timers late.
const ANSWER_GRACE_MS = 30_000;

interface Options {
  dataDir: string;
  cfg: HubConfig;
  sessions: { snapshot(): HubSnapshot; on(event: 'changed', fn: () => void): unknown };
  /** A git action of the panel is running. */
  repoBusy: () => boolean;
  /** Environment of the hub's own tools: without the Claude access and GitHub sign-in it adds to sessions. */
  env: () => Record<string, string>;
  window: () => BrowserWindow | null;
  send: (state: UpdateState) => void;
  /** Closes the hub without asking (the user chose, or nothing runs), and with `relaunch` opens it again. */
  restart: (relaunch: boolean) => void;
}

/** The hub's data folder for updates: the job, the helper's copy, its lock and result, the build kept aside. */
const folderOf = (dataDir: string) => join(dataDir, 'update');
const gitText = (err: unknown) => redact(err instanceof GitError ? err.stderr || err.message : String(err));

/**
 * An install runs (the hub was closed for it): this start leaves it to finish, and asks it to start the hub again.
 * False when there is none, or it ended while asked.
 */
export function installRunning(dataDir: string): boolean {
  const dir = folderOf(dataDir);
  if (!lockHeld(dir)) return false;
  writeFileSync(join(dir, 'relaunch'), '');
  if (lockHeld(dir)) return true;
  rmSync(join(dir, 'relaunch'), { force: true });
  return false;
}

/**
 * Keeps a source checkout of the hub up to date with its official repository: `git fetch` at start and every few
 * hours; "Update" (or, unattended, a quiet moment) moves the checkout by a fast-forward, builds it and restarts the
 * hub, whose sessions pick up. A failure puts the previous commit and build back. New dependencies are installed by a
 * helper once the hub has closed.
 */
export class Updater {
  private readonly root = app.getAppPath();
  private readonly dir: string;
  private state: UpdateState;
  private pending: Inspection['pending'] = null;
  private remote = '';
  private timers: NodeJS.Timeout[] = [];
  private checkRun: Promise<UpdateState> | null = null;
  private quietSince: number | null = null;
  private awaySince: number | null = null;
  private lastQuietCheck = 0;
  /** The update the user put off (unattended installs leave it to the hub's close). */
  private postponed = '';
  /** Target of an install that failed: never retried unattended. */
  private failed = '';
  private applying = false;
  /** The realignment's dialog is open. */
  private asking = false;
  /** Installed and built: the restart waits for the sessions that started meanwhile. */
  private readyTimer: NodeJS.Timeout | null = null;
  /** The hub is closing for an install: nothing else starts. */
  private launched = false;
  private node = '';

  constructor(private readonly opts: Options) {
    this.dir = folderOf(opts.dataDir);
    this.state = {
      kind: app.isPackaged ? 'off' : 'none',
      mode: opts.cfg.updates,
      checking: false,
      checkedAt: null,
      offline: false,
      target: '',
      block: null,
      branch: '',
      files: [],
      progress: null,
      confirm: 0,
      waiting: false,
      countdown: null,
      last: null,
      problem: '',
      detail: '',
    };
  }

  start(): void {
    mkdirSync(this.dir, { recursive: true });
    this.state.last = this.readResult();
    if (app.isPackaged) return;
    this.timers.push(
      setTimeout(() => void this.check(true), FIRST_CHECK_MS),
      setInterval(() => void this.check(true), CHECK_EVERY_MS),
      setInterval(() => this.tick(), TICK_MS),
    );
    this.opts.sessions.on('changed', () => this.sessionsChanged());
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  view(): UpdateState {
    return { ...this.state, mode: this.opts.cfg.updates, files: [...this.state.files] };
  }

  private emit(): void {
    this.opts.send(this.view());
  }

  /** The last install's result, left before the restart that followed it: read once. */
  private readResult(): UpdateResult | null {
    let result: UpdateResult | null = null;
    try {
      result = parseResult(JSON.parse(readFileSync(join(this.dir, 'result.json'), 'utf8')));
      rmSync(join(this.dir, 'result.json'), { force: true });
      if (result?.ok) rmSync(join(this.dir, 'failed'), { force: true });
      else if (result) writeFileSync(join(this.dir, 'failed'), result.to);
    } catch {
      // No install since the last start.
    }
    try {
      this.failed = readFileSync(join(this.dir, 'failed'), 'utf8').trim();
    } catch {
      this.failed = '';
    }
    return result;
  }

  // ---------- checking ----------

  /** Checks (and with `fetch`, asks the official repository first). Concurrent calls share one run. */
  check(fetch: boolean): Promise<UpdateState> {
    if (this.state.kind === 'off' || this.applying || this.launched) return Promise.resolve(this.view());
    this.checkRun ??= this.run(fetch).finally(() => (this.checkRun = null));
    return this.checkRun;
  }

  private async run(fetch: boolean): Promise<UpdateState> {
    this.state.checking = true;
    this.emit();
    try {
      await this.read(fetch);
    } finally {
      this.state.checking = false;
      this.state.checkedAt = Date.now();
    }
    this.emit();
    return this.view();
  }

  private async read(fetch: boolean): Promise<void> {
    const r = await inspect(this.root, fetch);
    const s = this.state;
    Object.assign(s, { kind: r.kind, block: r.block, branch: r.branch, files: r.files, target: r.pending?.to.slice(0, 7) ?? '' });
    if (r.kind === 'unofficial' || r.kind === 'none') Object.assign(s, { offline: false, detail: '' });
    if (r.fetched) Object.assign(s, { offline: !r.fetched.ok, detail: r.fetched.detail });
    this.pending = r.pending;
    this.remote = r.remote;
    if (r.kind !== 'available') Object.assign(s, { confirm: 0, waiting: false, countdown: null });
    // Found ahead of time: the hub's close has no time to look for it.
    else void this.nodePath();
  }

  // ---------- when to install ----------

  private quiet(): boolean {
    return sessionsQuiet(this.opts.sessions.snapshot().sessions) && !this.opts.repoBusy();
  }

  /** A session that starts working resets the quiet time (checked at most once a second, only with an update waiting). */
  private sessionsChanged(): void {
    if (this.state.kind !== 'available' || Date.now() - this.lastQuietCheck < 1000) return;
    this.lastQuietCheck = Date.now();
    if (!this.quiet()) this.quietSince = null;
  }

  private tick(): void {
    if (this.state.kind !== 'available' || this.applying || this.launched) {
      this.quietSince = this.awaySince = null;
      return;
    }
    const now = Date.now();
    this.quietSince = this.quiet() ? (this.quietSince ?? now) : null;
    const win = this.opts.window();
    this.awaySince = !win || win.isDestroyed() || !win.isFocused() ? (this.awaySince ?? now) : null;
    if (this.state.countdown !== null) {
      // The window never answered: left to the hub's close.
      if (now > this.state.countdown + ANSWER_GRACE_MS) this.answer(false);
      return;
    }
    const ready = readyToInstall({
      mode: this.opts.cfg.updates,
      kind: this.state.kind,
      quietFor: this.quietSince === null ? null : now - this.quietSince,
      awayFor: Math.max(this.awaySince === null ? 0 : now - this.awaySince, powerMonitor.getSystemIdleTime() * 1000),
      waiting: this.state.waiting,
      postponed: this.postponed === this.pending?.to || this.failed === this.pending?.to,
    });
    if (!ready) return;
    // The window counts down and answers: it alone knows of an unsent message or open settings.
    this.state.countdown = now + (this.state.waiting ? ASKED_MS : UNATTENDED_MS);
    this.emit();
  }

  /** The window's answer to a countdown: go, or later (the user's choice, an unsent message, open settings). */
  answer(go: boolean): void {
    if (this.state.countdown === null || this.applying || this.launched) return;
    this.state.countdown = null;
    if (go && this.quiet()) {
      void this.apply('ff');
      return;
    }
    // Refused while the user had asked to wait for the sessions (a message being written): asked again later.
    if (!go && !this.state.waiting) this.postponed = this.pending?.to ?? '';
    this.quietSince = null;
    this.emit();
  }

  /**
   * "Update": right away when nothing runs. With sessions at work, `ask` lets the window ask first; `when-quiet`
   * waits for them, `now` interrupts them (they pick up after the restart). `cancel` drops the question or the wait.
   */
  install(choice: UpdateChoice): UpdateState {
    const s = this.state;
    if (choice === 'cancel') {
      Object.assign(s, { confirm: 0, waiting: false, countdown: null, problem: '' });
      this.emit();
      return this.view();
    }
    if (s.progress === 'ready' && choice === 'now') {
      this.restartNow();
      return this.view();
    }
    if ((s.kind !== 'available' && s.kind !== 'realign') || this.applying || this.launched) return this.view();
    if (s.kind === 'realign') {
      void this.realign();
      return this.view();
    }
    const atWork = sessionsAtWork(this.opts.sessions.snapshot().sessions);
    if (atWork > 0 && choice === 'ask') s.confirm = atWork;
    else if (atWork > 0 && choice === 'when-quiet') {
      Object.assign(s, { confirm: 0, waiting: true });
      this.quietSince = null;
    } else {
      void this.apply('ff', choice === 'now');
      return this.view();
    }
    this.emit();
    return this.view();
  }

  /** After a rewrite of the official history: confirmed in a dialog, then a backup branch and the official main. */
  private async realign(): Promise<void> {
    const win = this.opts.window();
    // One dialog at a time, however many clicks.
    if (!win || this.asking) return;
    this.asking = true;
    try {
      const options = { type: 'warning' as const, title: t('update.realign.title'), noLink: true };
      if (!this.quiet()) {
        await dialog.showMessageBox(win, { ...options, message: t('update.realign.busy'), buttons: [t('update.ok')] });
        return;
      }
      // The name the dialog gives is the branch made.
      const backup = await this.freeBranch(backupBranch(new Date()));
      const choice = await dialog.showMessageBox(win, {
        ...options,
        message: t('update.realign.title'),
        detail: t('update.realign.detail', { branch: backup }),
        buttons: [t('update.realign.go'), t('update.cancel')],
        defaultId: 1,
        cancelId: 1,
      });
      if (choice.response === 0) await this.apply('realign', false, backup);
    } finally {
      this.asking = false;
    }
  }

  /** `backup/pre-update-…`, with a number when a backup of that minute exists. */
  private async freeBranch(base: string): Promise<string> {
    for (let n = 1; n < 50; n++) {
      const name = n === 1 ? base : `${base}-${n}`;
      if (!(await git(this.root, ['rev-parse', '--verify', '-q', `refs/heads/${name}`]).catch(() => ''))) return name;
    }
    return `${base}-${Date.now()}`;
  }

  openFolder(): void {
    void shell.openPath(this.root);
  }

  // ---------- installing ----------

  /** The user's Node.js (npm's), as the build needs it: its path, or empty when missing or older than 22.12. */
  private nodePath(): Promise<string> {
    if (this.node) return Promise.resolve(this.node);
    return new Promise((resolve) => {
      // From the update folder: Windows would run a node.exe of the current folder before the one on the PATH.
      execFile('node', ['-p', 'process.execPath + "\\n" + process.versions.node'], { cwd: this.dir, env: this.opts.env(), timeout: 15_000, windowsHide: true }, (err, out) => {
        const [path, version] = err ? [] : out.trim().split('\n');
        const [major, minor] = (version ?? '').split('.').map(Number);
        resolve((this.node = path && (major > 22 || (major === 22 && minor >= 12)) ? path.trim() : ''));
      });
    });
  }

  /**
   * Gets the official main again, moves the checkout onto it (fast-forward, or after a backup branch, a reset),
   * builds, and restarts the hub. Anything that fails puts the previous commit and build back, the hub keeps running.
   * `now`: the user chose to interrupt the sessions; otherwise a session that started meanwhile delays the restart.
   * `backup`: the branch a realignment keeps the old commits on.
   */
  private async apply(mode: 'ff' | 'realign', now = false, backup = ''): Promise<void> {
    if (this.applying || this.launched) return;
    this.applying = true;
    const s = this.state;
    Object.assign(s, { confirm: 0, waiting: false, countdown: null, problem: '', last: null, progress: 'fetch' });
    this.emit();
    try {
      await this.read(true);
      const p = this.pending;
      if (s.kind !== (mode === 'ff' ? 'available' : 'realign') || !p) return;
      const node = await this.nodePath();
      const cli = node ? npmCli(node, process.env.npm_execpath ?? '') : '';
      if (!cli) {
        s.problem = 'node';
        return;
      }
      if (mode === 'realign') {
        try {
          await git(this.root, ['branch', backup, p.from]);
        } catch (err) {
          Object.assign(s, { problem: 'start', detail: gitText(err) });
          return;
        }
      }
      if (p.lockChanged) return this.closeForHelper(mode, backup, node);

      s.progress = 'install';
      this.emit();
      const dist = join(this.root, 'dist');
      const kept = join(this.dir, 'dist-previous');
      rmSync(kept, { recursive: true, force: true });
      const hasKept = existsSync(dist);
      if (hasKept) cpSync(dist, kept, { recursive: true });
      const fail = async (step: UpdateResult['step'], detail: string) => {
        const restored = await this.undo(p.from, hasKept ? kept : '');
        const result: UpdateResult = { ok: false, step, at: Date.now(), restored, detail: redact(detail.trim()).slice(-6000), to: p.to };
        this.failed = p.to;
        writeFileSync(join(this.dir, 'failed'), p.to);
        s.last = result;
        await this.read(false);
      };
      try {
        await git(this.root, mode === 'ff' ? ['merge', '--ff-only', '--no-edit', p.to] : ['reset', '--keep', p.to], { timeout: 120_000, hooks: false });
      } catch (err) {
        return await fail('git', gitText(err));
      }
      s.progress = 'build';
      this.emit();
      const built = await run(node, [cli, 'run', 'build'], this.root, cleanEnv(this.opts.env()), 5 * 60_000);
      if (built.code !== 0) return await fail('build', built.out);

      const result: UpdateResult = { ok: true, step: '', at: Date.now(), restored: false, detail: '', to: p.to };
      writeFileSync(join(this.dir, 'result.json'), JSON.stringify(result));
      this.launched = true;
      if (now || this.quiet()) this.restartNow();
      else {
        s.progress = 'ready';
        this.readyTimer = setInterval(() => this.quiet() && this.restartNow(), 2000);
      }
    } catch (err) {
      Object.assign(s, { problem: 'start', detail: redact(String(err)) });
    } finally {
      this.applying = false;
      if (!this.launched) s.progress = null;
      this.emit();
    }
  }

  /** The new version is built: the hub restarts on it (the window shows "restarting" a moment before it closes). */
  private restartNow(): void {
    if (this.readyTimer) clearInterval(this.readyTimer);
    this.readyTimer = null;
    this.state.progress = 'restart';
    this.emit();
    setTimeout(() => this.opts.restart(true), 800);
  }

  /** Back to the commit and the build of before; true when both are back. `--keep`: what a session changed meanwhile stays. */
  private async undo(from: string, kept: string): Promise<boolean> {
    let ok = true;
    try {
      if ((await git(this.root, ['rev-parse', 'HEAD'])).trim() !== from) await git(this.root, ['reset', '--keep', from], { timeout: 60_000, hooks: false });
    } catch {
      ok = false;
    }
    if (kept) {
      const dist = join(this.root, 'dist');
      try {
        rmSync(dist, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
        cpSync(kept, dist, { recursive: true });
      } catch {
        ok = false;
      }
    }
    return ok;
  }

  /** New dependencies: the hub closes, the helper installs them, builds and opens the hub again. */
  private closeForHelper(mode: 'ff' | 'realign', backup: string, node: string): void {
    const job = this.job(mode, backup, true);
    if (!job || !this.spawnHelper(job, node)) return;
    this.launched = true;
    this.state.progress = 'closing';
    // Long enough to read why it closes.
    setTimeout(() => this.opts.restart(false), 2500);
  }

  /** Writes the job and starts the helper, detached: it waits for the hub to close. False when it could not start. */
  private spawnHelper(job: UpdateJob, node: string): boolean {
    try {
      if (!parseJob(job)) throw new Error('invalid job');
      mkdirSync(this.dir, { recursive: true });
      // A copy: the build it replaces never runs it, and a broken new build cannot break the way back.
      copyFileSync(join(here, 'update-helper.mjs'), join(this.dir, 'helper.mjs'));
      const jobFile = join(this.dir, 'job.json');
      writeFileSync(jobFile, JSON.stringify(job, null, 2));
      const child = spawn(node, [join(this.dir, 'helper.mjs'), jobFile], { cwd: this.dir, env: this.opts.env(), detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', () => undefined);
      child.unref();
      return child.pid !== undefined;
    } catch (err) {
      Object.assign(this.state, { problem: 'start', detail: redact(String(err)) });
      return false;
    }
  }

  private job(mode: 'ff' | 'realign', backup: string, restart: boolean): UpdateJob | null {
    const p = this.pending;
    if (!p || !this.remote) return null;
    return {
      root: this.root,
      remote: this.remote,
      appPid: process.pid,
      from: p.from,
      to: p.to,
      mode,
      backup,
      lockChanged: p.lockChanged,
      relaunch: { exe: process.execPath, args: process.argv.slice(1), cwd: process.cwd() },
      restart,
      npmCli: process.env.npm_execpath ?? '',
    };
  }

  /**
   * The hub closes with an update waiting (auto or next-start): the helper installs it once the hub is gone, without
   * starting it again. A checkout that changed since the check is left alone: the helper checks everything again.
   */
  atQuit(): void {
    if (this.launched || this.applying || this.state.kind !== 'available' || this.opts.cfg.updates === 'ask' || !this.node) return;
    if (this.failed === this.pending?.to) return;
    const job = this.job('ff', '', false);
    if (job && this.spawnHelper(job, this.node)) this.launched = true;
  }
}
