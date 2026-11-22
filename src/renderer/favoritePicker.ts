import { favoriteGroups, filterFavorites } from '../shared/favorites';
import type { ProviderBadge } from '../shared/types';
import { h, icon, ICONS } from './dom';
import { t } from './i18n';
import { mascotMark } from './mascot';
import { shortcut } from './palette';

// The Favourites tab of a conversation's model menu: the models the user starred at each connected provider, grouped
// by provider, behind a filter field. Arrows move, Enter applies, Escape closes (the menu's). Picking a model of
// another provider moves the conversation there, as the provider tabs do.

export interface FavoritePickerOptions {
  providers: ProviderBadge[];
  /** Where the conversation is: its row is checked and selected first. */
  current: { provider: string; model: string };
  pick: (provider: string, model: string) => void;
  /** Opens Settings › Providers, where the stars are put. */
  manage: () => void;
}

let lists = 0;

/** The pane, and its field (which takes the focus once the menu shows). */
export function favoritePicker(o: FavoritePickerOptions): { el: HTMLElement; field: HTMLInputElement } {
  const groups = favoriteGroups(o.providers);
  const el = h('div', 'fav-pick');
  const field = h('input', 'fav-filter');
  field.type = 'text';
  field.placeholder = t('fav.filter');
  field.spellcheck = false;
  field.autocomplete = 'off';
  field.setAttribute('aria-label', t('fav.filter'));
  const list = h('div', 'fav-list');
  list.id = `fav-list-${++lists}`;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', t('fav.title'));
  field.setAttribute('role', 'combobox');
  field.setAttribute('aria-expanded', 'true');
  field.setAttribute('aria-controls', list.id);
  field.setAttribute('aria-autocomplete', 'list');

  let rows: { el: HTMLButtonElement; provider: string; model: string }[] = [];
  let index = 0;
  // Where the pointer last was: a list scrolled under a still pointer fires a mousemove that is no move.
  let pointer = '';
  const select = (i: number) => {
    if (rows.length === 0) return field.removeAttribute('aria-activedescendant');
    index = (i + rows.length) % rows.length;
    rows.forEach((r, n) => {
      r.el.classList.toggle('active', n === index);
      r.el.setAttribute('aria-selected', String(n === index));
    });
    field.setAttribute('aria-activedescendant', rows[index].el.id);
    rows[index].el.scrollIntoView({ block: 'nearest' });
  };
  const draw = () => {
    list.replaceChildren();
    rows = [];
    if (groups.length === 0) {
      list.append(h('div', 'menu-note', t('fav.none')));
      return select(0);
    }
    const shown = filterFavorites(groups, field.value);
    if (shown.length === 0) list.append(h('div', 'menu-note', t('fav.noMatch')));
    for (const g of shown) {
      const head = h('div', 'fav-group');
      head.setAttribute('role', 'presentation');
      head.append(mascotMark(g.id, 'fav-mark', g.label, g.models.map((m) => m.value)), h('span', '', g.label));
      list.append(head);
      for (const m of g.models) {
        const n = rows.length;
        const on = g.id === o.current.provider && m.value === o.current.model;
        const row = h('button', on ? 'menu-row fav-row checked' : 'menu-row fav-row');
        row.type = 'button';
        row.tabIndex = -1;
        row.id = `${list.id}-${n}`;
        row.setAttribute('role', 'option');
        const text = h('span', 'menu-text');
        text.append(h('span', 'menu-title', m.label));
        if (m.description) text.append(h('span', 'menu-hint', m.description));
        row.append(on ? icon(ICONS.check) : h('span', 'ico'), text);
        row.addEventListener('click', () => o.pick(g.id, m.value));
        // The pointer and the arrows share one selection: never two rows lit.
        row.addEventListener('mousemove', (e) => {
          const at = `${e.screenX},${e.screenY}`;
          if (at === pointer) return;
          pointer = at;
          if (index !== n) select(n);
        });
        rows.push({ el: row, provider: g.id, model: m.value });
        list.append(row);
      }
    }
    const here = rows.findIndex((r) => r.provider === o.current.provider && r.model === o.current.model);
    select(field.value.trim() || here < 0 ? 0 : here);
  };
  field.addEventListener('input', draw);
  field.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      select(index + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = rows[index];
      if (r) o.pick(r.provider, r.model);
    }
  });

  const foot = h('div', 'fav-foot');
  const manage = h('button', 'menu-more fav-manage', t('fav.manage'));
  manage.type = 'button';
  manage.addEventListener('click', o.manage);
  foot.append(manage, h('kbd', 'fav-keys', shortcut('M', true)));
  el.append(field, list, foot);
  draw();
  return { el, field };
}
