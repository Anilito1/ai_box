import { pulseState, shortTokens } from '../shared/pulse';
import type { ChatItem, SessionView } from '../shared/types';
import { h, oneLine } from './dom';
import { LANG, t, tn } from './i18n';

// Claude Code's spinner: the starburst breathes in and out while a verb rotates.
const FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
const FRAME_MS = 120;
const VERB_MS = 3200;
// Under this a tool's length would only flicker from one step to the next.
const TOOL_SHOWN_MS = 10_000;
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

function fmtShort(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return total < 60 ? `${total} s` : `${Math.floor(total / 60)} min`;
}

/** The hour a limit opens again, with the day when it is not today; empty when unknown or already past. */
function reopening(resetsAt: number | null, now: number): string {
  if (resetsAt === null || resetsAt * 1000 <= now) return '';
  const at = new Date(resetsAt * 1000);
  const today = at.toDateString() === new Date(now).toDateString();
  return at.toLocaleString(LANG, { ...(today ? {} : { weekday: 'short' }), hour: '2-digit', minute: '2-digit' });
}

/**
 * "✻ Cogitation… (12 s · Bash npm test · ↓ 3,2 k tokens) ● signal il y a 4 s": shown while a session works. The
 * starburst, verbs and clock only tell that the app runs; the dot and the tokens tell what came out of the process.
 * Between turns it stays up while background tasks (subagents, shells) are still running.
 */
export class WorkingLine {
  readonly root = h('div', 'working');
  private readonly glyph = h('span', 'working-glyph');
  private readonly verb = h('span', 'working-verb');
  private readonly meta = h('span', 'working-meta');
  private readonly facts = h('span', 'working-facts');
  private readonly pulse = h('span', 'working-pulse');
  private readonly pulseLong = h('span', 'working-pulse-long');
  private readonly pulseShort = h('span', 'working-pulse-short');
  private readonly hintState = h('span', 'working-hint-state', t('work.stuck'));
  private readonly hintEsc = h('span', 'working-hint-esc');
  private since = 0;
  private seed = 0;
  private activity = '';
  private session: SessionView | undefined;
  private mode: 'busy' | 'waiting' | 'background' = 'busy';

  constructor() {
    this.pulse.title = t('work.signalTip');
    this.pulse.append(h('span', 'working-pulse-dot'), this.pulseLong, this.pulseShort);
    const hint = h('span', 'working-hint');
    hint.append(this.hintState, this.hintEsc);
    const info = h('span', 'working-info');
    info.append(this.meta, this.facts);
    this.root.append(this.glyph, this.verb, info, this.pulse, hint);
    this.root.hidden = true;
  }

  /** Busy: animated from the turn's start. Attention: frozen on the permission prompt. Otherwise shown only for background tasks. */
  update(session: SessionView | null | undefined, activity: string): void {
    this.session = session ?? undefined;
    const status = session?.status;
    const working = status === 'busy' || status === 'attention';
    const on = working || (status !== 'exited' && !!session?.background.length);
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
    if (working) {
      const start = session?.busySince ?? (this.since || Date.now());
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

  private limitText(s: SessionView, now: number): string {
    const time = reopening(s.limit?.resetsAt ?? null, now);
    return time ? t('work.limitUntil', { time }) : t('work.limit');
  }

  /** "(2 min 14 s · Bash npm test": cut when short of room. The tool's length and the tokens keep theirs, in `facts`. */
  private tickInfo(s: SessionView, now: number): void {
    const n = s.background.length;
    if (this.mode === 'background') {
      setText(this.meta, `(${[oneLine(s.background[0]).slice(0, 90), n > 1 ? `+${n - 1}` : ''].filter(Boolean).join(' · ')})`);
      setText(this.facts, '');
      return;
    }
    const tool = this.mode === 'waiting' ? null : s.tool;
    const doing = tool ? oneLine(`${tool.name} ${tool.summary}`).slice(0, 90) : this.activity;
    const head = [fmtElapsed(now - this.since), doing].filter(Boolean).join(' · ');
    const length = tool && now - tool.since >= TOOL_SHOWN_MS ? t('work.toolFor', { time: fmtShort(now - tool.since) }) : '';
    const { tokens, estimated } = s.pulse;
    const count = tokens > 0 ? t('work.tokens', { count: `${estimated ? '~' : ''}${shortTokens(tokens, LANG)}` }) : '';
    const more = [n ? tn('work.tasks', n) : '', count].filter(Boolean).join(' · ');
    const tail = [length, more && `· ${more}`].filter(Boolean).join(' ');
    setText(this.meta, tail ? `(${head}` : `(${head})`);
    setText(this.facts, tail && `${tail})`);
  }

  private tickPulse(s: SessionView, now: number): void {
    const state = pulseState(s, now);
    this.pulse.hidden = !state;
    this.root.classList.toggle('stuck', state?.tone === 'stuck');
    setText(this.hintEsc, state?.tone === 'stuck' ? ` · ${t('work.escHint')}` : t('work.escHint'));
    if (!state) return;
    if (this.pulse.dataset.tone !== state.tone) this.pulse.dataset.tone = state.tone;
    const time = fmtElapsed(state.ms);
    setText(this.pulseLong, t(state.silent ? 'work.silent' : 'work.signal', { time }));
    setText(this.pulseShort, time);
  }

  tick(now: number): void {
    const s = this.session;
    if (!s) return;
    const limited = this.mode === 'busy' && s.limit !== null;
    // Reduced motion: a still starburst, verbs swap without sliding in.
    const still = this.mode === 'waiting' || limited || reducedMotion.matches;
    setText(this.glyph, still ? '✻' : FRAMES[Math.floor(now / FRAME_MS) % FRAMES.length]);
    const verb =
      this.mode === 'waiting'
        ? t('work.waiting')
        : this.mode === 'background'
          ? t('work.background')
          : limited
            ? this.limitText(s, now)
            : s.retrying
              ? t('work.retry')
              : s.compacting
                ? t('slash.compacting')
                : `${VERBS[(this.seed + Math.floor((now - this.since) / VERB_MS)) % VERBS.length]}…`;
    if (this.verb.textContent !== verb) {
      this.verb.textContent = verb;
      if (!reducedMotion.matches)
        this.verb.animate([{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'ease-out' });
    }
    this.tickInfo(s, now);
    this.tickPulse(s, now);
  }
}
