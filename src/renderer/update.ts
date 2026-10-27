import type { HubApi } from '../shared/types';
import { UPDATE_MODES, type UpdateChoice, type UpdateMode, type UpdateState } from '../shared/update';
import { ago, h, icon, ICONS, techDetails } from './dom';
import { t, tn } from './i18n';

// The hub's own updates: a badge in the master's header that opens a card, and the block of Settings › About.

/** A result after the restart that installed it, or the outcome of a check the user asked for, fades after this long. */
const DONE_MS = 12_000;
const CHECKED_MS = 6_000;

let hub: HubApi;
let uiBusy: () => boolean = () => false;
let state: UpdateState | null = null;
/** What "close" put away until the next start or the next version: its topic and target. */
let dismissed = '';
/** A check the user asked for: its outcome shows on the badge even when there is nothing new. */
let asked = false;
/** The card under the badge is open. */
let open = false;
let slot: HTMLElement;
let lastSeen = false;
let ticker = 0;
let decideTimer = 0;
let fadeTimer = 0;
let answered: number | null = null;
const sections = new Set<HTMLElement>();

/** What the badge is about, from the most pressing. */
type Topic = 'progress' | 'countdown' | 'confirm' | 'failed' | 'problem' | 'done' | 'waiting' | 'available' | 'realign' | 'blocked' | 'quiet';

function topic(s: UpdateState): Topic {
  if (s.progress) return 'progress';
  if (s.countdown !== null) return 'countdown';
  if (s.confirm > 0) return 'confirm';
  if (s.last && !s.last.ok && !lastSeen) return 'failed';
  if (s.problem) return 'problem';
  if (s.waiting) return 'waiting';
  // A new version outranks the news of the last one.
  if (s.kind === 'available' || s.kind === 'realign' || s.kind === 'blocked') return s.kind;
  if (s.last?.ok && !lastSeen) return 'done';
  return 'quiet';
}

const seconds = (s: UpdateState) => Math.max(0, Math.ceil(((s.countdown ?? 0) - Date.now()) / 1000));

/** The sentence that says where the update stands. */
function message(s: UpdateState): string {
  switch (topic(s)) {
    case 'progress':
      return t(`update.step.${s.progress ?? 'fetch'}` as 'update.step.fetch');
    case 'countdown':
      return t('update.countdown', { secs: seconds(s) });
    case 'confirm':
      return tn('update.confirm', s.confirm);
    case 'failed': {
      const where = t(`update.where.${s.last?.step || 'check'}` as 'update.where.check');
      return s.last?.restored ? t('update.failed', { where }) : t('update.failedBroken', { where });
    }
    case 'problem':
      return s.problem === 'node' ? t('update.noNode') : t('update.noStart');
    case 'done':
      return t('update.done');
    case 'waiting':
      return t('update.waiting');
    case 'available':
      return t('update.available');
    case 'realign':
      return t('update.realignLead');
    case 'blocked':
      return s.block === 'branch' ? t('update.blocked.branch', { branch: s.branch || 'HEAD' }) : s.block === 'changes' ? t('update.blocked.changes') : t('update.blocked.commits');
    case 'quiet':
      if (s.kind === 'off') return t('update.lead.off');
      if (s.kind === 'unofficial') return t('update.lead.unofficial');
      if (s.checking) return t('update.lead.checking');
      if (s.offline) return t('update.lead.offline');
      if (s.kind === 'current') return t('update.lead.current');
      if (s.kind === 'ahead') return t('update.lead.ahead');
      return s.checkedAt === null ? t('update.lead.notYet') : t('update.lead.none');
  }
}

/** The tone of the badge: the app's blue for an update, amber when the copy is left alone, red for a failure. */
function tone(s: UpdateState): 'accent' | 'warn' | 'error' | 'neutral' {
  const k = topic(s);
  if (k === 'failed' || k === 'problem') return 'error';
  if (k === 'blocked') return 'warn';
  if (k === 'quiet') return 'neutral';
  return 'accent';
}

function button(label: string, cls: string, run: () => void, disabled = false): HTMLButtonElement {
  const b = h('button', cls, label);
  b.type = 'button';
  b.disabled = disabled;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    run();
  });
  return b;
}

const choose = (choice: UpdateChoice) => void hub.installUpdate(choice).then(apply);
const retry = () => {
  lastSeen = true;
  void hub.checkUpdate().then((s) => {
    apply(s);
    if (s.kind === 'available') choose('ask');
  });
};

/** The buttons of the moment: `primary` for the main one, `secondary` for the others. */
function actions(s: UpdateState, primary: string, secondary: string): HTMLButtonElement[] {
  switch (topic(s)) {
    case 'progress':
      return s.progress === 'ready' ? [button(t('update.restartNow'), primary, () => choose('now'))] : [];
    case 'countdown':
      return [button(t('update.now'), primary, () => answer(true, true))];
    case 'confirm':
      return [button(tn('update.whenQuiet', s.confirm), primary, () => choose('when-quiet')), button(t('update.nowShort'), secondary, () => choose('now'))];
    case 'failed':
    case 'problem':
      return s.kind === 'available' ? [button(t('update.retry'), primary, retry)] : [];
    case 'waiting':
      return [button(t('update.now'), primary, () => choose('now'))];
    case 'available':
      return [button(t('update.button'), primary, () => choose('ask'))];
    case 'realign':
      return [button(t('update.realign'), primary, () => choose('ask'))];
    case 'blocked':
      return [button(t('update.openFolder'), secondary, () => hub.openUpdateFolder())];
    default:
      return [];
  }
}

/** The raw words behind a problem, or the files in the way, folded under "Details". */
function details(s: UpdateState): HTMLElement[] {
  const k = topic(s);
  const raw = k === 'failed' ? (s.last?.detail ?? '') : k === 'problem' || (k === 'quiet' && s.offline) ? s.detail : k === 'blocked' && s.block === 'changes' ? s.files.join('\n') : '';
  return raw ? [techDetails(raw)] : [];
}

// ---------- the badge, and the card it opens ----------

const chip = h('button', 'update-chip');
const chipText = h('span');
const card = h('div', 'update-card');
const text = h('div', 'update-card-text');
const buttons = h('div', 'update-card-actions');
const close = h('button', 'update-card-close');
const more = h('div', 'update-card-more');
const bar = h('div', 'update-card-bar');
text.setAttribute('role', 'status');
text.setAttribute('aria-live', 'polite');
chip.type = 'button';
chip.setAttribute('aria-haspopup', 'dialog');
chip.append(icon(ICONS.up, 'ico small'), chipText);
chip.addEventListener('click', () => {
  open = !open;
  render();
});
card.setAttribute('role', 'dialog');
card.setAttribute('aria-label', t('update.title'));
close.type = 'button';
close.append(icon(ICONS.remove));
close.addEventListener('click', () => onClose());
bar.append(h('span'));
card.append(text, more, buttons, close, bar);

const dismissKey = (s: UpdateState) => `${topic(s)}:${s.target}`;

/** Shown for anything to say, except what "close" put away and a quiet state nobody asked about. */
function shown(s: UpdateState): boolean {
  const k = topic(s);
  if (k === 'quiet') return asked;
  if (k === 'realign' || k === 'blocked') return dismissed !== dismissKey(s);
  return true;
}

/** The few words on the badge: the card holds the sentence and the buttons. */
function chipLabel(s: UpdateState): string {
  switch (topic(s)) {
    case 'progress':
      return t(s.progress === 'ready' ? 'update.chip.ready' : 'update.chip.working');
    case 'countdown':
      return t('update.chip.countdown', { secs: seconds(s) });
    case 'failed':
    case 'problem':
      return t('update.chip.failed');
    case 'done':
      return t('update.chip.done');
    case 'waiting':
      return t('update.chip.waiting');
    case 'blocked':
      return t('update.chip.blocked');
    case 'quiet':
      return t('update.title');
    default:
      return t('update.chip.available');
  }
}

/** The cross: "cancel" for a question or a wait, "close" for the rest. */
function closeLabel(s: UpdateState): string {
  const k = topic(s);
  if (k === 'countdown') return t('update.later');
  if (k === 'confirm' || k === 'waiting') return t('update.cancel');
  return t('update.close');
}

function onClose(): void {
  const s = state;
  open = false;
  if (!s) return;
  const k = topic(s);
  // A countdown the user asked for ("when they are done") is dropped; an unattended one is put off.
  if (k === 'countdown' && !s.waiting) answer(false, true);
  else if (k === 'countdown' || k === 'confirm' || k === 'waiting' || k === 'problem') choose('cancel');
  else if (k === 'failed' || k === 'done') lastSeen = true;
  else if (k === 'quiet') asked = false;
  else if (k === 'realign' || k === 'blocked') dismissed = dismissKey(s);
  render();
}

function renderChip(): void {
  const s = state;
  const visible = !!s && shown(s);
  if (!visible) open = false;
  // Focus inside a closing card goes back to the conversation.
  if (!open && card.contains(document.activeElement)) (document.querySelector('#pane-master textarea') as HTMLElement | null)?.focus();
  slot.hidden = !visible;
  chip.setAttribute('aria-expanded', String(open));
  card.hidden = !open;
  if (!s || !visible) return;
  slot.dataset.tone = tone(s);
  const label = chipLabel(s);
  if (chipText.textContent !== label) chipText.textContent = label;
  if (!open) return;
  const words = message(s);
  if (text.textContent !== words) text.textContent = words;
  // The buttons and the fold only when what they do changed: the countdown redraws its text every second.
  const key = `${topic(s)}:${s.progress}:${s.confirm}:${s.kind}:${s.last?.at ?? ''}:${s.problem}:${s.offline}`;
  if (buttons.dataset.key !== key) {
    buttons.dataset.key = key;
    buttons.replaceChildren(...actions(s, 'update-card-btn primary', 'update-card-btn'));
    more.replaceChildren(...details(s));
  }
  const closing = closeLabel(s);
  close.title = closing;
  close.setAttribute('aria-label', closing);
  close.hidden = topic(s) === 'progress';
  bar.hidden = topic(s) !== 'progress' || s.progress === 'ready';
}

// ---------- countdown ----------

/**
 * The window answers the main process: it alone knows of an unsent message or open settings, which put off a restart
 * nobody clicked for. A click (`explicit`) is the user's own answer.
 */
function answer(go: boolean, explicit = false): void {
  if (!state?.countdown || answered === state.countdown) return;
  answered = state.countdown;
  hub.answerUpdate(go && (explicit || !uiBusy()));
}

/** Redraws the seconds left. */
function tick(): void {
  if (!state?.countdown) {
    window.clearInterval(ticker);
    ticker = 0;
    return;
  }
  render();
}

/**
 * The answer at the end of a countdown, from one timer set when it starts: a hidden window runs a chain of timers
 * late, a single one about on time.
 */
function schedule(s: UpdateState): void {
  window.clearTimeout(decideTimer);
  if (s.countdown === null) return;
  const at = s.countdown;
  decideTimer = window.setTimeout(() => state?.countdown === at && answer(true), Math.max(0, at - Date.now()));
}

function render(): void {
  renderChip();
  for (const el of sections) {
    if (el.isConnected) fill(el);
    else sections.delete(el);
  }
}

/** News that fades by itself: a done install, the outcome of a check the user asked for. */
function fade(s: UpdateState): void {
  window.clearTimeout(fadeTimer);
  const k = topic(s);
  if (k !== 'done' && !(k === 'quiet' && asked && !s.checking)) return;
  fadeTimer = window.setTimeout(
    () => {
      if (k === 'done') lastSeen = true;
      asked = false;
      render();
    },
    k === 'done' ? DONE_MS : CHECKED_MS,
  );
}

function apply(next: UpdateState): void {
  // A new failure or install shows again, even after an earlier one was closed.
  if (next.last && next.last.at !== state?.last?.at) lastSeen = false;
  if (next.countdown !== state?.countdown) schedule(next);
  state = next;
  if (next.countdown && !ticker) ticker = window.setInterval(tick, 1000);
  fade(next);
  render();
}

// ---------- Settings › About ----------

function fill(el: HTMLElement): void {
  const s = state;
  const key = s ? JSON.stringify([topic(s), { ...s, countdown: s.countdown !== null }]) : '';
  if (el.dataset.key === key) {
    const lead = el.querySelector('.update-about-lead');
    if (s && lead && lead.textContent !== message(s)) lead.textContent = message(s);
    return;
  }
  el.dataset.key = key;
  el.replaceChildren(h('div', 'setup-label', t('update.title')));
  if (!s) return;
  el.append(h('p', 'update-about-lead', message(s)));
  if (s.checkedAt && s.kind !== 'off') el.append(h('div', 'setup-hint', t('update.checkedAgo', { when: ago(s.checkedAt) })));
  el.append(...details(s));
  const actionsRow = h('div', 'setup-row');
  if (s.kind !== 'off' && s.kind !== 'unofficial' && !s.progress) {
    const check = button(s.checking ? t('update.lead.checking') : t('update.check'), 'btn small', () => void hub.checkUpdate().then(apply), s.checking);
    check.prepend(icon(ICONS.sync));
    actionsRow.append(check);
  }
  actionsRow.append(...actions(s, 'btn primary small', 'btn small'));
  if (actionsRow.childElementCount > 0) el.append(actionsRow);
  if (s.kind === 'off' || s.kind === 'unofficial') {
    el.append(button(t('update.readme'), 'setup-link', () => hub.openExternal('https://github.com/Anilito1/ai_box#updating')));
    return;
  }
  const choices = h('div', 'setup-choices update-modes');
  choices.setAttribute('role', 'radiogroup');
  choices.setAttribute('aria-label', t('update.modes'));
  for (const mode of UPDATE_MODES) choices.append(modeChoice(mode, s.mode));
  el.append(h('div', 'setup-label update-modes-label', t('update.modes')), choices);
}

function modeChoice(mode: UpdateMode, current: UpdateMode): HTMLLabelElement {
  const choice = h('label', `setup-choice${mode === current ? ' checked' : ''}`);
  const radio = h('input');
  radio.type = 'radio';
  radio.name = 'update-mode';
  radio.checked = mode === current;
  radio.addEventListener('change', () => {
    if (radio.checked) void hub.saveSettings({ updates: mode }).then(() => hub.updateState()).then(apply);
  });
  const words = h('span', 'setup-choice-text');
  words.append(h('span', 'setup-choice-title', t(`update.mode.${mode}` as 'update.mode.auto')), h('span', 'setup-choice-hint', t(`update.mode.${mode}.hint` as 'update.mode.auto.hint')));
  choice.append(radio, words);
  return choice;
}

/** The block of Settings › About: kept up to date while it is shown. */
export function updateSection(): HTMLElement {
  const el = h('div', 'setup-field update-about');
  sections.add(el);
  fill(el);
  return el;
}

// ---------- start ----------

/** `busy`: an unsent message or open settings, which an unattended restart would lose. `place`: where the badge goes. */
export function initUpdates(api: HubApi, busy: () => boolean, place: HTMLElement): void {
  hub = api;
  uiBusy = busy;
  slot = place;
  slot.hidden = true;
  slot.append(chip, card);
  document.addEventListener('pointerdown', (e) => {
    if (!open || slot.contains(e.target as Node)) return;
    open = false;
    render();
  });
  slot.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !open) return;
    e.stopPropagation();
    open = false;
    render();
    chip.focus();
  });
  hub.onUpdate(apply);
  void hub.updateState().then(apply);
}

/** The palette's "Check for updates": asks now and shows the outcome on the badge's card. */
export function checkForUpdates(): void {
  asked = true;
  open = true;
  dismissed = '';
  if (state) render();
  void hub.checkUpdate().then(apply);
}
