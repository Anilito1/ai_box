import { open } from 'node:fs/promises';
import { portOf } from '../shared/backgroundTask';

/** A shell the model started in the background: what it said it was (the task's description), its command, its output file. */
export interface BackgroundRun {
  description: string;
  command: string;
  outputFile: string;
}

const TAIL_BYTES = 8192;
const OUTPUT_FILE = /Output is being written to:\s*(\S+?)\.?(?:\s|$)/;

/** The run a Bash call starts when it asks to go on in the background, else null. */
export function runOf(name: unknown, input: unknown): BackgroundRun | null {
  const i = (input ?? {}) as Record<string, unknown>;
  if (name !== 'Bash' || i.run_in_background !== true) return null;
  return { description: String(i.description ?? ''), command: String(i.command ?? ''), outputFile: '' };
}

/** "Command running in background with ID: x. Output is being written to: /tmp/…/x.output" → the file. */
export function outputFileOf(result: string): string {
  return OUTPUT_FILE.exec(result)?.[1] ?? '';
}

async function tail(file: string): Promise<string> {
  try {
    const handle = await open(file, 'r');
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, TAIL_BYTES);
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, size - length);
      return buf.toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}

/** The port a run serves on: named in its command, else printed in its output ("http://localhost:8821"). */
export async function portOfRun(run: BackgroundRun): Promise<number | null> {
  return portOf(run.command) ?? (run.outputFile ? portOf(await tail(run.outputFile)) : null);
}

/** The run behind a task: the CLI names a shell task by the call's description, else by its command. */
export function runFor(label: string, runs: Iterable<BackgroundRun>): BackgroundRun | undefined {
  const all = [...runs];
  return all.find((r) => r.description === label) ?? all.find((r) => r.command === label);
}
