import type { ChatItem } from '../shared/types';

/**
 * Items received but not on screen yet, per session: the latest state of each changed item in the order they first
 * came, or 'reset' for a whole new conversation (drawn from the store, so later items need no listing).
 */
export class Unshown {
  private readonly bySession = new Map<string, Map<string, ChatItem> | 'reset'>();

  get size(): number {
    return this.bySession.size;
  }

  add(id: string, items: ChatItem[], fresh: boolean): void {
    const changed = this.bySession.get(id);
    if (fresh) return void this.bySession.set(id, 'reset');
    if (changed === 'reset') return;
    const next = changed ?? new Map<string, ChatItem>();
    for (const item of items) next.set(item.id, item);
    this.bySession.set(id, next);
  }

  /** What to show, emptied. */
  take(): [string, ChatItem[] | 'reset'][] {
    const out = [...this.bySession].map(([id, changed]): [string, ChatItem[] | 'reset'] => [id, changed === 'reset' ? 'reset' : [...changed.values()]]);
    this.bySession.clear();
    return out;
  }
}
