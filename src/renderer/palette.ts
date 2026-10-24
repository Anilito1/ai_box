import { h } from './dom';
import { PLATFORM, t } from './i18n';

export interface Command {
  title: string;
  hint?: string;
  /** Shortcut shown on the right, as `shortcut()` writes it. */
  keys?: string;
  run: () => void;
}

const MAC = PLATFORM === 'darwin';

/** "⌘K" on a Mac, "Ctrl+K" elsewhere. */
export const shortcut = (key: string, shift = false) => (MAC ? `${shift ? '⇧' : ''}⌘${key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`);

/** Cmd on a Mac, Ctrl elsewhere, and no other modifier unless asked. */
export const isMod = (e: KeyboardEvent, shift = false) => (MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey && e.shiftKey === shift;

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

let openPalette: { close: () => void } | null = null;

export const paletteOpen = () => openPalette !== null;

/** Filterable list of commands over the window; Enter runs the selected one, Escape closes. */
export function showPalette(commands: Command[]): void {
  if (openPalette) return openPalette.close();
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const overlay = h('div', 'palette-overlay');
  const panel = h('div', 'palette');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', t('palette.title'));
  const input = h('input', 'palette-input');
  input.type = 'text';
  input.placeholder = t('palette.placeholder');
  input.spellcheck = false;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-controls', 'palette-list');
  input.setAttribute('aria-autocomplete', 'list');
  const list = h('div', 'palette-list');
  list.id = 'palette-list';
  list.setAttribute('role', 'listbox');
  panel.append(input, list);
  overlay.append(panel);

  let shown: Command[] = [];
  let index = 0;
  const select = (i: number) => {
    index = Math.max(0, Math.min(shown.length - 1, i));
    for (const [n, row] of [...list.children].entries()) row.setAttribute('aria-selected', String(n === index));
    const row = list.children[index] as HTMLElement | undefined;
    if (row) {
      input.setAttribute('aria-activedescendant', row.id);
      row.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  };
  const draw = () => {
    const words = fold(input.value).split(/\s+/).filter(Boolean);
    shown = commands.filter((c) => words.every((w) => fold(`${c.title} ${c.hint ?? ''}`).includes(w)));
    list.replaceChildren(
      ...shown.map((c, i) => {
        const row = h('div', 'palette-row');
        row.id = `palette-${i}`;
        row.setAttribute('role', 'option');
        const text = h('span', 'palette-text');
        text.append(h('span', 'palette-title', c.title));
        if (c.hint) text.append(h('span', 'palette-hint', c.hint));
        row.append(text);
        if (c.keys) row.append(h('kbd', 'kbd', c.keys));
        row.addEventListener('pointermove', () => index !== i && select(i));
        row.addEventListener('click', () => run(i));
        return row;
      }),
    );
    if (shown.length === 0) list.append(h('div', 'palette-empty', t('palette.empty')));
    select(0);
  };
  const close = () => {
    openPalette = null;
    overlay.classList.add('closing');
    document.removeEventListener('keydown', onKey, true);
    window.setTimeout(() => overlay.remove(), 160);
    if (returnFocus?.isConnected) returnFocus.focus();
  };
  const run = (i: number) => {
    const command = shown[i];
    if (!command) return;
    close();
    command.run();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      select(index + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      run(index);
    } else if (e.key === 'Tab') {
      e.preventDefault(); // The field is the dialog's only stop.
    }
  };
  input.addEventListener('input', draw);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onKey, true);
  draw();
  document.body.append(overlay);
  input.focus();
  openPalette = { close };
}
