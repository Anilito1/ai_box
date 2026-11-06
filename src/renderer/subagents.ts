import { ENDED_SHOWN, subagentRows, subagentTime } from '../shared/subagentList';
import type { SessionView, SubagentView } from '../shared/types';
import { h, oneLine } from './dom';
import { LANG, t, tn } from './i18n';

// A session's subagents: indented rows under its card, a "Sous-agents" section in its view, and the read-only
// activity of one (its tools, what it said, its result). Only a running one moves: its dot breathes and its time
// counts; an ended one is still.

/** Where the open dialog reads its subagent again at each snapshot: set by app.ts. */
let sessionOf: (id: string) => SessionView | undefined = () => undefined;
export function setSubagentSource(get: (id: string) => SessionView | undefined): void {
  sessionOf = get;
}

/** Sessions whose ended subagents are unfolded, by where they show (card or view). */
const unfolded = new Set<string>();

// Running rows' times count every second, without a render.
let clock: number | null = null;
function startClock(): void {
  clock ??= window.setInterval(() => {
    const live = document.querySelectorAll<HTMLElement>('[data-sub-start]');
    if (live.length === 0 && clock !== null) {
      window.clearInterval(clock);
      clock = null;
    }
    const now = Date.now();
    for (const el of live) {
      const text = subagentTime({ startedAt: Number(el.dataset.subStart), endedAt: null }, now, el.dataset.subShort === '1');
      if (el.textContent !== text) el.textContent = text;
    }
  }, 1000);
}

const statusText = (a: SubagentView) => t(`sub.status.${a.status}` as const);

function dot(a: SubagentView): HTMLElement {
  const el = h('span', `sub-dot s-${a.status}`);
  el.setAttribute('aria-label', statusText(a));
  return el;
}

function timeEl(a: SubagentView, cls: string, short = false): HTMLElement {
  const el = h('span', cls, subagentTime(a, Date.now(), short));
  if (a.status === 'running') {
    el.dataset.subStart = String(a.startedAt);
    if (short) el.dataset.subShort = '1';
    startClock();
  }
  return el;
}

/** "Explore · sonnet · en arrière-plan": what the call asked for. */
const kindOf = (a: SubagentView) => [a.agentType, a.model, a.background ? t('sub.background') : ''].filter(Boolean).join(' · ');

function row(s: SessionView, a: SubagentView, short: boolean, open: (session: SessionView, id: string) => void): HTMLElement {
  const el = h('button', `sub-row s-${a.status}`);
  el.type = 'button';
  el.dataset.sub = a.id;
  el.title = [a.description, kindOf(a), statusText(a), a.activity].filter(Boolean).join('\n');
  const main = h('span', 'sub-main');
  main.append(dot(a), h('span', 'sub-desc', oneLine(a.description) || t('sub.unnamed')));
  // Its time, then what it did last (or how it ended, when it said nothing).
  const line = h('span', 'sub-act');
  const act = a.activity || (a.status === 'running' ? '' : statusText(a));
  line.append(timeEl(a, 'sub-time', short));
  if (act) line.append(h('span', 'sub-sep', '·'), h('span', 'sub-act-text', oneLine(act)));
  el.append(main, line);
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    open(s, a.id);
  });
  return el;
}

/** Content key of a list: rebuilt only when it changes (a card renders at every streamed fragment). */
const keyOf = (s: SessionView, where: string) =>
  JSON.stringify([where, unfolded.has(`${where}:${s.id}`), (s.subagents ?? []).map((a) => [a.id, a.status, a.description, a.activity, a.agentType, a.model, a.background])]);

/**
 * The rows of a session's subagents in `box`: the running ones, the latest ended, "+n terminés" for the others.
 * `where` keeps the card's folding apart from the view's. Hidden when it has none.
 */
export function renderSubagentRows(box: HTMLElement, s: SessionView, where: 'card' | 'view', open: (session: SessionView, id: string) => void): void {
  const key = keyOf(s, where);
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  const fold = `${where}:${s.id}`;
  const { shown, folded } = subagentRows(s.subagents, unfolded.has(fold));
  box.hidden = shown.length === 0 && folded === 0;
  const rows: HTMLElement[] = shown.map((a) => row(s, a, where === 'card', open));
  const ended = (s.subagents ?? []).filter((a) => a.status !== 'running').length;
  if (folded > 0 || (unfolded.has(fold) && ended > ENDED_SHOWN)) {
    const more = h('button', 'sub-more', folded > 0 ? tn('sub.more', folded) : t('sub.less'));
    more.type = 'button';
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      if (unfolded.has(fold)) unfolded.delete(fold);
      else unfolded.add(fold);
      renderSubagentRows(box, s, where, open);
    });
    rows.push(more);
  }
  box.replaceChildren(...rows);
}

/** The "Sous-agents" section of a session's view, at the end of its conversation. */
export class SubagentSection {
  readonly root = h('div', 'sub-section');
  private readonly list = h('div', 'sub-list');

  constructor() {
    this.root.append(h('span', 'sub-section-label', t('sub.title')), this.list);
    this.root.hidden = true;
  }

  get empty(): boolean {
    return this.root.hidden;
  }

  update(s: SessionView | undefined): void {
    if (!s || (s.subagents ?? []).length === 0) {
      this.root.hidden = true;
      this.list.replaceChildren();
      delete this.list.dataset.key;
      return;
    }
    renderSubagentRows(this.list, s, 'view', (session, id) => openSubagent(session.id, id));
    this.root.hidden = this.list.hidden;
  }

  /** The "En arrière-plan" block points here: the row shows itself for a moment. */
  reveal(id: string): void {
    const el = this.list.querySelector<HTMLElement>(`[data-sub="${CSS.escape(id)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    el.focus({ preventScroll: true });
  }
}

// ---------- activity of one subagent ----------

interface Dialog {
  session: string;
  id: string;
  overlay: HTMLElement;
  body: HTMLElement;
  key: string;
}
let dialog: Dialog | null = null;

const clockOf = (at: number) => new Date(at).toLocaleTimeString(LANG, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function fillDialog(d: Dialog, s: SessionView | undefined, a: SubagentView | undefined): void {
  const key = JSON.stringify(a ?? null);
  if (key === d.key) return;
  d.key = key;
  if (!s || !a) {
    d.body.replaceChildren(h('p', 'sub-empty', t('sub.gone')));
    return;
  }
  const head = h('div', 'sub-head');
  const title = h('h2', 'sub-title', oneLine(a.description) || t('sub.unnamed'));
  title.id = 'sub-title';
  const facts = h('div', 'sub-facts');
  const state = h('span', `sub-state s-${a.status}`);
  state.append(dot(a), h('span', '', statusText(a)));
  facts.append(state, timeEl(a, 'sub-fact'), h('span', 'sub-fact', t('sub.of', { name: s.name })));
  const kind = kindOf(a);
  if (kind) facts.append(h('span', 'sub-fact', kind));
  if (a.tools > 0) facts.append(h('span', 'sub-fact', tn('sub.tools', a.tools)));
  head.append(title, facts);

  const log = h('ol', 'sub-log');
  if (a.log.length === 0) log.append(h('li', 'sub-empty', a.status === 'running' ? t('sub.noStepYet') : t('sub.noStep')));
  for (const step of a.log) {
    const li = h('li', `sub-step ${step.kind}`);
    li.append(h('span', 'sub-step-time', clockOf(step.at)), h('span', 'sub-step-kind', t(`sub.kind.${step.kind}` as const)), h('span', 'sub-step-text', step.text));
    log.append(li);
  }
  const parts: HTMLElement[] = [head, h('h3', 'sub-label', t('sub.activity')), log];
  if (a.result) parts.push(h('h3', 'sub-label', t('sub.result')), h('pre', `sub-result s-${a.status}`, a.result));
  else if (a.status !== 'running') parts.push(h('p', 'sub-empty', t('sub.noResult')));
  d.body.replaceChildren(...parts);
  // Following a running one: its latest step stays in sight.
  if (a.status === 'running') log.lastElementChild?.scrollIntoView({ block: 'nearest' });
}

/** Opens the activity of a subagent, read-only; it follows the subagent while open. */
export function openSubagent(session: string, id: string): void {
  closeSubagent();
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const overlay = h('div', 'notes-overlay sub-overlay');
  const card = h('div', 'notes-card sub-card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'sub-title');
  const body = h('div', 'notes-body sub-body');
  const foot = h('div', 'notes-foot');
  const close = h('button', 'btn primary', t('sub.close'));
  close.type = 'button';
  foot.append(h('span', 'sub-readonly', t('sub.readOnly')), close);
  card.append(body, foot);
  overlay.append(card);
  const d: Dialog = { session, id, overlay, body, key: '' };
  dialog = d;
  const done = () => {
    if (dialog === d) dialog = null;
    overlay.classList.add('closing');
    document.removeEventListener('keydown', onKey, true);
    window.setTimeout(() => overlay.remove(), 240);
    if (returnFocus?.isConnected) returnFocus.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    done();
  };
  close.addEventListener('click', done);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) done();
  });
  document.addEventListener('keydown', onKey, true);
  (overlay as HTMLElement & { closeDialog?: () => void }).closeDialog = done;
  document.body.append(overlay);
  refreshSubagent();
  close.focus();
}

export function closeSubagent(): void {
  (dialog?.overlay as (HTMLElement & { closeDialog?: () => void }) | undefined)?.closeDialog?.();
}

/** A new snapshot: the open dialog shows its subagent as it is now. */
export function refreshSubagent(): void {
  if (!dialog) return;
  const s = sessionOf(dialog.session);
  fillDialog(dialog, s, s?.subagents?.find((a) => a.id === dialog?.id));
}
