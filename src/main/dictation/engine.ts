import type { DictationEvent } from '../../shared/dictation';

export interface DictationOptions {
  /** BCP 47 tag of the spoken language. */
  language: string;
  /** Names and jargon the engine should favour. */
  terms: string[];
}

/**
 * A speech-to-text engine for one dictation at a time. Today Apple's on-device one (apple.ts); a cloud engine or one
 * for Windows plugs in behind the same few calls.
 *
 * The audio is 16 kHz mono 16-bit little-endian PCM, as it comes from the window. Events: `ready` once audio is
 * welcome (feed() before that is kept), `partial` with the whole text so far, then `final` after stop(), or `error`.
 * After `final`, `error` or cancel() the engine is done: start() again for the next dictation.
 */
export interface DictationEngine {
  start(options: DictationOptions): void;
  feed(pcm: Buffer): void;
  /** The audio has ended: the engine settles the text and sends `final`. */
  stop(): void;
  /** Drops the dictation with no event after it. */
  cancel(): void;
  onEvent(listener: (event: DictationEvent) => void): void;
}

/** What `parseLine` makes of a line the helper wrote: an event, or null for anything else. */
export function parseLine(line: string): DictationEvent | null {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const { type, text, code, message } = o as Record<string, unknown>;
  if (type === 'ready') return { type };
  if ((type === 'partial' || type === 'final') && typeof text === 'string') return { type, text };
  if (type === 'error') return { type, code: typeof code === 'string' ? code : 'unknown', message: typeof message === 'string' ? message : '' };
  return null;
}

/** Cuts a byte stream into lines, whatever the way it was chunked. */
export class LineSplitter {
  private rest = '';
  push(chunk: string): string[] {
    const parts = (this.rest + chunk).split('\n');
    this.rest = parts.pop() ?? '';
    return parts.filter((l) => l.trim() !== '');
  }
}
