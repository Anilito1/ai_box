/** An async queue a producer fills and a consumer iterates once: ends with `close()`, throws with `fail()`. */
export class EventQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiting: { resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void } | null = null;
  private done = false;
  private error: unknown = null;

  push(item: T): void {
    if (this.done) return;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w.resolve({ value: item, done: false });
    } else this.items.push(item);
  }

  close(): void {
    if (this.done) return;
    this.done = true;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w.resolve({ value: undefined, done: true });
    }
  }

  fail(err: unknown): void {
    if (this.done) return;
    this.done = true;
    this.error = err;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w.reject(err);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.error) return Promise.reject(this.error);
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => (this.waiting = { resolve, reject }));
      },
    };
  }
}
