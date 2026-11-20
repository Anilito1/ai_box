// Runs the read-only collectors. powercfg is called from collect.ps1: PowerShell decodes its output with the console's
// own code page, so nothing switches the terminal to UTF-8 behind the user's back.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const COLLECTOR = fileURLToPath(new URL('./collect.ps1', import.meta.url));
// Absolute paths: a bare name would be searched in the current folder first.
const SYSTEM32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const POWERSHELL = join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const NVIDIA_SMI = join(SYSTEM32, 'nvidia-smi.exe');

function run(file, args, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    // Our own child and what it started (powercfg), nothing else.
    const timer = setTimeout(() => spawnSync('taskkill.exe', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true }), timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr: stderr + String(e) });
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

/** The CIM/registry/process/powercfg collector, parsed from the JSON file it writes in a temporary folder. The folder
 *  goes away even when the audit is interrupted (Ctrl+C). */
export async function collect(sampleSeconds) {
  const dir = mkdtempSync(join(tmpdir(), 'energy-audit-'));
  const clean = () => rmSync(dir, { recursive: true, force: true });
  const interrupted = () => {
    clean();
    process.exit(130);
  };
  process.once('exit', clean).once('SIGINT', interrupted).once('SIGTERM', interrupted);
  try {
    const file = join(dir, 'collect.json');
    const r = await run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', COLLECTOR, '-SampleSeconds', String(sampleSeconds), '-OutFile', file]);
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      throw new Error(`collect.ps1 failed (status ${r.status}): ${(r.stderr || r.stdout).slice(0, 500)}`);
    }
  } finally {
    clean();
    process.off('exit', clean).off('SIGINT', interrupted).off('SIGTERM', interrupted);
  }
}

/** NVIDIA cards through the driver's nvidia-smi; null when there is none. Called after the process sample, so its own
 *  start-up does not show in it. */
export async function nvidiaSmi(gpus = []) {
  if (!gpus.some((g) => /nvidia/i.test(g?.name ?? '')) || !existsSync(NVIDIA_SMI)) return null;
  const fields = 'name,pstate,power.draw,power.limit,utilization.gpu,temperature.gpu,clocks.mem';
  const r = await run(NVIDIA_SMI, [`--query-gpu=${fields}`, '--format=csv,noheader,nounits'], { timeoutMs: 20_000 });
  return r.status === 0 ? parseNvidiaSmi(r.stdout) : null;
}

export function parseNvidiaSmi(text) {
  const n = (v) => (v === undefined || v.trim() === '' || /n\/a|not supported|\[/i.test(v) ? null : Number(v));
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => {
      const [name, pstate, power, limit, util, temp, mem] = l.split(',').map((s) => s.trim());
      return { name, pstate, powerW: n(power), limitW: n(limit), util: n(util), tempC: n(temp), memMHz: n(mem) };
    });
}
