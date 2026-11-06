import { taskView } from '../shared/backgroundTask';
import { splitBackground } from '../shared/subagentList';
import { pulseState, shortTokens } from '../shared/pulse';
import type { ChatItem, SessionView } from '../shared/types';
import { workView } from '../shared/workView';
import { h, oneLine } from './dom';
import { LANG, t } from './i18n';
import { SubagentSection } from './subagents';

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
 * "✻ Cogitation… (12 s · Bash npm test · ↓ 3,2 k tokens) ● signal il y a 4 s": shown while a turn runs. The
 * starburst, verbs and clock only tell that the app runs; the dot and the tokens tell what came out of the process.
 * Background tasks (subagents, shells) that outlive the turn are a still list under it, one per line ("En
 * arrière-plan / calculette V1 · localhost:8821 / Point 1…"; a local server's address opens in the browser): nothing
 * moves there, so a session with only those does not look like it is thinking.
 */
export class WorkingLine {
  readonly root = h('div', 'working-stack');
  private readonly line = h('div', 'working');
  private readonly tasks = h('div', 'working-tasks');
  private readonly subs = new SubagentSection();
  private tasksKey = '';
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
  private mode: 'busy' | 'waiting' = 'busy';

  /** `open`: how a link leaves the app (the default browser). */
  constructor(private readonly open: (url: string) => void) {
    this.pulse.title = t('work.signalTip');
    this.pulse.append(h('span', 'working-pulse-dot'), this.pulseLong, this.pulseShort);
    const hint = h('span', 'working-hint');
    hint.append(this.hintState, this.hintEsc);
    const info = h('span', 'working-info');
    info.append(this.meta, this.facts);
    this.line.append(this.glyph, this.verb, info, this.pulse, hint);
    this.root.append(this.line, this.subs.root, this.tasks);
    this.root.hidden = true;
    this.line.hidden = true;
    this.tasks.hidden = true;
  }

  /** Busy: animated from the turn's start. Attention: frozen on the permission prompt. Background tasks: a still list, whatever the turn does. */
  update(session: SessionView | null | undefined, activity: string): void {
    this.session = session ?? undefined;
    const { turn, tasks } = workView(session);
    this.subs.update(session ?? undefined);
    this.showTasks(tasks, session?.backgroundPorts ?? {}, session ?? undefined);
    this.root.hidden = !turn && tasks.length === 0 && this.subs.empty;
    this.line.hidden = !turn;
    if (!turn) {
      active.delete(this);
      this.since = 0;
      return;
    }
    this.mode = session?.status === 'attention' ? 'waiting' : 'busy';
    this.line.classList.toggle('waiting', this.mode === 'waiting');
    this.activity = activity;
    const start = session?.busySince ?? (this.since || Date.now());
    if (start !== this.since) {
      this.since = start;
      this.seed = Math.floor(Math.random() * VERBS.length);
    }
    active.add(this);
    startTicker();
    this.tick(Date.now());
  }

  /** "En arrière-plan" and one line per task; rebuilt only when the list changes (it renders 25 times a second while a reply streams). */
  private showTasks(all: string[], ports: Record<string, number>, session: SessionView | undefined): void {
    // A subagent listed above is not listed again: its line here points to its row.
    const { tasks, linked } = splitBackground(all, session?.subagents);
    this.tasks.hidden = all.length === 0;
    const key = [...tasks.map((task) => `${task}\t${ports[task] ?? ''}`), ...linked.map((l) => `${l.label}\t${l.id}`)].join('\n');
    if (key === this.tasksKey) return;
    this.tasksKey = key;
    this.tasks.replaceChildren(
      h('span', 'working-tasks-label', t('work.background')),
      ...linked.map(({ label, id }) => {
        const row = h('button', 'working-task working-task-sub');
        row.type = 'button';
        row.title = t('sub.seeRow');
        row.append(h('span', 'working-task-text', t('sub.backgroundLink', { text: taskView(label).summary })), h('span', 'working-task-arrow', '↑'));
        row.addEventListener('click', () => this.subs.reveal(id));
        return row;
      }),
      ...tasks.map((task) => {
        const view = taskView(task, ports[task]);
        const row = h('div', 'working-task');
        row.title = view.label;
        row.append(h('span', 'working-task-text', view.summary));
        if (view.url) {
          const { url } = view;
          const link = h('a', 'working-task-link', `localhost:${view.port}`);
          link.href = url;
          link.title = url;
          link.addEventListener('click', (e) => {
            e.preventDefault();
            this.open(url);
          });
          row.append(h('span', 'working-task-sep', '·'), link);
        }
        return row;
      }),
    );
  }

  private limitText(s: SessionView, now: number): string {
    const time = reopening(s.limit?.resetsAt ?? null, now);
    return time ? t('work.limitUntil', { time }) : t('work.limit');
  }

  /** "(2 min 14 s · Bash npm test": cut when short of room. The tool's length and the tokens keep theirs, in `facts`. */
  private tickInfo(s: SessionView, now: number): void {
    const tool = this.mode === 'waiting' ? null : s.tool;
    const doing = tool ? oneLine(`${tool.name} ${tool.summary}`).slice(0, 90) : this.activity;
    const head = [fmtElapsed(now - this.since), doing].filter(Boolean).join(' · ');
    const length = tool && now - tool.since >= TOOL_SHOWN_MS ? t('work.toolFor', { time: fmtShort(now - tool.since) }) : '';
    const { tokens, estimated } = s.pulse;
    const count = tokens > 0 ? t('work.tokens', { count: `${estimated ? '~' : ''}${shortTokens(tokens, LANG)}` }) : '';
    const tail = [length, count && `· ${count}`].filter(Boolean).join(' ');
    setText(this.meta, tail ? `(${head}` : `(${head})`);
    setText(this.facts, tail && `${tail})`);
  }

  private tickPulse(s: SessionView, now: number): void {
    const state = pulseState(s, now);
    this.pulse.hidden = !state;
    this.line.classList.toggle('stuck', state?.tone === 'stuck');
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
