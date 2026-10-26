import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { release } from 'node:os';
import { join } from 'node:path';
import type { DictationEvent, DictationSupport } from '../../shared/dictation';
import { LineSplitter, parseLine, type DictationEngine, type DictationOptions } from './engine';

/** Where the compiled helper is: next to the app's resources once packaged, else where `npm run build:native` puts it. */
export function helperPath(resources: string, appRoot: string, packaged: boolean): string {
  return packaged ? join(resources, 'dictation-mac') : join(appRoot, 'native', 'dictation-mac', 'build', 'dictation-mac');
}

/** Apple's SpeechAnalyzer needs macOS 26, which is Darwin 25. */
export const appleSupported = (platform = process.platform, kernel = release()): boolean => platform === 'darwin' && Number.parseInt(kernel, 10) >= 25;

/** Asks the helper whether the language is supported and its voice asset installed. */
export function checkApple(helper: string, language: string): Promise<DictationSupport> {
  const none: DictationSupport = { available: false, installed: false };
  if (!appleSupported() || !existsSync(helper)) return Promise.resolve(none);
  return new Promise((resolve) => {
    const child = spawn(helper, ['--check', '--locale', language], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => child.kill(), 5000);
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', () => resolve(none));
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const o = JSON.parse(out.trim().split('\n')[0] ?? '') as { type?: string; available?: boolean; installed?: boolean };
        resolve(o.type === 'check' ? { available: o.available === true, installed: o.installed === true } : none);
      } catch {
        resolve(none);
      }
    });
  });
}

/** SpeechAnalyzer in a helper process (native/dictation-mac): audio on its stdin, one JSON event per line on its stdout. */
export class AppleEngine implements DictationEngine {
  private child: ChildProcessWithoutNullStreams | null = null;
  private listener: (event: DictationEvent) => void = () => undefined;
  private ended = false;
  private killTimer: NodeJS.Timeout | undefined;

  constructor(private readonly helper: string) {}

  onEvent(listener: (event: DictationEvent) => void): void {
    this.listener = listener;
  }

  start({ language, terms }: DictationOptions): void {
    this.cancel();
    this.ended = false;
    const args = ['--locale', language, ...terms.flatMap((t) => ['--term', t])];
    const child = spawn(this.helper, args);
    this.child = child;
    child.stderr.resume();
    const lines = new LineSplitter();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (this.child !== child) return;
      for (const line of lines.push(chunk)) {
        const event = parseLine(line);
        if (event) this.emit(event);
      }
    });
    // A closed pipe (the helper died) must not take the hub down.
    child.stdin.on('error', () => undefined);
    child.on('error', (err) => this.fail(child, 'spawn', err.message));
    child.on('close', (code) => {
      if (this.child !== child) return;
      this.child = null;
      clearTimeout(this.killTimer);
      if (!this.ended) this.fail(child, 'exited', `The dictation helper stopped (${code ?? 'signal'})`);
    });
  }

  feed(pcm: Buffer): void {
    if (this.child && !this.child.stdin.destroyed && !this.ended) this.child.stdin.write(pcm);
  }

  stop(): void {
    const child = this.child;
    if (!child || this.ended) return;
    child.stdin.end();
    // The helper settles the text in a fraction of a second; one that hangs is cut.
    this.killTimer = setTimeout(() => this.fail(child, 'timeout', 'The dictation helper did not answer'), 8000);
  }

  cancel(): void {
    const child = this.child;
    this.child = null;
    this.ended = true;
    clearTimeout(this.killTimer);
    child?.kill();
  }

  private emit(event: DictationEvent): void {
    if (this.ended) return;
    if (event.type === 'final' || event.type === 'error') {
      this.ended = true;
      clearTimeout(this.killTimer);
    }
    this.listener(event);
  }

  private fail(child: ChildProcessWithoutNullStreams, code: string, message: string): void {
    if (this.child !== child && this.child !== null) return;
    this.emit({ type: 'error', code, message });
    this.child = null;
    child.kill();
  }
}
