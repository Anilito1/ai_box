import type { Graph } from '../../shared/graph/format';
import type { GraphInfo, GraphListing, GraphSeed } from '../../shared/graph/protocol';
import type { HubApi } from '../../shared/types';
import { t } from '../i18n';
import { GraphChat } from './chat';
import { CONVERTER_LIST, converterName } from './describe';
import { button, el } from './dom';
import { Editor } from './editor';
import { openJson, pickModel, toaster } from './picker';
import { GraphStore } from './store';

// The Graphs view, opened from the header: it takes the place of the conversations. On the left the user's graphs
// (new, from an example, rename, duplicate, delete), in the middle the editor of the one open, on the right a chat
// to try it, on simulated or real models. Each graph is a file of the main process; a change is saved a moment later.

const LAST = 'graphs:last';
const SAVE_DELAY = 400;

export interface GraphsHost {
  /** Settings › Accounts, where a provider and its key are added. */
  openProviders(): void;
  /** The view opened or closed: the header's button follows. */
  toggled(open: boolean): void;
}

export class GraphsView {
  readonly root = el('section', 'gr-view');
  private readonly store = new GraphStore();
  private readonly items = el('div', 'gr-list-items');
  private readonly title = el('span', 'gr-graph-name');
  private readonly addMenu = el('div', 'gr-add-menu');
  private readonly editor: Editor;
  private readonly chat: GraphChat;
  private readonly toast: (message: string) => void;
  private listing: GraphListing = { graphs: [], examples: [] };
  private renaming = '';
  private confirming = '';
  private saveTimer = 0;
  private saving: Promise<unknown> = Promise.resolve();
  isOpen = false;

  constructor(
    private readonly hub: HubApi,
    private readonly workspace: HTMLElement,
    private readonly host: GraphsHost,
  ) {
    this.root.hidden = true;
    this.root.setAttribute('aria-label', t('graphs.title'));
    const toastBox = el('div', 'gr-toast');
    const toast = toaster(toastBox);
    this.toast = toast;
    const canvas = el('div', 'gr-canvas');
    const chatBox = el('div', 'gr-chat');
    this.editor = new Editor(canvas, hub, this.store, { toast, pickModel: (anchor, current, onPick) => pickModel(this.store, anchor, current, onPick) });
    canvas.append(toastBox);
    this.chat = new GraphChat(chatBox, hub, this.store, { toast, openProviders: () => host.openProviders() });

    this.addMenu.hidden = true;
    const add = button('btn primary small gr-new', t('graphs.new'), () => this.toggleAddMenu(), t('graphs.newHint'));
    add.setAttribute('aria-haspopup', 'menu');
    const list = el('aside', 'gr-list', el('div', 'gr-list-head', el('span', 'gr-list-title', t('graphs.title')), add), this.addMenu, this.items);
    const addModel = button('btn ghost small', t('graphs.addModel'), () => pickModel(this.store, addModel, '', (spec) => this.editor.addModel(spec)), t('graphs.addModelHint'));
    const toolbar = el(
      'div',
      'gr-toolbar',
      this.title,
      el('span', 'gr-gap'),
      addModel,
      ...CONVERTER_LIST.map((id) => button('btn ghost small', t('graphs.addConvert', { name: converterName(id) }), () => this.editor.addConverter(id), t('graphs.addConvertHint'))),
      button('btn ghost small', t('graphs.json'), () => openJson(this.store.graph, (graph) => this.replace(graph)), t('graphs.jsonHint')),
    );
    const center = el('div', 'gr-center', toolbar, canvas);
    this.root.append(list, center, chatBox);
    workspace.append(this.root);

    this.store.onChange.push(() => this.scheduleSave());
    document.addEventListener('pointerdown', (e) => {
      if (!this.addMenu.hidden && !this.addMenu.contains(e.target as Node) && !add.contains(e.target as Node)) this.addMenu.hidden = true;
    });
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else void this.open();
  }

  async open(): Promise<void> {
    this.isOpen = true;
    this.root.hidden = false;
    this.workspace.classList.add('graphs-open');
    this.host.toggled(true);
    // The providers' models may have changed since the last time: read again each time the view opens.
    const [catalog, listing] = await Promise.all([this.hub.graphsCatalog(), this.hub.graphsList()]);
    this.store.setCatalog(catalog);
    this.listing = listing;
    const wanted = this.store.id || localStorage.getItem(LAST) || '';
    const first = listing.graphs.find((g) => g.id === wanted) ?? listing.graphs[0];
    // A first visit starts on the first example: something runs at once.
    if (!first) await this.create({ example: listing.examples[0]?.id ?? '' });
    else await this.load(first.id, true);
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.flush();
    this.root.hidden = true;
    this.workspace.classList.remove('graphs-open');
    this.host.toggled(false);
  }

  // ── The list ───────────────────────────────────────────────────────────────────────────────────────────────────

  private renderList(): void {
    this.title.textContent = this.store.graph.name || t('graphs.untitled');
    if (this.listing.graphs.length === 0) {
      this.items.replaceChildren(el('p', 'gr-muted', t('graphs.none')));
      return;
    }
    this.items.replaceChildren(...this.listing.graphs.map((g) => this.item(g)));
  }

  private item(g: GraphInfo): HTMLElement {
    const current = g.id === this.store.id;
    const row = el('div', `gr-item${current ? ' current' : ''}`);
    row.dataset.id = g.id;
    if (this.renaming === g.id) {
      const input = el('input', 'gr-rename');
      input.value = g.name;
      input.maxLength = 80;
      input.setAttribute('aria-label', t('graphs.rename'));
      const done = (keep: boolean) => {
        if (this.renaming !== g.id) return;
        this.renaming = '';
        const name = input.value.trim();
        if (keep && name && name !== g.name) void this.rename(g.id, name);
        else this.renderList();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') done(true);
        if (e.key === 'Escape') done(false);
      });
      input.addEventListener('blur', () => done(true));
      row.append(input);
      queueMicrotask(() => {
        input.focus();
        input.select();
      });
      return row;
    }
    const open = button('gr-item-open', g.name || t('graphs.untitled'), () => void this.load(g.id));
    if (current) open.setAttribute('aria-current', 'true');
    const confirm = this.confirming === g.id;
    row.append(
      open,
      el(
        'span',
        'gr-item-actions',
        button('gr-item-act', '✎', () => this.startRename(g.id), t('graphs.rename')),
        button('gr-item-act', '⧉', () => void this.create({ copy: g.id }), t('graphs.duplicate')),
        button(`gr-item-act${confirm ? ' danger' : ''}`, confirm ? t('graphs.deleteSure') : '🗑', () => void this.remove(g.id), t('graphs.delete')),
      ),
    );
    return row;
  }

  private startRename(id: string): void {
    this.renaming = id;
    this.confirming = '';
    this.renderList();
  }

  private toggleAddMenu(): void {
    this.addMenu.hidden = !this.addMenu.hidden;
    if (this.addMenu.hidden) return;
    this.addMenu.replaceChildren(
      button('gr-add-item', t('graphs.blank'), () => void this.create({ blank: true })),
      el('div', 'gr-add-label', t('graphs.examples')),
      ...this.listing.examples.map((e) => button('gr-add-item', e.name, () => void this.create({ example: e.id }))),
    );
    this.addMenu.querySelector('button')?.focus();
  }

  // ── Graphs ─────────────────────────────────────────────────────────────────────────────────────────────────────

  private async refreshList(): Promise<void> {
    this.listing = await this.hub.graphsList();
    this.renderList();
  }

  /** A run is under way: its graph stays open until it ends or is stopped. */
  private held(): boolean {
    if (this.chat.busy) this.toast(t('graphs.busy'));
    return this.chat.busy;
  }

  private async load(id: string, quiet = false): Promise<void> {
    // The graph open already: it is shown as it is in the editor, the changes not saved yet included.
    if (id === this.store.id) return this.renderList();
    if (this.held()) return;
    this.flush();
    const graph = await this.hub.graphsGet(id);
    if (!graph) {
      if (!quiet) await this.refreshList();
      return;
    }
    localStorage.setItem(LAST, id);
    this.confirming = '';
    this.store.load(id, graph);
    this.renderList();
  }

  private async create(seed: GraphSeed): Promise<void> {
    this.addMenu.hidden = true;
    if (this.held()) return;
    this.flush();
    await this.saving;
    const r = await this.hub.graphsCreate(seed);
    if (!r.ok || !r.id) return;
    this.listing = await this.hub.graphsList();
    await this.load(r.id);
    // A copy is named at once: it is told apart from its original by the name.
    if ('copy' in seed) this.startRename(r.id);
  }

  private async rename(id: string, name: string): Promise<void> {
    if (id === this.store.id) {
      this.store.graph.name = name;
      this.store.changed(false);
      this.flush();
      await this.saving;
    } else {
      const graph = await this.hub.graphsGet(id);
      if (graph) await this.hub.graphsSave(id, { ...graph, name });
    }
    await this.refreshList();
  }

  private async remove(id: string): Promise<void> {
    if (this.confirming !== id) {
      this.confirming = id;
      return this.renderList();
    }
    this.confirming = '';
    if (id === this.store.id && this.held()) return this.renderList();
    await this.hub.graphsDelete(id);
    if (id === this.store.id) {
      window.clearTimeout(this.saveTimer);
      this.store.id = '';
    }
    this.listing = await this.hub.graphsList();
    const next = this.listing.graphs[0];
    // The last one gone: an empty one takes its place, so that the editor always has a graph to write to.
    if (!next) await this.create({ blank: true });
    else if (!this.store.id) await this.load(next.id);
    this.renderList();
  }

  /** A graph pasted as JSON takes the place of the open one, under its name unless it has one. */
  private replace(graph: Graph): void {
    if (this.held()) return;
    this.store.load(this.store.id, { ...graph, name: graph.name || this.store.graph.name });
    this.store.changed(false);
  }

  private scheduleSave(): void {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.flush(), SAVE_DELAY);
  }

  /** Writes the open graph now, if a change waits. */
  private flush(): void {
    if (!this.saveTimer) return;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    const { id, graph } = this.store;
    if (!id) return;
    const name = this.listing.graphs.find((g) => g.id === id)?.name;
    this.saving = this.hub.graphsSave(id, structuredClone(graph)).then(() => (name !== graph.name ? this.refreshList() : undefined));
  }
}
