import {
  formatBytes,
  PURGE_CATEGORIES,
  inScratch,
  type PurgeCategory,
  type PurgeEntry,
  type PurgeLogEntry,
  type PurgeProject,
  type PurgeReport,
} from '../shared/purge';
import type { HubApi } from '../shared/types';
import { ago, errorNote, h, icon, ICONS } from './dom';
import { LANG, t, tn, type Key } from './i18n';

// The view of ephemeral files, project by project (docs/purge-ephemeres.md): the projects on the left; for the one
// chosen, a scan grouped by category and folder, the trash, the history of purges and the project's own rules.
// The view never holds a path it could send back: it ticks ids of the main process's own scan.

type Tab = 'scan' | 'history' | 'rules' | 'help';
/** Files shown at once in an unfolded folder. */
const FOLDER_ROWS = 200;

interface Folder {
  key: string;
  category: PurgeCategory;
  dir: string;
  entries: PurgeEntry[];
  bytes: number;
  sessions: string[];
}

const size = (bytes: number) => formatBytes(bytes, LANG === 'fr' ? 'fr' : 'en');
const dirOf = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const nameOf = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1);

export class PurgeView {
  private readonly root = document.getElementById('purge') as HTMLDivElement;
  private readonly card = h('div', 'setup-card caps-card purge-card');
  private projects: PurgeProject[] = [];
  private suggested: PurgeProject[] | null = null;
  private current = '';
  private tab: Tab = 'scan';
  private report: PurgeReport | null = null;
  private scanning = false;
  private failed = '';
  private selected = new Set<number>();
  private openFolders = new Set<string>();
  private moreFolders = new Set<string>();
  private confirming = false;
  private trashing = false;
  private history: PurgeLogEntry[] = [];
  private rules = '';
  private note: { text: string; tone: 'ok' | 'error' } | null = null;
  private returnFocus: HTMLElement | null = null;

  constructor(private readonly hub: HubApi) {
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-labelledby', 'purge-title');
    document.addEventListener('keydown', (e) => {
      if (this.root.hidden) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        if (this.confirming) {
          this.confirming = false;
          this.render();
        } else this.close();
      } else if (e.key === 'Tab') this.trapFocus(e);
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  async open(root?: string): Promise<void> {
    if (this.root.hidden) this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.root.hidden = false;
    this.render();
    this.projects = await this.hub.purgeProjects().catch(() => []);
    const pick = root ?? this.current;
    this.select(this.projects.some((p) => p.root === pick) ? pick : (this.projects[0]?.root ?? ''));
    // The folders of before, read from the agents' conversations: a few seconds the first time.
    void this.hub.purgeSuggest().then(
      (list) => {
        this.suggested = list;
        if (!this.current && list[0]) this.select(list[0].root);
        else this.render();
      },
      () => (this.suggested = []),
    );
  }

  close(): void {
    this.root.hidden = true;
    this.confirming = false;
    this.returnFocus?.focus();
    this.returnFocus = null;
  }

  private all(): PurgeProject[] {
    return [...this.projects, ...(this.suggested ?? [])];
  }

  private project(): PurgeProject | undefined {
    return this.all().find((p) => p.root === this.current);
  }

  private select(root: string): void {
    if (root !== this.current) {
      this.current = root;
      this.report = null;
      this.failed = '';
      this.note = null;
      this.selected.clear();
      this.openFolders.clear();
      this.moreFolders.clear();
      this.confirming = false;
      this.tab = 'scan';
    }
    this.render();
    if (root) void this.loadSide(root);
  }

  private async loadSide(root: string): Promise<void> {
    const [history, settings] = await Promise.all([this.hub.purgeHistory(root).catch(() => []), this.hub.purgeSettings(root).catch(() => ({ exclude: [] }))]);
    if (root !== this.current) return;
    this.history = history;
    this.rules = settings.exclude.join('\n');
    if (this.tab !== 'scan') this.render();
  }

  private async scan(): Promise<void> {
    const root = this.current;
    if (!root || this.scanning) return;
    this.scanning = true;
    this.failed = '';
    this.confirming = false;
    this.render();
    try {
      const report = await this.hub.purgeScan(root);
      if (root !== this.current) return;
      this.report = report;
      // Ticked in advance: the "safe" category only.
      this.selected = new Set(report.entries.filter((e) => e.category === 'safe').map((e) => e.id));
    } catch (err) {
      if (root === this.current) this.failed = err instanceof Error ? err.message : String(err);
    } finally {
      this.scanning = false;
      if (root === this.current) this.render();
    }
  }

  private async trash(): Promise<void> {
    const report = this.report;
    if (!report || this.trashing || this.selected.size === 0) return;
    this.trashing = true;
    this.render();
    try {
      const r = await this.hub.purgeTrash(report.scanId, [...this.selected]);
      if (r.stale) this.note = { text: t('purge.stale'), tone: 'error' };
      else {
        const moved = r.trashed + r.quarantined;
        const parts = [tn('purge.done', moved, { size: size(r.bytes) })];
        if (r.quarantined) parts.push(tn('purge.doneQuarantine', r.quarantined));
        if (r.skipped.length) parts.push(tn('purge.doneSkipped', r.skipped.length));
        this.note = { text: parts.join(' '), tone: r.skipped.length && !moved ? 'error' : 'ok' };
      }
    } catch {
      this.note = { text: t('purge.failed'), tone: 'error' };
    } finally {
      this.trashing = false;
      this.confirming = false;
      this.report = null;
      this.selected.clear();
    }
    void this.loadSide(this.current);
    await this.scan();
  }

  // ---------- drawing ----------

  private render(): void {
    const nav = h('nav', 'setup-nav purge-nav');
    nav.append(h('div', 'setup-nav-title', t('purge.title')));
    const item = (p: PurgeProject) => {
      const b = h('button', `setup-nav-item${p.root === this.current ? ' active' : ''}`);
      b.title = p.root;
      b.append(icon(ICONS.folder), h('span', '', p.source === 'appScratch' ? t('purge.appScratch') : p.name));
      b.addEventListener('click', () => this.select(p.root));
      return b;
    };
    for (const p of this.projects) nav.append(item(p));
    if (this.suggested === null) nav.append(h('div', 'setup-hint purge-nav-hint', t('purge.suggestLoading')));
    else if (this.suggested.length) {
      nav.append(h('div', 'setup-nav-title purge-nav-sub', t('purge.suggested')));
      for (const p of this.suggested) nav.append(item(p));
    }
    const add = h('button', 'setup-nav-item purge-add');
    add.append(icon(ICONS.plus), h('span', '', t('purge.add')));
    add.addEventListener('click', () => void this.add());
    nav.append(add);

    const body = h('div', 'setup-body');
    const content = h('div', 'setup-content caps-content purge-content');
    const p = this.project();
    if (!p) this.empty(content);
    else {
      this.head(content, p);
      this.tabs(content);
      if (this.tab === 'scan') this.scanTab(content);
      else if (this.tab === 'history') this.historyTab(content);
      else if (this.tab === 'rules') this.rulesTab(content);
      else this.helpTab(content);
    }
    body.append(content);
    if (this.note) body.append(this.note.tone === 'error' ? errorNote('setup-note', this.note.text) : h('div', 'setup-note ok', this.note.text));
    body.append(this.foot());

    const scroll = this.card.querySelector('.caps-list')?.scrollTop ?? 0;
    this.card.replaceChildren(nav, body);
    if (this.card.parentElement !== this.root) this.root.replaceChildren(this.card);
    const list = this.card.querySelector('.caps-list');
    if (list) list.scrollTop = scroll;
  }

  private empty(el: HTMLElement): void {
    const head = h('div', 'caps-head');
    const title = h('h2', 'caps-title', t('purge.title'));
    title.id = 'purge-title';
    head.append(title);
    const e = h('div', 'caps-empty');
    e.append(h('p', '', t('purge.noProject')));
    el.append(head, e, this.helpBlock());
  }

  private head(el: HTMLElement, p: PurgeProject): void {
    const head = h('div', 'caps-head');
    const title = h('h2', 'caps-title', p.source === 'appScratch' ? t('purge.appScratch') : p.name);
    title.id = 'purge-title';
    title.title = p.root;
    head.append(title, h('span', 'spacer'));
    const open = h('button', 'icon-btn');
    open.title = t('purge.openFolder');
    open.setAttribute('aria-label', t('purge.openFolder'));
    open.append(icon(ICONS.folder));
    open.addEventListener('click', () => void this.hub.purgeOpen(p.root));
    head.append(open);
    if (p.source === 'added') {
      const remove = h('button', 'btn ghost small', t('purge.removeProject'));
      remove.addEventListener('click', () => void this.removeProject(p.root));
      head.append(remove);
    }
    const scan = h('button', this.report ? 'btn small' : 'btn strong small', this.scanning ? t('purge.scanning') : this.report ? t('purge.rescan') : t('purge.scan'));
    scan.disabled = this.scanning || this.trashing;
    scan.addEventListener('click', () => void this.scan());
    head.append(scan);
    el.append(head, h('div', 'caps-src purge-path', p.root));
  }

  private tabs(el: HTMLElement): void {
    const bar = h('div', 'purge-bar');
    const chips = h('div', 'caps-chips');
    chips.setAttribute('role', 'tablist');
    for (const tab of ['scan', 'history', 'rules', 'help'] as const) {
      const c = h('button', `caps-chip${tab === this.tab ? ' active' : ''}`, t(`purge.tab.${tab}`));
      c.setAttribute('role', 'tab');
      c.setAttribute('aria-selected', String(tab === this.tab));
      if (tab === 'history' && this.history.length) c.append(h('span', 'caps-chip-n', String(this.history.length)));
      c.addEventListener('click', () => {
        this.tab = tab;
        this.confirming = false;
        this.render();
      });
      chips.append(c);
    }
    bar.append(chips);
    // What the scan saw, beside the tabs: a fact about the folder, not a fourth block above the list.
    const r = this.report;
    if (this.tab === 'scan' && r && !this.failed) {
      const facts = [tn('purge.seen', r.files, { size: size(r.bytes) }), t('purge.scannedAgo', { ago: ago(r.scannedAt) })];
      if (r.partial) facts.push(t(`purge.partial.${r.partial}`));
      const line = h('span', 'setup-hint purge-facts', facts.join(' · '));
      line.title = line.textContent ?? '';
      bar.append(line);
    }
    el.append(bar);
  }

  private scanTab(el: HTMLElement): void {
    const r = this.report;
    if (this.failed) {
      const e = h('div', 'caps-empty');
      e.append(h('p', '', t('purge.scanFailed')));
      el.append(e);
      return;
    }
    if (this.scanning && !r) {
      const list = h('div', 'caps-list caps-loading');
      list.setAttribute('aria-busy', 'true');
      list.append(h('div', 'setup-hint', t('purge.scanningLong')));
      for (let i = 0; i < 6; i++) {
        const row = h('div', 'caps-row caps-skel');
        row.append(h('span', 'caps-skel-bar'), h('span', 'caps-skel-bar short'));
        list.append(row);
      }
      el.append(list);
      return;
    }
    if (!r) {
      const e = h('div', 'caps-empty');
      e.append(h('p', '', t('purge.intro')));
      const go = h('button', 'btn strong', t('purge.scan'));
      go.addEventListener('click', () => void this.scan());
      e.append(go);
      el.append(e);
      return;
    }
    // The four totals: one strip, the category's colour reduced to its dot.
    const sum = h('div', 'purge-sum');
    for (const c of PURGE_CATEGORIES) {
      const stat = h('div', `purge-stat${r.totals[c].count ? '' : ' none'}`);
      const label = h('span', 'purge-stat-label');
      label.append(h('span', `caps-dot purge-dot ${c}`), h('span', '', t(`purge.cat.${c}`)));
      stat.append(label, h('span', 'purge-stat-n', tn('purge.files', r.totals[c].count)), h('span', 'purge-stat-size', size(r.totals[c].bytes)));
      stat.title = t(`purge.cat.${c}.hint`);
      sum.append(stat);
    }
    el.append(sum);
    if (!r.entries.length) {
      const e = h('div', 'caps-empty');
      e.append(h('p', '', t('purge.nothing')));
      el.append(e);
      return;
    }
    const list = h('div', 'caps-list purge-list');
    for (const c of PURGE_CATEGORIES) {
      const entries = r.entries.filter((e) => e.category === c);
      if (!entries.length) continue;
      list.append(this.categoryRow(c, entries));
      for (const f of this.folders(c, entries)) {
        list.append(this.folderRow(f));
        if (this.openFolders.has(f.key)) {
          const shown = this.moreFolders.has(f.key) ? f.entries : f.entries.slice(0, FOLDER_ROWS);
          for (const e of shown) list.append(this.fileRow(e));
          if (shown.length < f.entries.length) {
            const more = h('button', 'btn ghost small purge-more', tn('purge.more', f.entries.length - shown.length));
            more.addEventListener('click', () => {
              this.moreFolders.add(f.key);
              this.render();
            });
            list.append(more);
          }
        }
      }
    }
    el.append(list);
  }

  private folders(category: PurgeCategory, entries: PurgeEntry[]): Folder[] {
    const map = new Map<string, Folder>();
    for (const e of entries) {
      const dir = dirOf(e.rel);
      const key = `${category}:${dir}`;
      let f = map.get(key);
      if (!f) map.set(key, (f = { key, category, dir, entries: [], bytes: 0, sessions: [] }));
      f.entries.push(e);
      f.bytes += e.size;
      for (const s of e.sessions) if (f.sessions.length < 3 && !f.sessions.includes(s)) f.sessions.push(s);
    }
    return [...map.values()].sort((a, b) => b.bytes - a.bytes);
  }

  /** A checkbox for a set of entries: ticked, unticked or mixed. */
  private box(entries: PurgeEntry[], label: string): HTMLInputElement {
    const box = h('input', 'purge-box');
    box.type = 'checkbox';
    box.setAttribute('aria-label', label);
    const n = entries.filter((e) => this.selected.has(e.id)).length;
    box.checked = n > 0 && n === entries.length;
    box.indeterminate = n > 0 && n < entries.length;
    box.disabled = this.trashing;
    box.addEventListener('click', (ev) => ev.stopPropagation());
    box.addEventListener('change', () => {
      for (const e of entries) {
        if (box.checked) this.selected.add(e.id);
        else this.selected.delete(e.id);
      }
      this.confirming = false;
      this.render();
    });
    return box;
  }

  private categoryRow(c: PurgeCategory, entries: PurgeEntry[]): HTMLElement {
    const row = h('div', `caps-group purge-group ${c}`);
    if (c !== 'protected') row.append(this.box(entries, t(`purge.cat.${c}`)));
    else row.append(h('span', 'purge-box-gap'));
    const bytes = entries.reduce((n, e) => n + e.size, 0);
    const label = h('span', 'purge-group-label');
    label.append(h('span', `caps-dot purge-dot ${c}`), h('span', '', t(`purge.cat.${c}`)), h('span', 'purge-group-hint', t(`purge.cat.${c}.hint`)));
    row.append(label, h('span', 'purge-num', tn('purge.files', entries.length)), h('span', 'purge-num', size(bytes)));
    return row;
  }

  private folderRow(f: Folder): HTMLElement {
    const open = this.openFolders.has(f.key);
    const row = h('div', `caps-row purge-row folder${open ? ' open' : ''}`);
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-expanded', String(open));
    const chevron = icon(ICONS.chevron, 'caps-chevron');
    if (f.category !== 'protected') row.append(this.box(f.entries, f.dir || t('purge.rootFolder')));
    else row.append(h('span', 'purge-box-gap'));
    const name = h('span', 'caps-name');
    const dir = h('span', 'caps-name-text', f.dir ? `${f.dir}/` : t('purge.rootFolder'));
    dir.title = dir.textContent ?? '';
    name.append(chevron, dir);
    if (inScratch(`${f.dir}/x`)) name.append(h('span', 'purge-tag scratch', t('purge.sig.scratch')));
    const from = h('span', 'caps-desc', f.sessions.length ? t('purge.from', { sessions: f.sessions.join(', ') }) : '');
    from.title = from.textContent ?? '';
    row.append(
      name,
      from,
      h('span', 'purge-num', tn('purge.files', f.entries.length)),
      h('span', 'purge-num', size(f.bytes)),
    );
    const toggle = () => {
      if (open) this.openFolders.delete(f.key);
      else this.openFolders.add(f.key);
      this.render();
    };
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
    return row;
  }

  private fileRow(e: PurgeEntry): HTMLElement {
    const row = h('div', `caps-row purge-row file${e.category === 'protected' ? ' off' : ''}`);
    if (e.category !== 'protected') row.append(this.box([e], e.rel));
    else row.append(h('span', 'purge-box-gap'));
    const name = h('span', 'caps-name caps-name-text', nameOf(e.rel));
    name.title = e.rel;
    const why = e.block ? t(`purge.block.${e.block}`) : e.signals.map((s) => t(`purge.sig.${s}`)).join(' · ');
    const reveal = h('button', 'icon-btn caps-more');
    reveal.title = t('purge.reveal');
    reveal.setAttribute('aria-label', t('purge.reveal'));
    reveal.append(icon(ICONS.external));
    reveal.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (this.report) void this.hub.purgeReveal(this.report.scanId, e.id);
    });
    const desc = h('span', `caps-desc${e.block ? ' purge-block' : ''}`, why);
    desc.title = why;
    row.append(name, desc, h('span', 'purge-num', ago(e.mtime)), h('span', 'purge-num', size(e.size)), reveal);
    return row;
  }

  private historyTab(el: HTMLElement): void {
    if (!this.history.length) {
      const e = h('div', 'caps-empty');
      e.append(h('p', '', t('purge.history.none')));
      el.append(e);
      return;
    }
    const list = h('div', 'caps-list');
    for (const entry of this.history) {
      const count = entry.items.reduce((n, i) => n + (i.files ?? 1), 0);
      const quarantined = entry.items.filter((i) => i.how === 'quarantine' && !i.restored);
      const row = h('div', 'caps-row purge-row history');
      const where = quarantined.length ? t('purge.history.quarantine') : entry.items.every((i) => i.restored) ? t('purge.history.restored') : t('purge.history.trash');
      row.append(
        h('span', 'caps-name', new Date(entry.at).toLocaleString(LANG)),
        h('span', 'caps-desc', `${tn('purge.files', count)} · ${size(entry.bytes)} · ${where}`),
      );
      if (quarantined.length) {
        const restore = h('button', 'btn small', t('purge.restore'));
        restore.addEventListener('click', () => void this.restore(entry.id));
        row.append(restore);
      } else row.append(h('span', ''));
      list.append(row);
    }
    el.append(list, h('div', 'setup-hint', t('purge.history.hint')));
  }

  private rulesTab(el: HTMLElement): void {
    el.append(h('div', 'setup-hint', t('purge.rules.hint')));
    const area = h('textarea', 'setup-input purge-rules');
    area.value = this.rules;
    area.rows = 8;
    area.spellcheck = false;
    area.placeholder = 'renders/final/**\n*.blend\nlivraison/';
    area.setAttribute('aria-label', t('purge.tab.rules'));
    area.addEventListener('input', () => (this.rules = area.value));
    const save = h('button', 'btn small', t('purge.rules.save'));
    save.addEventListener('click', async () => {
      const v = await this.hub.purgeSaveSettings(this.current, this.rules.split('\n'));
      this.rules = v.exclude.join('\n');
      this.note = { text: t('purge.rules.saved'), tone: 'ok' };
      this.report = null;
      this.render();
    });
    const row = h('div', 'purge-rules-row');
    row.append(save);
    el.append(area, row);
  }

  private helpTab(el: HTMLElement): void {
    el.append(this.helpBlock());
  }

  private helpBlock(): HTMLElement {
    const box = h('div', 'purge-help');
    for (const k of ['purge.help.scratch', 'purge.help.scan', 'purge.help.safe', 'purge.help.trash'] as const) box.append(h('p', '', t(k)));
    return box;
  }

  private foot(): HTMLElement {
    const foot = h('div', 'setup-foot');
    const r = this.report;
    if (this.tab === 'scan' && r && r.entries.length) {
      const chosen = r.entries.filter((e) => this.selected.has(e.id));
      const bytes = chosen.reduce((n, e) => n + e.size, 0);
      if (this.confirming) {
        foot.append(h('span', 'setup-hint warn', tn('purge.confirm', chosen.length, { size: size(bytes) })), h('span', 'spacer'));
        const cancel = h('button', 'btn ghost', t('purge.cancel'));
        cancel.addEventListener('click', () => {
          this.confirming = false;
          this.render();
        });
        const go = h('button', 'btn danger', this.trashing ? t('purge.trashing') : t('purge.trashGo'));
        go.disabled = this.trashing;
        go.addEventListener('click', () => void this.trash());
        foot.append(cancel, go);
        queueMicrotask(() => go.focus());
        return foot;
      }
      foot.append(h('span', 'setup-hint purge-sel', chosen.length ? tn('purge.selected', chosen.length, { size: size(bytes) }) : t('purge.noneSelected')), h('span', 'spacer'));
      const scratch = r.entries.filter((e) => e.category !== 'protected' && (e.signals.includes('scratch') || inScratch(e.rel)));
      if (scratch.length) {
        const all = h('button', 'btn ghost', t('purge.emptyScratch'));
        all.title = t('purge.emptyScratch.hint');
        all.addEventListener('click', () => {
          for (const e of scratch) this.selected.add(e.id);
          this.render();
        });
        foot.append(all);
      }
      const trash = h('button', 'btn primary', t('purge.trash'));
      trash.disabled = chosen.length === 0 || this.trashing || this.scanning;
      trash.addEventListener('click', () => {
        this.confirming = true;
        this.render();
      });
      foot.append(trash);
    } else foot.append(h('span', 'setup-hint', t('purge.never')), h('span', 'spacer'));
    const done = h('button', 'btn', t('purge.close'));
    done.addEventListener('click', () => this.close());
    foot.append(done);
    return foot;
  }

  // ---------- actions ----------

  private async add(): Promise<void> {
    const r = await this.hub.purgeAdd().catch(() => null);
    if (!r) return;
    if ('problem' in r) {
      this.note = { text: t(`purge.problem.${r.problem}` as Key), tone: 'error' };
      this.render();
      return;
    }
    this.projects = await this.hub.purgeProjects().catch(() => this.projects);
    if (r.project) this.select(r.project.root);
    else this.render();
  }

  private async removeProject(root: string): Promise<void> {
    this.projects = await this.hub.purgeRemove(root).catch(() => this.projects);
    this.select(this.projects[0]?.root ?? '');
  }

  private async restore(id: string): Promise<void> {
    const r = await this.hub.purgeRestore(id).catch(() => null);
    this.note = r ? { text: [tn('purge.restored', r.restored), r.kept.length ? tn('purge.restoreKept', r.kept.length) : ''].filter(Boolean).join(' '), tone: r.kept.length && !r.restored ? 'error' : 'ok' } : { text: t('purge.failed'), tone: 'error' };
    this.report = null;
    await this.loadSide(this.current);
    this.render();
  }

  private trapFocus(e: KeyboardEvent): void {
    const items = [...this.root.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex="0"]')].filter((el) => !(el as HTMLButtonElement).disabled && el.offsetParent !== null);
    if (!items.length) return;
    const [first, last] = [items[0], items[items.length - 1]];
    const inside = this.root.contains(document.activeElement);
    if (e.shiftKey && (document.activeElement === first || !inside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
      e.preventDefault();
      first.focus();
    }
  }
}
