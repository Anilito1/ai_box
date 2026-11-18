import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

// Windows job objects, without a native module: one PowerShell process, kept for the life of the hub, calls the
// kernel for it. A job holds a program and everything started under it, whoever the parent was: a process whose
// parent has ended is still in it, which no walk through parent PIDs can tell.
//
// Each job is named, and the helper gives a handle of it to the hub's own process. So the helper ending changes
// nothing (another one opens the job again by its name), and the hub ending, however it ends, closes the last handle:
// Windows then ends what the job still holds. Nothing a session started outlives the hub.
//
// The same process lists every process of Windows in a few milliseconds, where a PowerShell started for each listing
// takes seconds, and longer than its timeout on a loaded machine.

const SOURCE = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class HubJobs {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attrs, string name);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref EXT info, uint len);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, IntPtr info, uint len, IntPtr ret);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr fromProc, IntPtr handle, IntPtr toProc, out IntPtr copy, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr proc, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr proc, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32FirstW(IntPtr snap, ref ENTRY e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32NextW(IntPtr snap, ref ENTRY e);
  [StructLayout(LayoutKind.Sequential)] struct BASIC { public long PerProcessTime, PerJobTime; public uint LimitFlags; public UIntPtr MinSet, MaxSet; public uint ActiveLimit; public UIntPtr Affinity; public uint Priority, Scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct EXT { public BASIC Basic; public IO Io; public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct ENTRY { public uint size, usage, pid; public IntPtr heap; public uint module, threads, ppid; public int priority; public uint flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string exe; }
  struct P { public int pid, ppid; public long created; }
  static readonly Dictionary<string, IntPtr> jobs = new Dictionary<string, IntPtr>();
  // The handle of each job in the owner's process, as that process numbers it.
  static readonly Dictionary<string, IntPtr> given = new Dictionary<string, IntPtr>();
  public static int Owner;

  // A new job goes to the owner too, and only then ends its processes when its last handle closes: never on the
  // helper's handle alone, whose end must change nothing.
  static IntPtr Job(string name, bool create) {
    IntPtr job;
    if (jobs.TryGetValue(name, out job)) return job;
    job = create ? CreateJobObjectW(IntPtr.Zero, name) : OpenJobObjectW(0x000D, false, name);
    bool made = create && job != IntPtr.Zero && Marshal.GetLastWin32Error() != 183;
    if (job == IntPtr.Zero) return job;
    jobs[name] = job;
    if (!made) return job;
    IntPtr owner = OpenProcess(0x0040, false, Owner);
    if (owner == IntPtr.Zero) return job;
    try {
      IntPtr copy;
      if (!DuplicateHandle(GetCurrentProcess(), job, owner, out copy, 0, false, 2)) return job;
      given[name] = copy;
      var info = new EXT(); info.Basic.LimitFlags = 0x2000;
      SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(EXT)));
    } finally { CloseHandle(owner); }
    return job;
  }

  static List<P> List() {
    var all = new List<P>();
    IntPtr snap = CreateToolhelp32Snapshot(2, 0);
    if (snap == new IntPtr(-1)) throw new Exception("snapshot " + Marshal.GetLastWin32Error());
    try {
      var e = new ENTRY(); e.size = (uint)Marshal.SizeOf(typeof(ENTRY));
      for (bool ok = Process32FirstW(snap, ref e); ok; ok = Process32NextW(snap, ref e)) {
        long created = 0, x, k, u;
        uint code = 259;
        IntPtr h = OpenProcess(0x1000, false, (int)e.pid);
        // A process that has ended stays listed for a moment, or while another one holds a handle of it: it can no
        // longer be opened (87), or it has an exit code. One that is refused (a system process) runs, its birth unknown.
        if (h == IntPtr.Zero) { if (Marshal.GetLastWin32Error() == 87) continue; }
        else { if (!GetProcessTimes(h, out created, out x, out k, out u)) created = 0; GetExitCodeProcess(h, out code); CloseHandle(h); }
        if (code == 259) all.Add(new P { pid = (int)e.pid, ppid = (int)e.ppid, created = created });
      }
    } finally { CloseHandle(snap); }
    return all;
  }

  public static string Procs() {
    var sb = new StringBuilder();
    foreach (var p in List()) sb.Append(p.pid).Append(' ').Append(p.ppid).Append(' ').Append(p.created).Append(';');
    return sb.ToString();
  }

  static bool Put(IntPtr job, int pid) {
    IntPtr proc = OpenProcess(0x0101, false, pid);
    if (proc == IntPtr.Zero) return false;
    try { return AssignProcessToJobObject(job, proc); } finally { CloseHandle(proc); }
  }

  // The process, then what it had already started (each one born after its parent): they join the job too.
  public static string Assign(string name, int pid) {
    IntPtr job = Job(name, true);
    if (job == IntPtr.Zero) throw new Exception("create " + Marshal.GetLastWin32Error());
    if (!Put(job, pid)) throw new Exception("assign " + Marshal.GetLastWin32Error());
    var all = List();
    var born = new Dictionary<int, long>();
    foreach (var p in all) born[p.pid] = p.created;
    var seen = new HashSet<int> { pid };
    var level = new HashSet<int> { pid };
    int late = 0;
    while (level.Count > 0) {
      var next = new HashSet<int>();
      foreach (var p in all) {
        if (!level.Contains(p.ppid) || seen.Contains(p.pid) || p.created == 0 || p.created < born[p.ppid]) continue;
        seen.Add(p.pid);
        next.Add(p.pid);
        if (Put(job, p.pid)) late++;
      }
      level = next;
    }
    return late.ToString();
  }

  public static string Pids(string name) {
    IntPtr job = Job(name, false);
    if (job == IntPtr.Zero) return "";
    int size = 8 + 4096 * IntPtr.Size;
    IntPtr buf = Marshal.AllocHGlobal(size);
    try {
      if (!QueryInformationJobObject(job, 3, buf, (uint)size, IntPtr.Zero)) throw new Exception("query " + Marshal.GetLastWin32Error());
      int n = Marshal.ReadInt32(buf, 4);
      var sb = new StringBuilder();
      for (int i = 0; i < n; i++) sb.Append(Marshal.ReadIntPtr(buf, 8 + i * IntPtr.Size).ToInt64()).Append(' ');
      return sb.ToString().Trim();
    } finally { Marshal.FreeHGlobal(buf); }
  }

  // Ends every process of the job and lets go of it, the owner's handle included.
  public static string End(string name) {
    IntPtr job = Job(name, false);
    if (job == IntPtr.Zero) return "0";
    string left = Pids(name);
    bool ok = TerminateJobObject(job, 1);
    int err = Marshal.GetLastWin32Error();
    CloseHandle(job);
    jobs.Remove(name);
    IntPtr copy;
    if (given.TryGetValue(name, out copy)) {
      given.Remove(name);
      IntPtr owner = OpenProcess(0x0040, false, Owner);
      if (owner != IntPtr.Zero) { IntPtr none; DuplicateHandle(owner, copy, IntPtr.Zero, out none, 0, false, 1); CloseHandle(owner); }
    }
    if (!ok) throw new Exception("terminate " + err);
    return left.Length == 0 ? "0" : left.Split(' ').Length.ToString();
  }
}`;

// The source comes as the first line of the input, in base64: the command line stays short and holds no code of its own.
const LOOP = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine())))',
  '[HubJobs]::Owner = [int][Console]::In.ReadLine()',
  "[Console]::Out.WriteLine('ready')",
  'while ($null -ne ($line = [Console]::In.ReadLine())) {',
  "  $p = $line.Split(' ')",
  '  try {',
  "    $out = switch ($p[1]) { 'assign' { [HubJobs]::Assign($p[2], [int]$p[3]) } 'pids' { [HubJobs]::Pids($p[2]) } 'end' { [HubJobs]::End($p[2]) } 'procs' { [HubJobs]::Procs() } default { throw 'unknown' } }",
  '    [Console]::Out.WriteLine("$($p[0]) ok $out")',
  '  } catch { [Console]::Out.WriteLine("$($p[0]) err $($_.Exception.Message)") }',
  '}',
].join('\n');

/** The helper compiles its calls when it starts: a few seconds on a loaded machine. */
const START_TIMEOUT_MS = 30_000;
const ANSWER_TIMEOUT_MS = 5_000;
/** A helper that ended is started again at the next call, but not in a loop. */
const RESTART_EVERY_MS = 60_000;
const JOB_NAME = /^[A-Za-z0-9-]{1,80}$/;

export class WinJobs {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<boolean> | null = null;
  private startedAt = 0;
  private seq = 0;
  private readonly waiting = new Map<string, (out: string | null) => void>();

  /** `owner`: the process whose end ends what the jobs hold (the hub itself). */
  constructor(private readonly owner = process.pid) {}

  /** Starts the helper ahead of its first use. */
  warm(): void {
    void this.up();
  }

  private up(): Promise<boolean> {
    if (process.platform !== 'win32') return Promise.resolve(false);
    if (this.ready && (this.child || Date.now() - this.startedAt < RESTART_EVERY_MS)) return this.ready;
    this.startedAt = Date.now();
    this.ready = new Promise<boolean>((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', LOOP], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch {
        return resolve(false);
      }
      this.child = child;
      // The hub (or a test) never waits for it to exit.
      child.unref();
      for (const stream of [child.stdin, child.stdout, child.stderr] as unknown as { unref?(): void }[]) stream.unref?.();
      const late = setTimeout(() => child.kill(), START_TIMEOUT_MS);
      late.unref();
      const gone = () => {
        clearTimeout(late);
        if (this.child === child) this.child = null;
        resolve(false);
        for (const answer of this.waiting.values()) answer(null);
        this.waiting.clear();
      };
      child.on('error', gone);
      child.on('exit', gone);
      child.stdin.on('error', () => undefined);
      child.stderr.resume();
      createInterface({ input: child.stdout }).on('line', (line) => {
        if (line === 'ready') {
          clearTimeout(late);
          return resolve(true);
        }
        const [id, status] = line.split(' ', 2);
        const answer = this.waiting.get(id);
        this.waiting.delete(id);
        answer?.(status === 'ok' ? line.slice(id.length + 4) : null);
      });
      child.stdin.write(`${Buffer.from(SOURCE, 'utf8').toString('base64')}\n${this.owner}\n`);
    });
    return this.ready;
  }

  /** The helper's answer, null when it has none (not Windows, helper gone, call refused, too late). */
  private async ask(command: string): Promise<string | null> {
    if (!(await this.up()) || !this.child) return null;
    const id = String(++this.seq);
    return new Promise((resolve) => {
      const late = setTimeout(() => {
        this.waiting.delete(id);
        resolve(null);
      }, ANSWER_TIMEOUT_MS);
      late.unref();
      this.waiting.set(id, (out) => {
        clearTimeout(late);
        resolve(out);
      });
      this.child?.stdin.write(`${id} ${command}\n`);
    });
  }

  /** Puts a running process in the job of that name, with what it already started and everything it starts from then on. */
  async assign(job: string, pid: number): Promise<boolean> {
    return JOB_NAME.test(job) && Number.isInteger(pid) && (await this.ask(`assign ${job} ${pid}`)) !== null;
  }

  /** The processes of the job that still run; empty when the job is gone; null when it cannot be told. */
  async pids(job: string): Promise<number[] | null> {
    const out = JOB_NAME.test(job) ? await this.ask(`pids ${job}`) : null;
    return out === null ? null : out.split(' ').filter(Boolean).map(Number);
  }

  /** Ends every process of the job, whoever its parent was: how many still ran, null when it could not be done. */
  async end(job: string): Promise<number | null> {
    const out = JOB_NAME.test(job) ? await this.ask(`end ${job}`) : null;
    return out === null ? null : Number(out);
  }

  /** Every process of Windows as lines of `pid ppid filetime`, null when the helper cannot say. */
  async procs(): Promise<string | null> {
    const out = await this.ask('procs');
    return out === null ? null : out.split(';').join('\n');
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
    this.ready = null;
  }
}

/** The hub's own helper: started at its first use. */
export const winJobs = new WinJobs();
