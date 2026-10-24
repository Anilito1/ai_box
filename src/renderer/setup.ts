import { LANG_NAMES, LANGS } from '../shared/i18n';
import {
  APP_NAME,
  EFFORTS,
  type ClaudeStatus,
  type Effort,
  type FoundRepo,
  type GithubDevice,
  type GithubRepo,
  type HubApi,
  type HubSettings,
  type Mode,
  type ModelOption,
  type Provider,
  type SettingsPatch,
  type SettingsView,
} from '../shared/types';
import { copyButton, h, icon, ICONS } from './dom';
import { effortLabel, t, type Key } from './i18n';

type Section = 'general' | 'claude' | 'github' | 'workspace' | 'repos' | 'sessions' | 'about';
type Kind = 'onboarding' | 'settings';
type Resume = { mode: Kind; section: Section };
/** One repo of the picker: local (path), on GitHub only (slug, no path), or both. */
type Row = { name: string; path: string; slug: string; detail: string; private: boolean; pushedAt: number };

const STEPS: Section[] = ['general', 'claude', 'github', 'workspace', 'repos', 'sessions'];
const SECTIONS: Section[] = [...STEPS, 'about'];
const HUB_MODES: (Mode | '')[] = ['', 'default', 'acceptEdits', 'auto', 'bypassPermissions'];
const PROVIDER_OPTIONS: Provider[] = ['claude-code', 'api-key', 'bedrock', 'vertex'];
const MODEL_ALIASES = ['opus', 'sonnet', 'haiku'];
const MAIN_REPOS_MAX = 12;
/** Survives the reload a language change triggers, so the setup reopens where it was. */
const RESUME_KEY = 'setupResume';
/** Step of an unfinished first run, kept across restarts. */
const STEP_KEY = 'setupStep';

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not kept: the first run restarts at its first step.
  }
}
function forget(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing kept.
  }
}
function stepReached(): Section {
  try {
    const step = localStorage.getItem(STEP_KEY) as Section | null;
    return step && STEPS.includes(step) ? step : 'general';
  } catch {
    return 'general';
  }
}

const INSTALL = {
  win32: 'irm https://claude.ai/install.ps1 | iex',
  other: 'curl -fsSL https://claude.ai/install.sh | bash',
};

/** First-run setup (steps, no way out before the end) and the settings screen (same sections, free navigation). */
export class SetupView {
  private readonly root = document.getElementById('setup') as HTMLDivElement;
  private mode: Kind = 'settings';
  private section: Section = 'general';
  private view: SettingsView | null = null;
  private claude: ClaudeStatus | null = null;
  private checkingClaude = false;
  private ghUser: string | null = null;
  private found: FoundRepo[] | null = null;
  private scanned = false;
  private ghRepos: GithubRepo[] | null = null;
  private repoFilter = '';
  private cloning = '';
  /** Result of checking the saved GitHub sign-in: null = not checked, '' = checking, 'ok' or an error code. */
  private githubHealth: string | null = null;
  /** "Allow everything" picked, waiting for the explicit confirmation shown under it. */
  private confirmBypass = false;
  /** API key typed but not saved yet: kept across re-renders so a failed check can be retried. */
  private keyDraft = '';
  /** Settings typed but not saved yet (see flush). */
  private pending: SettingsPatch = {};
  /** Focused before the dialog opened: it gets the focus back. */
  private returnFocus: HTMLElement | null = null;
  /** Start pressed while Claude has no access yet: the next press starts anyway. */
  private startAnyway = false;
  private device: GithubDevice | null = null;
  private note: { text: string; tone: 'ok' | 'error' } | null = null;
  private busy = false;

  constructor(
    private readonly hub: HubApi,
    private readonly models: () => ModelOption[],
  ) {
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-labelledby', 'setup-title');
    document.addEventListener('keydown', (e) => {
      if (this.root.hidden) return;
      if (e.key === 'Escape' && this.mode === 'settings') void this.close();
      else if (e.key === 'Tab') this.trapFocus(e);
    });
  }

  /** Tab cycles through the dialog's own controls only. */
  private trapFocus(e: KeyboardEvent): void {
    const items = [...this.root.querySelectorAll<HTMLElement>('button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')].filter(
      (el) => !(el as HTMLButtonElement).disabled && el.offsetParent !== null,
    );
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const inside = this.root.contains(document.activeElement);
    if (e.shiftKey && (document.activeElement === first || !inside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
      e.preventDefault();
      first.focus();
    }
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** Reopens the setup a language change reloaded the page in the middle of; false when there was none. */
  resume(): boolean {
    let saved: Resume | null = null;
    try {
      saved = JSON.parse(sessionStorage.getItem(RESUME_KEY) ?? 'null') as Resume | null;
      sessionStorage.removeItem(RESUME_KEY);
    } catch {
      // Storage unavailable: start over.
    }
    if (!saved) return false;
    void this.open(saved.mode, saved.section);
    return true;
  }

  async open(mode: Kind, section?: Section): Promise<void> {
    this.mode = mode;
    // A first run interrupted by a restart picks up at the step it reached.
    this.section = section ?? (mode === 'onboarding' ? stepReached() : 'general');
    this.note = null;
    this.view = await this.hub.getSettings();
    if (this.root.hidden) this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.root.hidden = false;
    this.render();
  }

  /** Saves what was typed first: a refused value keeps the dialog open with its message. */
  async close(): Promise<void> {
    if (!(await this.flush(false))) return;
    if (this.device) this.hub.githubCancel();
    this.device = null;
    this.root.hidden = true;
    this.root.replaceChildren();
    this.returnFocus?.focus();
    this.returnFocus = null;
  }

  /** Typed values wait here until their field loses focus, the section changes or the dialog closes. */
  private stage(patch: SettingsPatch): void {
    this.pending = { ...this.pending, ...patch, ...(patch.github ? { github: { ...this.pending.github, ...patch.github } } : {}) };
  }

  /** Saves what was typed; `redraw` once the user has left the field (a redraw would steal the caret). */
  private async flush(redraw: boolean): Promise<boolean> {
    const patch = this.pending;
    this.pending = {};
    if (Object.keys(patch).length === 0) return true;
    const r = await this.hub.saveSettings(patch);
    this.view = r;
    if (!r.ok) this.note = { text: t('setup.invalid'), tone: 'error' };
    if (redraw || !r.ok) this.render();
    return r.ok;
  }

  // ---------- frame ----------

  private render(): void {
    const v = this.view;
    if (!v) return;
    const sections = this.mode === 'onboarding' ? STEPS : SECTIONS;
    const nav = h('nav', 'setup-nav');
    nav.append(h('div', 'setup-nav-title', this.mode === 'onboarding' ? t('setup.firstRun') : t('side.settings')));
    sections.forEach((id, i) => {
      const item = h('button', `setup-nav-item${id === this.section ? ' active' : ''}`);
      if (this.mode === 'onboarding') item.append(h('span', 'setup-step-num', String(i + 1)));
      item.append(h('span', '', t(`setup.nav.${id}` as Key)));
      item.addEventListener('click', () => this.go(id));
      nav.append(item);
    });

    const body = h('div', 'setup-body');
    const content = h('div', 'setup-content');
    this.sectionBody(content, v);
    body.append(content);
    if (this.note) body.append(h('div', `setup-note ${this.note.tone}`, this.note.text));

    const foot = h('div', 'setup-foot');
    if (this.mode === 'onboarding') {
      const index = STEPS.indexOf(this.section);
      if (index > 0) foot.append(this.button(t('setup.back'), 'btn ghost', () => this.go(STEPS[index - 1])));
      foot.append(h('span', 'spacer'));
      if (index < STEPS.length - 1) foot.append(this.button(t('setup.next'), 'btn primary', () => this.go(STEPS[index + 1])));
      else foot.append(this.button(this.startAnyway ? t('setup.finish.anyway') : t('setup.finish'), 'btn primary', () => void this.finish()));
    } else {
      foot.append(h('span', 'setup-hint', t('setup.appliesNext')), h('span', 'spacer'));
      foot.append(this.button(t('setup.restart'), 'btn ghost', () => this.hub.relaunch()));
      foot.append(this.button(t('setup.close'), 'btn primary', () => void this.close()));
    }
    body.append(foot);

    const card = h('div', 'setup-card');
    card.append(nav, body);
    this.root.replaceChildren(card);
    content.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }

  private go(section: Section): void {
    void this.flush(false);
    if (this.device) this.hub.githubCancel();
    this.device = null;
    this.confirmBypass = false;
    this.startAnyway = false;
    this.section = section;
    this.note = null;
    if (this.mode === 'onboarding') remember(STEP_KEY, section);
    this.render();
  }

  /**
   * The master needs Claude: without Claude Code the start is refused and the Claude step shown; without access
   * yet, a first press explains, a second one starts anyway.
   */
  private async finish(): Promise<void> {
    if (!(await this.flush(false))) return;
    if (!this.claude) await this.checkClaude();
    const c = this.claude;
    if (!c?.executable) {
      this.section = 'claude';
      this.note = { text: t('setup.finish.noClaude'), tone: 'error' };
      return this.render();
    }
    const s = this.view?.settings;
    const external = s?.provider === 'bedrock' || s?.provider === 'vertex';
    const noKey = s?.provider === 'api-key' && !this.view?.apiKeySet;
    if (!this.startAnyway && (noKey || (!external && c.account?.ready !== true))) {
      this.startAnyway = true;
      this.note = { text: t('setup.finish.noAccess'), tone: 'error' };
      return this.render();
    }
    await this.hub.finishSetup();
    forget(STEP_KEY);
    await this.close();
  }

  private sectionBody(el: HTMLElement, v: SettingsView): void {
    switch (this.section) {
      case 'general':
        return this.general(el, v);
      case 'claude':
        return this.claudeSection(el, v);
      case 'github':
        return this.github(el, v);
      case 'workspace':
        return this.workspace(el, v.settings);
      case 'repos':
        return this.repos(el, v);
      case 'sessions':
        return this.sessions(el, v.settings);
      case 'about':
        return this.about(el, v);
    }
  }

  // ---------- helpers ----------

  private button(label: string, cls: string, run: () => void, disabled = false): HTMLButtonElement {
    const b = h('button', cls, label);
    b.disabled = disabled || this.busy;
    b.addEventListener('click', run);
    return b;
  }

  private head(el: HTMLElement, title: string, lead: string): void {
    const heading = h('h2', 'setup-title', title);
    heading.id = 'setup-title';
    el.append(heading, h('p', 'setup-lead', lead));
  }

  private field(label: string, hint = ''): HTMLDivElement {
    const f = h('div', 'setup-field');
    f.append(h('div', 'setup-label', label));
    if (hint) f.append(h('div', 'setup-hint', hint));
    return f;
  }

  private input(value: string, placeholder: string, type = 'text'): HTMLInputElement {
    const i = h('input', 'setup-input');
    i.type = type;
    i.value = value;
    i.placeholder = placeholder;
    i.spellcheck = false;
    return i;
  }

  private choice(name: string, checked: boolean, title: string, hint: string, onPick: () => void, danger = false): HTMLLabelElement {
    const row = h('label', `setup-choice${checked ? ' checked' : ''}${danger ? ' danger' : ''}`);
    const radio = h('input');
    radio.type = 'radio';
    radio.name = name;
    radio.checked = checked;
    radio.addEventListener('change', () => radio.checked && onPick());
    const text = h('span', 'setup-choice-text');
    text.append(h('span', 'setup-choice-title', title));
    if (hint) text.append(h('span', 'setup-choice-hint', hint));
    row.append(radio, text);
    return row;
  }

  private link(label: string, url: string): HTMLButtonElement {
    const a = h('button', 'setup-link', label);
    a.addEventListener('click', () => this.hub.openExternal(url));
    return a;
  }

  private command(text: string): HTMLDivElement {
    const row = h('div', 'setup-cmd');
    row.append(h('code', '', text), copyButton(() => text));
    return row;
  }

  private flash(text: string, tone: 'ok' | 'error'): void {
    this.note = { text, tone };
  }

  private async run<T>(task: () => Promise<T>): Promise<T> {
    this.busy = true;
    this.render();
    try {
      return await task();
    } finally {
      this.busy = false;
    }
  }

  private async save(patch: SettingsPatch): Promise<void> {
    const r = await this.run(() => this.hub.saveSettings(patch));
    this.view = r;
    this.note = r.ok ? null : { text: t('setup.invalid'), tone: 'error' };
    this.render();
  }

  /** Error codes of the main process, explained; anything else (a git message) is shown as is. */
  private errorText(code: string, context: 'key' | 'github' | 'pat' = 'github'): string {
    const known: Record<string, Key> = {
      format: 'setup.err.format',
      unauthorized: context === 'key' ? 'setup.err.invalidKey' : context === 'pat' ? 'setup.err.patRefused' : 'setup.err.githubToken',
      forbidden: context === 'key' ? 'setup.err.invalidKey' : 'setup.err.forbidden',
      'rate-limited': 'setup.err.rateLimited',
      network: 'setup.err.network',
      'no-keychain': 'setup.err.keychain',
      'no-client-id': 'setup.err.clientId',
      client_id: 'setup.err.badClientId',
      device_flow_disabled: 'setup.err.deviceFlowDisabled',
      'gh-signed-out': 'setup.err.gh',
      'clone-denied': 'setup.err.cloneDenied',
      'not-connected': 'setup.repos.connect',
      expired: 'setup.err.expired',
      access_denied: 'setup.err.denied',
      cancelled: 'setup.err.cancelled',
    };
    if (known[code]) return t(known[code]);
    if (/^http-\d+$/.test(code)) return t('setup.err.http', { status: code.slice(5) });
    // A code nobody explained (an API's error name) is not shown as is; a sentence (git's own message) is.
    return /^[\w.-]+$/.test(code) ? t('setup.err.unexpected') : code;
  }

  // ---------- sections ----------

  private general(el: HTMLElement, v: SettingsView): void {
    if (this.mode === 'onboarding') this.head(el, t('setup.welcome'), t('setup.welcome.lead'));
    else this.head(el, t('setup.nav.general'), t('setup.general.lead'));
    const f = this.field(t('setup.language'));
    const seg = h('div', 'segmented setup-seg');
    for (const lang of LANGS) {
      const b = h('button', lang === v.settings.language ? 'seg active' : 'seg', LANG_NAMES[lang]);
      b.addEventListener('click', () => {
        if (lang === v.settings.language) return;
        try {
          sessionStorage.setItem(RESUME_KEY, JSON.stringify({ mode: this.mode, section: this.section }));
        } catch {
          // The setup starts over after the reload.
        }
        void this.save({ language: lang });
      });
      seg.append(b);
    }
    f.append(seg);
    el.append(f);
    if (this.mode === 'onboarding') {
      const list = h('ul', 'setup-list');
      for (const key of ['setup.welcome.p1', 'setup.welcome.p2', 'setup.welcome.p3'] as const) list.append(h('li', '', t(key)));
      el.append(list);
    }
  }

  private claudeSection(el: HTMLElement, v: SettingsView): void {
    const s = v.settings;
    this.head(el, t('setup.claude.title'), t('setup.claude.lead'));
    if (!this.claude && !this.checkingClaude) void this.checkClaude();

    const status = h('div', 'setup-status');
    const c = this.claude;
    if (this.checkingClaude || !c) {
      status.append(h('span', 'setup-spin'), h('span', '', t('setup.claude.checking')));
    } else if (!c.executable) {
      status.classList.add('error');
      status.append(h('b', '', t('setup.claude.notFound')));
    } else if (s.provider === 'bedrock' || s.provider === 'vertex') {
      status.append(icon(ICONS.check), h('b', '', t('setup.claude.external')), h('span', 'setup-status-path', c.executable));
    } else if (s.provider === 'api-key' && !v.apiKeySet) {
      // Without a key Claude Code would fall back to its own sign-in: the choice is not complete yet.
      status.classList.add('warn');
      status.append(icon(ICONS.shield), h('b', '', t('setup.claude.needKey')), h('span', 'setup-status-path', c.executable));
    } else {
      const ready = c.account?.ready === true;
      status.classList.add(ready ? 'ok' : 'warn');
      const who = c.account
        ? [c.account.email, c.account.plan, c.account.provider !== 'firstParty' ? c.account.provider : '', c.account.source].filter(Boolean).join(' · ')
        : c.error === 'timeout'
          ? t('setup.claude.timeout')
          : c.error
            ? t('setup.claude.probeFailed')
            : '';
      status.append(icon(ready ? ICONS.check : ICONS.shield), h('b', '', ready ? t('setup.claude.ready') : t('setup.claude.noAccess')));
      if (who) status.append(h('span', 'setup-status-detail', who));
      status.append(h('span', 'setup-status-path', c.executable));
    }
    status.append(this.button(t('setup.check'), 'btn ghost small', () => void this.checkClaude(), this.checkingClaude));
    el.append(status);

    const options = h('div', 'setup-choices');
    for (const p of PROVIDER_OPTIONS) {
      options.append(this.choice('provider', s.provider === p, t(`setup.provider.${p}` as Key), t(`setup.provider.${p}.hint` as Key), () => void this.pickProvider(p)));
    }
    el.append(options);

    if (s.provider === 'api-key') {
      const f = this.field(t('setup.apiKey'), v.secureStorage ? t('setup.apiKey.hint') : t('setup.err.keychain'));
      const row = h('div', 'setup-row');
      if (v.apiKeySet) {
        row.append(h('span', 'setup-pill ok', t('setup.apiKey.saved')), this.button(t('setup.remove'), 'btn ghost', () => void this.setApiKey(null)));
      } else {
        const input = this.input(this.keyDraft, 'sk-ant-…', 'password');
        input.dataset.autofocus = '';
        input.addEventListener('input', () => (this.keyDraft = input.value));
        const save = () => void this.setApiKey(input.value);
        input.addEventListener('keydown', (e) => e.key === 'Enter' && save());
        row.append(input, this.button(t('setup.verifySave'), 'btn primary', save, !v.secureStorage));
      }
      f.append(row, this.link(t('setup.apiKey.console'), 'https://console.anthropic.com/settings/keys'));
      el.append(f);
    } else if (s.provider === 'bedrock' || s.provider === 'vertex') {
      const bedrock = s.provider === 'bedrock';
      const f = this.field(t(bedrock ? 'setup.bedrock' : 'setup.vertex'), t(bedrock ? 'setup.bedrock.hint' : 'setup.vertex.hint'));
      // What was typed but not saved yet survives a redraw (the Claude check redraws when it ends).
      const b = { ...s.bedrock, ...this.pending.bedrock };
      const x = { ...s.vertex, ...this.pending.vertex };
      const region = this.input(bedrock ? b.region : x.region, bedrock ? 'us-east-1' : 'us-east5');
      const other = this.input(bedrock ? b.profile : x.projectId, bedrock ? t('setup.bedrock.profile') : t('setup.vertex.project'));
      const stage = () =>
        this.stage(
          bedrock
            ? { bedrock: { region: region.value.trim(), profile: other.value.trim() } }
            : { vertex: { region: region.value.trim(), projectId: other.value.trim() } },
        );
      for (const input of [region, other]) {
        input.addEventListener('input', stage);
        input.addEventListener('change', () => void this.flush(true));
      }
      const row = h('div', 'setup-row');
      row.append(region, other);
      f.append(row);
      el.append(f);
    }

    if (c && (!c.executable || (s.provider === 'claude-code' && !c.account?.ready))) {
      const guide = h('div', 'setup-guide');
      guide.append(h('div', 'setup-label', c.executable ? t('setup.claude.signIn') : t('setup.claude.install')));
      if (!c.executable) {
        guide.append(this.command(v.platform === 'win32' ? INSTALL.win32 : INSTALL.other));
        guide.append(h('div', 'setup-hint', t('setup.claude.thenSignIn')));
      } else {
        guide.append(this.command('claude'), h('div', 'setup-hint', t('setup.claude.signInHint')));
      }
      guide.append(this.link(t('setup.claude.docs'), 'https://code.claude.com/docs/en/setup'));
      el.append(guide);
    }
    el.append(h('p', 'setup-fine', t('setup.claude.policy')));
  }

  private async checkClaude(): Promise<void> {
    this.checkingClaude = true;
    this.render();
    try {
      this.claude = await this.hub.checkClaude();
    } finally {
      this.checkingClaude = false;
      this.render();
    }
  }

  private async pickProvider(p: Provider): Promise<void> {
    await this.save({ provider: p });
    await this.checkClaude();
  }

  private async setApiKey(key: string | null): Promise<void> {
    const r = await this.run(() => this.hub.setApiKey(key === null ? null : key.trim()));
    this.view = r;
    if (r.ok) this.keyDraft = '';
    this.flash(r.ok ? t(key === null ? 'setup.apiKey.removed' : 'setup.apiKey.ok') : this.errorText(r.error, 'key'), r.ok ? 'ok' : 'error');
    if (r.ok) await this.checkClaude();
    else this.render();
  }

  private github(el: HTMLElement, v: SettingsView): void {
    const g = v.settings.github;
    this.head(el, t('setup.github.title'), t('setup.github.lead'));
    if (this.ghUser === null) {
      this.ghUser = '';
      void this.hub.ghLogin().then((login) => {
        this.ghUser = login;
        this.render();
      });
    }

    if (g.source !== 'none' && this.githubHealth === null) {
      this.githubHealth = '';
      void this.hub.githubCheck().then((r) => {
        this.githubHealth = r.ok ? 'ok' : r.error;
        this.render();
      });
    }
    const broken = g.source !== 'none' && this.githubHealth !== '' && this.githubHealth !== 'ok' && this.githubHealth !== null;
    const status = h('div', `setup-status ${g.source === 'none' ? '' : broken ? 'warn' : 'ok'}`);
    if (g.source === 'none') {
      status.append(h('b', '', t('setup.github.none')));
    } else {
      status.append(
        icon(broken ? ICONS.shield : ICONS.check),
        h('b', '', broken ? t('setup.github.signedOut', { login: g.login }) : t('setup.github.connected', { login: g.login })),
        h('span', 'setup-status-detail', t(`setup.github.via.${g.source}` as Key)),
      );
      status.append(this.button(t('setup.github.disconnect'), 'btn ghost small', () => void this.disconnect()));
      // The heading already says the sign-in stopped working: this line says why.
      if (broken) status.append(h('span', 'setup-status-problem', this.errorText(this.githubHealth ?? '')));
    }
    el.append(status);

    if (this.device) {
      const box = h('div', 'setup-device');
      box.append(h('div', 'setup-hint', t('setup.github.enterCode')));
      const code = h('div', 'setup-code');
      code.append(h('span', '', this.device.userCode), copyButton(() => this.device?.userCode ?? ''));
      const url = this.device.verificationUri;
      box.append(code, h('div', 'setup-row'));
      (box.lastChild as HTMLElement).append(
        this.button(t('setup.github.openGithub'), 'btn primary', () => this.hub.openExternal(url)),
        this.button(t('setup.cancel'), 'btn ghost', () => {
          this.hub.githubCancel();
          this.device = null;
          this.render();
        }),
      );
      box.append(h('div', 'setup-wait', t('setup.github.waiting')));
      el.append(box);
      return;
    }

    const clientId = g.clientId || (v.defaultClientId ? 'default' : '');
    const options = h('div', 'setup-options');
    // A working sign-in keeps the other ways folded away.
    const healthy = g.source !== 'none' && !broken;
    const other = h('details', 'setup-advanced');
    other.append(h('summary', '', t('setup.github.other')));
    const device = h('div', 'setup-option');
    device.append(h('div', 'setup-choice-title', t('setup.github.device')), h('div', 'setup-choice-hint', t('setup.github.device.hint')));
    if (clientId) device.append(this.button(t('setup.github.signIn'), 'btn primary', () => void this.startDevice(), !v.secureStorage));
    else device.append(this.clientIdField(g.clientId, v.defaultClientId));
    if (clientId) options.append(device);

    const gh = h('div', 'setup-option');
    gh.append(h('div', 'setup-choice-title', t('setup.github.gh')), h('div', 'setup-choice-hint', this.ghUser ? t('setup.github.gh.found', { login: this.ghUser }) : t('setup.github.gh.hint')));
    gh.append(this.button(t('setup.github.useGh'), 'btn', () => void this.githubResult(this.hub.githubUseGh()), !this.ghUser));
    options.append(gh);

    const pat = h('div', 'setup-option');
    pat.append(h('div', 'setup-choice-title', t('setup.github.token')), h('div', 'setup-choice-hint', t('setup.github.token.hint')));
    const tokenInput = this.input('', 'github_pat_… / ghp_…', 'password');
    const row = h('div', 'setup-row');
    row.append(tokenInput, this.button(t('setup.verifySave'), 'btn', () => void this.githubResult(this.hub.githubUseToken(tokenInput.value.trim()), 'pat'), !v.secureStorage));
    pat.append(row);
    options.append(pat);
    if (!clientId) options.append(device);
    if (healthy) {
      other.append(options);
      el.append(other);
    } else {
      el.append(options);
    }

    const share = h('label', 'setup-toggle');
    const box = h('input');
    box.type = 'checkbox';
    box.checked = g.shareWithSessions;
    box.addEventListener('change', () => void this.save({ github: { shareWithSessions: box.checked } }));
    const text = h('span', 'setup-choice-text');
    text.append(h('span', 'setup-choice-title', t('setup.github.share')), h('span', 'setup-choice-hint', t('setup.github.share.hint')));
    share.append(box, text);
    el.append(share);

    // With a Client ID set, changing it stays possible under Advanced.
    if (clientId) {
      const adv = h('details', 'setup-advanced');
      adv.append(h('summary', '', t('setup.github.advanced')), this.clientIdField(g.clientId, v.defaultClientId));
      el.append(adv);
    }
  }

  /** The OAuth App's Client ID, saved when the field is left. */
  private clientIdField(value: string, hasDefault: boolean): HTMLElement {
    const f = this.field(t('setup.github.clientId'), t('setup.github.clientId.hint'));
    const input = this.input(this.pending.github?.clientId ?? value, hasDefault ? t('setup.github.clientId.default') : 'Ov23li…');
    input.addEventListener('input', () => this.stage({ github: { clientId: input.value.trim() } }));
    input.addEventListener('change', () => void this.flush(true));
    f.append(input, this.link(t('setup.github.clientId.how'), 'https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app'));
    return f;
  }

  private async startDevice(): Promise<void> {
    const r = await this.run(() => this.hub.githubDeviceStart());
    if (!r.ok) {
      this.flash(this.errorText(r.error), 'error');
      this.render();
      return;
    }
    const flow = (this.device = r);
    this.note = null;
    this.render();
    this.hub.openExternal(r.verificationUri);
    const done = await this.hub.githubDeviceWait();
    if (this.device !== flow) return; // Cancelled, or replaced by a newer sign-in, meanwhile.
    this.device = null;
    this.view = done;
    this.ghRepos = null;
    this.githubHealth = null;
    this.flash(done.ok ? t('setup.github.ok', { login: done.settings.github.login }) : this.errorText(done.error), done.ok ? 'ok' : 'error');
    this.render();
  }

  private async githubResult(task: Promise<SettingsView & { ok: boolean; error: string }>, context: 'github' | 'pat' = 'github'): Promise<void> {
    const r = await this.run(() => task);
    this.view = r;
    this.ghRepos = null;
    this.githubHealth = null;
    this.flash(r.ok ? t('setup.github.ok', { login: r.settings.github.login }) : this.errorText(r.error, context), r.ok ? 'ok' : 'error');
    this.render();
  }

  private async disconnect(): Promise<void> {
    this.view = await this.run(() => this.hub.githubDisconnect());
    this.ghRepos = null;
    this.githubHealth = null;
    this.flash(t('setup.github.disconnected'), 'ok');
    this.render();
  }

  private workspace(el: HTMLElement, s: HubSettings): void {
    this.head(el, t('setup.workspace.title'), t('setup.workspace.lead'));
    const f = this.field(t('setup.workspace.folders'), t('setup.workspace.folders.hint'));
    const list = h('div', 'setup-folders');
    s.workspaces.forEach((dir, i) => {
      const row = h('div', 'setup-folder');
      row.append(h('span', 'setup-folder-path', dir));
      if (i === 0) row.append(h('span', 'setup-pill', t('setup.workspace.masterHere')));
      else row.append(this.button(t('setup.workspace.makeFirst'), 'btn ghost small', () => void this.setFolders([dir, ...s.workspaces.filter((d) => d !== dir)])));
      if (s.workspaces.length > 1) {
        const remove = h('button', 'icon-btn');
        remove.title = t('setup.remove');
        remove.append(icon(ICONS.remove));
        remove.addEventListener('click', () => void this.setFolders(s.workspaces.filter((d) => d !== dir)));
        row.append(remove);
      }
      list.append(row);
    });
    f.append(
      list,
      this.button(t('setup.workspace.add'), 'btn', async () => {
        const dir = await this.hub.pickFolder();
        if (dir && !s.workspaces.includes(dir)) void this.setFolders([...s.workspaces, dir]);
      }),
    );
    el.append(f);
  }

  private async setFolders(workspaces: string[]): Promise<void> {
    await this.save({ workspaces });
    this.found = null;
    this.render();
  }

  /** Local repos of the working folders and repos of the GitHub account, one row per repo; nothing is picked for the user. */
  private repos(el: HTMLElement, v: SettingsView): void {
    const s = v.settings;
    const connected = s.github.source !== 'none';
    this.head(el, t('setup.repos.title'), t('setup.repos.lead', { max: MAIN_REPOS_MAX }));
    if (this.found === null) {
      this.found = [];
      void this.hub.scanRepos(s.workspaces).then((repos) => {
        this.found = repos;
        this.scanned = true;
        this.render();
      });
    }
    if (connected && this.ghRepos === null) {
      this.ghRepos = [];
      void this.hub.githubRepos().then((r) => {
        this.ghRepos = r.repos;
        if (!r.ok) this.flash(this.errorText(r.error), 'error');
        this.render();
      });
    }

    const slugOf = (remote: string) => /^github\.com\/(.+\/.+)$/i.exec(remote)?.[1].toLowerCase() ?? '';
    const pinned = new Set(s.mainRepos);
    const local = new Map<string, Row>();
    // Pinned repos stay listed even when they sit outside the working folders.
    for (const p of s.mainRepos) local.set(p, { name: p.split(/[\\/]/).pop() ?? p, path: p, slug: '', detail: p, private: false, pushedAt: 0 });
    for (const r of this.found ?? []) local.set(r.path, { name: r.name, path: r.path, slug: slugOf(r.remote), detail: r.remote || r.path, private: false, pushedAt: 0 });
    const bySlug = new Map([...local.values()].filter((r) => r.slug).map((r) => [r.slug, r]));
    const remoteOnly: Row[] = [];
    for (const g of this.ghRepos ?? []) {
      const mine = bySlug.get(g.slug.toLowerCase());
      if (mine) Object.assign(mine, { private: g.private, pushedAt: g.pushedAt, detail: g.slug });
      else remoteOnly.push({ name: g.slug.split('/')[1], path: '', slug: g.slug, detail: g.description || g.slug, private: g.private, pushedAt: g.pushedAt });
    }
    const rows = [
      ...[...local.values()].sort((a, b) => Number(pinned.has(b.path)) - Number(pinned.has(a.path)) || b.pushedAt - a.pushedAt),
      ...remoteOnly.sort((a, b) => b.pushedAt - a.pushedAt),
    ];

    const bar = h('div', 'setup-row setup-repos-bar');
    const search = this.input(this.repoFilter, t('setup.repos.search'));
    search.dataset.autofocus = '';
    const count = h('span', 'setup-hint', t('setup.repos.count', { n: pinned.size, max: MAIN_REPOS_MAX }));
    bar.append(search, count);
    el.append(bar);

    const box = h('div', 'setup-repos');
    const fill = () => {
      const q = this.repoFilter.trim().toLowerCase();
      const shown = rows.filter((r) => !q || `${r.name} ${r.slug} ${r.path}`.toLowerCase().includes(q)).slice(0, 200);
      box.replaceChildren(...shown.map((r) => this.repoRow(r, pinned, s)));
      if (shown.length === 0) box.append(h('div', 'setup-hint', this.scanned || connected ? t('setup.repos.none') : t('setup.workspace.scanning')));
    };
    search.addEventListener('input', () => {
      this.repoFilter = search.value;
      fill();
    });
    fill();
    el.append(box);
    el.append(h('p', 'setup-fine', connected ? t('setup.repos.cloneInto', { dir: s.workspaces[0] ?? '' }) : t('setup.repos.connect')));
  }

  private repoRow(r: Row, pinned: Set<string>, s: HubSettings): HTMLElement {
    const row = h('label', 'setup-repo');
    row.title = r.path || r.slug;
    const text = h('span', 'setup-repo-text');
    const title = h('span', 'setup-repo-title');
    title.append(h('b', '', r.name));
    if (r.private) title.append(h('span', 'setup-tag', t('setup.repos.private')));
    text.append(title, h('span', '', r.detail));
    if (r.path) {
      const check = h('input');
      check.type = 'checkbox';
      check.checked = pinned.has(r.path);
      check.disabled = this.busy || (!check.checked && pinned.size >= MAIN_REPOS_MAX);
      check.addEventListener('change', () => {
        const next = check.checked ? [...s.mainRepos, r.path] : s.mainRepos.filter((p) => p !== r.path);
        void this.save({ mainRepos: next });
      });
      row.append(check, text);
    } else {
      row.classList.add('remote');
      const cloning = this.cloning === r.slug;
      const clone = this.button(cloning ? t('setup.repos.cloning') : t('setup.repos.clone'), 'btn ghost small', () => void this.clone(r.slug), cloning || pinned.size >= MAIN_REPOS_MAX);
      row.append(h('span', 'setup-repo-cloud', '↓'), text, clone);
    }
    return row;
  }

  private async clone(slug: string): Promise<void> {
    const root = this.view?.settings.workspaces[0];
    if (!root) return;
    this.cloning = slug;
    const r = await this.run(() => this.hub.cloneRepo(slug, root));
    this.cloning = '';
    this.view = r;
    const failure = r.error === 'exists' ? t('setup.err.exists', { slug }) : r.error === 'exists-other' ? t('setup.err.existsOther', { slug }) : this.errorText(r.error);
    this.flash(r.ok ? t('setup.repos.cloned', { slug }) : failure, r.ok ? 'ok' : 'error');
    this.found = null;
    this.render();
  }

  private sessions(el: HTMLElement, s: HubSettings): void {
    this.head(el, t('setup.sessions.title'), t('setup.sessions.lead'));
    const modes = this.field(t('setup.sessions.mode'));
    const choices = h('div', 'setup-choices');
    for (const mode of HUB_MODES) {
      const key = mode || 'inherit';
      const danger = mode === 'bypassPermissions';
      const picked = this.confirmBypass ? danger : s.permissionMode === mode;
      choices.append(
        this.choice('mode', picked, t(`setup.mode.${key}` as Key), t(`setup.mode.${key}.hint` as Key), () => {
          this.confirmBypass = danger;
          if (danger) this.render();
          else void this.save({ permissionMode: mode });
        }, danger),
      );
      if (danger && this.confirmBypass && s.permissionMode !== mode) choices.append(this.bypassConfirm());
    }
    modes.append(choices);
    el.append(modes);

    const grid = h('div', 'setup-grid');
    grid.append(this.modelField(t('setup.sessions.master'), s.master, (v) => void this.save({ master: v })));
    grid.append(this.modelField(t('setup.sessions.worker'), s.worker, (v) => void this.save({ worker: v })));
    el.append(grid);

    const f = this.field(t('setup.sessions.instructions'), t('setup.sessions.instructions.hint'));
    const area = h('textarea', 'setup-textarea');
    area.value = this.pending.masterInstructions ?? s.masterInstructions;
    area.rows = 7;
    area.placeholder = t('setup.sessions.instructions.placeholder');
    area.spellcheck = false;
    area.addEventListener('input', () => this.stage({ masterInstructions: area.value }));
    area.addEventListener('change', () => void this.flush(false));
    f.append(area);
    el.append(f);
  }

  /** "Allow everything" only takes effect once the user ticks that they understand what it lets the sessions do. */
  private bypassConfirm(): HTMLElement {
    const box = h('div', 'setup-confirm');
    const label = h('label', 'setup-toggle');
    const check = h('input');
    check.type = 'checkbox';
    label.append(check, h('span', 'setup-choice-hint', t('setup.mode.bypassConfirm')));
    const enable = this.button(t('setup.mode.bypassEnable'), 'btn danger', () => {
      this.confirmBypass = false;
      void this.save({ permissionMode: 'bypassPermissions' });
    }, true);
    check.addEventListener('change', () => (enable.disabled = !check.checked));
    const cancel = this.button(t('setup.cancel'), 'btn ghost', () => {
      this.confirmBypass = false;
      this.render();
    });
    const row = h('div', 'setup-row');
    row.append(enable, cancel);
    box.append(label, row);
    return box;
  }

  private modelField(label: string, value: { model: string; effort: Effort | '' }, set: (v: { model: string; effort: Effort | '' }) => void): HTMLElement {
    const f = this.field(label);
    const model = h('select', 'setup-select');
    const known = [...new Set([...this.models().map((m) => m.value).filter((m) => m !== 'default'), ...MODEL_ALIASES, value.model].filter(Boolean))];
    model.append(new Option(t('setup.sessions.inherit'), ''), ...known.map((m) => new Option(this.models().find((x) => x.value === m)?.label ?? m, m)));
    model.value = value.model;
    const effort = h('select', 'setup-select');
    effort.append(new Option(t('setup.sessions.inheritEffort'), ''), ...EFFORTS.map((e) => new Option(effortLabel(e), e)));
    effort.value = value.effort;
    const update = () => set({ model: model.value, effort: effort.value as Effort | '' });
    model.addEventListener('change', update);
    effort.addEventListener('change', update);
    const row = h('div', 'setup-row');
    row.append(model, effort);
    f.append(row);
    return f;
  }

  private about(el: HTMLElement, v: SettingsView): void {
    this.head(el, APP_NAME, t('setup.about.lead'));
    const list = h('ul', 'setup-list');
    list.append(h('li', '', t('setup.about.version', { version: v.version })), h('li', '', t('setup.about.license')), h('li', '', t('setup.about.data')));
    el.append(list, h('p', 'setup-fine', t('setup.about.trademark')));
  }
}
