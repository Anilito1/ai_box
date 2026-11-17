import { randomUUID } from 'node:crypto';

export type DeliveryState = 'queued' | 'sent' | 'acknowledged' | 'failed' | 'unknown';
export interface InboxEntry<T> {
  id: string;
  value: T;
  state: DeliveryState;
  createdAt: number;
  updatedAt: number;
}

/** Push stream with an explicit delivery journal. Consuming is not acknowledging. */
export class Inbox<T> implements AsyncIterable<T> {
  private waiting: ((r: IteratorResult<T>) => void) | null = null;
  private closed = false;
  private paused = false;

  constructor(readonly entries: InboxEntry<T>[] = [], private readonly changed: () => void = () => undefined) {}

  /** A crash after send may have delivered the input: retain it, never replay it blindly. */
  static recover<T>(entries: InboxEntry<T>[]): InboxEntry<T>[] {
    return entries.map(entry => entry.state === 'sent' ? { ...entry, state: 'unknown', updatedAt: Date.now() } : entry);
  }

  /** Inputs still on their way to this stream's process; an unknown one went to a process that is gone, nothing waits for it. */
  get pending(): number { return this.entries.filter(e => e.state === 'queued' || e.state === 'sent').length; }

  push(value: T, id: string = randomUUID()): string {
    if (this.closed) throw new Error('Inbox is closed');
    const at = Date.now();
    const entry: InboxEntry<T> = { id, value, state: 'queued', createdAt: at, updatedAt: at };
    this.entries.push(entry);
    try { this.changed(); } catch (error) { this.entries.pop(); throw error; }
    this.drain();
    return id;
  }

  /** IDs can be supplied by future provider protocols; today's text echo is matched in FIFO order. */
  acknowledge(match: string | ((value: T) => boolean)): boolean {
    const entry = this.entries.find(e => (e.state === 'sent' || e.state === 'unknown') && (typeof match === 'string' ? e.id === match : match(e.value)));
    if (!entry) return false;
    entry.state = 'acknowledged'; entry.updatedAt = Date.now();
    this.changed();
    return true;
  }

  /**
   * The provider's echo of an input it took. Inputs that waited together can come back as one echo, their texts
   * joined (Claude Code coalesces its queue): every input of that run is received.
   */
  acknowledgeEcho(echo: string, textOf: (value: T) => string): boolean {
    // The live process's inputs first: an unknown one went to an earlier process.
    const sent = this.entries.filter(e => e.state === 'sent');
    const same = sent.find(e => textOf(e.value) === echo);
    if (same) return this.receive([same]);
    for (let i = 0; i < sent.length; i++) {
      const run = coalesced(sent.slice(i), echo.trim(), textOf);
      if (run.length > 0) return this.receive(run);
    }
    return this.acknowledge(value => textOf(value) === echo);
  }

  /** Inputs sent but not taken go out again, to the next process: a new conversation never saw them. */
  requeue(): void {
    const sent = this.entries.filter(e => e.state === 'sent');
    if (sent.length === 0) return;
    for (const entry of sent) { entry.state = 'queued'; entry.updatedAt = Date.now(); }
    this.changed();
  }

  /**
   * A turn ended with `held` inputs still waiting in the provider: the oldest sent ones beyond those were taken, even
   * without an echo of their own. Only those sent before `echoedAt` (the last echo heard), so an input written as the
   * turn ended stays unconfirmed until its own echo.
   */
  settle(held: number, echoedAt: number): boolean {
    const sent = this.entries.filter(e => e.state === 'sent');
    return this.receive(sent.slice(0, Math.max(0, sent.length - held)).filter(e => e.updatedAt <= echoedAt));
  }

  private receive(entries: InboxEntry<T>[]): boolean {
    if (entries.length === 0) return false;
    const at = Date.now();
    for (const entry of entries) { entry.state = 'acknowledged'; entry.updatedAt = at; }
    this.changed();
    return true;
  }

  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; this.drain(); }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.entries) if (entry.state === 'sent') { entry.state = 'unknown'; entry.updatedAt = Date.now(); }
    try { this.changed(); } catch { /* Recovery also turns the persisted sent state into unknown. Closing must succeed even with a full disk. */ } finally {
      this.waiting?.({ value: undefined, done: true });
      this.waiting = null;
    }
  }

  private take(): IteratorResult<T> | null {
    if (this.closed) return { value: undefined, done: true };
    if (this.paused) return null;
    const entry = this.entries.find(e => e.state === 'queued');
    if (!entry) return null;
    entry.state = 'sent'; entry.updatedAt = Date.now();
    try { this.changed(); } catch (error) { entry.state = 'queued'; throw error; }
    return { value: entry.value, done: false };
  }

  private drain(): void {
    if (!this.waiting) return;
    const next = this.take();
    if (!next) return;
    const resolve = this.waiting; this.waiting = null;
    resolve(next);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const next = this.take();
        if (next) return Promise.resolve(next);
        if (this.waiting) return Promise.reject(new Error('Inbox supports one consumer'));
        return new Promise((resolve) => (this.waiting = resolve));
      },
    };
  }
}

/** The entries, from the first one on, whose texts make up the whole echo in order; none when they do not. */
function coalesced<T>(entries: InboxEntry<T>[], echo: string, textOf: (value: T) => string): InboxEntry<T>[] {
  const run: InboxEntry<T>[] = [];
  let rest = echo;
  for (const entry of entries) {
    const text = textOf(entry.value).trim();
    const after = rest.slice(text.length);
    // Joined at a line or a space, never inside a word: "ok" and "ay" are not "okay".
    if (!text || !rest.startsWith(text) || (after && !/^\s/.test(after))) return [];
    run.push(entry);
    rest = after.trimStart();
    if (!rest) return run;
  }
  return [];
}
