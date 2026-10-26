import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { npmCliCandidates } from './updateLogic';

// Running npm for an update, and the helper's lock, shared by the hub and the helper (no Electron): always an
// argument list, never a shell.

/** Runs a program, its output kept to the last 20 000 characters; `code` is -1 when it could not start or timed out. */
export function run(exe: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let out = '';
    const keep = (chunk: Buffer) => (out = (out + chunk.toString()).slice(-20_000));
    const child = spawn(exe, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, out: `${out}\n${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out });
    });
  });
}

/** npm's CLI script for this Node.js (run as `node npm-cli.js`: npm's own .cmd needs a shell on Windows), or empty. */
export const npmCli = (node: string, execPath: string) => npmCliCandidates(node, process.platform, execPath).find((p) => existsSync(p)) ?? '';

/** The environment of the hub for npm and a restart, without the variables of the `npm start` that ran it. */
export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const key of Object.keys(out)) {
    if ((key.startsWith('npm_') && !key.startsWith('npm_config_')) || key === 'INIT_CWD' || key === 'ELECTRON_RUN_AS_NODE') delete out[key];
  }
  return out;
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The helper rewrites its lock this often while it works; a lock left longer than LOCK_STALE_MS is a dead one's. */
export const LOCK_BEAT_MS = 30_000;
const LOCK_STALE_MS = 2 * 60_000;

/** A helper is at work in this update folder: its lock is fresh and its process alive. */
export function lockHeld(dir: string): boolean {
  try {
    const { pid, at } = JSON.parse(readFileSync(join(dir, 'helper.lock'), 'utf8')) as { pid: unknown; at: unknown };
    return typeof pid === 'number' && typeof at === 'number' && Date.now() - at < LOCK_STALE_MS && alive(pid);
  } catch {
    return false;
  }
}
