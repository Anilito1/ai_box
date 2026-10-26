import { spawn } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { UpdateResult } from '../shared/update';
import { samePath } from './repos';
import { alive, cleanEnv, LOCK_BEAT_MS, lockHeld, npmCli, run } from './updateExec';
import { MAIN, normalizeRemote, parseJob, redact, retryable, TARGET_REF, type UpdateJob } from './updateLogic';

// Installs an update whose dependencies changed, once the hub has closed, then starts it again. Run by the user's own
// Node.js from a copy in the hub's data folder (never from the checkout it changes): Electron and the Claude Code
// binaries `npm ci` replaces are locked while the hub runs, on Windows. Also installs, without a restart, an update
// left for the hub's close. Every command is an argument list, never a shell; nothing but the checkout's own `npm ci`
// and `npm run build` (and the installer of the Electron package they bring) runs code from it.

const jobFile = process.argv[2] ?? '';
const dir = dirname(jobFile);
const file = (name: string) => join(dir, name);

const log = (line: string) => {
  try {
    appendFileSync(file('helper.log'), `${new Date().toISOString()} ${redact(line)}\n`);
  } catch {
    // The log is only for whoever helps.
  }
};

const ENV = cleanEnv(process.env);
const GIT_ENV = { ...ENV, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C' };
// No hook can run (a hooks path that is a file), nor a program named by the repo's config (fsmonitor).
const GIT_CONFIG = ['-c', `core.hooksPath=${process.execPath}`, '-c', 'core.fsmonitor=false'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function install(job: UpdateJob): Promise<UpdateResult> {
  const git = async (args: string[]) => {
    const r = await run('git', [...GIT_CONFIG, '-C', job.root, ...args], dir, GIT_ENV, 120_000);
    log(`git ${args[0]}: ${r.code}`);
    return r;
  };
  const value = async (args: string[]) => {
    const r = await git(args);
    return r.code === 0 ? r.out.trim() : '';
  };
  const fail = (step: UpdateResult['step'], detail: string, restored: boolean): UpdateResult => ({
    ok: false,
    step,
    at: Date.now(),
    restored,
    detail: redact(detail.trim()).slice(-6000),
    to: job.to,
  });

  // The checkout as the hub saw it: on main, clean, the same commits, the official remote. Anything else and nothing changes.
  const checks: [string, boolean][] = [
    ['folder', samePath(await value(['rev-parse', '--show-toplevel']), job.root)],
    ['remote', normalizeRemote(await value(['remote', 'get-url', 'origin'])) === job.remote],
    ['branch', (await value(['symbolic-ref', '-q', '--short', 'HEAD'])) === MAIN],
    ['head', (await value(['rev-parse', 'HEAD'])) === job.from],
    ['target', (await value(['rev-parse', '--verify', '-q', TARGET_REF])) === job.to],
    ['clean', (await git(['status', '--porcelain=v1', '--untracked-files=normal'])).out.trim() === ''],
    job.mode === 'ff'
      ? ['fast-forward', (await git(['merge-base', '--is-ancestor', job.from, job.to])).code === 0]
      : ['backup', (await value(['rev-parse', '--verify', '-q', `refs/heads/${job.backup}`])) === job.from],
  ];
  const broken = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (broken.length > 0) return fail('check', `The checkout changed before the install: ${broken.join(', ')}`, true);
  const cli = npmCli(process.execPath, job.npmCli);
  if (!cli) return fail('check', `npm was not found next to Node.js (${process.execPath}).`, true);

  const npm = async (args: string[], timeout: number) => {
    let r = await run(process.execPath, [cli, ...args], job.root, ENV, timeout);
    // A file the closing hub still held: tried again once it is surely gone.
    for (let i = 0; i < 2 && r.code !== 0 && retryable(r.out); i++) {
      await sleep(5000);
      r = await run(process.execPath, [cli, ...args], job.root, ENV, timeout);
    }
    log(`npm ${args[0]}: ${r.code}`);
    return r;
  };
  const build = () => npm(['run', 'build'], 5 * 60_000);
  // Electron fetches its binary on its first start (`electron .`), not when npm installs it: the hub restarts it
  // directly, so it is fetched here, by the installer of the electron package npm just installed.
  const electronInstaller = join(job.root, 'node_modules', 'electron', 'install.js');
  const ci = async () => {
    const r = await npm(['ci', '--no-audit', '--no-fund', '--prefer-offline'], 15 * 60_000);
    if (r.code !== 0 || existsSync(job.relaunch.exe) || !existsSync(electronInstaller)) return r;
    const e = await run(process.execPath, [electronInstaller], job.root, ENV, 10 * 60_000);
    log(`electron install: ${e.code}`);
    return existsSync(job.relaunch.exe) ? e : { code: e.code || 1, out: `${r.out}\n${e.out}` };
  };

  // The build that ran, kept aside: put back as it was if anything fails.
  const dist = join(job.root, 'dist');
  const kept = file('dist-previous');
  rmSync(kept, { recursive: true, force: true });
  const hasKept = existsSync(dist);
  if (hasKept) cpSync(dist, kept, { recursive: true });

  /** Back to the commit, dependencies and build of before; true when all of it is back. */
  const undo = async (reinstall: boolean): Promise<boolean> => {
    let ok = true;
    if ((await value(['rev-parse', 'HEAD'])) !== job.from) ok = (await git(['reset', '--keep', job.from])).code === 0;
    if (reinstall) ok = (await ci()).code === 0 && ok;
    if (hasKept) {
      try {
        rmSync(dist, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
        cpSync(kept, dist, { recursive: true });
      } catch (err) {
        log(`dist not restored: ${(err as Error).message}`);
        ok = (await build()).code === 0 && ok;
      }
    } else ok = (await build()).code === 0 && ok;
    return ok;
  };

  const moved = job.mode === 'ff' ? await git(['merge', '--ff-only', '--no-edit', job.to]) : await git(['reset', '--keep', job.to]);
  if (moved.code !== 0) return fail('git', moved.out, await undo(false));
  if (job.lockChanged) {
    const r = await ci();
    if (r.code !== 0) return fail('install', r.out, await undo(true));
  }
  const built = await build();
  if (built.code !== 0) return fail('build', built.out, await undo(job.lockChanged));
  return { ok: true, step: '', at: Date.now(), restored: false, detail: '', to: job.to };
}

/** Starts the hub again, as it was started, when the install was asked from it or a start came meanwhile. */
function restart(job: UpdateJob): void {
  const asked = existsSync(file('relaunch'));
  rmSync(file('relaunch'), { force: true });
  if (!job.restart && !asked) return;
  const { exe, args, cwd } = job.relaunch;
  const child = spawn(exe, args, { cwd, env: ENV, detached: true, stdio: 'ignore' });
  child.on('error', (err) => log(`restart failed: ${err.message}`));
  child.unref();
}

async function main(): Promise<void> {
  let job: UpdateJob | null = null;
  try {
    job = parseJob(JSON.parse(readFileSync(jobFile, 'utf8')));
  } catch {
    // Unreadable: refused below.
  }
  if (!job) return log('invalid job');
  // One install at a time; a hub started meanwhile finds this file and leaves the restart to us. A lock left by a
  // helper that died (the computer shut down mid-install) is taken over.
  if (lockHeld(dir)) return log('another install is running');
  const beat = () => writeFileSync(file('helper.lock'), JSON.stringify({ pid: process.pid, at: Date.now() }));
  beat();
  const beating = setInterval(beat, LOCK_BEAT_MS);
  let result: UpdateResult;
  try {
    const until = Date.now() + 90_000;
    while (alive(job.appPid) && Date.now() < until) await sleep(250);
    if (alive(job.appPid)) {
      result = { ok: false, step: 'check', at: Date.now(), restored: true, detail: 'The hub did not close.', to: job.to };
    } else {
      // Its sessions' processes close a moment after it.
      await sleep(1500);
      result = await install(job);
    }
  } catch (err) {
    result = { ok: false, step: 'check', at: Date.now(), restored: false, detail: redact(String((err as Error).stack ?? err)), to: job.to };
  }
  try {
    log(`done: ${result.ok ? 'installed' : `failed at ${result.step}, restored: ${result.restored}`}`);
    writeFileSync(file('result.json'), JSON.stringify(result));
    rmSync(jobFile, { force: true });
  } finally {
    clearInterval(beating);
    rmSync(file('helper.lock'), { force: true });
  }
  // After the lock is gone: a hub that started meanwhile either saw the lock (and asked for this restart) or not.
  if (alive(job.appPid)) return;
  restart(job);
}

void main();
