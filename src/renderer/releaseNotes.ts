import { NOTE_SECTIONS } from '../shared/releaseNotes';
import type { HubApi } from '../shared/types';
import { h } from './dom';
import { t } from './i18n';

// What changed since the last start, over the window once: Ajouté / Modifié / Supprimé, one short line each. The main
// process works out the lines (main/releaseNotes.ts); shown means seen, a reload of the window shows them no more.

/** Shows the notes if there are any, unless `busy` (the settings are open): they then wait for the next start. */
export async function showReleaseNotes(hub: HubApi, busy: () => boolean): Promise<void> {
  const notes = await hub.releaseNotes().catch(() => null);
  if (!notes || busy()) return;
  hub.releaseNotesSeen();
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const overlay = h('div', 'notes-overlay');
  const card = h('div', 'notes-card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'notes-title');
  const title = h('h2', 'notes-title', t('notes.title'));
  title.id = 'notes-title';
  const body = h('div', 'notes-body');
  body.append(title, h('p', 'notes-lead', t('notes.lead')));
  for (const section of NOTE_SECTIONS) {
    if (notes[section].length === 0) continue;
    const list = h('ul', 'notes-list');
    list.append(...notes[section].map((line) => h('li', '', line)));
    const block = h('section', `notes-section ${section}`);
    block.append(h('h3', 'notes-label', t(`notes.${section}`)), list);
    body.append(block);
  }
  const foot = h('div', 'notes-foot');
  const close = h('button', 'btn primary', t('notes.close'));
  close.type = 'button';
  foot.append(close);
  card.append(body, foot);
  overlay.append(card);

  const done = () => {
    overlay.classList.add('closing');
    document.removeEventListener('keydown', onKey, true);
    window.setTimeout(() => overlay.remove(), 240);
    if (returnFocus?.isConnected) returnFocus.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      // The button is the dialog's only stop.
      if (e.key === 'Escape') done();
    }
  };
  close.addEventListener('click', done);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) done();
  });
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  close.focus();
}
