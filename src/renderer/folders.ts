import { addFolder, FOLDER_LIMITS, moveFolder, NO_FOLDERS, placePost, removeFolder, renameFolder, toggleFolder, type Arranged, type TeamFolder, type TeamFolderPrefs } from '../shared/teamFolders';
import type { HubApi, SessionView } from '../shared/types';
import { h, icon, ICONS, openMenu } from './dom';
import { t, tn } from './i18n';

/** A post with what the sidebar shows under it (its instances at work, its group's posts): it moves as one. */
export type Block = SessionView[];

/** Where a drop lands: into a folder (null: the root) before a post or a folder (null: last). */
interface Target {
  to: string | null;
  before: string | null;
  /** Framed while the pointer is there: the folder or the root a post would land in. */
  zone: HTMLElement | null;
  /** Height of the insertion line in the list, none when the drop goes into a folder's header. */
  line: number | null;
}

/** A folder's nodes, made once: a fold or a new count changes them in place, under the pointer of a double-click. */
interface Section {
  root: HTMLElement;
  head: HTMLDivElement;
  toggle: HTMLButtonElement;
  name: HTMLSpanElement;
  count: HTMLSpanElement;
  list: HTMLDivElement;
  key: string;
}

const setData = (el: HTMLElement, key: string, value: string | null) => {
  if ((el.dataset[key] ?? null) === value) return;
  if (value === null) delete el.dataset[key];
  else el.dataset[key] = value;
};

const newId = () => `f-${[...crypto.getRandomValues(new Uint8Array(8))].map((b) => (b % 36).toString(36)).join('')}`;

/**
 * The folders of the Team section: the user's own arrangement of the posts, saved in the settings. A folder folds on a
 * click, renames on a double-click, and has a menu on a right-click; a post or a folder moves by drag and drop, or by
 * the post's menu. With no folder the section looks as it always did.
 */
export class TeamFolders {
  private prefs: TeamFolderPrefs = NO_FOLDERS;
  private readonly sections = new Map<string, Section>();
  private readonly rootList = h('div', 'card-list team-root');
  private readonly rootDrop = h('div', 'team-root-drop', t('folder.dropRoot'));
  private readonly line = h('div', 'team-drop-line');
  /** Posts at the root as shown, first to last. */
  private shownRoot: string[] = [];
  private drag: { kind: 'post' | 'folder'; id: string; from: HTMLElement } | null = null;
  private target: Target | null = null;
  /** The folder whose name is being typed; "new" for a folder being created. */
  private editing: string | null = null;
  private newRow: HTMLElement | null = null;

  constructor(
    private readonly hub: HubApi,
    private readonly list: HTMLElement,
    label: HTMLElement,
    private readonly changed: () => void,
  ) {
    const add = h('button', 'side-add');
    add.type = 'button';
    add.title = t('folder.new');
    add.setAttribute('aria-label', add.title);
    add.append(icon(ICONS.plus));
    add.addEventListener('click', () => this.edit('new'));
    label.append(add);
    this.line.hidden = true;
    this.list.addEventListener('dragstart', (e) => this.dragStart(e));
    this.list.addEventListener('dragover', (e) => this.dragOver(e));
    // Chromium gives a drag's leave no related element: the pointer's place tells whether it left the list.
    this.list.addEventListener('dragleave', (e) => {
      const r = this.list.getBoundingClientRect();
      if (e.clientX <= r.left || e.clientX >= r.right || e.clientY <= r.top || e.clientY >= r.bottom) this.mark(null);
    });
    this.list.addEventListener('drop', (e) => this.dropped(e));
    this.list.addEventListener('dragend', () => this.endDrag());
    this.list.addEventListener('contextmenu', (e) => this.contextMenu(e));
    this.reload();
  }

  get current(): TeamFolderPrefs {
    return this.prefs;
  }

  private use(prefs: TeamFolderPrefs): void {
    this.prefs = prefs;
    this.changed();
  }

  /** What the hub has saved; it drops the posts deleted meanwhile. */
  reload(): void {
    void this.hub.getSettings().then((v) => this.adopt(v.settings.teamFolders));
  }

  private adopt(saved: TeamFolderPrefs): void {
    if (JSON.stringify(saved) !== JSON.stringify(this.prefs)) this.use(saved);
  }

  /** Shown at once; refused by the hub (or the call failed), the sidebar goes back to what is saved. */
  private save(next: TeamFolderPrefs): void {
    if (next === this.prefs) return;
    this.use(next);
    this.hub.saveSettings({ teamFolders: next }).then(
      (r) => {
        if (this.prefs === next) this.adopt(r.settings.teamFolders);
      },
      () => this.reload(),
    );
  }

  /** Puts the cards in their folders; `extra` (posts a group loop would leave out) goes last, never dragged. */
  render(tree: Arranged<Block>, extra: Block[], nodeOf: (s: SessionView) => HTMLElement): void {
    const blockNodes = (b: Block) => {
      const nodes = b.map(nodeOf);
      const id = b[0]?.id ?? '';
      for (const n of nodes) {
        setData(n, 'block', id);
        setData(n, 'post', n === nodes[0] ? id : null);
        if (n.draggable !== (n === nodes[0])) n.draggable = n === nodes[0];
      }
      return nodes;
    };
    const seen = new Set<string>();
    const sections = tree.folders.map(({ folder, posts }) => {
      seen.add(folder.id);
      const section = this.section(folder, posts);
      syncList(section.list, posts.flatMap(blockNodes));
      return section.root;
    });
    for (const id of [...this.sections.keys()]) if (!seen.has(id)) this.sections.delete(id);
    this.shownRoot = tree.root.map((b) => b[0]?.id ?? '');
    const extraNodes = extra.flat().map(nodeOf);
    for (const n of extraNodes) {
      if (n.draggable) n.draggable = false;
      setData(n, 'post', null);
      setData(n, 'block', null);
    }
    syncList(this.rootList, [...tree.root.flatMap(blockNodes), ...extraNodes]);
    if (this.editing !== 'new') this.newRow = null;
    else this.newRow ??= this.makeNewRow();
    syncList(this.list, [...sections, ...(this.newRow ? [this.newRow] : []), this.rootList, this.rootDrop, this.line]);
    this.rootDrop.hidden = !this.rootDropShown();
  }

  /** A post dragged out of a folder needs somewhere to land when the root has no other post. */
  private rootDropShown(): boolean {
    const drag = this.drag;
    return drag?.kind === 'post' && this.shownRoot.every((id) => id === drag.id);
  }

  private section(folder: TeamFolder, posts: Block[]): Section {
    const s = this.sections.get(folder.id) ?? this.makeSection(folder.id);
    const all = posts.flat();
    const count = all.filter((x) => x.post).length;
    // Folded, it still says when one of its posts waits for the user or works.
    const mark = !folder.collapsed ? '' : all.some((x) => x.status === 'attention') ? 'attention' : all.some((x) => x.status === 'busy') ? 'busy' : '';
    const editing = this.editing === folder.id;
    const key = JSON.stringify([folder.name, folder.collapsed, count, mark, editing]);
    if (s.key === key) return s;
    s.key = key;
    s.root.classList.toggle('collapsed', folder.collapsed);
    s.toggle.setAttribute('aria-expanded', String(!folder.collapsed));
    s.toggle.setAttribute('aria-label', `${folder.name}, ${tn('folder.posts', count)}`);
    s.toggle.title = t('folder.tip', { name: folder.name });
    s.name.textContent = folder.name;
    s.count.replaceChildren(...(mark ? [h('span', `dot s-${mark}`)] : []), String(count));
    s.head.draggable = !editing;
    const typing = s.head.querySelector('input');
    if (editing && !typing) s.head.replaceChildren(this.input(folder.name, (name) => this.save(renameFolder(this.prefs, folder.id, name))));
    else if (!editing && (typing || s.head.childElementCount === 0)) s.head.replaceChildren(s.toggle, s.count);
    return s;
  }

  private makeSection(id: string): Section {
    const root = h('section', 'team-folder');
    root.dataset.folder = id;
    const head = h('div', 'team-folder-head');
    const toggle = h('button', 'team-folder-toggle');
    toggle.type = 'button';
    const name = h('span', 'team-folder-name');
    toggle.append(icon(ICONS.chevron, 'ico small team-folder-chevron'), name);
    // The two clicks of a double-click fold and unfold it: it ends as it was, its name being typed.
    toggle.addEventListener('click', (e) => {
      if (e.detail <= 1) this.save(toggleFolder(this.prefs, id));
    });
    toggle.addEventListener('dblclick', () => {
      this.save(toggleFolder(this.prefs, id));
      this.edit(id);
    });
    const count = h('span', 'team-folder-count');
    const list = h('div', 'card-list team-folder-list');
    root.append(head, list);
    const s = { root, head, toggle, name, count, list, key: '' };
    this.sections.set(id, s);
    return s;
  }

  private makeNewRow(): HTMLElement {
    const row = h('div', 'team-folder-head team-folder-new');
    row.append(icon(ICONS.chevron, 'ico small team-folder-chevron'), this.input('', (name) => this.save(addFolder(this.prefs, newId(), name))));
    return row;
  }

  /** A name field: Enter or leaving it keeps the name, Escape gives up. */
  private input(value: string, done: (name: string) => void): HTMLInputElement {
    const input = h('input', 'team-folder-input');
    input.value = value;
    input.placeholder = t('folder.name');
    input.maxLength = FOLDER_LIMITS.name;
    input.setAttribute('aria-label', t('folder.name'));
    let over = false;
    const finish = (keep: boolean) => {
      if (over) return;
      over = true;
      this.editing = null;
      const name = input.value.trim();
      if (keep && name) done(name);
      else this.changed();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
    return input;
  }

  private edit(id: string): void {
    // A name still being typed elsewhere is kept first (a removed field gets no blur).
    this.list.querySelector<HTMLInputElement>('.team-folder-input')?.blur();
    this.editing = id;
    for (const s of this.sections.values()) s.key = '';
    this.changed();
  }

  // ---------- drag and drop ----------

  private dragStart(e: DragEvent): void {
    const el = e.target as HTMLElement;
    const head = el.closest<HTMLElement>('.team-folder-head');
    const card = el.closest<HTMLElement>('.card[data-post]');
    const folder = head?.closest<HTMLElement>('.team-folder');
    if (folder?.dataset.folder && head?.draggable) this.drag = { kind: 'folder', id: folder.dataset.folder, from: folder };
    else if (card?.dataset.post) this.drag = { kind: 'post', id: card.dataset.post, from: card };
    else return;
    this.drag.from.classList.add('dragging');
    this.list.classList.add('team-dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', this.drag.id);
    }
    this.rootDrop.hidden = !this.rootDropShown();
  }

  private dragOver(e: DragEvent): void {
    if (!this.drag) return;
    const target = this.targetOf(e);
    if (!target) {
      this.mark(null);
      return;
    }
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    this.mark(target);
  }

  private dropped(e: DragEvent): void {
    const drag = this.drag;
    const target = drag && this.targetOf(e);
    this.endDrag();
    if (!drag || !target) return;
    e.preventDefault();
    if (drag.kind === 'folder') this.save(moveFolder(this.prefs, drag.id, target.before));
    else this.save(placePost(this.prefs, this.shownRoot, drag.id, target.to, target.before));
  }

  private endDrag(): void {
    this.drag?.from.classList.remove('dragging');
    this.drag = null;
    this.list.classList.remove('team-dragging');
    this.rootDrop.hidden = true;
    this.mark(null);
  }

  private mark(target: Target | null): void {
    this.target?.zone?.classList.remove('drop-zone', 'drop-into');
    target?.zone?.classList.add(target.line === null ? 'drop-into' : 'drop-zone');
    this.target = target;
    this.line.hidden = target?.line == null;
    if (target?.line != null) this.line.style.transform = `translateY(${target.line}px)`;
  }

  /** Where the pointer would drop what is dragged; in a gap between two rows, where it was a moment ago. */
  private targetOf(e: DragEvent): Target | null {
    const drag = this.drag;
    const el = e.target as HTMLElement;
    if (!drag || !(el instanceof Element)) return null;
    if (el === this.list) return this.target;
    const top = this.list.getBoundingClientRect().top;
    const folderEl = el.closest<HTMLElement>('.team-folder');
    if (drag.kind === 'folder') {
      const ids = this.prefs.folders.map((f) => f.id);
      if (!folderEl) return { to: null, before: null, zone: null, line: this.lineAfter(ids, top) };
      const id = folderEl.dataset.folder ?? '';
      if (id === drag.id) return null;
      const r = folderEl.getBoundingClientRect();
      const above = e.clientY < r.top + r.height / 2;
      return { to: null, before: above ? id : this.nextOf(ids, id, drag.id), zone: null, line: Math.max(0, (above ? r.top - 2 : r.bottom) - top) };
    }
    const to = folderEl?.dataset.folder ?? null;
    const zone = folderEl ?? el.closest<HTMLElement>('.team-root-drop') ?? this.rootList;
    // A folder's header takes it in; the row of a folder being created is no place.
    if (el.closest('.team-folder-head')) return folderEl ? { to, before: null, zone: folderEl, line: null } : null;
    const card = el.closest<HTMLElement>('.card[data-block]');
    const list = folderEl ? (folderEl.querySelector('.team-folder-list') as HTMLElement) : this.rootList;
    const blocks = [...new Set([...list.querySelectorAll<HTMLElement>('.card[data-block]')].map((n) => n.dataset.block ?? ''))];
    if (!card) return { to, before: null, zone, line: blocks.length > 0 ? this.blockEdge(list, blocks.at(-1) ?? '', false) - top : null };
    const block = card.dataset.block ?? '';
    if (block === drag.id) return null;
    const first = this.blockEdge(list, block, true);
    const last = this.blockEdge(list, block, false);
    const above = e.clientY < (first + last) / 2;
    return { to, before: above ? block : this.nextOf(blocks, block, drag.id), zone, line: (above ? first - 2 : last) - top };
  }

  /** The next of `ids` after `id`, skipping the one dragged; null at the end. */
  private nextOf(ids: string[], id: string, dragged: string): string | null {
    return ids.slice(ids.indexOf(id) + 1).find((x) => x !== dragged) ?? null;
  }

  /** Top of the first card of a block, or bottom of its last. */
  private blockEdge(list: HTMLElement, block: string, first: boolean): number {
    const nodes = [...list.querySelectorAll<HTMLElement>(`.card[data-block="${CSS.escape(block)}"]`)];
    const node = first ? nodes[0] : nodes.at(-1);
    const r = node?.getBoundingClientRect();
    return r ? (first ? r.top : r.bottom) : 0;
  }

  private lineAfter(ids: string[], top: number): number | null {
    const last = this.sections.get(ids.at(-1) ?? '')?.root.getBoundingClientRect();
    return last ? last.bottom + 1 - top : null;
  }

  // ---------- menus ----------

  private contextMenu(e: MouseEvent): void {
    const el = e.target as HTMLElement;
    if (el.closest('input')) return;
    const folder = el.closest<HTMLElement>('.team-folder-head')?.closest<HTMLElement>('.team-folder')?.dataset.folder;
    const card = el.closest<HTMLElement>('.card[data-post]');
    if (folder) {
      e.preventDefault();
      this.folderMenu(folder, el.closest('.team-folder-head') as HTMLElement);
    } else if (card?.dataset.post && this.prefs.folders.length > 0) {
      e.preventDefault();
      this.postMenu(card.dataset.post, card);
    }
  }

  private folderMenu(id: string, anchor: HTMLElement): void {
    const ids = this.prefs.folders.map((f) => f.id);
    const at = ids.indexOf(id);
    openMenu(
      anchor,
      (menu, close) => {
        const row = menuRow(close);
        menu.append(
          row(t('folder.rename'), ICONS.edit, () => this.edit(id)),
          row(t('folder.up'), ICONS.up, () => this.save(moveFolder(this.prefs, id, ids[at - 1] ?? null)), at === 0),
          row(t('folder.down'), ICONS.down, () => this.save(moveFolder(this.prefs, id, ids[at + 2] ?? null)), at === ids.length - 1),
          h('div', 'menu-sep'),
        );
        const del = row(t('folder.delete'), ICONS.remove, () => this.save(removeFolder(this.prefs, id)), false, t('folder.deleteHint'));
        del.classList.add('danger');
        menu.append(del);
      },
      true,
    );
    document.querySelector<HTMLElement>('#menu .menu-row')?.focus();
  }

  private postMenu(id: string, anchor: HTMLElement): void {
    const at = this.prefs.folders.find((f) => f.posts.includes(id))?.id ?? null;
    openMenu(
      anchor,
      (menu, close) => {
        const row = menuRow(close);
        const move = (to: string | null) => () => this.save(placePost(this.prefs, this.shownRoot, id, to, null));
        menu.append(h('div', 'menu-label', t('folder.moveTo')));
        for (const f of this.prefs.folders) menu.append(row(f.name, ICONS.folder, move(f.id), f.id === at));
        menu.append(h('div', 'menu-sep'), row(t('folder.root'), ICONS.up, move(null), at === null));
      },
      true,
    );
    document.querySelector<HTMLElement>('#menu .menu-row:not(:disabled)')?.focus();
  }
}

function menuRow(close: () => void) {
  return (label: string, path: string, run: () => void, disabled = false, hint = ''): HTMLButtonElement => {
    const btn = h('button', 'menu-row');
    btn.type = 'button';
    btn.disabled = disabled;
    const text = h('span', 'menu-text');
    text.append(h('span', 'menu-title', label));
    if (hint) text.append(h('span', 'menu-hint', hint));
    btn.append(icon(path), text);
    btn.addEventListener('click', () => {
      close();
      run();
    });
    return btn;
  };
}

/** Re-inserts the nodes only when their order or list changed, so hover, focus and a name being typed survive renders. */
export function syncList(list: HTMLElement, nodes: HTMLElement[]): void {
  const current = [...list.children];
  if (current.length !== nodes.length || current.some((n, i) => n !== nodes[i])) list.replaceChildren(...nodes);
}
