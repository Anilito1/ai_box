// Runs the read-only collectors. powercfg is called from collect.ps1: PowerShell decodes its output with the console's
// own code page, so nothing switches the terminal to UTF-8 behind the user's back.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const COLLECTOR = fileURLToPath(new URL('./collect.ps1', import.meta.url));

function run(file, args, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill(), timeoutMs);
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

/** The CIM/registry/process/powercfg collector, parsed from the JSON file it writes in a temporary folder. */
export async function collect(sampleSeconds) {
  const dir = mkdtempSync(join(tmpdir(), 'energy-audit-'));
  try {
    const file = join(dir, 'collect.json');
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', COLLECTOR, '-SampleSeconds', String(sampleSeconds), '-OutFile', file]);
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      throw new Error(`collect.ps1 failed (status ${r.status}): ${(r.stderr || r.stdout).slice(0, 500)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** NVIDIA cards through nvidia-smi when the driver ships it; null otherwise. */
export async function nvidiaSmi() {
  const fields = 'name,pstate,power.draw,power.limit,utilization.gpu,temperature.gpu,clocks.mem';
  const r = await run('nvidia-smi', [`--query-gpu=${fields}`, '--format=csv,noheader,nounits'], { timeoutMs: 20_000 });
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
