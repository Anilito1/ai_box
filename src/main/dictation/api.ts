import type { DictationEvent, SttPreset } from '../../shared/dictation';
import type { DictationEngine, DictationOptions } from './engine';

/** Where a dictation is sent. The key stays in the main process: it goes nowhere but in this request's header. */
export interface ApiTarget {
  protocol: SttPreset['protocol'];
  /** Up to the version (`https://api.groq.com/openai/v1`), no trailing slash. */
  baseUrl: string;
  model: string;
  key: string;
}

const SAMPLE_RATE = 16_000;
/** 12 minutes of 16 kHz 16-bit mono (23 MB as WAV): under the 25 MB the services take. Audio past it is dropped. */
export const MAX_PCM_BYTES = 12 * 60 * SAMPLE_RATE * 2;
/** Under 0.3 s there is no word to look for: nothing is sent. */
export const MIN_PCM_BYTES = Math.round(0.3 * SAMPLE_RATE * 2);
/** Groq answers in a fraction of a second, OpenAI in a few; a request still open after this is given up. */
const TIMEOUT_MS = 45_000;
/** Whisper reads only the end of a long prompt (224 tokens): the terms are cut well under. */
const PROMPT_MAX = 400;

/** The PCM wrapped in a WAV header: the one container every service reads. */
export function wav(pcm: Buffer): Buffer {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(SAMPLE_RATE, 24);
  head.writeUInt32LE(SAMPLE_RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

/** The language as the services name it: ISO 639-1 (`fr`), but xAI keeps European Spanish and Portuguese apart. */
export function languageFor(protocol: ApiTarget['protocol'], tag: string): string {
  const [base = '', region = ''] = tag.split('-');
  const short = base.toLowerCase();
  if (protocol === 'xai' && ((short === 'es' && region === 'ES') || (short === 'pt' && region === 'PT'))) return `${short}-${region}`;
  return short;
}

/** The request: its address and its form, the options first and the audio last (xAI reads them in that order). */
export function transcriptionRequest(target: ApiTarget, options: DictationOptions, audio: Buffer): { url: string; form: FormData } {
  const form = new FormData();
  if (target.model) form.append('model', target.model);
  form.append('language', languageFor(target.protocol, options.language));
  if (target.protocol === 'xai') {
    for (const term of options.terms.slice(0, 100)) form.append('keyterm', term.slice(0, 50));
  } else {
    let prompt = '';
    for (const term of options.terms) if (prompt.length + term.length + 2 <= PROMPT_MAX) prompt += (prompt ? ', ' : '') + term;
    if (prompt) form.append('prompt', prompt);
    form.append('response_format', 'json');
  }
  form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'dictation.wav');
  return { url: `${target.baseUrl}/${target.protocol === 'xai' ? 'stt' : 'audio/transcriptions'}`, form };
}

/** A refusal as a code the window has words for, with the service's own message (never the key: it is not in it). */
export function errorOf(status: number, body: string): { code: string; message: string } {
  let message = '';
  try {
    const o = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    const m = typeof o.error === 'string' ? o.error : (o.error?.message ?? o.message);
    if (typeof m === 'string') message = m;
  } catch {
    // Not JSON: the status says enough.
  }
  const code = status === 401 || status === 403 ? 'auth' : status === 404 ? 'model' : status === 413 ? 'too-long' : status === 429 ? 'rate' : status >= 500 ? 'service' : 'request';
  return { code, message: message.slice(0, 300) || `HTTP ${status}` };
}

/** The text of an answer: `{ text }` for every protocol. */
export function textOf(body: string): string | null {
  try {
    const o = JSON.parse(body) as { text?: unknown };
    return typeof o.text === 'string' ? o.text : null;
  } catch {
    return null;
  }
}

/**
 * A transcription service reached over HTTPS (OpenAI-compatible, or xAI's): the audio is kept while the user speaks
 * and sent in one request once it ends. No partial text: `final` comes with the service's answer.
 */
export class ApiEngine implements DictationEngine {
  private listener: (event: DictationEvent) => void = () => undefined;
  private chunks: Buffer[] = [];
  private size = 0;
  private options: DictationOptions = { language: 'en', terms: [] };
  /** Listening: start() was called, and neither stop() nor cancel() yet. */
  private open = false;
  private ended = true;
  private request: AbortController | null = null;

  constructor(
    private readonly target: ApiTarget,
    private readonly send: typeof fetch = fetch,
  ) {}

  onEvent(listener: (event: DictationEvent) => void): void {
    this.listener = listener;
  }

  start(options: DictationOptions): void {
    this.cancel();
    this.options = options;
    this.chunks = [];
    this.size = 0;
    this.open = true;
    this.ended = false;
    this.emit({ type: 'ready' });
  }

  feed(pcm: Buffer): void {
    if (!this.open || this.size + pcm.length > MAX_PCM_BYTES) return;
    this.chunks.push(pcm);
    this.size += pcm.length;
  }

  stop(): void {
    if (!this.open) return;
    this.open = false;
    const pcm = Buffer.concat(this.chunks);
    this.chunks = [];
    if (pcm.length < MIN_PCM_BYTES) return this.emit({ type: 'final', text: '' });
    void this.transcribe(pcm);
  }

  cancel(): void {
    this.open = false;
    this.ended = true;
    this.chunks = [];
    this.request?.abort();
    this.request = null;
  }

  private async transcribe(pcm: Buffer): Promise<void> {
    const request = new AbortController();
    this.request = request;
    const timer = setTimeout(() => request.abort(), TIMEOUT_MS);
    try {
      const { url, form } = transcriptionRequest(this.target, this.options, wav(pcm));
      const r = await this.send(url, { method: 'POST', headers: { Authorization: `Bearer ${this.target.key}` }, body: form, signal: request.signal, redirect: 'error' });
      const body = await r.text();
      if (this.request !== request) return;
      if (!r.ok) return this.emit({ type: 'error', ...errorOf(r.status, body) });
      const text = textOf(body);
      this.emit(text === null ? { type: 'error', code: 'service', message: 'Unreadable answer' } : { type: 'final', text });
    } catch (err) {
      if (this.request !== request) return;
      const timedOut = request.signal.aborted;
      this.emit({ type: 'error', code: timedOut ? 'timeout' : 'network', message: timedOut ? 'No answer' : err instanceof Error ? err.message : String(err) });
    } finally {
      clearTimeout(timer);
      if (this.request === request) this.request = null;
    }
  }

  private emit(event: DictationEvent): void {
    if (this.ended) return;
    if (event.type === 'final' || event.type === 'error') this.ended = true;
    this.listener(event);
  }
}
