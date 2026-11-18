import { execFile } from 'node:child_process';
import { alive } from './updateExec';
import { winJobs } from './winJobs';

/** A process as Windows lists it; `created` in ms since the epoch. */
export interface Proc {
  pid: number;
  ppid: number;
  created: number;
}

/** The process a session's program runs in, stamped by the hub when it was spawned. */
export interface CliProc {
  pid: number;
  startedAt: number;
  /** When it was closed, or last known to run (an earlier run of the hub): its children are those born before. */
  endedAt?: number;
  /** The Windows job that holds it and everything started under it, once it was put there (winJobs.ts). */
  job?: string;
}

/** The hub stamps a program when spawn() returns, a moment after Windows created it. */
const STAMP_SLACK_MS = 5_000;
/** How long closed programs get to end on their own (the SDK kills Claude Code after 5 s), SessionEnd hooks included. */
export const EXIT_WAIT_MS = 8_000;
const LIST_TIMEOUT_MS = 10_000;
const KILL_SETTLE_MS = 250;
const LIST_SCRIPT =
  "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }) }";
/** Windows file times count 100 ns from 1601. */
const FILETIME_EPOCH_MS = 11_644_473_600_000;

/** Lines of `pid ppid filetime`; anything else is skipped. */
export function parseProcs(out: string): Proc[] {
  const procs: Proc[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\d+) (\d+) (\d+)$/.exec(line.trim());
    if (!m) continue;
    const ft = Number(m[3]);
    procs.push({ pid: Number(m[1]), ppid: Number(m[2]), created: ft > 0 ? ft / 10_000 - FILETIME_EPOCH_MS : 0 });
  }
  return procs;
}

/**
 * Every process the program started, and theirs, still running; never the program itself. Windows keeps a dead
 * parent's PID in its children, so a child is one that names the program and was created between its start and
 * `until` (when it was last known to run): a PID reused since by another process never brings in that one's children.
 * Below, a process names its parent and was created after it. One whose own parent ended first is out of reach.
 */
export function leftBehind(procs: Proc[], root: CliProc, until = Infinity): Proc[] {
  const holder = procs.find((p) => p.pid === root.pid);
  // A holder whose birth is unknown (0) says nothing of when the PID changed hands: `until` alone bounds the children.
  const reused = holder && holder.created > 0 && Math.abs(holder.created - root.startedAt) > STAMP_SLACK_MS ? holder.created : Infinity;
  const end = Math.min(until, reused);
  const found: Proc[] = [];
  const seen = new Set<number>([root.pid, process.pid]);
  let level = procs.filter((p) => p.ppid === root.pid && p.created >= root.startedAt - STAMP_SLACK_MS && p.created < end);
  while (level.length > 0) {
    const next: Proc[] = [];
    for (const p of level) {
      if (seen.has(p.pid)) continue;
      seen.add(p.pid);
      found.push(p);
      next.push(...procs.filter((c) => c.ppid === p.pid && c.created >= p.created));
    }
    level = next;
  }
  return found;
}

/**
 * Every process of Windows, null elsewhere or when it cannot be listed. The hub's helper answers in milliseconds; a
 * PowerShell started for the listing is the way without it.
 */
export async function listProcs(): Promise<Proc[] | null> {
  if (process.platform !== 'win32') return null;
  const listed = await winJobs.procs();
  if (listed !== null) return parseProcs(listed);
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', LIST_SCRIPT], { windowsHide: true, timeout: LIST_TIMEOUT_MS, maxBuffer: 16_000_000 }, (err, out) =>
      resolve(err ? null : parseProcs(out)),
    );
  });
}

function kill(procs: Proc[]): void {
  for (const p of procs) {
    try {
      process.kill(p.pid);
    } catch {
      // Ended meanwhile.
    }
  }
}

/** The program itself still runs under its PID (not another process that got the PID since). */
const running = (procs: Proc[], root: CliProc) => procs.some((p) => p.pid === root.pid && Math.abs(p.created - root.startedAt) <= STAMP_SLACK_MS);

export interface Reaped {
  ended: number;
  /** Processes still there after the last try. */
  left: number;
  /** Programs not cleared now (still running, or the processes could not be listed): to try again later. */
  kept: CliProc[];
}

/**
 * Once closed programs have ended (or `waitMs` has passed), ends what they left running: background shells, dev
 * servers, MCP servers, test browsers. A program still running is neither killed nor cleared: it is kept. First what
 * its job holds, which includes a process whose parent has ended; then the descendants found through their parent,
 * for what started before the program was in its job. Each try lists the processes again and takes the descendants
 * anew, so one started meanwhile is not missed. Windows only.
 */
export async function reapTrees(roots: CliProc[], waitMs = EXIT_WAIT_MS): Promise<Reaped> {
  if (process.platform !== 'win32' || roots.length === 0) return { ended: 0, left: 0, kept: [] };
  for (const end = Date.now() + waitMs; roots.some((r) => alive(r.pid)) && Date.now() < end; ) await new Promise((r) => setTimeout(r, 250));
  const now = Date.now();
  const limit = (r: CliProc) => (r.endedAt ?? now) + EXIT_WAIT_MS;
  let inJobs = 0;
  for (const root of roots) {
    if (!root.job) continue;
    const held = await winJobs.pids(root.job);
    // The program itself is in its job: while it runs, nothing of it is ended. (A job may still list, for a moment,
    // a program that has just ended.)
    if (held === null || (held.includes(root.pid) && alive(root.pid))) continue;
    inJobs += (await winJobs.end(root.job)) ?? 0;
  }
  const killed = new Set<number>();
  let gone = roots;
  let kept: CliProc[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const procs = await listProcs();
    if (!procs) return { ended: inJobs + killed.size, left: 0, kept: attempt === 0 ? roots : kept };
    if (attempt === 0) {
      kept = roots.filter((r) => running(procs, r));
      gone = roots.filter((r) => !kept.includes(r));
    }
    const doomed = new Map<number, Proc>();
    for (const root of gone) for (const p of leftBehind(procs, root, limit(root))) doomed.set(p.pid, p);
    if (doomed.size === 0 || attempt === 2) return { ended: inJobs + [...killed].filter((pid) => !doomed.has(pid)).length, left: doomed.size, kept };
    kill([...doomed.values()]);
    for (const pid of doomed.keys()) killed.add(pid);
    // A killed process takes a moment to end: the next listing would still show it.
    await new Promise((r) => setTimeout(r, KILL_SETTLE_MS));
  }
  return { ended: inJobs + killed.size, left: 0, kept };
}
