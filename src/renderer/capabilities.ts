import type { Capabilities, CapResult, McpDraft, McpEntry, PluginEntry, Reach, SkillEntry } from '../shared/capabilities';
import type { HubApi } from '../shared/types';
import { errorNote, folderName, h, icon, ICONS } from './dom';
import { t, tn, type Key } from './i18n';

type Kind = 'mcp' | 'skills';
type McpGroup = 'all' | 'user' | 'repos' | 'plugin' | 'claude.ai' | 'other';
type SkillGroup = 'all' | 'user' | 'repos' | 'plugin' | 'disabled' | 'agents';
type View = McpGroup | SkillGroup | 'plugins' | 'add';
type StateFilter = 'all' | 'on' | 'off';

/** Older than this, opening the MCP panel asks Claude Code for the servers' state again. */
const STALE_MS = 5 * 60_000;
const ROWS_MAX = 400;

const mcpGroup = (m: McpEntry): McpGroup => (m.source === 'project' || m.source === 'local' ? 'repos' : m.source);
const skillGroup = (s: SkillEntry): SkillGroup =>
  s.kind === 'agent' ? (s.source === 'disabled' ? 'disabled' : 'agents') : s.source === 'project' ? 'repos' : s.source;

/** The MCP and Skills panels: what Claude Code has installed on this computer, a sheet like the settings. */
export class CapsView {
  private readonly root = document.getElementById('caps') as HTMLDivElement;
  private readonly card = h('div', 'setup-card');
  private kind: Kind = 'mcp';
  private view: View = 'all';
  private caps: Capabilities | null = null;
  private checking = false;
  private query = '';
  private stateFilter: StateFilter = 'all';
  private sort: 'name' | 'source' = 'name';
  /** Row whose removal or deletion waits for the confirmation shown in it. */
  private confirm = '';
  private busy = false;
  private note: { text: string; tone: 'ok' | 'error'; detail?: string } | null = null;
  private draft: McpDraft = emptyDraft();
  private envText = '';
  private headerText = '';
  private argsText = '';
  private githubUrl = '';
  private githubSkill = '';
  private pasted = '';
  private returnFocus: HTMLElement | null = null;
  private clearTimer = 0;

  constructor(private readonly hub: HubApi) {
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-labelledby', 'caps-title');
    document.addEventListener('keydown', (e) => {
      if (this.root.hidden) return;
      if (e.key === 'Escape') this.close();
      else if (e.key === 'Tab') this.trapFocus(e);
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  async open(kind: Kind): Promise<void> {
    if (this.root.hidden) this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.kind = kind;
    this.view = 'all';
    this.query = '';
    this.confirm = '';
    this.note = null;
    window.clearTimeout(this.clearTimer);
    this.root.hidden = false;
    this.caps = await this.hub.capabilities();
    this.render();
    if (kind === 'mcp' && Date.now() - this.caps.checkedAt > STALE_MS) void this.check();
  }

  close(): void {
    this.root.hidden = true;
    this.clearTimer = window.setTimeout(() => this.root.hidden && this.root.replaceChildren(), 240);
    this.returnFocus?.focus();
    this.returnFocus = null;
  }

  private trapFocus(e: KeyboardEvent): void {
    const items = [...this.root.querySelectorAll<HTMLElement>('button, input, select, textarea, summary')].filter(
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
    } finally {
      this.checking = false;
      if (!this.root.hidden) this.render();
    }
  }

  /** Runs a change; the list comes back with its result. */
  private async act(task: () => Promise<CapResult>, done: string): Promise<boolean> {
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
    this.confirm = '';
    this.note = r.ok ? { text: done, tone: 'ok' } : { text: this.errorText(r.error), tone: 'error', detail: r.detail };
    this.render();
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
      'skill-format': 'caps.err.skillFormat',
    };
    return t(known[code] ?? 'caps.err.unexpected');
  }

  // ---------- frame ----------

  private render(): void {
    const c = this.caps;
    if (!c) return;
    const nav = h('nav', 'setup-nav');
    nav.append(h('div', 'setup-nav-title', t(this.kind === 'mcp' ? 'caps.mcp' : 'caps.skills')));
    const item = (id: View, label: string, count?: number) => {
      const b = h('button', `setup-nav-item${id === this.view ? ' active' : ''}`);
      b.append(h('span', 'caps-nav-label', label));
      if (count !== undefined) b.append(h('span', 'caps-count', String(count)));
      b.addEventListener('click', () => this.go(id));
      nav.append(b);
    };
    if (this.kind === 'mcp') {
      const n = (g: McpGroup) => c.mcp.filter((m) => g === 'all' || mcpGroup(m) === g).length;
      item('all', t('caps.group.all'), n('all'));
      for (const g of ['user', 'repos', 'plugin', 'claude.ai', 'other'] as const) if (g !== 'other' || n(g) > 0) item(g, t(`caps.mcp.group.${g}`), n(g));
      nav.append(h('div', 'caps-nav-sep'));
      item('add', t('caps.mcp.add'));
    } else {
      const n = (g: SkillGroup) => c.skills.filter((s) => g === 'all' || skillGroup(s) === g).length;
      item('all', t('caps.group.all'), n('all'));
      for (const g of ['user', 'repos', 'plugin', 'disabled', 'agents'] as const) item(g, t(`caps.skills.group.${g}`), n(g));
      nav.append(h('div', 'caps-nav-sep'));
      item('plugins', t('caps.plugins'), c.plugins.length);
      item('add', t('caps.skills.add'));
    }

    const body = h('div', 'setup-body');
    const content = h('div', 'setup-content caps-content');
    if (this.view === 'add') {
      if (this.kind === 'mcp') this.mcpForm(content, c);
      else this.skillForm(content);
    } else if (this.view === 'plugins') this.pluginList(content, c.plugins);
    else if (this.kind === 'mcp') this.mcpList(content, c);
    else this.skillList(content, c);
    body.append(content);
    if (this.note) body.append(this.note.tone === 'error' ? errorNote('setup-note', this.note.text, this.note.detail) : h('div', 'setup-note ok', this.note.text));

    const foot = h('div', 'setup-foot');
    foot.append(h('span', 'setup-hint', t('caps.appliesNext')), h('span', 'spacer'));
    const done = h('button', 'btn primary', t('setup.close'));
    done.addEventListener('click', () => this.close());
    foot.append(done);
    body.append(foot);

    // The list keeps its scroll and the search its caret across a redraw.
    const scroll = this.card.querySelector('.caps-list')?.scrollTop ?? 0;
    const focused = document.activeElement instanceof HTMLElement && this.root.contains(document.activeElement) ? document.activeElement.dataset.focus : undefined;
    this.card.replaceChildren(nav, body);
    if (this.card.parentElement !== this.root) this.root.replaceChildren(this.card);
    const list = this.card.querySelector('.caps-list');
    if (list) list.scrollTop = scroll;
    const again = focused ? this.card.querySelector<HTMLElement>(`[data-focus="${focused}"]`) : this.card.querySelector<HTMLElement>('[data-autofocus]');
    again?.focus();
  }

  private go(view: View): void {
    this.view = view;
    this.confirm = '';
    this.note = null;
    this.render();
  }

  private head(el: HTMLElement, title: string, lead: string): void {
    const heading = h('h2', 'setup-title', title);
    heading.id = 'caps-title';
    el.append(heading, h('p', 'setup-lead', lead));
  }

  private button(label: string, cls: string, run: () => void, disabled = false): HTMLButtonElement {
    const b = h('button', cls, label);
    b.disabled = disabled || this.busy;
    b.addEventListener('click', run);
    return b;
  }

  private search(placeholder: string, refill: () => void): HTMLInputElement {
    const i = h('input', 'setup-input caps-search');
    i.type = 'search';
    i.placeholder = placeholder;
    i.value = this.query;
    i.spellcheck = false;
    i.dataset.autofocus = '';
    i.dataset.focus = 'search';
    i.addEventListener('input', () => {
      this.query = i.value;
      refill();
    });
    return i;
  }

  private seg<T extends string>(options: [T, string][], value: T, pick: (v: T) => void): HTMLDivElement {
    const seg = h('div', 'segmented');
    for (const [id, label] of options) {
      const b = h('button', id === value ? 'seg active' : 'seg', label);
      b.addEventListener('click', () => pick(id));
      seg.append(b);
    }
    return seg;
  }

  private reach(reach: Reach, project: string, why = ''): HTMLElement {
    const line = h('span', `caps-reach r-${reach}`);
    line.append(h('span', 'caps-reach-dot'), h('span', '', reach === 'repo' ? t('caps.reach.repo', { repo: folderName(project) }) : why || t(`caps.reach.${reach}`)));
    if (reach === 'repo') line.title = project;
    return line;
  }

  private matches(...words: string[]): boolean {
    const q = this.query.trim().toLowerCase();
    return !q || words.join(' ').toLowerCase().includes(q);
  }

  /** Inline confirmation of a removal, in place of the row's actions. */
  private confirmBox(key: string, text: string, label: string, run: () => void): HTMLElement {
    const box = h('div', 'caps-confirm');
    box.append(h('span', '', text));
    box.append(this.button(t('caps.cancel'), 'btn ghost small', () => {
      this.confirm = '';
      this.render();
    }));
    const go = this.button(label, 'btn danger small', run);
    box.append(go);
    queueMicrotask(() => this.confirm === key && go.focus());
    return box;
  }

  // ---------- MCP ----------

  private mcpList(el: HTMLElement, c: Capabilities): void {
    this.head(el, t(this.view === 'all' ? 'caps.mcp.title' : (`caps.mcp.group.${this.view as McpGroup}` as Key)), t('caps.mcp.lead'));
    const bar = h('div', 'setup-row caps-bar');
    const box = h('div', 'setup-repos caps-list');
    const on = (m: McpEntry) => m.state === 'connected';
    const fill = () => {
      const rows = c.mcp.filter(
        (m) =>
          (this.view === 'all' || mcpGroup(m) === this.view) &&
          (this.stateFilter === 'all' || (this.stateFilter === 'on') === on(m)) &&
          this.matches(m.name, m.target, m.plugin, folderName(m.project)),
      );
      box.replaceChildren(...rows.slice(0, ROWS_MAX).map((m) => this.mcpRow(m)));
      if (rows.length === 0) box.append(h('div', 'setup-hint', t(c.mcp.length === 0 && !c.checkedAt ? 'caps.mcp.none' : 'caps.none')));
    };
    bar.append(
      this.search(t('caps.mcp.search'), fill),
      this.seg<StateFilter>(
        [
          ['all', t('caps.filter.all')],
          ['on', t('caps.filter.on')],
          ['off', t('caps.filter.off')],
        ],
        this.stateFilter,
        (v) => {
          this.stateFilter = v;
          this.render();
        },
      ),
    );
    el.append(bar, this.checkLine(c), box);
    fill();
  }

  /** When the states were checked, and the way to check again (Claude Code starts or calls every server: slow). */
  private checkLine(c: Capabilities): HTMLElement {
    const line = h('div', 'caps-check');
    if (this.checking) {
      line.append(h('span', 'setup-spin'), h('span', '', t('caps.checking')));
    } else if (c.checkError) {
      line.append(errorNote('caps-check-error', t(c.checkError === 'no-claude' ? 'caps.err.noClaude' : 'caps.checkFailed'), ''));
    } else {
      line.append(h('span', '', c.checkedAt ? t('caps.checked', { when: ago(c.checkedAt) }) : t('caps.notChecked')));
    }
    const again = this.button(t('caps.checkAgain'), 'btn ghost small', () => void this.check(), this.checking);
    again.prepend(icon(ICONS.resume));
    line.append(h('span', 'spacer'), again);
    return line;
  }

  private mcpRow(m: McpEntry): HTMLElement {
    const key = `mcp:${m.source}:${m.project}:${m.name}`;
    const row = h('div', 'setup-repo remote caps-row');
    const dot = h('span', `caps-dot st-${m.state}`);
    dot.title = t(`caps.state.${m.state}`);
    const text = h('span', 'setup-repo-text');
    const title = h('span', 'setup-repo-title');
    title.append(h('b', '', m.name));
    if (m.transport) title.append(h('span', 'setup-tag', m.transport));
    title.append(h('span', 'setup-tag', t(`caps.source.${m.source}`)));
    text.append(title);
    if (m.target) text.append(h('code', 'caps-target', m.target));
    const keys = [...m.envKeys, ...m.headerKeys];
    if (keys.length > 0) text.append(h('span', 'caps-sub', t('caps.hidden', { list: keys.join(', ') })));
    text.append(this.reach(m.reach, m.project, m.source === 'plugin' && m.reach === 'nowhere' ? t('caps.reach.pluginOff') : ''));
    if (m.state === 'needs-auth') text.append(h('span', 'caps-help', t(m.source === 'claude.ai' ? 'caps.auth.claudeai' : 'caps.auth.mcp', { name: m.name })));
    if (m.state === 'pending') text.append(h('span', 'caps-help', t('caps.pending')));
    if (m.state === 'failed') text.append(h('span', 'caps-help', t('caps.failed')));
    if (m.source === 'plugin') text.append(h('span', 'caps-sub', t('caps.managed.plugin', { plugin: m.plugin.split('@')[0] })));
    if (m.source === 'claude.ai') text.append(h('span', 'caps-sub', t('caps.managed.claudeai')));
    const side = h('div', 'caps-side');
    side.append(h('span', `caps-state st-${m.state}`, t(`caps.state.${m.state}`)));
    const removable = m.source === 'user' || m.source === 'project' || m.source === 'local';
    if (removable) {
      const del = h('button', 'icon-btn');
      del.title = t('caps.mcp.remove');
      del.setAttribute('aria-label', `${t('caps.mcp.remove')} ${m.name}`);
      del.disabled = this.busy;
      del.append(icon(ICONS.remove));
      del.addEventListener('click', () => {
        this.confirm = key;
        this.render();
      });
      side.append(del);
    }
    row.append(dot, text, side);
    if (this.confirm !== key) return row;
    const wrap = h('div', 'caps-row-wrap');
    const ask = t(m.source === 'project' ? 'caps.mcp.removeAskProject' : 'caps.mcp.removeAsk', { name: m.name, repo: folderName(m.project) });
    wrap.append(
      row,
      this.confirmBox(key, ask, t('caps.mcp.removeYes'), () => void this.act(() => this.hub.removeMcp(m.name, m.source, m.project), t('caps.mcp.removed', { name: m.name }))),
    );
    return wrap;
  }

  private mcpForm(el: HTMLElement, c: Capabilities): void {
    this.head(el, t('caps.mcp.add'), t('caps.mcp.addLead'));
    const d = this.draft;
    const field = (label: string, hint = '') => {
      const f = h('div', 'setup-field');
      f.append(h('div', 'setup-label', label));
      if (hint) f.append(h('div', 'setup-hint', hint));
      el.append(f);
      return f;
    };
    const input = (value: string, placeholder: string, set: (v: string) => void, focus: string) => {
      const i = h('input', 'setup-input');
      i.value = value;
      i.placeholder = placeholder;
      i.spellcheck = false;
      i.dataset.focus = focus;
      i.addEventListener('input', () => set(i.value));
      return i;
    };
    const area = (value: string, placeholder: string, set: (v: string) => void, focus: string) => {
      const a = h('textarea', 'setup-textarea caps-area');
      a.value = value;
      a.placeholder = placeholder;
      a.spellcheck = false;
      a.rows = 3;
      a.dataset.focus = focus;
      a.addEventListener('input', () => set(a.value));
      return a;
    };

    const name = input(d.name, 'my-server', (v) => (d.name = v.trim()), 'name');
    name.dataset.autofocus = '';
    field(t('caps.form.name'), t('caps.form.nameHint')).append(name);

    const scope = field(t('caps.form.scope'));
    scope.append(
      this.seg<McpDraft['scope']>(
        [
          ['user', t('caps.form.scopeUser')],
          ['project', t('caps.form.scopeProject')],
        ],
        d.scope,
        (v) => {
          d.scope = v;
          this.render();
        },
      ),
    );
    if (d.scope === 'project') {
      if (c.repos.length === 0) scope.append(h('div', 'setup-hint warn', t('caps.form.noRepo')));
      else {
        const select = h('select', 'setup-select');
        for (const repo of c.repos) {
          const o = h('option', '', folderName(repo));
          o.value = repo;
          o.title = repo;
          select.append(o);
        }
        if (!c.repos.includes(d.project)) d.project = c.repos[0];
        select.value = d.project;
        select.addEventListener('change', () => (d.project = select.value));
        scope.append(select, h('div', 'setup-hint', t('caps.form.projectHint')));
      }
    }

    field(t('caps.form.type')).append(
      this.seg<McpDraft['transport']>(
        [
          ['stdio', t('caps.form.stdio')],
          ['http', 'HTTP'],
          ['sse', 'SSE'],
        ],
        d.transport,
        (v) => {
          d.transport = v;
          this.render();
        },
      ),
    );
    if (d.transport === 'stdio') {
      field(t('caps.form.command'), t('caps.form.commandHint')).append(input(d.command, 'npx', (v) => (d.command = v), 'command'));
      field(t('caps.form.args'), t('caps.form.argsHint')).append(area(this.argsText, '@playwright/mcp@latest', (v) => (this.argsText = v), 'args'));
      field(t('caps.form.env'), t('caps.form.envHint')).append(area(this.envText, 'API_KEY=…', (v) => (this.envText = v), 'env'));
    } else {
      field(t('caps.form.url')).append(input(d.url, 'https://example.com/mcp', (v) => (d.url = v.trim()), 'url'));
      field(t('caps.form.headers'), t('caps.form.headersHint')).append(area(this.headerText, 'Authorization: Bearer …', (v) => (this.headerText = v), 'headers'));
    }
    const add = this.button(t('caps.form.submit'), 'btn primary', () => void this.submitMcp());
    el.append(add, h('p', 'setup-fine', t('caps.form.secretNote')));
  }

  private async submitMcp(): Promise<void> {
    const d = this.draft;
    const env = pairs(this.envText, '=');
    const headers = pairs(this.headerText, ':');
    if (!env || !headers) {
      this.note = { text: t(env ? 'caps.err.headers' : 'caps.err.env'), tone: 'error' };
      return this.render();
    }
    const draft: McpDraft = {
      ...d,
      args: d.transport === 'stdio' ? lines(this.argsText) : [],
      env: d.transport === 'stdio' ? env : {},
      headers: d.transport === 'stdio' ? {} : headers,
      project: d.scope === 'project' ? d.project : '',
    };
    const ok = await this.act(() => this.hub.addMcp(draft), t('caps.mcp.added', { name: d.name }));
    if (!ok) return;
    this.draft = emptyDraft();
    this.envText = this.headerText = this.argsText = '';
    this.view = 'all';
    this.render();
    void this.check();
  }

  // ---------- skills ----------

  private skillList(el: HTMLElement, c: Capabilities): void {
    this.head(el, t(this.view === 'all' ? 'caps.skills.title' : (`caps.skills.group.${this.view as SkillGroup}` as Key)), t('caps.skills.lead'));
    const bar = h('div', 'setup-row caps-bar');
    const box = h('div', 'setup-repos caps-list');
    const order: SkillGroup[] = ['user', 'repos', 'plugin', 'agents', 'disabled'];
    const fill = () => {
      const rows = c.skills
        .filter((s) => (this.view === 'all' || skillGroup(s) === this.view) && this.matches(s.name, s.description, s.plugin, folderName(s.project)))
        .sort((a, b) => (this.sort === 'source' ? order.indexOf(skillGroup(a)) - order.indexOf(skillGroup(b)) : 0) || a.name.localeCompare(b.name));
      box.replaceChildren(...rows.slice(0, ROWS_MAX).map((s) => this.skillRow(s, c)));
      if (rows.length === 0) box.append(h('div', 'setup-hint', t('caps.none')));
    };
    bar.append(
      this.search(t('caps.skills.search'), fill),
      this.seg<'name' | 'source'>(
        [
          ['name', t('caps.sort.name')],
          ['source', t('caps.sort.source')],
        ],
        this.sort,
        (v) => {
          this.sort = v;
          this.render();
        },
      ),
    );
    el.append(bar, box);
    fill();
  }

  private skillRow(s: SkillEntry, c: Capabilities): HTMLElement {
    const key = `skill:${s.source}:${s.kind}:${s.path}`;
    const row = h('div', 'setup-repo remote caps-row');
    row.title = s.path;
    const text = h('span', 'setup-repo-text');
    const title = h('span', 'setup-repo-title');
    title.append(h('b', '', s.name));
    if (s.kind === 'agent') title.append(h('span', 'setup-tag', t('caps.tag.agent')));
    title.append(h('span', 'setup-tag', s.source === 'project' ? folderName(s.project) : t(`caps.skills.source.${s.source}`)));
    text.append(title);
    if (s.description) text.append(h('span', 'caps-desc', s.description));
    const pluginOff = s.source === 'plugin' && s.reach === 'nowhere';
    text.append(this.reach(s.reach, s.project, pluginOff ? t('caps.reach.pluginOff') : s.source === 'disabled' ? t('caps.reach.disabled') : ''));
    const side = h('div', 'caps-side');
    if (s.source === 'user' || s.source === 'disabled') {
      const off = s.source === 'disabled';
      side.append(
        this.button(t(off ? 'caps.skills.enable' : 'caps.skills.disable'), 'btn ghost small', () =>
          void this.act(() => this.hub.moveSkill(s.kind, s.dir, off), t(off ? 'caps.skills.enabled' : 'caps.skills.disabled', { name: s.name })),
        ),
      );
      const del = h('button', 'icon-btn');
      del.title = t('caps.skills.delete');
      del.setAttribute('aria-label', `${t('caps.skills.delete')} ${s.name}`);
      del.disabled = this.busy;
      del.append(icon(ICONS.remove));
      del.addEventListener('click', () => {
        this.confirm = key;
        this.render();
      });
      side.append(del);
    } else if (s.source === 'plugin') {
      const plugin = c.plugins.find((p) => p.id === s.plugin);
      if (plugin) side.append(this.button(t('caps.skills.seePlugin'), 'btn ghost small', () => this.go('plugins')));
    }
    row.append(text, side);
    if (this.confirm !== key) return row;
    const wrap = h('div', 'caps-row-wrap');
    wrap.append(
      row,
      this.confirmBox(key, t(s.kind === 'agent' ? 'caps.skills.deleteAskAgent' : 'caps.skills.deleteAsk', { name: s.name }), t('caps.skills.deleteYes'), () =>
        void this.act(() => this.hub.deleteSkill(s.kind, s.dir, s.source === 'disabled'), t('caps.skills.deleted', { name: s.name })),
      ),
    );
    return wrap;
  }

  private pluginList(el: HTMLElement, plugins: PluginEntry[]): void {
    this.head(el, t('caps.plugins'), t('caps.plugins.lead'));
    const box = h('div', 'setup-repos caps-list');
    for (const p of [...plugins].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name))) {
      const row = h('label', 'setup-repo caps-row');
      row.title = p.id;
      const check = h('input');
      check.type = 'checkbox';
      check.checked = p.enabled;
      check.disabled = this.busy;
      check.addEventListener('change', () => void this.act(() => this.hub.setPlugin(p.id, check.checked), t(check.checked ? 'caps.plugins.on' : 'caps.plugins.off', { name: p.name })));
      const text = h('span', 'setup-repo-text');
      const title = h('span', 'setup-repo-title');
      title.append(h('b', '', p.name), h('span', 'setup-tag', p.id.split('@')[1] ?? ''));
      const parts = [tn('caps.plugins.skills', p.skills), ...(p.mcp > 0 ? [tn('caps.plugins.servers', p.mcp)] : [])];
      text.append(title, h('span', 'caps-sub', parts.join(', ')));
      text.append(this.reach(p.enabled ? 'everywhere' : 'nowhere', '', p.enabled ? '' : t('caps.reach.pluginOff')));
      row.append(check, text);
      box.append(row);
    }
    if (plugins.length === 0) box.append(h('div', 'setup-hint', t('caps.plugins.none')));
    el.append(box);
  }

  private skillForm(el: HTMLElement): void {
    this.head(el, t('caps.skills.add'), t('caps.skills.addLead'));
    const gh = h('div', 'setup-field');
    gh.append(h('div', 'setup-label', t('caps.github')), h('div', 'setup-hint', t('caps.github.hint')));
    const url = h('input', 'setup-input');
    url.placeholder = 'https://github.com/owner/repo';
    url.value = this.githubUrl;
    url.spellcheck = false;
    url.dataset.autofocus = '';
    url.dataset.focus = 'gh-url';
    url.addEventListener('input', () => (this.githubUrl = url.value.trim()));
    const skill = h('input', 'setup-input caps-skill-name');
    skill.placeholder = t('caps.github.skill');
    skill.value = this.githubSkill;
    skill.spellcheck = false;
    skill.dataset.focus = 'gh-skill';
    skill.addEventListener('input', () => (this.githubSkill = skill.value.trim()));
    const row = h('div', 'setup-row');
    const install = this.button(this.busy ? t('caps.github.installing') : t('caps.github.install'), 'btn primary', () =>
      void this.act(() => this.hub.githubSkill(this.githubUrl, this.githubSkill), t('caps.github.installed', { name: this.githubSkill })).then((ok) => {
        if (!ok) return;
        this.githubUrl = this.githubSkill = '';
        this.render();
      }),
    );
    row.append(url, skill, install);
    gh.append(row);

    const paste = h('div', 'setup-field');
    paste.append(h('div', 'setup-label', t('caps.paste')), h('div', 'setup-hint', t('caps.paste.hint')));
    const area = h('textarea', 'setup-textarea caps-area caps-paste');
    area.rows = 9;
    area.spellcheck = false;
    area.placeholder = '---\nname: my-skill\ndescription: What it does, and when to use it.\n---\n\n# My skill\n…';
    area.value = this.pasted;
    area.dataset.focus = 'paste';
    area.addEventListener('input', () => (this.pasted = area.value));
    const create = this.button(t('caps.paste.create'), 'btn primary', () =>
      void this.act(() => this.hub.pasteSkill(this.pasted), t('caps.paste.created')).then((ok) => {
        if (!ok) return;
        this.pasted = '';
        this.render();
      }),
    );
    paste.append(area, create);
    el.append(gh, paste);
  }
}

function emptyDraft(): McpDraft {
  return { name: '', scope: 'user', project: '', transport: 'stdio', command: '', args: [], url: '', env: {}, headers: {} };
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

function ago(at: number): string {
  const min = Math.round((Date.now() - at) / 60_000);
  if (min < 1) return t('caps.justNow');
  if (min < 60) return tn('caps.minutes', min);
  return tn('caps.hours', Math.round(min / 60));
}

