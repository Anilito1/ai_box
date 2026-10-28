/** Up/down arrows in the message field walk back through what was sent, like a terminal's history. */

export const HISTORY_LIMIT = 100;

/** The messages the user sent, oldest first: no empty ones, no consecutive duplicates, the last HISTORY_LIMIT. */
export function sentMessages(items: Iterable<{ kind: string; text?: string }>): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (item.kind !== 'user' || !item.text || item.text.trim() === '') continue;
    if (out[out.length - 1] !== item.text) out.push(item.text);
  }
  return out.slice(-HISTORY_LIMIT);
}

export interface KeyState {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
}

/**
 * Whether an arrow key walks the history rather than moving the caret: plain key, no composition, no selection, and
 * the caret on the first line (up) or the last one (down), so a multi-line message stays navigable.
 */
export function wantsHistory(e: KeyState, value: string, selStart: number, selEnd: number): 'up' | 'down' | null {
  if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.isComposing || selStart !== selEnd) return null;
  if (e.key === 'ArrowUp') return value.slice(0, selStart).includes('\n') ? null : 'up';
  if (e.key === 'ArrowDown') return value.indexOf('\n', selEnd) < 0 ? 'down' : null;
  return null;
}

/** Where the user is in the history; `back` counts from the newest message (0: the draft being typed). */
export class HistoryCursor {
  private back = 0;
  private draft = '';

  get browsing(): boolean {
    return this.back > 0;
  }

  /** Back to the draft's place (a message was sent, another conversation opened). */
  reset(): void {
    this.back = 0;
    this.draft = '';
  }

  /** The text to show after an arrow key, or null when there is nowhere to go. The draft is kept when leaving it. */
  step(dir: 'up' | 'down', current: string, history: readonly string[]): string | null {
    if (dir === 'up') {
      if (this.back >= history.length) return null;
      if (this.back === 0) this.draft = current;
      this.back++;
      return history[history.length - this.back];
    }
    if (this.back === 0) return null;
    this.back--;
    if (this.back > 0) return history[history.length - this.back] ?? this.draft;
    const draft = this.draft;
    this.draft = '';
    return draft;
  }
}
