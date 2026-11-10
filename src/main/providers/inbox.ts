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

  get pending(): number { return this.entries.filter(e => e.state === 'queued' || e.state === 'sent' || e.state === 'unknown').length; }

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
