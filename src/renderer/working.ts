import type { ChatItem, Status } from '../shared/types';
import { h, oneLine } from './dom';
import { t, tn } from './i18n';

// Claude Code's spinner: the starburst breathes in and out while a verb rotates.
const FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
const FRAME_MS = 120;
const VERB_MS = 3200;
const VERBS = t('work.verbs').split(',');

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const active = new Set<WorkingLine>();
let ticker: number | null = null;

function startTicker(): void {
  ticker ??= window.setInterval(() => {
    const now = Date.now();
    for (const line of active) line.tick(now);
    if (active.size === 0 && ticker !== null) {
      window.clearInterval(ticker);
      ticker = null;
    }
  }, FRAME_MS);
}

const setText = (el: HTMLElement, text: string) => {
  if (el.textContent !== text) el.textContent = text;
};

function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total} s`;
  return `${Math.floor(total / 60)} min ${String(total % 60).padStart(2, '0')} s`;
}

export function lastOf(items: Map<string, ChatItem> | undefined): ChatItem | undefined {
  let last: ChatItem | undefined;
  for (const item of items?.values() ?? []) last = item;
  return last;
}

/** What a session is doing right now, read from its latest chat item. */
export function activityOf(last: ChatItem | undefined): string {
  if (last?.kind === 'tool' && last.result === null) return oneLine(`${last.name} ${last.summary}`).slice(0, 90);
  if (last?.kind === 'thinking') return t('work.thinking');
  if (last?.kind === 'assistant' && last.live) return t('work.writing');
  return '';
}

/**
 * "✻ Cogitation… (12 s · Bash npm test)": shown while a session works, so a long turn visibly progresses.
 * Between turns it stays up while background tasks (subagents, shells) are still running.
 */
export class WorkingLine {
  readonly root = h('div', 'working');
  private readonly glyph = h('span', 'working-glyph');
  private readonly verb = h('span', 'working-verb');
  private readonly meta = h('span', 'working-meta');
  private since = 0;
  private seed = 0;
  private activity = '';
  private background: string[] = [];
  private mode: 'busy' | 'waiting' | 'background' = 'busy';

  constructor() {
    this.root.append(this.glyph, this.verb, this.meta, h('span', 'working-hint', t('work.escHint')));
    this.root.hidden = true;
  }

  /** Busy: animated from `since`. Attention: frozen on the permission prompt. Otherwise shown only for background tasks. */
  update(status: Status | undefined, since: number | null, activity: string, background: string[] = []): void {
    const working = status === 'busy' || status === 'attention';
    const on = working || (status !== 'exited' && background.length > 0);
    this.root.hidden = !on;
    if (!on) {
      active.delete(this);
      this.since = 0;
      return;
    }
    this.mode = status === 'attention' ? 'waiting' : working ? 'busy' : 'background';
    this.root.classList.toggle('waiting', this.mode === 'waiting');
    this.root.classList.toggle('background', this.mode === 'background');
    this.activity = activity;
    this.background = background;
    if (working) {
      const start = since ?? (this.since || Date.now());
      if (start !== this.since) {
        this.since = start;
        this.seed = Math.floor(Math.random() * VERBS.length);
      }
    } else {
      this.since = 0;
    }
    active.add(this);
    startTicker();
    this.tick(Date.now());
  }

  tick(now: number): void {
    // Reduced motion: a still starburst, verbs swap without sliding in.
    const still = this.mode === 'waiting' || reducedMotion.matches;
    setText(this.glyph, still ? '✻' : FRAMES[Math.floor(now / FRAME_MS) % FRAMES.length]);
    const verb =
      this.mode === 'waiting'
        ? t('work.waiting')
        : this.mode === 'background'
          ? t('work.background')
          : `${VERBS[(this.seed + Math.floor((now - this.since) / VERB_MS)) % VERBS.length]}…`;
    if (this.verb.textContent !== verb) {
      this.verb.textContent = verb;
      if (!reducedMotion.matches)
        this.verb.animate([{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'ease-out' });
    }
    const n = this.background.length;
    const parts =
      this.mode === 'background'
        ? [oneLine(this.background[0]).slice(0, 90), n > 1 ? `+${n - 1}` : '']
        : [fmtElapsed(now - this.since), this.activity, n ? tn('work.tasks', n) : ''];
    setText(this.meta, `(${parts.filter(Boolean).join(' · ')})`);
  }
}
