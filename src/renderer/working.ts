import type { ChatItem, Status } from '../shared/types';
import { h, oneLine } from './dom';

// Claude Code's spinner: the starburst breathes in and out while a verb rotates.
const FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
const FRAME_MS = 120;
const VERB_MS = 3200;
const VERBS = [
  'Cogitation',
  'Mijotage',
  'Gamberge',
  'Ruminage',
  'Infusion',
  'Brassage',
  'Distillation',
  'Élaboration',
  'Concoction',
  'Fermentation',
  'Peaufinage',
  'Bricolage',
  'Pétrissage',
  'Mitonnage',
  'Décorticage',
  'Turbinage',
  'Méditation',
  'Tricotage',
  'Ciselage',
  'Alchimie',
  'Délibération',
  'Maturation',
  'Cristallisation',
  'Orchestration',
  'Échafaudage',
  'Moulinage',
  'Synthèse',
  'Défrichage',
  'Calibrage',
  'Clauding',
];

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
  if (last?.kind === 'thinking') return 'réflexion';
  if (last?.kind === 'assistant' && last.live) return 'rédaction';
  return '';
}

/** "✻ Cogitation… (12 s · Bash npm test)": shown while a session works, so a long turn visibly progresses. */
export class WorkingLine {
  readonly root = h('div', 'working');
  private readonly glyph = h('span', 'working-glyph');
  private readonly verb = h('span', 'working-verb');
  private readonly meta = h('span', 'working-meta');
  private since = 0;
  private seed = 0;
  private activity = '';
  private waiting = false;

  constructor(compact: boolean) {
    this.root.append(this.glyph, this.verb, this.meta);
    if (compact) this.root.classList.add('compact');
    else this.root.append(h('span', 'working-hint', 'Échap pour interrompre'));
    this.root.hidden = true;
  }

  /** Busy: animated from `since`. Attention: frozen on the permission prompt. Any other status hides it. */
  update(status: Status | undefined, since: number | null, activity: string): void {
    const on = status === 'busy' || status === 'attention';
    this.root.hidden = !on;
    if (!on) {
      active.delete(this);
      this.since = 0;
      return;
    }
    this.waiting = status === 'attention';
    this.root.classList.toggle('waiting', this.waiting);
    this.activity = activity;
    const start = since ?? (this.since || Date.now());
    if (start !== this.since) {
      this.since = start;
      this.seed = Math.floor(Math.random() * VERBS.length);
    }
    active.add(this);
    startTicker();
    this.tick(Date.now());
  }

  stop(): void {
    active.delete(this);
  }

  tick(now: number): void {
    setText(this.glyph, this.waiting ? '✻' : FRAMES[Math.floor(now / FRAME_MS) % FRAMES.length]);
    const verb = this.waiting ? 'En attente de ta validation' : `${VERBS[(this.seed + Math.floor((now - this.since) / VERB_MS)) % VERBS.length]}…`;
    if (this.verb.textContent !== verb) {
      this.verb.textContent = verb;
      this.verb.animate([{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'ease-out' });
    }
    setText(this.meta, `(${[fmtElapsed(now - this.since), this.activity].filter(Boolean).join(' · ')})`);
  }
}
