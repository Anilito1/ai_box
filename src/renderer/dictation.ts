import type { DictationEvent, DictationKey, DictationSettings } from '../shared/dictation';
import type { HubApi } from '../shared/types';
import { h, icon, ICONS } from './dom';
import { PLATFORM, t } from './i18n';

// Voice dictation in the composer: a microphone button, and a key to hold (talk while it is down) or tap (talk until
// it is tapped again). The words appear dimmed where the cursor is while they are being recognised, and settle there
// when the speech ends. Nothing is sent: the text waits in the composer. Escape drops it.

/** Under this long, a press of the key is a tap (it toggles) and not a hold (it ends on release). */
const HOLD_MS = 350;
/** How long the settled text is waited for once the audio has ended, before the last partial stands in for it. */
const FINAL_WAIT_MS = 4000;

export interface DictationSource {
  input: HTMLTextAreaElement;
  /** Names the engine should favour (the repo, the branch…). */
  terms(): string[];
  /** A message for the user, under the composer. */
  note(text: string): void;
  /** The text changed: the send button follows. */
  changed(): void;
}

export interface DictationUi {
  /** The text field with the layer that shows the partial text; takes the place of the bare textarea. */
  field: HTMLElement;
  button: HTMLButtonElement;
}

type State = 'idle' | 'starting' | 'listening' | 'finishing';

interface Run {
  ui: Ui;
  /** The composer's text around the cursor when the dictation began. */
  before: string;
  after: string;
  partial: string;
  /** Escape or a second press came while the engine and the microphone were still starting. */
  stopAsked: boolean;
  cancelAsked: boolean;
  audio: { stream: MediaStream; context: AudioContext; node: AudioWorkletNode } | null;
  finalTimer: number;
}

interface Ui extends DictationUi {
  source: DictationSource;
  mirror: HTMLElement;
}

let hub: HubApi;
let settings: DictationSettings | null = null;
let supported = false;
let state: State = 'idle';
let run: Run | null = null;
/** The key went down and has not come up: its release ends a dictation that lasted HOLD_MS or more. */
let keyDownAt: number | null = null;
const uis: Ui[] = [];
let lastFocused: Ui | null = null;

/** Called once, with the window's API: reads the settings and what the machine can do, and listens to the key. */
export function initDictation(api: HubApi): void {
  hub = api;
  hub.onDictation(onEvent);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', () => keyDownAt !== null && endHold());
  window.addEventListener('hub-settings', () => void refresh());
  void refresh();
}

/** Asks again what the settings say and what the machine can do (the language or the switch changed). */
async function refresh(): Promise<void> {
  const view = await hub.getSettings();
  settings = view.settings.dictation;
  supported = settings.enabled && (await hub.dictationSupport()).available;
  for (const ui of uis) {
    ui.button.hidden = !supported;
    ui.button.title = buttonTitle();
  }
  if (!supported && state !== 'idle') cancel();
}

/** `KeyboardEvent.key` of the modifier whose release ends a hold. */
const modifierOf: Record<DictationKey, string> = { 'Alt+Space': 'Alt', 'Ctrl+Space': 'Control', F9: '' };

function matches(e: KeyboardEvent, key: DictationKey): boolean {
  if (key === 'F9') return e.code === 'F9' && !e.altKey && !e.ctrlKey && !e.metaKey;
  if (e.code !== 'Space' || e.metaKey || e.shiftKey) return false;
  return key === 'Alt+Space' ? e.altKey && !e.ctrlKey : e.ctrlKey && !e.altKey;
}

function target(): Ui | undefined {
  const focused = uis.find((u) => u.source.input === document.activeElement);
  const visible = (u: Ui) => u.field.offsetParent !== null;
  return focused ?? (lastFocused && visible(lastFocused) ? lastFocused : uis.find(visible));
}

function onKeyDown(e: KeyboardEvent): void {
  if (!supported || !settings) return;
  if (e.key === 'Escape' && state !== 'idle') {
    // The dictation goes, and so does this key: it must not also interrupt the session.
    e.preventDefault();
    e.stopImmediatePropagation();
    cancel();
    return;
  }
  if (!matches(e, settings.key)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (e.repeat) return;
  if (state === 'idle') {
    const ui = target();
    if (!ui) return;
    keyDownAt = Date.now();
    void start(ui);
  } else if (state === 'starting' || state === 'listening') {
    // A tap started it: the next press ends it.
    keyDownAt = null;
    stop();
  }
}

function onKeyUp(e: KeyboardEvent): void {
  if (keyDownAt === null || !settings) return;
  const released = settings.key === 'F9' ? e.code === 'F9' : e.code === 'Space' || e.key === modifierOf[settings.key];
  if (released) endHold();
}

function endHold(): void {
  const held = keyDownAt !== null && Date.now() - keyDownAt >= HOLD_MS;
  keyDownAt = null;
  if (held) stop();
}

// ---------- the dictation ----------

async function start(ui: Ui): Promise<void> {
  if (state !== 'idle') return;
  state = 'starting';
  const current: Run = { ui, before: '', after: '', partial: '', stopAsked: false, cancelAsked: false, audio: null, finalTimer: 0 };
  run = current;
  const input = ui.source.input;
  const from = input.selectionStart;
  const to = input.selectionEnd;
  current.before = input.value.slice(0, from);
  current.after = input.value.slice(to);
  input.readOnly = true;
  paint(current, true);
  try {
    const allowed = await hub.dictationPermission();
    if (!allowed.ok) return fail(current, t('dictation.denied'));
    // The engine and the microphone start together; audio gathered meanwhile waits in the pipe.
    const [started, audio] = await Promise.all([hub.dictationStart(termsOf(ui)), openMicrophone(current)]);
    current.audio = audio;
    if (!started.ok) return fail(current, current.cancelAsked ? '' : t('dictation.unavailable'));
  } catch (err) {
    return fail(current, err instanceof DOMException && err.name === 'NotAllowedError' ? t('dictation.denied') : t('dictation.noMic'));
  }
  if (run !== current) return closeAudio(current);
  state = 'listening';
  if (current.cancelAsked) return cancel();
  paint(current, true);
  if (current.stopAsked) stop();
}

const termsOf = (ui: Ui): string[] => {
  try {
    return ui.source.terms();
  } catch {
    return [];
  }
};

async function openMicrophone(current: Run): Promise<NonNullable<Run['audio']>> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  try {
    const context = new AudioContext({ sampleRate: 16_000 });
    await context.audioWorklet.addModule('dictation-worklet.js');
    const node = new AudioWorkletNode(context, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 0 });
    node.port.onmessage = (m: MessageEvent<ArrayBuffer>) => {
      if (run === current && (state === 'starting' || state === 'listening' || state === 'finishing')) hub.dictationAudio(m.data);
    };
    context.createMediaStreamSource(stream).connect(node);
    return { stream, context, node };
  } catch (err) {
    for (const track of stream.getTracks()) track.stop();
    throw err;
  }
}

function closeAudio(current: Run): void {
  const audio = current.audio;
  current.audio = null;
  if (!audio) return;
  for (const track of audio.stream.getTracks()) track.stop();
  audio.node.port.onmessage = null;
  void audio.context.close();
}

/** The speech has ended (key released, button tapped again): the audio stops and the engine settles the text. */
function stop(): void {
  const current = run;
  if (!current) return;
  if (state === 'starting') {
    current.stopAsked = true;
    return;
  }
  if (state !== 'listening') return;
  state = 'finishing';
  paint(current, true);
  // The last block of the microphone goes out before the audio closes.
  current.audio?.node.port.postMessage('flush');
  window.setTimeout(() => {
    if (run !== current) return;
    closeAudio(current);
    hub.dictationStop();
    current.finalTimer = window.setTimeout(() => run === current && settle(current, current.partial), FINAL_WAIT_MS);
  }, 60);
}

function cancel(): void {
  const current = run;
  if (!current) return;
  if (state === 'starting') {
    current.cancelAsked = true;
    hub.dictationCancel();
    // The start in progress ends first; its own checks see the flag.
    return;
  }
  hub.dictationCancel();
  end(current);
  current.ui.source.input.value = current.before + current.after;
  restoreCursor(current, current.before.length);
  current.ui.source.changed();
}

function fail(current: Run, message: string): void {
  hub.dictationCancel();
  end(current);
  current.ui.source.input.value = current.before + current.after;
  restoreCursor(current, current.before.length);
  current.ui.source.changed();
  if (message) current.ui.source.note(message);
}

function end(current: Run): void {
  window.clearTimeout(current.finalTimer);
  closeAudio(current);
  if (run === current) {
    run = null;
    state = 'idle';
  }
  const ui = current.ui;
  ui.source.input.readOnly = false;
  ui.field.classList.remove('dictating');
  ui.button.classList.remove('recording');
  ui.button.setAttribute('aria-pressed', 'false');
  ui.mirror.replaceChildren();
}

function restoreCursor(current: Run, at: number): void {
  const input = current.ui.source.input;
  input.setSelectionRange(at, at);
  input.focus();
}

/** What goes between the composer's text and the dictation: a space where two words would touch. */
function around(current: Run, text: string): { lead: string; trail: string } {
  if (text === '') return { lead: '', trail: '' };
  const lead = current.before !== '' && !/\s$/.test(current.before) && !/^\s/.test(text) ? ' ' : '';
  const trail = current.after !== '' && !/^\s/.test(current.after) && !/\s$/.test(text) && !/^[.,;:!?)]/.test(current.after) ? ' ' : '';
  return { lead, trail };
}

function onEvent(event: DictationEvent): void {
  const current = run;
  if (!current) return;
  if (event.type === 'partial') {
    current.partial = event.text;
    paint(current, false);
  } else if (event.type === 'final') {
    settle(current, event.text);
  } else if (event.type === 'error') {
    fail(current, t('dictation.failed'));
  }
}

/** The text is final: it is part of the composer's, the cursor after it. */
function settle(current: Run, raw: string): void {
  const text = raw.trim();
  const { lead, trail } = around(current, text);
  const input = current.ui.source.input;
  end(current);
  input.value = current.before + lead + text + trail + current.after;
  restoreCursor(current, (current.before + lead + text).length);
  // The draft, the send button and the "/" menu follow as they do for typing.
  input.dispatchEvent(new Event('input'));
  input.scrollTop = input.scrollHeight;
}

/**
 * The composer's text with the partial words in it, dimmed. The field holds the whole text (so its height and its line
 * breaks are the right ones); the layer above it draws it, the partial words fainter.
 */
function paint(current: Run, force: boolean): void {
  const { ui } = current;
  const text = current.partial.trim();
  const { lead, trail } = around(current, text);
  const input = ui.source.input;
  const inserted = lead + text + trail;
  if (force || input.value !== current.before + inserted + current.after) input.value = current.before + inserted + current.after;
  ui.field.classList.add('dictating');
  ui.button.classList.add('recording');
  ui.button.setAttribute('aria-pressed', 'true');
  const hint = state === 'starting' ? h('span', 'dictation-wait', '…') : null;
  ui.mirror.replaceChildren(document.createTextNode(current.before + lead), h('span', 'dictation-partial', text), ...(hint ? [hint] : []), document.createTextNode(trail + current.after + '​'));
  ui.mirror.scrollTop = input.scrollTop;
  ui.source.changed();
}

/** Drops the dictation that writes into this field, if any. */
export function cancelDictation(input: HTMLTextAreaElement): void {
  if (run?.ui.source.input === input) cancel();
}

// ---------- the composer's side ----------

export function createDictationUi(source: DictationSource): DictationUi {
  const mirror = h('div', 'composer-mirror');
  mirror.setAttribute('aria-hidden', 'true');
  const field = h('div', 'composer-field');
  field.append(source.input, mirror);
  const button = h('button', 'cbtn cbtn-icon cbtn-mic');
  button.append(icon(ICONS.mic));
  button.hidden = !supported;
  button.title = buttonTitle();
  button.setAttribute('aria-label', t('dictation.label'));
  button.setAttribute('aria-pressed', 'false');
  // The field keeps the focus: the text lands at its cursor.
  button.addEventListener('mousedown', (e) => e.preventDefault());
  const ui: Ui = { field, button, source, mirror };
  button.addEventListener('click', () => {
    if (state === 'idle') {
      lastFocused = ui;
      void start(ui);
    } else if (run?.ui === ui) stop();
  });
  source.input.addEventListener('focus', () => (lastFocused = ui));
  source.input.addEventListener('scroll', () => (mirror.scrollTop = source.input.scrollTop));
  uis.push(ui);
  return ui;
}

/** The key as the button's tooltip shows it. */
export const keyLabel = (key: DictationKey): string => (PLATFORM === 'darwin' ? key.replace('Alt', '⌥').replace('Ctrl', '⌃') : key);

const buttonTitle = (): string => t('dictation.button', { key: keyLabel(settings?.key ?? 'Alt+Space') });
