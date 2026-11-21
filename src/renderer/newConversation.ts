import type { ConversationChoices, Effort, HubApi, PickerEntry, PickerFolder } from '../shared/types';
import { h } from './dom';
import { effortLabel, t } from './i18n';

// "New conversation": the user opens a worker conversation themselves, without going through the master. The window
// lists what the main process offers (conversationChoices in main/sessions.ts: the models spawn_worker may run, in
// groups, and the folders it knows); the hub starts it the master's way and the conversation opens beside the master.
// The model list is made of groups of entries: another kind of group (graphs of models) only adds its own.

/** The model and effort of the last conversation opened: the next window starts on them. */
const LAST_KEY = 'newConversation';

let current: { close: () => void } | null = null;

/** The window is open: the app's own shortcuts wait. */
export const newConversationOpen = () => current !== null;

function option(value: string, text: string): HTMLOptionElement {
  const o = h('option', '', text);
  o.value = value;
  return o;
}

function lastPick(): { entry: string; effort: string } {
  try {
    const raw = JSON.parse(localStorage.getItem(LAST_KEY) ?? '{}') as { entry?: unknown; effort?: unknown };
    return { entry: typeof raw.entry === 'string' ? raw.entry : '', effort: typeof raw.effort === 'string' ? raw.effort : '' };
  } catch {
    return { entry: '', effort: '' };
  }
}

/** Opens the window; `opened` gets the new session's id once the hub made it. */
export async function openNewConversation(hub: HubApi, opened: (id: string) => void): Promise<void> {
  if (current) return;
  current = { close: () => undefined };
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const choices = await hub.conversationChoices().catch(() => null);

  const overlay = h('div', 'notes-overlay');
  const card = h('form', 'notes-card conv-card');
  card.noValidate = true;
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'conv-title');
  const title = h('h2', 'notes-title', t('newConv.title'));
  title.id = 'conv-title';
  const body = h('div', 'notes-body');
  body.append(title, h('p', 'notes-lead', t('newConv.lead')));
  const error = h('p', 'conv-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const foot = h('div', 'notes-foot');
  const cancel = h('button', 'btn ghost', t('newConv.cancel'));
  cancel.type = 'button';
  const create = h('button', 'btn primary conv-create', t('newConv.create'));
  create.type = 'submit';
  foot.append(cancel, create);
  card.append(body, foot);
  overlay.append(card);

  const done = () => {
    if (!overlay.isConnected) return;
    overlay.classList.add('closing');
    document.removeEventListener('keydown', onKey, true);
    window.setTimeout(() => overlay.remove(), 240);
    current = null;
    if (returnFocus?.isConnected) returnFocus.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      done();
    } else if (e.key === 'Tab') {
      // The window's own fields and buttons are its only stops.
      const stops = [...card.querySelectorAll<HTMLElement>('select:not([disabled]), input, textarea, button:not([disabled])')];
      if (stops.length === 0) return;
      const at = stops.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (at <= 0 ? stops.length - 1 : at - 1) : (at + 1) % stops.length;
      e.preventDefault();
      stops[next].focus();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      card.requestSubmit();
    } else if (e.ctrlKey || e.metaKey || e.altKey) {
      // The app's shortcuts (palette, settings, workers) wait while the window is open; editing keys still work.
      e.stopPropagation();
    }
  };
  cancel.addEventListener('click', done);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) done();
  });
  document.addEventListener('keydown', onKey, true);
  current = { close: done };

  const groups = choices?.groups.filter((g) => g.entries.length > 0) ?? [];
  if (!choices || groups.length === 0) {
    body.append(h('p', 'conv-empty', t(choices ? 'newConv.noModel' : 'newConv.failed')));
    create.disabled = true;
    document.body.append(overlay);
    cancel.focus();
    return;
  }
  const form = fields(hub, choices);
  body.append(form.root, error);
  document.body.append(overlay);
  form.model.focus();

  let busy = false;
  card.addEventListener('submit', (e) => {
    e.preventDefault();
    const entry = form.entry();
    if (!entry || busy) return;
    busy = true;
    create.disabled = true;
    create.textContent = t('newConv.creating');
    error.hidden = true;
    const effort = (form.effort.value || null) as Effort | null;
    void hub
      .newConversation({ target: entry.target, effort, cwd: form.folder.value, name: form.name.value.trim(), message: form.message.value })
      .catch((err: unknown) => ({ ok: false as const, error: String(err) }))
      .then((r) => {
        if (r.ok) {
          try {
            localStorage.setItem(LAST_KEY, JSON.stringify({ entry: entry.id, effort: form.effort.value }));
          } catch {
            // Not remembered: fine.
          }
          done();
          opened(r.id);
          return;
        }
        busy = false;
        create.disabled = false;
        create.textContent = t('newConv.create');
        error.textContent = r.error;
        error.hidden = false;
      });
  });
}

/** The window's fields: model (in its groups), effort, folder, name and first message. */
function fields(hub: HubApi, choices: ConversationChoices) {
  const root = h('div', 'conv-fields');
  /** `shown`: what goes under the label when the control sits in a row of its own. */
  const field = (id: string, label: string, control: HTMLElement, cls = '', shown: HTMLElement = control) => {
    const f = h('div', `conv-field ${cls}`.trim());
    const l = h('label', 'conv-label', label);
    l.htmlFor = id;
    control.id = id;
    f.append(l, shown);
    root.append(f);
    return f;
  };

  const entries = new Map<string, PickerEntry>();
  const model = h('select', 'setup-select conv-select');
  for (const g of choices.groups) {
    if (g.entries.length === 0) continue;
    const group = h('optgroup');
    group.label = g.label;
    for (const entry of g.entries) {
      const o = option(entry.id, entry.label);
      if (entry.hint) o.title = entry.hint;
      group.append(o);
      entries.set(entry.id, entry);
    }
    model.append(group);
  }
  const effort = h('select', 'setup-select conv-select');
  const last = lastPick();
  if (entries.has(last.entry)) model.value = last.entry;
  const fillEffort = (wanted: string) => {
    const entry = entries.get(model.value);
    effort.replaceChildren();
    effort.disabled = !entry || entry.efforts.length === 0;
    if (effort.disabled) return void effort.append(option('', t('newConv.effortNone')));
    effort.append(option('', t('newConv.effortAuto')), ...(entry?.efforts ?? []).map((x) => option(x, effortLabel(x))));
    effort.value = (entry?.efforts as string[]).includes(wanted) ? wanted : '';
  };
  fillEffort(last.effort);
  model.addEventListener('change', () => fillEffort(effort.value));
  field('conv-model', t('newConv.model'), model, 'conv-model');
  field('conv-effort', t('newConv.effort'), effort, 'conv-effort');

  // The known folders, the home folder first (the default); "Browse…" adds the one picked.
  const folders = new Map<string, PickerFolder>();
  const folder = h('select', 'setup-select conv-select');
  const addFolder = (f: PickerFolder) => {
    folders.set(f.path, f);
    const o = option(f.path, f.label && f.label !== f.path ? `${f.label} — ${f.path}` : f.path);
    o.title = f.path;
    folder.append(o);
  };
  for (const f of choices.folders) addFolder(f);
  if (!folders.has(choices.cwd)) addFolder({ path: choices.cwd, label: '', writers: [] });
  folder.value = choices.cwd;
  const browse = h('button', 'btn conv-browse', t('newConv.browse'));
  browse.type = 'button';
  const row = h('div', 'conv-row');
  row.append(folder, browse);
  const where = field('conv-folder', t('newConv.folder'), folder, 'conv-wide', row);
  const writers = h('p', 'conv-hint');
  where.append(writers);
  const hint = () => {
    const names = folders.get(folder.value)?.writers ?? [];
    writers.textContent = names.length > 0 ? t('newConv.writers', { names: names.join(', ') }) : '';
    writers.hidden = names.length === 0;
  };
  hint();
  folder.addEventListener('change', hint);
  browse.addEventListener('click', () => {
    void hub.pickFolder().then((path) => {
      if (!path) return;
      if (!folders.has(path)) addFolder({ path, label: '', writers: [] });
      folder.value = path;
      hint();
      folder.focus();
    });
  });

  const name = h('input', 'setup-input conv-input');
  name.type = 'text';
  name.maxLength = 60;
  name.placeholder = t('newConv.namePlaceholder');
  name.spellcheck = false;
  field('conv-name', t('newConv.name'), name, 'conv-wide');
  const message = h('textarea', 'setup-textarea conv-message');
  message.rows = 4;
  message.placeholder = t('newConv.messagePlaceholder');
  field('conv-message', t('newConv.message'), message, 'conv-wide');

  return { root, model, effort, folder, name, message, entry: () => entries.get(model.value) };
}
