import {
  GITHUB_URL,
  listedMcp,
  MCP_NAME,
  mcpStatus,
  SKILL_NAME,
  type Capabilities,
  type CapResult,
  type ConnectResult,
  type McpDraft,
  type McpEntry,
  type McpStatus,
  type PluginEntry,
  type SkillEntry,
} from '../shared/capabilities';
import { parseAgentFile } from '../shared/team';
import type { HubApi } from '../shared/types';
import { ago, errorNote, folderName, h, icon, ICONS, openMenu, techDetails } from './dom';
import { t, tn, type Key } from './i18n';

type Kind = 'mcp' | 'skills';
type McpFilter = 'all' | McpStatus;
type SkillFilter = 'all' | 'user' | 'plugin' | 'project' | 'disabled';
type SkillTab = 'github' | 'paste';

/** Older than this, opening the MCP panel asks for the servers' state again. */
const STALE_MS = 5 * 60_000;
const ROWS_MAX = 400;
const NOTE_MS = 5000;
const MCP_ORDER: McpStatus[] = ['on', 'todo', 'error'];

const pluginName = (id: string) => id.split('@')[0];
const removable = (m: McpEntry) => m.source === 'user' || m.source === 'project' || m.source === 'local';
const mcpKey = (m: McpEntry) => `m:${m.source}:${m.project}:${m.name}`;
/** Without the on/off source: a switch flip keeps the row's detail open. */
const skillKey = (s: SkillEntry) => `s:${s.project}:${s.plugin}:${s.dir}`;

/** The name a row shows: a plugin's server without its "plugin:x:" prefix, a connector without "claude.ai ". */
function shownName(m: McpEntry): string {
  if (m.source === 'plugin') return m.name.split(':').pop() || m.name;
  if (m.source === 'claude.ai') return m.name.replace(/^claude\.ai /, '');
  return m.name;
}

/** A plugin's skill without its "plugin:" prefix: the plugin is the group it sits in. */
const skillName = (s: SkillEntry) => (s.source === 'plugin' ? s.name.slice(s.name.indexOf(':') + 1) : s.name);

function mcpSource(m: McpEntry): string {
  if (m.source === 'plugin') return t('caps.source.plugin', { plugin: pluginName(m.plugin) });
  if (m.source === 'project' || m.source === 'local') return t('caps.source.project', { repo: folderName(m.project) });
  return t(m.source === 'user' ? 'caps.source.user' : m.source === 'claude.ai' ? 'caps.source.claudeai' : 'caps.source.other');
}

function skillSource(s: SkillEntry): string {
  if (s.source === 'plugin') return t('caps.source.plugin', { plugin: pluginName(s.plugin) });
  if (s.source === 'project') return t('caps.source.project', { repo: folderName(s.project) });
  return t(s.source === 'disabled' ? 'caps.source.userOff' : 'caps.source.user');
}

function reachText(reach: string, project: string, off: Key = 'caps.reach.off'): string {
  if (reach === 'repo') return t('caps.reach.repo', { repo: folderName(project) });
  if (reach === 'nowhere') return t(off);
  return t(reach === 'master-only' ? 'caps.reach.master' : 'caps.reach.everywhere');
}

/** The program and its arguments of a command line; quotes keep a path with spaces in one piece. */
function splitCommand(line: string): string[] {
  return (line.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map((w) => w.replace(/"([^"]*)"|'([^']*)'/g, '$1$2')).filter(Boolean);
}

const lines = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/** "KEY=value" or "Name: value" lines; null when one has no separator. */
function pairs(text: string, sep: '=' | ':'): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const line of lines(text)) {
    const i = line.indexOf(sep);
    if (i <= 0) return null;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

interface McpForm {
  name: string;
  transport: McpDraft['transport'];
  command: string;
  url: string;
  scope: McpDraft['scope'];
  project: string;
  extra: string;
  tried: boolean;
}

interface SkillForm {
  tab: SkillTab;
  url: string;
  skill: string;
  name: string;
  text: string;
  tried: boolean;
}

const emptyMcpForm = (): McpForm => ({ name: '', transport: 'stdio', command: '', url: '', scope: 'user', project: '', extra: '', tried: false });
const emptySkillForm = (): SkillForm => ({ tab: 'github', url: '', skill: '', name: '', text: '', tried: false });

/**
 * The MCP and Skills panels, in the settings sheet: one row per server or skill, its detail unfolded under it on a
 * click, an add form in place of the list.
 */
export class CapsView {
  private readonly root = document.getElementById('caps') as HTMLDivElement;
  private readonly card = h('div', 'setup-card caps-card');
  private kind: Kind = 'mcp';
  private adding = false;
  private caps: Capabilities | null = null;
  private loadFailed = false;
  private checking = false;
  private busy = false;
  private query = '';
  private mcpFilter: McpFilter = 'all';
  private skillFilter: SkillFilter = 'all';
  /** Row whose detail is unfolded. */
  private openKey = '';
  /** Row whose removal waits for the confirmation shown in its detail. */
  private confirmKey = '';
  /** Plugins whose skills are unfolded. */
  private expanded = new Set<string>();
  /** Whether each personal skill was off when the list was first drawn: flipping a switch does not move its row. */
  private sortedOff = new Map<string, boolean>();
  /** Servers being signed in to (waiting for the browser) or restarted. */
  private signing = new Map<string, 'auth' | 'restart'>();
  /** claude.ai connectors whose page was opened: their button checks them again. */
  private browserOpened = new Set<string>();
  private note: { text: string; tone: 'ok' | 'error'; detail?: string } | null = null;
  private noteTimer = 0;
  private mcpForm = emptyMcpForm();
  private skillForm = emptySkillForm();
  private returnFocus: HTMLElement | null = null;
  private clearTimer = 0;

  constructor(private readonly hub: HubApi) {
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-labelledby', 'caps-title');
    document.addEventListener('keydown', (e) => {
      if (this.root.hidden) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        this.escape();
      } else if (e.key === 'Tab') this.trapFocus(e);
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  async open(kind: Kind): Promise<void> {
    if (this.root.hidden) this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.switchTo(kind);
    window.clearTimeout(this.clearTimer);
    this.root.hidden = false;
    await this.load();
  }

  close(): void {
    this.root.hidden = true;
    this.clearTimer = window.setTimeout(() => this.root.hidden && this.root.replaceChildren(), 240);
    this.returnFocus?.focus();
    this.returnFocus = null;
  }

  /** Escape steps back: out of the form, then out of a confirmation or a detail, then out of the panel. */
  private escape(): void {
    if (this.adding) return this.back();
    if (this.confirmKey) {
      this.confirmKey = '';
      return this.render();
    }
    if (this.openKey) {
      const key = this.openKey;
      this.openKey = '';
      this.render();
      return this.focusRow(key);
    }
    this.close();
  }

  private switchTo(kind: Kind): void {
    this.kind = kind;
    this.adding = false;
    this.query = '';
    this.openKey = this.confirmKey = '';
    this.sortedOff.clear();
    this.setNote(null);
  }

  private async load(): Promise<void> {
    this.loadFailed = false;
    this.render();
    try {
      this.caps = await this.hub.capabilities();
    } catch {
      this.loadFailed = true;
    }
    if (this.root.hidden) return;
    this.render();
    if (this.caps && this.kind === 'mcp' && Date.now() - this.caps.checkedAt > STALE_MS) void this.check();
  }

  private trapFocus(e: KeyboardEvent): void {
    const items = [...this.root.querySelectorAll<HTMLElement>('button, input, select, textarea, summary, [tabindex="0"]')].filter(
      (el) => !(el as HTMLButtonElement).disabled && el.offsetParent !== null,
    );
    if (items.length === 0) return;
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

  private async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    this.render();
    try {
      this.caps = await this.hub.checkCapabilities();
      // A connector signed in on claude.ai: should it ask again later, its button signs in anew.
      for (const m of this.caps.mcp) if (m.state === 'connected') this.browserOpened.delete(m.name);
    } finally {
      this.checking = false;
      if (!this.root.hidden) this.render();
    }
  }

  private setNote(note: CapsView['note']): void {
    window.clearTimeout(this.noteTimer);
    this.note = note;
    if (note?.tone === 'ok')
      this.noteTimer = window.setTimeout(() => {
        this.note = null;
        if (!this.root.hidden) this.render();
      }, NOTE_MS);
  }

  /** Runs a change; the list comes back with its result. A toggle says nothing when it works: the switch shows it. */
  private async act(task: () => Promise<CapResult>, done: string): Promise<boolean> {
    // A control disabled while busy loses focus: give it back once the change is done.
    const keep = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.focus : undefined;
    this.busy = true;
    this.render();
    let r: CapResult;
    try {
      r = await task();
    } catch (e) {
      if (!this.caps) throw e;
      r = { ...this.caps, ok: false, error: 'unexpected', detail: String(e) };
    } finally {
      this.busy = false;
    }
    this.caps = r;
    this.confirmKey = '';
    this.setNote(r.ok ? (done ? { text: done, tone: 'ok' } : null) : { text: this.errorText(r.error), tone: 'error', detail: r.detail });
    this.render();
    if (keep) this.focusRow(keep);
    return r.ok;
  }

  private errorText(code: string): string {
    const known: Record<string, Key> = {
      name: 'caps.err.name',
      project: 'caps.err.project',
      env: 'caps.err.env',
      command: 'caps.err.command',
      url: 'caps.err.url',
      headers: 'caps.err.headers',
      'no-claude': 'caps.err.noClaude',
      'no-node': 'caps.err.noNode',
      cli: 'caps.err.cli',
      exists: 'caps.err.exists',
      missing: 'caps.err.missing',
      fs: 'caps.err.fs',
      settings: 'caps.err.settings',
      install: 'caps.err.install',
      'skill-name': 'caps.err.skillName',
      format: 'caps.err.format',
      'skill-format': 'caps.err.pasteHeader',
      'sign-in': 'caps.err.signIn',
      'sign-in-timeout': 'caps.err.signInTimeout',
      still: 'caps.err.still',
      failed: 'caps.checkFailed',
    };
    return t(known[code] ?? 'caps.err.unexpected');
  }

  // ---------- frame ----------

  private render(): void {
    const nav = h('nav', 'setup-nav');
    nav.append(h('div', 'setup-nav-title', t('caps.title')));
    for (const [kind, label, path] of [
      ['mcp', t('caps.mcp'), ICONS.plug],
      ['skills', t('caps.skills'), ICONS.sparkle],
    ] as const) {
      const b = h('button', `setup-nav-item${kind === this.kind ? ' active' : ''}`);
      b.append(icon(path), h('span', '', label));
      b.addEventListener('click', () => {
        if (kind === this.kind && !this.adding) return;
        this.switchTo(kind);
        this.render();
        if (kind === 'mcp' && this.caps && Date.now() - this.caps.checkedAt > STALE_MS) void this.check();
      });
      nav.append(b);
    }

    const body = h('div', 'setup-body');
    const content = h('div', 'setup-content caps-content');
    const c = this.caps;
    if (this.loadFailed) this.failed(content);
    else if (!c) this.skeleton(content);
    else if (this.adding) {
      if (this.kind === 'mcp') this.mcpAdd(content, c);
      else this.skillAdd(content);
    } else if (this.kind === 'mcp') this.mcpList(content, c);
    else this.skillList(content, c);
    body.append(content);
    if (this.note) body.append(this.note.tone === 'error' ? errorNote('setup-note', this.note.text, this.note.detail) : h('div', 'setup-note ok', this.note.text));

    const foot = h('div', 'setup-foot');
    foot.append(h('span', 'setup-hint', t('caps.appliesNext')), h('span', 'spacer'));
    const done = h('button', 'btn', t('setup.close'));
    done.addEventListener('click', () => this.close());
    foot.append(done);
    body.append(foot);

    // The list keeps its scroll and the focused control its focus (and caret) across a redraw.
    const scroll = this.card.querySelector('.caps-list')?.scrollTop ?? 0;
    const active = document.activeElement instanceof HTMLElement && this.root.contains(document.activeElement) ? document.activeElement : null;
    const focused = active?.dataset.focus;
    const caret = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active.selectionStart : null;
    this.card.replaceChildren(nav, body);
    if (this.card.parentElement !== this.root) this.root.replaceChildren(this.card);
    const list = this.card.querySelector('.caps-list');
    if (list) list.scrollTop = scroll;
    const again = (focused ? this.card.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focused)}"]`) : null) ?? this.card.querySelector<HTMLElement>('[data-autofocus]');
    again?.focus();
    if (caret !== null && (again instanceof HTMLInputElement || again instanceof HTMLTextAreaElement)) again.setSelectionRange(caret, caret);
  }

  private focusRow(key: string): void {
    this.card.querySelector<HTMLElement>(`[data-focus="${CSS.escape(key)}"]`)?.focus();
  }

  /** Title, count, search, then the panel's own buttons. */
  private header(el: HTMLElement, title: string, count: number | null, refill: () => void, tools: HTMLElement[]): void {
    const head = h('div', 'caps-head');
    const heading = h('h2', 'caps-title', title);
    heading.id = 'caps-title';
    head.append(heading);
    if (count !== null) head.append(h('span', 'caps-total', String(count)));
    head.append(h('span', 'spacer'));
    const search = h('input', 'setup-input caps-search');
    search.type = 'search';
    search.placeholder = t('caps.search');
    search.setAttribute('aria-label', t('caps.search'));
    search.value = this.query;
    search.spellcheck = false;
    search.dataset.focus = 'search';
    search.dataset.autofocus = '';
    search.addEventListener('input', () => {
      this.query = search.value;
      refill();
    });
    head.append(search, ...tools);
    el.append(head);
  }

  private addButton(): HTMLButtonElement {
    const add = h('button', 'btn caps-add');
    add.append(icon(ICONS.plus), h('span', '', t('caps.add')));
    add.dataset.focus = 'add';
    add.addEventListener('click', () => this.startAdd());
    return add;
  }

  private startAdd(): void {
    this.adding = true;
    this.openKey = this.confirmKey = '';
    this.setNote(null);
    this.render();
  }

  private back(): void {
    this.adding = false;
    this.setNote(null);
    this.render();
  }

  private chips<T extends string>(options: [T, string, number | null][], value: T, pick: (v: T) => void): HTMLElement {
    const bar = h('div', 'caps-chips');
    bar.setAttribute('role', 'radiogroup');
    for (const [id, label, count] of options) {
      const b = h('button', `caps-chip${id === value ? ' active' : ''}`);
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(id === value));
      b.dataset.focus = `chip:${id}`;
      b.append(h('span', '', label));
      if (count !== null) b.append(h('span', 'caps-chip-n', String(count)));
      b.addEventListener('click', () => pick(id));
      bar.append(b);
    }
    return bar;
  }

  private matches(...words: string[]): boolean {
    const q = this.query.trim().toLowerCase();
    return !q || words.join(' ').toLowerCase().includes(q);
  }

  private groupHead(label: string, count: number): HTMLElement {
    const g = h('div', 'caps-group');
    g.append(h('span', '', label), h('span', 'caps-group-n', String(count)));
    return g;
  }

  /** What an empty list says: nothing installed (with the way to add), nothing in this filter, or no match. */
  private empty(box: HTMLElement, none: boolean, noneText: Key, addText: Key): void {
    const q = this.query.trim();
    const e = h('div', 'caps-empty');
    if (q) e.append(h('p', '', t('caps.noMatch', { q })));
    else if (none) {
      e.append(h('p', '', t(noneText)));
      const add = h('button', 'btn', t(addText));
      add.addEventListener('click', () => this.startAdd());
      e.append(add);
    } else e.append(h('p', '', t('caps.emptyFilter')));
    box.append(e);
  }

  private skeleton(el: HTMLElement): void {
    const head = h('div', 'caps-head');
    const heading = h('h2', 'caps-title', t(this.kind === 'mcp' ? 'caps.mcp' : 'caps.skills'));
    heading.id = 'caps-title';
    head.append(heading);
    const list = h('div', 'caps-list caps-loading');
    list.setAttribute('aria-busy', 'true');
    for (let i = 0; i < 7; i++) {
      const row = h('div', 'caps-row caps-skel');
      row.append(h('span', 'caps-skel-bar'), h('span', 'caps-skel-bar short'));
      list.append(row);
    }
    el.append(head, list);
  }

  private failed(el: HTMLElement): void {
    const heading = h('h2', 'caps-title', t(this.kind === 'mcp' ? 'caps.mcp' : 'caps.skills'));
    heading.id = 'caps-title';
    const head = h('div', 'caps-head');
    head.append(heading);
    const e = h('div', 'caps-empty');
    const retry = h('button', 'btn', t('caps.retry'));
    retry.addEventListener('click', () => void this.load());
    e.append(h('p', '', t('caps.loadFailed')), retry);
    el.append(head, e);
  }

  /** A row's actions menu ("⋯"): see the detail, remove. */
  private moreButton(key: string, label: string, onRemove: () => void): HTMLButtonElement {
    const more = h('button', 'icon-btn caps-more');
    more.title = t('caps.more');
    more.setAttribute('aria-label', `${t('caps.more')} ${label}`);
    more.setAttribute('aria-haspopup', 'menu');
    more.disabled = this.busy;
    more.append(icon(ICONS.more));
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      openMenu(
        more,
        (menu, close) => {
          const item = (text: string, run: () => void, danger = false) => {
            const b = h('button', `menu-row${danger ? ' danger' : ''}`);
            b.append(h('span', 'menu-title', text));
            b.addEventListener('click', () => {
              close();
              run();
            });
            menu.append(b);
            return b;
          };
          item(t('caps.details'), () => {
            this.openKey = key;
            this.confirmKey = '';
            this.render();
          }).focus();
          item(t('caps.remove'), onRemove, true);
        },
        true,
      );
    });
    return more;
  }

  /** A row that unfolds its detail under it on a click or Enter. */
  private row(key: string, cls: string, cells: HTMLElement[]): HTMLElement {
    const open = this.openKey === key;
    const row = h('div', `caps-row ${cls}${open ? ' open' : ''}`);
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-expanded', String(open));
    row.dataset.focus = key;
    row.append(...cells);
    const toggle = () => {
      this.openKey = open ? '' : key;
      this.confirmKey = '';
      this.render();
    };
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (e) => {
      if (e.target !== row || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      toggle();
    });
    return row;
  }

  private detail(fields: [string, HTMLElement | string][], after: HTMLElement[] = []): HTMLElement {
    const box = h('div', 'caps-detail');
    const dl = h('dl', 'caps-fields');
    for (const [label, value] of fields) {
      const dd = h('dd');
      dd.append(value);
      dl.append(h('dt', '', label), dd);
    }
    box.append(dl, ...after);
    return box;
  }

  /** The removal button of a detail, or its confirmation once asked. */
  private removal(key: string, label: string, ask: string, run: () => void): HTMLElement {
    const bar = h('div', 'caps-actions');
    if (this.confirmKey !== key) {
      const del = h('button', 'btn small caps-danger', label);
      del.disabled = this.busy;
      del.dataset.focus = `del:${key}`;
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        this.confirmKey = key;
        this.render();
        this.focusRow(`cancel:${key}`);
      });
      bar.append(del);
      return bar;
    }
    bar.classList.add('confirm');
    bar.append(h('span', 'caps-confirm-text', ask));
    const cancel = h('button', 'btn small', t('caps.cancel'));
    cancel.dataset.focus = `cancel:${key}`;
    cancel.addEventListener('click', () => {
      this.confirmKey = '';
      this.render();
      this.card.querySelector<HTMLElement>(`[data-focus="${CSS.escape(`del:${key}`)}"]`)?.focus();
    });
    const go = h('button', 'btn small caps-danger-go', label);
    go.disabled = this.busy;
    go.dataset.focus = `go:${key}`;
    go.addEventListener('click', run);
    bar.append(cancel, go);
    return bar;
  }

  // ---------- MCP ----------

  private mcpList(el: HTMLElement, c: Capabilities): void {
    const servers = c.mcp.filter(listedMcp);
    const checked = c.checkedAt > 0;
    const count = (s: McpStatus) => (checked ? servers.filter((m) => mcpStatus(m.state) === s).length : null);

    const refresh = h('button', `icon-btn caps-refresh${this.checking ? ' spinning' : ''}`);
    const label = this.checking ? t('caps.checking') : checked ? t('caps.refreshChecked', { when: ago(c.checkedAt) }) : t('caps.refresh');
    refresh.title = label;
    refresh.setAttribute('aria-label', label);
    refresh.disabled = this.checking;
    refresh.dataset.focus = 'refresh';
    refresh.append(this.checking ? h('span', 'setup-spin') : icon(ICONS.resume));

    const box = h('div', 'caps-list');
    const fill = () => this.fillMcp(box, servers, checked);
    this.header(el, t('caps.mcp'), servers.length, fill, [refresh, this.addButton()]);
    refresh.addEventListener('click', () => void this.check());

    el.append(
      this.chips<McpFilter>(
        [
          ['all', t('caps.filter.all'), servers.length],
          ['on', t('caps.mcp.on'), count('on')],
          ['todo', t('caps.mcp.todo'), count('todo')],
          ['error', t('caps.mcp.error'), count('error')],
        ],
        this.mcpFilter,
        (v) => {
          this.mcpFilter = v;
          this.openKey = this.confirmKey = '';
          this.render();
        },
      ),
    );
    if (c.checkError && !this.checking) el.append(errorNote('caps-banner', t(c.checkError === 'no-claude' ? 'caps.err.noClaude' : 'caps.checkFailed')));
    el.append(box);
    fill();
  }

  private fillMcp(box: HTMLElement, servers: McpEntry[], checked: boolean): void {
    const rows = servers
      .filter((m) => (!checked || this.mcpFilter === 'all' || mcpStatus(m.state) === this.mcpFilter) && this.matches(m.name, mcpSource(m)))
      .sort((a, b) => shownName(a).localeCompare(shownName(b)));
    const parts: HTMLElement[] = [];
    if (!checked) {
      // Before the first check every state is unknown: one neutral group, not "to connect".
      if (rows.length > 0) parts.push(this.groupHead(t(this.checking ? 'caps.checking' : 'caps.mcp.unchecked'), rows.length));
      for (const m of rows.slice(0, ROWS_MAX)) parts.push(...this.mcpRow(m));
    } else
      for (const status of MCP_ORDER) {
        const group = rows.filter((m) => mcpStatus(m.state) === status);
        if (group.length === 0) continue;
        parts.push(this.groupHead(t(`caps.mcp.${status}`), group.length));
        for (const m of group.slice(0, ROWS_MAX)) parts.push(...this.mcpRow(m));
      }
    box.replaceChildren(...parts);
    if (rows.length === 0) this.empty(box, servers.length === 0, 'caps.mcp.empty', 'caps.mcp.addFirst');
  }

  private mcpRow(m: McpEntry): HTMLElement[] {
    const key = mcpKey(m);
    const dot = h('span', `caps-dot st-${this.caps?.checkedAt ? m.state : 'unknown'}${!this.caps?.checkedAt && this.checking ? ' pulse' : ''}`);
    dot.title = t(`caps.state.${m.state}`);
    const name = h('span', 'caps-name', shownName(m));
    name.title = m.name;
    const cells = [dot, name, h('span', 'caps-src', mcpSource(m)), this.connectButton(m) ?? h('span')];
    const ask = () => {
      this.openKey = key;
      this.confirmKey = key;
      this.render();
      this.focusRow(`cancel:${key}`);
    };
    cells.push(removable(m) ? this.moreButton(key, m.name, ask) : h('span', 'caps-more-gap'));
    const row = this.row(key, 'mcp', cells);
    return this.openKey === key ? [row, this.mcpDetail(m, key)] : [row];
  }

  private mcpDetail(m: McpEntry, key: string): HTMLElement {
    const state = h('span', 'caps-state');
    state.append(h('span', `caps-dot st-${m.state}`), h('span', '', t(`caps.state.${m.state}`)));
    const fields: [string, HTMLElement | string][] = [[t('caps.d.state'), state]];
    const help = this.mcpHelp(m);
    if (help) fields.push(['', h('span', 'caps-help', help)]);
    if (m.state === 'failed' && m.error) fields.push(['', techDetails(m.error)]);
    if (m.transport) fields.push([t('caps.d.type'), m.transport === 'stdio' ? t('caps.type.stdio') : m.transport.toUpperCase()]);
    if (m.target) fields.push([t(m.transport === 'stdio' ? 'caps.d.command' : 'caps.d.url'), h('code', 'caps-target', m.target)]);
    fields.push([t('caps.d.reach'), reachText(m.reach, m.project)]);
    const after: HTMLElement[] = [];
    if (removable(m)) {
      after.push(
        this.removal(key, t('caps.remove'), t('caps.mcp.removeAsk', { name: m.name }), () =>
          void this.act(() => this.hub.removeMcp(m.name, m.source, m.project), t('caps.mcp.removed', { name: m.name })).then((ok) => ok && (this.openKey = '')),
        ),
      );
    } else {
      const managed =
        m.source === 'plugin' ? t('caps.managed.plugin', { plugin: pluginName(m.plugin) }) : m.source === 'claude.ai' ? t('caps.managed.claudeai') : t('caps.managed.other');
      after.push(h('p', 'caps-managed', managed));
    }
    return this.detail(fields, after);
  }

  /** What to do about a server that is not connected, in one line. */
  private mcpHelp(m: McpEntry): string {
    if (this.signing.get(m.name) === 'auth') return t('caps.help.waiting');
    if (m.state === 'needs-auth') return t(m.source === 'claude.ai' ? 'caps.help.claudeai' : 'caps.help.auth');
    if (m.state === 'pending') return t('caps.help.pending');
    if (m.state === 'failed') return t('caps.help.failed');
    if (m.state === 'disabled') return t('caps.help.disabled');
    return '';
  }

  /**
   * A row's own action: sign in to a server that asks for it (Cancel while the browser is out; Refresh once claude.ai
   * was opened for a connector), restart one that failed. Null for the others.
   */
  private connectButton(m: McpEntry): HTMLButtonElement | null {
    const doing = this.signing.get(m.name);
    if (!this.caps?.checkedAt || (m.state !== 'needs-auth' && m.state !== 'failed' && !doing)) return null;
    const b = h('button', 'btn small caps-act');
    b.dataset.focus = `act:${mcpKey(m)}`;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (doing === 'auth') void this.hub.cancelConnectMcp(m.name);
      else if (m.state === 'failed' || this.browserOpened.has(m.name)) void this.restart(m);
      else void this.connect(m);
    });
    if (doing) b.append(h('span', 'setup-spin'));
    if (doing === 'auth') {
      b.append(h('span', '', t('caps.connect.cancel')));
      b.title = t('caps.help.waiting');
      return b;
    }
    b.disabled = doing === 'restart' || this.checking;
    const label = m.state === 'failed' ? 'caps.connect.restart' : this.browserOpened.has(m.name) ? 'caps.connect.refresh' : 'caps.connect';
    b.append(h('span', '', t(label)));
    return b;
  }

  private async connect(m: McpEntry): Promise<void> {
    this.openKey = mcpKey(m);
    this.confirmKey = '';
    await this.connectAction(m, 'auth', () => this.hub.connectMcp(m.name));
  }

  private async restart(m: McpEntry): Promise<void> {
    await this.connectAction(m, 'restart', () => this.hub.restartMcp(m.name));
  }

  /** Runs a sign-in or a restart; the list comes back with its result, and a note says how it ended. */
  private async connectAction(m: McpEntry, kind: 'auth' | 'restart', task: () => Promise<ConnectResult>): Promise<void> {
    this.signing.set(m.name, kind);
    this.setNote(null);
    this.render();
    let r: ConnectResult | null = null;
    try {
      r = await task();
    } catch (e) {
      this.setNote({ text: t('caps.err.unexpected'), tone: 'error', detail: String(e) });
    } finally {
      this.signing.delete(m.name);
    }
    if (r) {
      this.caps = r;
      const name = shownName(m);
      if (r.outcome === 'browser') {
        this.browserOpened.add(m.name);
        this.setNote({ text: t('caps.connect.browser', { name }), tone: 'ok' });
      } else if (r.outcome === 'connected') {
        this.browserOpened.delete(m.name);
        const text = r.missed > 0 ? tn('caps.connect.next', r.missed, { name }) : r.reached > 0 ? tn('caps.connect.live', r.reached, { name }) : t('caps.connect.done', { name });
        this.setNote({ text, tone: 'ok' });
      } else if (!r.ok) this.setNote({ text: this.errorText(r.error), tone: 'error', detail: r.detail });
    }
    if (!this.root.hidden) this.render();
  }

  private mcpErrors(c: Capabilities): Partial<Record<'name' | 'command' | 'url' | 'project' | 'extra', string>> {
    const f = this.mcpForm;
    const errors: Partial<Record<'name' | 'command' | 'url' | 'project' | 'extra', string>> = {};
    if (!f.name) errors.name = t('caps.err.nameEmpty');
    else if (!MCP_NAME.test(f.name)) errors.name = t('caps.err.name');
    else if (c.mcp.some((m) => m.name === f.name && (f.scope === 'user' ? m.source === 'user' : m.project === f.project && m.source === 'project')))
      errors.name = t('caps.err.nameTaken');
    if (f.transport === 'stdio' && splitCommand(f.command).length === 0) errors.command = t('caps.err.command');
    if (f.transport === 'http' && !/^https?:\/\/\S+$/i.test(f.url.trim())) errors.url = t('caps.err.url');
    if (f.scope === 'project' && !c.repos.includes(f.project)) errors.project = t('caps.err.project');
    const extra = pairs(f.extra, f.transport === 'stdio' ? '=' : ':');
    const keyOk = f.transport === 'stdio' ? /^[A-Za-z_][A-Za-z0-9_]{0,99}$/ : /^[A-Za-z0-9-]{1,100}$/;
    if (!extra || Object.keys(extra).some((k) => !keyOk.test(k))) errors.extra = t(f.transport === 'stdio' ? 'caps.err.env' : 'caps.err.headers');
    return errors;
  }

  private formHead(el: HTMLElement, title: string): void {
    const head = h('div', 'caps-head');
    const back = h('button', 'icon-btn caps-back');
    back.title = t('caps.back');
    back.setAttribute('aria-label', t('caps.back'));
    back.dataset.focus = 'back';
    back.append(icon('M10 3.5L5.5 8l4.5 4.5'));
    back.addEventListener('click', () => this.back());
    const heading = h('h2', 'caps-title', title);
    heading.id = 'caps-title';
    head.append(back, heading);
    el.append(head);
  }

  /** A labelled field; its error shows under it once the form was sent. */
  private field(parent: HTMLElement, label: string, control: HTMLElement, hint = '', error = ''): HTMLElement {
    const f = h('div', `setup-field caps-field${error ? ' invalid' : ''}`);
    const l = h('label', 'setup-label', label);
    const id = control.dataset.focus ? `caps-f-${control.dataset.focus}` : '';
    if (id && (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement)) {
      control.id = id;
      l.htmlFor = id;
    }
    f.append(l, control);
    if (error) f.append(h('div', 'caps-field-error', error));
    else if (hint) f.append(h('div', 'setup-hint', hint));
    parent.append(f);
    return f;
  }

  private input(value: string, placeholder: string, focus: string, set: (v: string) => void): HTMLInputElement {
    const i = h('input', 'setup-input caps-input');
    i.value = value;
    i.placeholder = placeholder;
    i.spellcheck = false;
    i.autocomplete = 'off';
    i.dataset.focus = focus;
    i.addEventListener('input', () => set(i.value));
    return i;
  }

  private seg<T extends string>(options: [T, string][], value: T, focus: string, pick: (v: T) => void): HTMLElement {
    const seg = h('div', 'segmented caps-seg');
    seg.setAttribute('role', 'radiogroup');
    for (const [id, label] of options) {
      const b = h('button', id === value ? 'seg active' : 'seg', label);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(id === value));
      b.dataset.focus = `${focus}:${id}`;
      b.addEventListener('click', () => pick(id));
      seg.append(b);
    }
    return seg;
  }

  private mcpAdd(el: HTMLElement, c: Capabilities): void {
    this.formHead(el, t('caps.mcp.addTitle'));
    const f = this.mcpForm;
    const errors = f.tried ? this.mcpErrors(c) : {};
    // Errors already shown follow what is typed; the others wait for the next "Add".
    const live = () => {
      if (f.tried) this.render();
    };
    const form = h('form', 'caps-form');
    form.noValidate = true;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.submitMcp(c);
    });

    const name = this.input(f.name, 'my-server', 'f-name', (v) => {
      f.name = v.trim();
      live();
    });
    name.dataset.autofocus = '';
    this.field(form, t('caps.form.name'), name, t('caps.form.nameHint'), errors.name);

    const pick = (v: McpForm['transport']) => {
      f.transport = v;
      this.render();
    };
    this.field(form, t('caps.form.type'), this.seg<McpForm['transport']>([['stdio', t('caps.form.stdio')], ['http', t('caps.form.http')]], f.transport, 'f-type', pick));
    if (f.transport === 'stdio') {
      const cmd = this.input(f.command, 'npx -y @playwright/mcp@latest', 'f-command', (v) => {
        f.command = v;
        live();
      });
      this.field(form, t('caps.form.command'), cmd, t('caps.form.commandHint'), errors.command);
    } else {
      const url = this.input(f.url, 'https://example.com/mcp', 'f-url', (v) => {
        f.url = v.trim();
        live();
      });
      this.field(form, t('caps.form.url'), url, '', errors.url);
    }

    const scope = this.field(
      form,
      t('caps.form.scope'),
      this.seg<McpForm['scope']>([['user', t('caps.form.scopeUser')], ['project', t('caps.form.scopeProject')]], f.scope, 'f-scope', (v) => {
        f.scope = v;
        this.render();
      }),
      t(f.scope === 'user' ? 'caps.form.scopeUserHint' : 'caps.form.scopeProjectHint'),
    );
    if (f.scope === 'project') {
      if (c.repos.length === 0) scope.append(h('div', 'caps-field-error', t('caps.form.noRepo')));
      else {
        const select = h('select', 'setup-select caps-input');
        select.dataset.focus = 'f-repo';
        select.setAttribute('aria-label', t('caps.form.repo'));
        for (const repo of c.repos) {
          const o = h('option', '', folderName(repo));
          o.value = repo;
          select.append(o);
        }
        if (!c.repos.includes(f.project)) f.project = c.repos[0];
        select.value = f.project;
        select.addEventListener('change', () => {
          f.project = select.value;
          live();
        });
        scope.append(select);
      }
    }

    const more = h('details', 'caps-more-fields');
    more.open = f.extra.trim() !== '' || Boolean(errors.extra);
    more.append(h('summary', '', t(f.transport === 'stdio' ? 'caps.form.env' : 'caps.form.headers')));
    const area = h('textarea', 'setup-textarea caps-area');
    area.rows = 3;
    area.spellcheck = false;
    area.value = f.extra;
    area.placeholder = f.transport === 'stdio' ? 'API_KEY=…' : 'Authorization: Bearer …';
    area.dataset.focus = 'f-extra';
    area.setAttribute('aria-label', t(f.transport === 'stdio' ? 'caps.form.env' : 'caps.form.headers'));
    area.addEventListener('input', () => {
      f.extra = area.value;
      live();
    });
    more.append(area);
    if (errors.extra) more.append(h('div', 'caps-field-error', errors.extra));
    else more.append(h('div', 'setup-hint', t(f.transport === 'stdio' ? 'caps.form.envHint' : 'caps.form.headersHint')));
    form.append(more);

    const actions = h('div', 'caps-form-actions');
    const cancel = h('button', 'btn', t('caps.cancel'));
    cancel.type = 'button';
    cancel.addEventListener('click', () => this.back());
    const submit = h('button', 'btn strong', this.busy ? t('caps.form.adding') : t('caps.form.submit'));
    submit.type = 'submit';
    submit.disabled = this.busy;
    submit.dataset.focus = 'f-submit';
    actions.append(cancel, submit);
    form.append(actions);
    el.append(form);
  }

  private async submitMcp(c: Capabilities): Promise<void> {
    const f = this.mcpForm;
    f.tried = true;
    const errors = this.mcpErrors(c);
    if (Object.keys(errors).length > 0) {
      this.render();
      const first = (['name', 'command', 'url', 'project', 'extra'] as const).find((k) => errors[k]);
      this.card.querySelector<HTMLElement>(`[data-focus="f-${first === 'project' ? 'repo' : first}"]`)?.focus();
      return;
    }
    const [command, ...args] = splitCommand(f.command);
    const extra = pairs(f.extra, f.transport === 'stdio' ? '=' : ':') ?? {};
    const draft: McpDraft = {
      name: f.name,
      scope: f.scope,
      project: f.scope === 'project' ? f.project : '',
      transport: f.transport,
      command: f.transport === 'stdio' ? command : '',
      args: f.transport === 'stdio' ? args : [],
      url: f.transport === 'http' ? f.url : '',
      env: f.transport === 'stdio' ? extra : {},
      headers: f.transport === 'http' ? extra : {},
    };
    const ok = await this.act(() => this.hub.addMcp(draft), t('caps.mcp.added', { name: f.name }));
    if (!ok) return;
    this.mcpForm = emptyMcpForm();
    // The other panel may have been opened while the server was being added.
    if (this.kind !== 'mcp') return;
    this.adding = false;
    this.mcpFilter = 'all';
    this.render();
    void this.check();
  }

  // ---------- skills ----------

  private skillList(el: HTMLElement, c: Capabilities): void {
    const off = (s: SkillEntry) => s.source === 'disabled' || (s.source === 'plugin' && s.reach === 'nowhere');
    const n = (f: SkillFilter) => c.skills.filter((s) => this.inFilter(s, f, off)).length;
    const box = h('div', 'caps-list');
    const fill = () => this.fillSkills(box, c, off);
    this.header(el, t('caps.skills'), c.skills.length, fill, [this.addButton()]);
    el.append(
      this.chips<SkillFilter>(
        [
          ['all', t('caps.filter.all'), c.skills.length],
          ['user', t('caps.skills.user'), n('user')],
          ['plugin', t('caps.skills.plugin'), n('plugin')],
          ['project', t('caps.skills.project'), n('project')],
          ['disabled', t('caps.skills.disabled'), n('disabled')],
        ],
        this.skillFilter,
        (v) => {
          this.skillFilter = v;
          this.openKey = this.confirmKey = '';
          this.sortedOff.clear();
          this.render();
        },
      ),
      box,
    );
    fill();
  }

  private inFilter(s: SkillEntry, f: SkillFilter, off: (s: SkillEntry) => boolean): boolean {
    if (f === 'all') return true;
    if (f === 'disabled') return off(s);
    if (f === 'user') return s.source === 'user' || s.source === 'disabled';
    return s.source === f;
  }

  private fillSkills(box: HTMLElement, c: Capabilities, off: (s: SkillEntry) => boolean): void {
    const f = this.skillFilter;
    const byName = (a: SkillEntry, b: SkillEntry) => skillName(a).localeCompare(skillName(b));
    const shown = c.skills.filter((s) => this.inFilter(s, f, off));
    const parts: HTMLElement[] = [];

    const own = shown.filter((s) => (s.source === 'user' || s.source === 'disabled') && this.matches(s.name, s.description));
    for (const s of own) if (!this.sortedOff.has(s.name)) this.sortedOff.set(s.name, off(s));
    own.sort((a, b) => Number(this.sortedOff.get(a.name)) - Number(this.sortedOff.get(b.name)) || byName(a, b));
    if (own.length > 0) parts.push(this.groupHead(t('caps.skills.user'), own.length), ...own.slice(0, ROWS_MAX).flatMap((s) => this.skillRow(s)));

    // A plugin shows when it or one of its skills matches; the "off" filter also lists the off plugins without skills.
    const plugins = c.plugins
      .map((p) => {
        const all = shown.filter((s) => s.source === 'plugin' && s.plugin === p.id).sort(byName);
        return { p, skills: this.matches(p.name) ? all : all.filter((s) => this.matches(s.name, s.description)) };
      })
      .filter(({ p, skills }) => {
        if (f !== 'all' && f !== 'plugin' && f !== 'disabled') return false;
        if (f === 'disabled' && p.enabled) return false;
        return skills.length > 0 || this.matches(p.name);
      })
      .sort((a, b) => Number(b.p.enabled) - Number(a.p.enabled) || a.p.name.localeCompare(b.p.name));
    if (plugins.length > 0) {
      parts.push(this.groupHead(t('caps.skills.plugin'), plugins.length));
      for (const { p, skills } of plugins) parts.push(...this.pluginRows(p, skills));
    }

    const repo = shown.filter((s) => s.source === 'project' && this.matches(s.name, s.description, folderName(s.project))).sort(byName);
    if (repo.length > 0) parts.push(this.groupHead(t('caps.skills.project'), repo.length), ...repo.slice(0, ROWS_MAX).flatMap((s) => this.skillRow(s)));

    box.replaceChildren(...parts);
    if (parts.length === 0) this.empty(box, c.skills.length === 0 && c.plugins.length === 0, 'caps.skills.empty', 'caps.skills.addFirst');
  }

  private toggle(on: boolean, label: string, run: () => void): HTMLButtonElement {
    const sw = h('button', 'caps-switch');
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(on));
    sw.setAttribute('aria-label', label);
    sw.title = label;
    sw.disabled = this.busy;
    sw.dataset.focus = `sw:${label}`;
    sw.addEventListener('click', (e) => {
      e.stopPropagation();
      run();
    });
    return sw;
  }

  private skillRow(s: SkillEntry, inPlugin = false): HTMLElement[] {
    const key = skillKey(s);
    const off = s.source === 'disabled' || s.reach === 'nowhere';
    const name = h('span', 'caps-name', skillName(s));
    name.title = s.name;
    const desc = h('span', 'caps-desc', s.description.replace(/\s+/g, ' ').trim());
    const cells: HTMLElement[] = [name, desc];
    if (s.source === 'user' || s.source === 'disabled') {
      const enable = s.source === 'disabled';
      cells.push(this.toggle(!enable, t('caps.skills.use', { name: s.name }), () => void this.act(() => this.hub.moveSkill(s.dir, enable), '')));
    } else if (s.source === 'project') cells.push(h('span', 'caps-src', folderName(s.project)));
    else cells.push(h('span', 'caps-more-gap'));
    const row = this.row(key, `skill${inPlugin ? ' child' : ''}${off ? ' off' : ''}`, cells);
    return this.openKey === key ? [row, this.skillDetail(s, key)] : [row];
  }

  private skillDetail(s: SkillEntry, key: string): HTMLElement {
    const fields: [string, HTMLElement | string][] = [
      [t('caps.d.source'), skillSource(s)],
      [t('caps.d.reach'), reachText(s.reach, s.project, s.source === 'plugin' ? 'caps.reach.pluginOff' : 'caps.reach.off')],
    ];
    const after: HTMLElement[] = [];
    if (s.source === 'user' || s.source === 'disabled')
      after.push(
        this.removal(key, t('caps.skills.delete'), t('caps.skills.deleteAsk', { name: s.name }), () =>
          void this.act(() => this.hub.deleteSkill(s.dir, s.source === 'disabled'), t('caps.skills.deleted', { name: s.name })).then((ok) => ok && (this.openKey = '')),
        ),
      );
    else if (s.source === 'plugin') after.push(h('p', 'caps-managed', t('caps.managed.pluginSkill', { plugin: pluginName(s.plugin) })));
    const box = this.detail(fields, after);
    box.prepend(h('p', 'caps-desc-full', s.description.trim() || t('caps.skills.noDesc')));
    return box;
  }

  /** A plugin's header (folded by default, unfolded by a search that hits its skills), then its skills. */
  private pluginRows(p: PluginEntry, skills: SkillEntry[]): HTMLElement[] {
    const key = `p:${p.id}`;
    const open = this.expanded.has(p.id) || (this.query.trim() !== '' && skills.length > 0);
    const head = h('div', `caps-row plugin${open ? ' open' : ''}${p.enabled ? '' : ' off'}`);
    head.tabIndex = 0;
    head.setAttribute('role', 'button');
    head.setAttribute('aria-expanded', String(open));
    head.dataset.focus = key;
    const name = h('span', 'caps-name');
    name.append(icon(ICONS.chevron, 'ico caps-chevron'), h('span', 'caps-name-text', p.name));
    name.title = p.id;
    const meta = p.skills > 0 ? tn('caps.plugin.skills', p.skills) : p.mcp > 0 ? tn('caps.plugin.servers', p.mcp) : t('caps.plugin.empty');
    head.append(
      name,
      h('span', 'caps-desc', meta),
      this.toggle(p.enabled, t('caps.skills.use', { name: p.name }), () => void this.act(() => this.hub.setPlugin(p.id, !p.enabled), '')),
    );
    const flip = () => {
      if (this.expanded.has(p.id)) this.expanded.delete(p.id);
      else this.expanded.add(p.id);
      this.openKey = this.confirmKey = '';
      this.render();
    };
    head.addEventListener('click', flip);
    head.addEventListener('keydown', (e) => {
      if (e.target !== head || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      flip();
    });
    return open ? [head, ...skills.slice(0, ROWS_MAX).flatMap((s) => this.skillRow(s, true))] : [head];
  }

  private skillErrors(): Partial<Record<'url' | 'skill' | 'name' | 'text', string>> {
    const f = this.skillForm;
    const errors: Partial<Record<'url' | 'skill' | 'name' | 'text', string>> = {};
    if (f.tab === 'github') {
      if (!GITHUB_URL.test(f.url)) errors.url = t('caps.err.githubUrl');
      if (!SKILL_NAME.test(f.skill)) errors.skill = t('caps.err.skillName');
      return errors;
    }
    if (!SKILL_NAME.test(f.name)) errors.name = t('caps.err.skillName');
    const fields = parseAgentFile(f.text)?.fields;
    if (!fields?.description) errors.text = t('caps.err.pasteHeader');
    else if (fields.name && fields.name !== f.name && !errors.name) errors.name = t('caps.err.pasteName', { name: fields.name });
    return errors;
  }

  private skillAdd(el: HTMLElement): void {
    this.formHead(el, t('caps.skills.addTitle'));
    const f = this.skillForm;
    const errors = f.tried ? this.skillErrors() : {};
    const live = () => {
      if (f.tried) this.render();
    };
    const form = h('form', 'caps-form');
    form.noValidate = true;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.submitSkill();
    });
    form.append(
      this.seg<SkillTab>([['github', t('caps.github')], ['paste', t('caps.paste')]], f.tab, 'f-tab', (v) => {
        f.tab = v;
        f.tried = false;
        this.setNote(null);
        this.render();
      }),
    );
    form.lastElementChild?.classList.add('caps-tabs');

    if (f.tab === 'github') {
      const url = this.input(f.url, 'https://github.com/owner/repo', 'f-gh-url', (v) => {
        f.url = v.trim();
        live();
      });
      url.dataset.autofocus = '';
      this.field(form, t('caps.github.url'), url, t('caps.github.urlHint'), errors.url);
      const skill = this.input(f.skill, 'my-skill', 'f-gh-skill', (v) => {
        f.skill = v.trim();
        live();
      });
      this.field(form, t('caps.github.skill'), skill, t('caps.github.skillHint'), errors.skill);
    } else {
      const name = this.input(f.name, 'my-skill', 'f-paste-name', (v) => {
        f.name = v.trim();
        live();
      });
      name.dataset.autofocus = '';
      this.field(form, t('caps.paste.name'), name, '', errors.name);
      const area = h('textarea', 'setup-textarea caps-area caps-paste');
      area.rows = 10;
      area.spellcheck = false;
      area.placeholder = '---\nname: my-skill\ndescription: What it does, and when to use it.\n---\n\n# My skill\n…';
      area.value = f.text;
      area.dataset.focus = 'f-paste-text';
      area.addEventListener('input', () => {
        f.text = area.value;
        // The header's own name fills an empty name field.
        const own = parseAgentFile(f.text)?.fields.name ?? '';
        if (!f.name && SKILL_NAME.test(own)) {
          f.name = own;
          return this.render();
        }
        live();
      });
      this.field(form, t('caps.paste.text'), area, t('caps.paste.textHint'), errors.text);
    }

    const actions = h('div', 'caps-form-actions');
    const cancel = h('button', 'btn', t('caps.cancel'));
    cancel.type = 'button';
    cancel.addEventListener('click', () => this.back());
    const label = f.tab === 'github' ? (this.busy ? t('caps.github.installing') : t('caps.github.install')) : t('caps.paste.create');
    const submit = h('button', 'btn strong', label);
    submit.type = 'submit';
    submit.disabled = this.busy;
    submit.dataset.focus = 'f-submit';
    if (this.busy) submit.prepend(h('span', 'setup-spin'));
    actions.append(cancel, submit);
    form.append(actions);
    el.append(form);
  }

  private async submitSkill(): Promise<void> {
    const f = this.skillForm;
    f.tried = true;
    const errors = this.skillErrors();
    if (Object.keys(errors).length > 0) {
      this.render();
      const first = (['url', 'skill', 'name', 'text'] as const).find((k) => errors[k]);
      const focus = { url: 'f-gh-url', skill: 'f-gh-skill', name: 'f-paste-name', text: 'f-paste-text' }[first ?? 'url'];
      this.card.querySelector<HTMLElement>(`[data-focus="${focus}"]`)?.focus();
      return;
    }
    const name = f.tab === 'github' ? f.skill : f.name;
    const ok =
      f.tab === 'github'
        ? await this.act(() => this.hub.githubSkill(f.url, f.skill), t('caps.github.installed', { name }))
        : await this.act(() => this.hub.pasteSkill(f.name, f.text), t('caps.paste.created', { name }));
    if (!ok) return;
    this.skillForm = emptySkillForm();
    if (this.kind !== 'skills') return;
    this.adding = false;
    this.skillFilter = 'all';
    this.render();
  }
}
