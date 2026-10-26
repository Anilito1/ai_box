import { ACCOUNT_LIMITS, ACCOUNTS_MAX, DEFAULT_ACCOUNT, normalizeAccount, OPENAI_URL } from '../shared/accounts';
import { LANG_NAMES, LANGS } from '../shared/i18n';
import { PARALLEL_LIMITS } from '../shared/parallel';
import { AUTO_MODELS, checkRole, FOLDERS_MAX, fromTemplate, normalizeRole, ROLE_LIMITS, ROLE_MODES, sessionNameOf, slugify, TEAM_MAX, TEMPLATE_IDS, type RoleError } from '../shared/team';
import {
  ACCOUNT_KINDS,
  APP_NAME,
  EFFORTS,
  PROVIDERS,
  type Account,
  type AccountStatus,
  type CodexCli,
  type AgentFile,
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
  type TeamRole,
} from '../shared/types';
import { copyButton, errorNote, folderName, h, icon, ICONS } from './dom';
import { effortLabel, LANG, t, type Key } from './i18n';
import { updateSection } from './update';

type Section = 'general' | 'claude' | 'accounts' | 'github' | 'workspace' | 'repos' | 'sessions' | 'team' | 'about';
type Kind = 'onboarding' | 'settings';
type Resume = { mode: Kind; section: Section };
/** One repo of the picker: local (path), on GitHub only (slug, no path), or both. */
type Row = { name: string; path: string; slug: string; detail: string; private: boolean; pushedAt: number };

const STEPS: Section[] = ['general', 'claude', 'github', 'workspace', 'repos', 'sessions'];
// The team and the other accounts are never part of the first run: they start empty, nothing imposed.
const SECTIONS: Section[] = ['general', 'claude', 'accounts', 'github', 'workspace', 'repos', 'sessions', 'team', 'about'];
const HUB_MODES: (Mode | '')[] = ['', 'default', 'acceptEdits', 'auto', 'bypassPermissions'];
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

/** Folder names as a list shows them: the last part, with its parent when two would read the same. */
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

function folderNames(paths: string[]): string[] {
  const short = paths.map(folderName);
  return paths.map((p, i) => (short.filter((s) => s === short[i]).length > 1 ? p.split(/[\\/]/).filter(Boolean).slice(-2).join('/') : short[i]));
}

const INSTALL = {
  win32: 'irm https://claude.ai/install.ps1 | iex',
  other: 'curl -fsSL https://claude.ai/install.sh | bash',
};
/** A sign-in started in a terminal window is watched this long. */
const WAIT_MS = 15 * 60_000;
/** A classic token with the scopes the hub needs, ticked in advance. */
const NEW_TOKEN = 'https://github.com/settings/tokens/new?description=Claude%20Hub&scopes=repo,read:org,workflow';

/** First-run setup (steps, no way out before the end) and the settings screen (same sections, free navigation). */
export class SetupView {
  private readonly root = document.getElementById('setup') as HTMLDivElement;
  /** Kept across renders, so the dialog animates in once when it opens, not at every section change. */
  private readonly card = h('div', 'setup-card');
  private clearTimer = 0;
  private mode: Kind = 'settings';
  private section: Section = 'general';
  private view: SettingsView | null = null;
  private claude: ClaudeStatus | null = null;
  /** The Codex program on this computer, once asked. */
  private codexCli: CodexCli | null = null;
  private checkingCodex = false;
  private checkingClaude = false;
  /** The GitHub CLI on this computer; null until checked. */
  private gh: { installed: boolean; login: string } | null = null;
  private ghChecking = false;
  /** Until when the step watches a sign-in started in a terminal window (0: not watching). */
  private claudeWait = 0;
  private ghWait = 0;
  private watchTimer = 0;
  /** No terminal window could be opened: the step shows the command to type instead. */
  private noTerminal = false;
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
  /** Post being edited (a copy; empty id for a new one), else null for the team list. */
  private draft: TeamRole | null = null;
  private draftDirty = false;
  /** Field the last check refused, outlined until it changes. */
  private draftError: { field: string; text: string } | null = null;
  /** "Allow everything" picked for the post being edited, waiting for its confirmation. */
  private confirmPostBypass = false;
  /** Post whose deletion waits for the confirmation shown in its row. */
  private confirmDelete = '';
  /** Subagent files offered for import: null = list closed, [] = loading or none. */
  private agents: AgentFile[] | null = null;
  /** `detail`: the raw words behind an error, folded under "Details". */
  private note: { text: string; tone: 'ok' | 'error'; detail?: string } | null = null;
  private busy = false;
  /** Account being added or changed (a copy; empty id for a new one), else null for the list. */
  private accountDraft: Account | null = null;
  /** The key typed for it, kept across redraws; empty = keep the stored one. */
  private accountKey = '';
  /** Field the last save refused, outlined. */
  private accountField = '';
  /** Each account's last check, by id. */
  private readonly accountStates = new Map<string, AccountStatus | 'checking'>();
  /** Models the last checked OpenAI server listed, offered in the model fields. */
  private accountModels: string[] = [];
  private confirmAccountDelete = '';
  /** A Claude account whose sign-in runs in a terminal window: its row is checked every few seconds until then. */
  private accountWait: { id: string; until: number } | null = null;
  private accountTimer = 0;

  constructor(
    private readonly hub: HubApi,
    private readonly models: () => ModelOption[],
    /** The models an account lists for itself (Codex), else null: Claude's list applies. */
    private readonly catalog: (account: string) => ModelOption[] | null = () => null,
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
    window.clearTimeout(this.clearTimer);
    this.root.hidden = false;
    this.render();
  }

  /** Saves what was typed first: a refused value keeps the dialog open with its message. */
  async close(): Promise<void> {
    if (!(await this.flush(false)) || !(await this.saveDraft())) return;
    if (this.device) this.hub.githubCancel();
    this.device = null;
    this.root.hidden = true;
    // Emptied once its closing transition is over.
    this.clearTimer = window.setTimeout(() => this.root.hidden && this.root.replaceChildren(), 240);
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
    if (this.note) body.append(this.note.tone === 'error' ? errorNote('setup-note', this.note.text, this.note.detail) : h('div', 'setup-note ok', this.note.text));

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

    this.card.replaceChildren(nav, body);
    if (this.card.parentElement !== this.root) this.root.replaceChildren(this.card);
    content.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }

  private go(section: Section): void {
    // A post being edited is saved first; a refused one keeps the editor open with its message.
    if (this.draft && this.draftDirty) {
      void this.saveDraft().then((ok) => ok && this.go(section));
      return;
    }
    this.draft = null;
    this.agents = null;
    this.confirmDelete = '';
    this.accountDraft = null;
    this.accountKey = '';
    this.confirmAccountDelete = '';
    this.accountWait = null;
    void this.flush(false);
    if (this.device) this.hub.githubCancel();
    this.device = null;
    this.confirmBypass = false;
    this.startAnyway = false;
    this.claudeWait = 0;
    this.ghWait = 0;
    this.noTerminal = false;
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
    if (!c?.found) {
      this.section = 'claude';
      this.note = { text: t('setup.finish.noClaude'), tone: 'error' };
      return this.render();
    }
    const s = this.view?.settings;
    const noKey = s?.provider === 'api-key' && !this.view?.apiKeySet;
    if (!this.startAnyway && (noKey || c.account?.ready !== true)) {
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
      case 'accounts':
        return this.accountsSection(el, v);
      case 'github':
        return this.github(el, v);
      case 'workspace':
        return this.workspace(el, v.settings);
      case 'repos':
        return this.repos(el, v);
      case 'sessions':
        return this.sessions(el, v.settings);
      case 'team':
        return this.team(el, v);
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

  private flash(text: string, tone: 'ok' | 'error', detail = ''): void {
    this.note = { text, tone, detail };
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
    if (/^http-\d+$/.test(code)) return t('setup.err.http');
    // A code nobody explained (an API's error name) or a raw message (git's own) is never shown as is.
    return t('setup.err.unexpected');
  }

  /** What an error's "Details" fold holds: the raw words or the HTTP status behind the sentence, if any. */
  private rawOf(code: string): string {
    if (/^http-\d+$/.test(code)) return `HTTP ${code.slice(5)}`;
    return code && !/^[\w.-]+$/.test(code) ? code : '';
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
    // Says whether Claude Code is connected, and with what: never where it is installed nor how it answered.
    if (this.checkingClaude || !c) {
      status.append(h('span', 'setup-spin'), h('span', '', t('setup.claude.checking')));
    } else if (!c.found) {
      status.classList.add('error');
      status.append(icon(ICONS.shield), h('b', '', t('setup.claude.notFound')));
    } else if (s.provider === 'api-key' && !v.apiKeySet) {
      // Without a key Claude Code would fall back to its own sign-in: the choice is not complete yet.
      status.classList.add('warn');
      status.append(icon(ICONS.shield), h('b', '', t('setup.claude.needKey')));
    } else {
      const a = c.account;
      const ready = a?.ready === true;
      status.classList.add(ready ? 'ok' : 'warn');
      const who = a
        ? [a.email, a.plan, a.provider !== 'firstParty' ? t('setup.claude.cloud') : '', a.source && !a.email ? t('setup.claude.viaKey') : ''].filter(Boolean).join(' · ')
        : c.error === 'timeout'
          ? t('setup.claude.timeout')
          : c.error
            ? t('setup.claude.probeFailed')
            : '';
      status.append(icon(ready ? ICONS.check : ICONS.shield), h('b', '', ready ? t('setup.claude.ready') : t('setup.claude.noAccess')));
      if (who) status.append(h('span', 'setup-status-detail', who));
    }
    status.append(this.button(t('setup.check'), 'btn ghost small', () => void this.checkClaude(), this.checkingClaude));
    el.append(status);

    // The way to Claude comes first: Anthropic's installer, then Claude Code's own sign-in, each in a terminal window.
    if (c && (!c.found || (s.provider === 'claude-code' && !c.account?.ready))) {
      const guide = h('div', 'setup-guide');
      const action = c.found ? 'login' : 'install';
      guide.append(
        h('div', 'setup-label', c.found ? t('setup.claude.signIn') : t('setup.claude.install')),
        h('div', 'setup-hint', c.found ? t('setup.claude.signIn.hint') : t('setup.claude.install.hint')),
      );
      const row = h('div', 'setup-row');
      row.append(this.button(c.found ? t('setup.claude.signInBtn') : t('setup.claude.installBtn'), 'btn primary', () => void this.claudeTerminal(action)));
      guide.append(row);
      if (this.claudeWait) guide.append(h('div', 'setup-wait', t(action === 'install' ? 'setup.claude.waitingInstall' : 'setup.claude.waiting')));
      if (this.noTerminal || !c.found) {
        guide.append(h('div', 'setup-hint', this.noTerminal ? t('setup.claude.noTerminal') : t('setup.claude.orRun')));
        guide.append(this.command(!c.found ? (v.platform === 'win32' ? INSTALL.win32 : INSTALL.other) : 'claude auth login'));
      }
      guide.append(this.link(t('setup.claude.docs'), 'https://code.claude.com/docs/en/setup'));
      el.append(guide);
    }

    const options = h('div', 'setup-choices');
    for (const p of PROVIDERS) {
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
    }
  }

  /** Opens the terminal window, then watches for the outcome: Claude Code found, then signed in. */
  private async claudeTerminal(action: 'login' | 'install'): Promise<void> {
    const opened = await this.run(() => this.hub.claudeTerminal(action));
    this.noTerminal = !opened;
    this.note = null;
    this.claudeWait = opened ? Date.now() + WAIT_MS : 0;
    this.render();
    if (opened) this.watch('claude');
  }

  /**
   * While the user signs in (or installs) in a terminal window, the step checks again every few seconds and redraws
   * only when the answer changes; it stops on success, on leaving the step, or after a quarter of an hour.
   */
  private watch(what: 'claude' | 'gh'): void {
    window.clearTimeout(this.watchTimer);
    this.watchTimer = window.setTimeout(() => void this.watchOnce(what), 4000);
  }

  private async watchOnce(what: 'claude' | 'gh'): Promise<void> {
    const deadline = what === 'claude' ? this.claudeWait : this.ghWait;
    const stop = () => {
      if (what === 'claude') this.claudeWait = 0;
      else this.ghWait = 0;
    };
    if (!deadline || Date.now() > deadline || this.root.hidden || this.section !== (what === 'claude' ? 'claude' : 'github')) {
      if (deadline) {
        stop();
        if (!this.root.hidden) this.render();
      }
      return;
    }
    if (what === 'claude') {
      const before = JSON.stringify(this.claude);
      const wasFound = this.claude?.found === true;
      const c = this.checkingClaude ? this.claude : await this.hub.checkClaude();
      if (!this.claudeWait || this.section !== 'claude') return;
      this.claude = c;
      if (c?.found && c.account?.ready) {
        stop();
        this.flash(t('setup.claude.signedIn'), 'ok');
      } else if (c?.found && !wasFound) {
        // Installed: the sign-in is the next click.
        stop();
        this.flash(t('setup.claude.installed'), 'ok');
      }
      if (JSON.stringify(c) !== before || !this.claudeWait) this.render();
    } else {
      const gh = await this.hub.ghStatus();
      if (!this.ghWait || this.section !== 'github') return;
      const changed = JSON.stringify(gh) !== JSON.stringify(this.gh);
      this.gh = gh;
      if (gh.login) {
        stop();
        return this.githubResult(this.hub.githubUseGh());
      }
      if (changed) this.render();
    }
    this.watch(what);
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
    this.claudeWait = 0;
    await this.save({ provider: p });
    await this.checkClaude();
  }

  private async setApiKey(key: string | null): Promise<void> {
    const r = await this.run(() => this.hub.setApiKey(key === null ? null : key.trim()));
    this.view = r;
    if (r.ok) this.keyDraft = '';
    this.flash(r.ok ? t(key === null ? 'setup.apiKey.removed' : 'setup.apiKey.ok') : this.errorText(r.error, 'key'), r.ok ? 'ok' : 'error', r.ok ? '' : this.rawOf(r.error));
    if (r.ok) await this.checkClaude();
    else this.render();
  }

  private github(el: HTMLElement, v: SettingsView): void {
    const g = v.settings.github;
    this.head(el, t('setup.github.title'), t('setup.github.lead'));
    if (this.gh === null && !this.ghChecking) void this.checkGh();

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
    // The best way first: GitHub sign-in when this build has a Client ID, then the GitHub CLI when it is installed
    // (no token to copy), then a token. Without a Client ID, the device flow waits under Advanced.
    if (clientId) {
      const device = h('div', 'setup-option');
      device.append(h('div', 'setup-choice-title', t('setup.github.device')), h('div', 'setup-choice-hint', t('setup.github.device.hint')));
      device.append(this.button(t('setup.github.signIn'), 'btn primary', () => void this.startDevice(), !v.secureStorage));
      options.append(device);
    }
    const gh = this.ghOption();
    const pat = h('div', 'setup-option');
    pat.append(h('div', 'setup-choice-title', t('setup.github.token')), h('div', 'setup-choice-hint', t('setup.github.token.hint')));
    const tokenInput = this.input('', 'github_pat_… / ghp_…', 'password');
    const row = h('div', 'setup-row');
    row.append(tokenInput, this.button(t('setup.verifySave'), 'btn', () => void this.githubResult(this.hub.githubUseToken(tokenInput.value.trim()), 'pat'), !v.secureStorage));
    pat.append(row, this.link(t('setup.github.token.create'), NEW_TOKEN));
    options.append(...(this.gh && !this.gh.installed ? [pat, gh] : [gh, pat]));
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

    // The OAuth App's Client ID, under Advanced: one-click GitHub sign-in once it is set.
    const adv = h('details', 'setup-advanced');
    adv.append(h('summary', '', t('setup.github.advanced')));
    if (!clientId) adv.append(h('p', 'setup-hint', t('setup.github.device.needsId')));
    adv.append(this.clientIdField(g.clientId, v.defaultClientId));
    el.append(adv);
  }

  /** The GitHub CLI's option: use it when signed in, sign in through it when installed, else where to get it. */
  private ghOption(): HTMLElement {
    const gh = this.gh;
    const box = h('div', 'setup-option');
    const hint = !gh
      ? t('setup.github.gh.checking')
      : gh.login
        ? t('setup.github.gh.found', { login: gh.login })
        : gh.installed
          ? t('setup.github.gh.signedOut')
          : t('setup.github.gh.missing');
    box.append(h('div', 'setup-choice-title', t('setup.github.gh')), h('div', 'setup-choice-hint', hint));
    const row = h('div', 'setup-row');
    if (gh?.login) row.append(this.button(t('setup.github.useGh'), 'btn primary', () => void this.githubResult(this.hub.githubUseGh())));
    else if (gh?.installed) row.append(this.button(t('setup.github.gh.signIn'), 'btn primary', () => void this.ghTerminal()));
    else if (gh) row.append(this.link(t('setup.github.gh.install'), 'https://cli.github.com'));
    if (gh && !gh.login) row.append(this.button(t('setup.check'), 'btn ghost small', () => void this.checkGh()));
    box.append(row);
    if (this.ghWait) box.append(h('div', 'setup-wait', t('setup.github.gh.waiting')));
    if (this.noTerminal) box.append(h('div', 'setup-hint', t('setup.github.noTerminal')));
    return box;
  }

  private async checkGh(): Promise<void> {
    this.ghChecking = true;
    try {
      this.gh = await this.hub.ghStatus();
    } finally {
      this.ghChecking = false;
    }
    if (this.section === 'github' && !this.root.hidden) this.render();
  }

  private async ghTerminal(): Promise<void> {
    const opened = await this.run(() => this.hub.githubTerminal());
    this.noTerminal = !opened;
    this.note = null;
    this.ghWait = opened ? Date.now() + WAIT_MS : 0;
    this.render();
    if (opened) this.watch('gh');
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
      this.flash(this.errorText(r.error), 'error', this.rawOf(r.error));
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
    this.flash(done.ok ? t('setup.github.ok', { login: done.settings.github.login }) : this.errorText(done.error), done.ok ? 'ok' : 'error', done.ok ? '' : this.rawOf(done.error));
    this.render();
  }

  private async githubResult(task: Promise<SettingsView & { ok: boolean; error: string }>, context: 'github' | 'pat' = 'github'): Promise<void> {
    const r = await this.run(() => task);
    this.view = r;
    this.ghRepos = null;
    this.githubHealth = null;
    this.flash(r.ok ? t('setup.github.ok', { login: r.settings.github.login }) : this.errorText(r.error, context), r.ok ? 'ok' : 'error', r.ok ? '' : this.rawOf(r.error));
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
    const names = folderNames(s.workspaces);
    s.workspaces.forEach((dir, i) => {
      const row = h('div', 'setup-folder');
      const name = h('span', 'setup-folder-path', names[i]);
      name.title = dir;
      row.append(name);
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
        if (!r.ok) this.flash(this.errorText(r.error), 'error', this.rawOf(r.error));
        this.render();
      });
    }

    const slugOf = (remote: string) => /^github\.com\/(.+\/.+)$/i.exec(remote)?.[1].toLowerCase() ?? '';
    // A remote on a server ("gitlab.com/team/app", "gitserver/team/app"), never a folder of this computer.
    const remoteName = (remote: string) => slugOf(remote) || (/^([a-z]:[\\/]|[\\/~]|\.{1,2}[\\/]|file:)|\\/i.test(remote) ? '' : remote);
    const pinned = new Set(s.mainRepos);
    const local = new Map<string, Row>();
    // Pinned repos stay listed even when they sit outside the working folders.
    for (const p of s.mainRepos) local.set(p, { name: folderName(p), path: p, slug: '', detail: this.scanned ? t('setup.repos.outside') : '', private: false, pushedAt: 0 });
    for (const r of this.found ?? []) local.set(r.path, { name: r.name, path: r.path, slug: slugOf(r.remote), detail: remoteName(r.remote) || t('setup.repos.localOnly'), private: false, pushedAt: 0 });
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
    el.append(h('p', 'setup-fine', connected ? t('setup.repos.cloneInto', { dir: folderName(s.workspaces[0] ?? '') }) : t('setup.repos.connect')));
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
    // The clone goes to <working folder>/<repo name>: the message names that folder.
    const folder = slug.split('/')[1];
    const failure = r.error === 'exists' ? t('setup.err.exists', { folder }) : r.error === 'exists-other' ? t('setup.err.existsOther', { folder }) : this.errorText(r.error);
    this.flash(r.ok ? t('setup.repos.cloned', { slug }) : failure, r.ok ? 'ok' : 'error', r.ok ? '' : this.rawOf(r.error));
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
    el.append(grid, this.autoChoice(s));

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

  /** Models the master may pick for a mission, and the highest effort it may pick. */
  private autoChoice(s: HubSettings): HTMLElement {
    const grid = h('div', 'setup-grid');
    const f = this.field(t('setup.sessions.auto'), t('setup.sessions.auto.hint'));
    const checks = h('div', 'setup-checks');
    const models = [...new Set([...AUTO_MODELS, ...s.workerModels])];
    for (const m of models) {
      const label = h('label', 'setup-check');
      const box = h('input');
      box.type = 'checkbox';
      box.checked = s.workerModels.includes(m);
      // One model at least stays allowed.
      box.disabled = this.busy || (box.checked && s.workerModels.length === 1);
      box.addEventListener('change', () => {
        const next = models.filter((x) => (x === m ? box.checked : s.workerModels.includes(x)));
        void this.save({ workerModels: next });
      });
      const name = this.models().find((x) => x.value === m)?.label ?? m.charAt(0).toUpperCase() + m.slice(1);
      label.append(box, h('span', '', name));
      checks.append(label);
    }
    f.append(checks);
    const maxField = this.field(t('setup.sessions.maxEffort'), t('setup.sessions.maxEffort.hint'));
    const max = h('select', 'setup-select');
    max.setAttribute('aria-label', t('setup.sessions.maxEffort'));
    max.append(...EFFORTS.map((e) => new Option(effortLabel(e), e)));
    max.value = s.workerMaxEffort;
    max.addEventListener('change', () => void this.save({ workerMaxEffort: max.value as Effort }));
    maxField.append(max);
    grid.append(f, maxField);
    return grid;
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

  // ---------- accounts ----------

  private accountsSection(el: HTMLElement, v: SettingsView): void {
    if (this.accountDraft) return this.accountEditor(el, v, this.accountDraft);
    const s = v.settings;
    this.head(el, t('setup.accounts.title'), t('setup.accounts.lead'));
    if (!this.claude && !this.checkingClaude) void this.checkClaude();
    if (!this.codexCli && !this.checkingCodex) void this.checkCodexCli();
    el.append(this.programsField());

    const grid = h('div', 'setup-grid');
    grid.append(
      this.accountSelect(t('setup.accounts.master'), t('setup.accounts.master.hint'), s.masterAccount, s, (id) => void this.save({ masterAccount: id })),
      this.accountSelect(t('setup.accounts.workers'), t('setup.accounts.workers.hint'), s.workerAccount, s, (id) => void this.save({ workerAccount: id })),
    );
    el.append(grid);

    const list = h('div', 'team-list');
    list.append(this.usualAccountRow(s));
    for (const a of s.accounts) list.append(this.accountRow(a));
    el.append(list);

    const full = s.accounts.length >= ACCOUNTS_MAX;
    const add = this.field(t('setup.accounts.add'), full ? t('setup.accounts.full', { max: ACCOUNTS_MAX }) : t('setup.accounts.add.hint'));
    const row = h('div', 'setup-row team-templates');
    for (const kind of ACCOUNT_KINDS) row.append(this.button(t(`setup.accounts.add.${kind}`), kind === 'claude' ? 'btn' : 'btn ghost', () => this.editAccount(normalizeAccount({ kind, isolated: kind === 'codex' })), full));
    add.append(row);
    el.append(add, h('p', 'setup-fine', t('setup.accounts.fine')));
  }

  /** "default", then each account: what a setting or a post picks from. `inherit`: a first choice that follows another. */
  private accountSelect(label: string, hint: string, value: string, s: HubSettings, pick: (id: string) => void, inherit?: string): HTMLElement {
    const f = this.field(label, hint);
    const select = h('select', 'setup-select');
    select.setAttribute('aria-label', label);
    if (inherit !== undefined) select.append(new Option(inherit, ''));
    select.append(new Option(t('account.default'), DEFAULT_ACCOUNT), ...s.accounts.map((a) => new Option(`${a.name} · ${t(`account.kind.${a.kind}`)}`, a.id)));
    select.value = value;
    select.disabled = this.busy;
    select.addEventListener('change', () => pick(select.value));
    f.append(select);
    return f;
  }

  /** The Claude access of Settings › Claude: always there, changed in its own section. */
  private usualAccountRow(s: HubSettings): HTMLElement {
    const row = h('div', 'team-row');
    const text = h('div', 'team-row-text');
    const title = h('div', 'team-row-title');
    title.append(h('b', '', t('account.default')), h('span', 'team-row-session', t(`setup.provider.${s.provider}` as Key)));
    const tags = h('div', 'team-tags');
    const a = this.claude?.account;
    if (this.checkingClaude || !this.claude) tags.append(h('span', 'setup-pill', t('setup.accounts.checking')));
    else if (a?.ready) tags.append(h('span', 'setup-pill ok', t('setup.accounts.ready')), ...[a.email, a.plan].filter(Boolean).map((x) => h('span', 'setup-tag', x)));
    else tags.append(h('span', 'setup-pill warn', t('setup.claude.noAccess')));
    text.append(title, tags);
    const actions = h('div', 'team-row-actions');
    actions.append(this.button(t('setup.accounts.usualEdit'), 'btn ghost small', () => this.go('claude')));
    row.append(text, actions);
    return row;
  }

  private accountRow(a: Account): HTMLElement {
    const row = h('div', 'team-row');
    const text = h('div', 'team-row-text');
    const title = h('div', 'team-row-title');
    title.append(h('b', '', a.name), h('span', 'team-row-session', t(`account.kind.${a.kind}`)));
    const tags = h('div', 'team-tags');
    if (a.kind === 'openai') tags.append(h('span', 'setup-tag', hostOf(a.baseUrl)), h('span', 'setup-tag', a.smallModel ? `${a.model} · ${a.smallModel}` : a.model));
    const st = this.accountStates.get(a.id);
    if (st === undefined) void this.checkAccount(a.id);
    if (!st || st === 'checking') tags.append(h('span', 'setup-pill', t('setup.accounts.checking')));
    else if (st.ready) tags.append(h('span', 'setup-pill ok', t('setup.accounts.ready')), ...(st.detail && a.kind !== 'openai' ? [h('span', 'setup-tag', st.detail)] : []));
    else if ((a.kind === 'claude' || a.kind === 'codex') && !st.error) tags.append(h('span', 'setup-pill warn', t('setup.accounts.signedOut')));
    else tags.append(h('span', 'setup-pill warn', this.accountErrorText(st.error)));
    text.append(title, tags);
    if (this.accountWait?.id === a.id) text.append(h('div', 'setup-wait', t('setup.accounts.waiting')));

    const actions = h('div', 'team-row-actions');
    if (this.confirmAccountDelete === a.id) {
      actions.append(
        h('span', 'setup-hint', t(a.kind === 'claude' ? 'setup.accounts.deleteAskClaude' : a.kind === 'codex' ? 'setup.accounts.deleteAskCodex' : 'setup.accounts.deleteAsk', { name: a.name })),
        this.button(t('team.delete'), 'btn danger small', () => void this.deleteAccount(a)),
        this.button(t('setup.cancel'), 'btn ghost small', () => {
          this.confirmAccountDelete = '';
          this.render();
        }),
      );
    } else {
      if ((a.kind === 'claude' || a.kind === 'codex') && st && st !== 'checking' && !st.ready && st.error !== 'no-codex') actions.append(this.button(t('setup.accounts.signIn'), 'btn primary small', () => void this.accountLogin(a)));
      actions.append(
        this.button(t('setup.check'), 'btn ghost small', () => void this.checkAccount(a.id), st === 'checking'),
        this.button(t('team.edit'), 'btn ghost small', () => this.editAccount(structuredClone(a))),
        this.button(t('team.delete'), 'btn ghost small', () => {
          this.confirmAccountDelete = a.id;
          this.render();
        }),
      );
    }
    row.append(text, actions);
    return row;
  }

  private editAccount(a: Account): void {
    this.accountDraft = a;
    this.accountKey = '';
    this.accountField = '';
    this.note = null;
    this.render();
  }

  /** One account's fields. A Claude account has a name only: its sign-in happens in Claude Code. */
  private accountEditor(el: HTMLElement, v: SettingsView, d: Account): void {
    const kind = t(`account.kind.${d.kind}`);
    this.head(el, d.id ? t('setup.accounts.editTitle', { name: d.name }) : t('setup.accounts.newTitle', { kind }), t(`setup.accounts.editor.${d.kind}`));
    const mark = (field: string, f: HTMLElement) => {
      if (this.accountField === field) f.classList.add('invalid');
    };
    // In a row, an input takes the width of its field.
    const row = (...els: HTMLElement[]) => {
      const r = h('div', 'setup-row');
      r.append(...els);
      return r;
    };
    const nameField = this.field(t('setup.accounts.name'), t('setup.accounts.name.hint'));
    const name = this.input(d.name, t(`setup.accounts.name.placeholder.${d.kind}`));
    name.maxLength = ACCOUNT_LIMITS.name;
    name.dataset.autofocus = '';
    name.addEventListener('input', () => (d.name = name.value));
    nameField.append(row(name));
    mark('name', nameField);
    el.append(nameField);

    if (d.kind === 'openai') {
      const urlField = this.field(t('setup.accounts.baseUrl'), t('setup.accounts.baseUrl.hint'));
      const url = this.input(d.baseUrl || OPENAI_URL, OPENAI_URL);
      url.classList.add('wide');
      url.addEventListener('input', () => (d.baseUrl = url.value));
      urlField.append(row(url));
      mark('baseUrl', urlField);
      el.append(urlField);
    }
    if (d.kind === 'anthropic-key' || d.kind === 'openai') {
      const stored = !!d.id && v.accountKeys.includes(d.id);
      const hint = !v.secureStorage ? t('setup.err.keychain', { app: APP_NAME }) : stored ? t('setup.accounts.key.keep') : t(`setup.accounts.key.hint.${d.kind}`);
      const keyField = this.field(t('setup.accounts.key'), hint);
      const key = this.input(this.accountKey, stored ? '••••••••' : d.kind === 'openai' ? 'sk-…' : 'sk-ant-…', 'password');
      key.addEventListener('input', () => (this.accountKey = key.value));
      keyField.append(row(key), this.link(t(`setup.accounts.key.where.${d.kind}`), d.kind === 'openai' ? 'https://platform.openai.com/api-keys' : 'https://console.anthropic.com/settings/keys'));
      mark('key', keyField);
      el.append(keyField);
    }
    if (d.kind === 'openai') {
      const grid = h('div', 'setup-grid');
      const listId = 'account-models';
      const models = h('datalist');
      models.id = listId;
      models.append(...this.accountModels.map((m) => new Option(m, m)));
      const field = (key: 'model' | 'smallModel', placeholder: string) => {
        const f = this.field(t(`setup.accounts.${key}`), t(`setup.accounts.${key}.hint`));
        const input = this.input(d[key], placeholder);
        input.setAttribute('list', listId);
        input.addEventListener('input', () => (d[key] = input.value));
        f.append(row(input));
        mark(key, f);
        return f;
      };
      grid.append(field('model', 'gpt-5'), field('smallModel', 'gpt-5-mini'));
      el.append(grid, models);
      if (this.accountModels.length > 0 && d.model && !this.accountModels.includes(d.model.trim())) el.append(h('div', 'setup-hint', t('setup.accounts.modelUnlisted', { model: d.model })));
    }

    if (d.kind === 'codex') {
      if (!this.codexCli && !this.checkingCodex) void this.checkCodexCli();
      const own = h('label', 'setup-toggle');
      const box = h('input');
      box.type = 'checkbox';
      box.checked = d.isolated;
      box.disabled = !!d.id;
      box.addEventListener('change', () => (d.isolated = box.checked));
      const ownText = h('span', 'setup-choice-text');
      ownText.append(h('span', 'setup-choice-title', t('setup.accounts.codexOwn')), h('span', 'setup-choice-hint', t(d.id ? 'setup.accounts.codexOwn.fixed' : 'setup.accounts.codexOwn.hint')));
      own.append(box, ownText);
      el.append(own);
      if (this.codexCli && !this.codexCli.found) el.append(h('div', 'setup-hint', t('setup.accounts.codexMissing')));
    }

    const actions = h('div', 'setup-row team-editor-actions');
    const label = d.id ? t('team.save') : d.kind === 'claude' || d.kind === 'codex' ? t('setup.accounts.createSignIn') : t('setup.verifySave');
    actions.append(
      this.button(label, 'btn primary', () => void this.saveAccount(d)),
      this.button(t('setup.cancel'), 'btn ghost', () => {
        this.accountDraft = null;
        this.accountKey = '';
        this.accountField = '';
        this.note = null;
        this.render();
      }),
    );
    el.append(actions);
  }

  private async saveAccount(d: Account): Promise<void> {
    const r = await this.run(() => this.hub.saveAccount(d, this.accountKey.trim() ? this.accountKey.trim() : null));
    this.view = r;
    if (r.status) this.accountModels = r.status.models;
    if (!r.ok) {
      this.accountField = r.field;
      const text = r.field && r.field !== 'key' && r.field !== 'baseUrl' ? t('team.err', { field: t(`setup.accounts.field.${r.field}` as Key), problem: t(`team.problem.${r.error}` as Key, { max: ACCOUNTS_MAX }) }) : this.accountErrorText(r.error);
      this.flash(text, 'error', this.rawOf(r.error));
      return this.render();
    }
    const isNew = !d.id;
    this.accountDraft = null;
    this.accountKey = '';
    this.accountField = '';
    if (r.status) this.accountStates.set(r.id, r.status);
    else this.accountStates.delete(r.id);
    this.flash(t(isNew ? 'setup.accounts.created' : 'setup.accounts.saved', { name: d.name.trim() }), 'ok');
    this.render();
    // A new Claude account signs in right away, in Claude Code's own window.
    const saved = r.settings.accounts.find((a) => a.id === r.id);
    if (isNew && (saved?.kind === 'claude' || saved?.kind === 'codex')) await this.accountLogin(saved);
  }

  private async deleteAccount(a: Account): Promise<void> {
    this.confirmAccountDelete = '';
    const r = await this.run(() => this.hub.deleteAccount(a.id));
    this.view = r;
    this.accountStates.delete(a.id);
    this.flash(r.ok ? t('setup.accounts.deleted', { name: a.name }) : t('setup.accounts.deleteWorking', { name: a.name }), r.ok ? 'ok' : 'error');
    this.render();
  }

  private async checkAccount(id: string): Promise<void> {
    this.accountStates.set(id, 'checking');
    this.render();
    const st = await this.hub.checkAccount(id);
    this.accountStates.set(id, st);
    if (st.models.length > 0) this.accountModels = st.models;
    if (!this.root.hidden && this.section === 'accounts') this.render();
  }

  /** Claude Code's own sign-in for this account, in a terminal window; the row turns ready by itself once done. */
  private async accountLogin(a: Account): Promise<void> {
    const opened = await this.run(() => this.hub.accountLogin(a.id));
    this.note = opened ? null : { text: t('setup.accounts.noTerminal'), tone: 'error' };
    this.accountWait = opened ? { id: a.id, until: Date.now() + WAIT_MS } : null;
    this.render();
    if (opened) this.watchAccount();
  }

  private watchAccount(): void {
    window.clearTimeout(this.accountTimer);
    this.accountTimer = window.setTimeout(() => void this.watchAccountOnce(), 4000);
  }

  private async watchAccountOnce(): Promise<void> {
    const wait = this.accountWait;
    if (!wait || Date.now() > wait.until || this.root.hidden || this.section !== 'accounts') {
      this.accountWait = null;
      if (!this.root.hidden && this.section === 'accounts') this.render();
      return;
    }
    const st = await this.hub.checkAccount(wait.id);
    if (this.accountWait?.id !== wait.id) return;
    this.accountStates.set(wait.id, st);
    if (st.ready) {
      this.accountWait = null;
      this.flash(t('setup.accounts.signedIn', { name: this.view?.settings.accounts.find((a) => a.id === wait.id)?.name ?? '' }), 'ok');
      this.render();
      return;
    }
    this.render();
    this.watchAccount();
  }

  /** An account check's or save's error code, in words. */
  private async checkCodexCli(): Promise<void> {
    this.checkingCodex = true;
    this.codexCli = await this.hub.checkCodex();
    this.checkingCodex = false;
    if (this.section === 'accounts') this.render();
  }

  /** The programs the accounts run on, found on this computer: what to install when one is missing. */
  private programsField(): HTMLElement {
    const f = this.field(t('setup.accounts.programs'), t('setup.accounts.programs.hint'));
    const row = h('div', 'team-tags');
    const claude = this.claude;
    if (this.checkingClaude || !claude) row.append(h('span', 'setup-pill', `Claude Code · ${t('setup.accounts.checking')}`));
    else if (claude.found) row.append(h('span', 'setup-pill ok', 'Claude Code'));
    else row.append(h('span', 'setup-pill warn', `Claude Code · ${t('setup.accounts.programMissing')}`));
    const codex = this.codexCli;
    if (this.checkingCodex || !codex) row.append(h('span', 'setup-pill', `Codex · ${t('setup.accounts.checking')}`));
    else if (!codex.found) row.append(h('span', 'setup-pill warn', `Codex · ${t('setup.accounts.programMissing')}`));
    else row.append(h('span', codex.outdated ? 'setup-pill warn' : 'setup-pill ok', `Codex ${codex.version}${codex.outdated ? ` · ${t('setup.accounts.programOld')}` : ''}`));
    f.append(row);
    if (codex && !codex.found) f.append(h('div', 'setup-hint', t('setup.accounts.codexMissing')), this.link(t('setup.accounts.codexInstall'), 'https://github.com/openai/codex'));
    return f;
  }

  private accountErrorText(code: string): string {
    const own: Record<string, Key> = {
      'no-key': 'setup.accounts.err.noKey',
      required: 'setup.accounts.err.noKey',
      'no-claude': 'setup.claude.notFound',
      'no-codex': 'setup.accounts.err.noCodex',
      timeout: 'setup.claude.timeout',
      'probe-failed': 'setup.claude.probeFailed',
      'not-found': 'setup.accounts.err.notFound',
      'http-404': 'setup.accounts.err.notFoundUrl',
      unauthorized: 'setup.accounts.err.refused',
      forbidden: 'setup.accounts.err.refused',
    };
    return own[code] ? t(own[code]) : this.errorText(code, 'key');
  }

  // ---------- team ----------

  /** The master changed the team: the list shows it (a post being edited stays as typed). */
  async teamChanged(): Promise<void> {
    if (this.root.hidden || this.section !== 'team' || this.draft) return;
    this.view = await this.hub.getSettings();
    this.render();
  }

  private team(el: HTMLElement, v: SettingsView): void {
    if (this.draft) return this.postEditor(el, v, this.draft);
    this.head(el, t('team.title'), t('team.lead'));
    const team = v.settings.team;
    const list = h('div', 'team-list');
    if (team.length === 0) list.append(h('p', 'setup-hint team-empty', t('team.empty')));
    team.forEach((role, i) => list.append(this.postRow(role, i, team.length)));
    el.append(list);

    const add = this.field(t('team.add'), team.length >= TEAM_MAX ? t('team.full', { max: TEAM_MAX }) : t('team.add.hint'));
    const row = h('div', 'setup-row team-templates');
    const full = team.length >= TEAM_MAX;
    const folder = v.settings.mainRepos[0] ?? v.settings.workspaces[0] ?? '';
    row.append(this.button(t('team.blank'), 'btn', () => this.edit({ id: '', name: '', description: '', instructions: '', folders: folder ? [folder] : [], model: '', effort: '', mode: '', account: '', enabled: true }), full));
    for (const id of TEMPLATE_IDS) row.append(this.button(t(`team.template.${id}`), 'btn ghost', () => this.edit(fromTemplate(id, LANG, folder)), full));
    row.append(this.button(t('team.import'), 'btn ghost', () => void this.openAgents(), full));
    add.append(row);
    el.append(add);
    if (this.agents) el.append(this.agentList(this.agents));
    el.append(this.parallelLimits(v.settings), h('p', 'setup-fine', t('team.fine')));
  }

  /** How many instances of one post, and how many workers in all, may run at the same time. */
  private parallelLimits(s: HubSettings): HTMLElement {
    const grid = h('div', 'setup-grid');
    const pick = (key: 'perPost' | 'maxWorkers', label: string, hint: string, text: (n: number) => string) => {
      const f = this.field(label, hint);
      const select = h('select', 'setup-select');
      select.id = `team-${key}`;
      select.setAttribute('aria-label', label);
      const hintEl = f.querySelector<HTMLElement>('.setup-hint');
      if (hintEl) select.setAttribute('aria-describedby', (hintEl.id = `team-${key}-hint`));
      const { min, max } = PARALLEL_LIMITS[key];
      for (let n = min; n <= max; n++) select.append(new Option(text(n), String(n)));
      select.value = String(s.parallel[key]);
      select.disabled = this.busy;
      select.addEventListener('change', () => void this.save({ parallel: { ...s.parallel, [key]: Number(select.value) } }));
      f.append(select);
      return f;
    };
    grid.append(
      pick('perPost', t('team.perPost'), t('team.perPost.hint'), (n) => (n === 1 ? t('team.perPost.one') : t('team.perPost.n', { n }))),
      pick('maxWorkers', t('team.maxWorkers'), t('team.maxWorkers.hint'), (n) => t('team.maxWorkers.n', { n })),
    );
    return grid;
  }

  private postRow(role: TeamRole, index: number, count: number): HTMLElement {
    const row = h('div', `team-row${role.enabled ? '' : ' off'}`);
    const text = h('div', 'team-row-text');
    const title = h('div', 'team-row-title');
    title.append(h('b', '', role.name), h('span', 'team-row-session', sessionNameOf(role)));
    const tags = h('div', 'team-tags');
    const tag = (label: string) => tags.append(h('span', 'setup-tag', label));
    tag(role.folders[0]?.split(/[\\/]/).filter(Boolean).pop() ?? '');
    tag(this.runLabel(role));
    if (role.mode) tag(t(`setup.mode.${role.mode}` as Key));
    if (!role.enabled) tag(t('team.off'));
    text.append(title, h('div', 'team-row-desc', role.description), tags);
    row.append(text);

    const actions = h('div', 'team-row-actions');
    if (this.confirmDelete === role.id) {
      actions.append(
        h('span', 'setup-hint', t('team.deleteAsk', { name: role.name })),
        this.button(t('team.delete'), 'btn danger small', () => void this.deletePost(role)),
        this.button(t('setup.cancel'), 'btn ghost small', () => {
          this.confirmDelete = '';
          this.render();
        }),
      );
    } else {
      actions.append(
        this.iconButton(t('team.up', { name: role.name }), ICONS.up, () => void this.movePost(role, -1), index === 0),
        this.iconButton(t('team.down', { name: role.name }), ICONS.down, () => void this.movePost(role, 1), index === count - 1),
        this.button(t('team.edit'), 'btn ghost small', () => this.edit(structuredClone(role))),
        this.button(t('team.delete'), 'btn ghost small', () => {
          this.confirmDelete = role.id;
          this.render();
        }),
      );
    }
    row.append(actions);
    return row;
  }

  private iconButton(label: string, path: string, run: () => void, disabled = false): HTMLButtonElement {
    const b = h('button', 'icon-btn');
    b.title = label;
    b.setAttribute('aria-label', label);
    b.append(icon(path));
    b.disabled = disabled || this.busy;
    b.addEventListener('click', run);
    return b;
  }

  /** "Opus · high", or "Auto" when the master picks. */
  private runLabel(role: Pick<TeamRole, 'model' | 'effort'>): string {
    if (!role.model && !role.effort) return t('team.auto');
    const model = role.model ? (this.models().find((m) => m.value === role.model)?.label ?? role.model) : t('team.autoModel');
    return `${model} · ${role.effort ? effortLabel(role.effort) : t('team.autoEffort')}`;
  }

  private edit(role: TeamRole): void {
    this.draft = role;
    // Untouched, a new post is dropped on leaving; once typed in, it is saved like any other setting.
    this.draftDirty = false;
    this.draftError = null;
    this.confirmPostBypass = false;
    this.agents = null;
    this.note = null;
    this.render();
  }

  private async openAgents(): Promise<void> {
    this.agents = [];
    this.render();
    this.agents = await this.hub.agentFiles();
    this.render();
  }

  private agentList(files: AgentFile[]): HTMLElement {
    const f = this.field(t('team.agents'), t('team.agents.hint'));
    const box = h('div', 'setup-repos team-agents');
    if (files.length === 0) box.append(h('div', 'setup-hint', t('team.agents.none')));
    for (const file of files) {
      const row = h('div', 'setup-repo remote');
      row.title = file.path;
      const text = h('span', 'setup-repo-text');
      const title = h('span', 'setup-repo-title');
      title.append(h('b', '', file.role.name), h('span', 'setup-tag', file.scope === 'user' ? t('team.agents.user') : file.scope));
      text.append(title, h('span', 'team-agent-desc', file.role.description || folderName(file.path)));
      if (file.ignored.length > 0) text.append(h('span', 'team-ignored', t('team.agents.ignored', { list: file.ignored.map((d) => t(`team.agents.drop.${d}`)).join(', ') })));
      row.append(text, this.button(t('team.agents.use'), 'btn ghost small', () => this.edit({ ...file.role, id: '' })));
      box.append(row);
    }
    f.append(box);
    return f;
  }

  private async movePost(role: TeamRole, delta: -1 | 1): Promise<void> {
    this.view = await this.run(() => this.hub.moveRole(role.id, delta));
    this.render();
  }

  private async deletePost(role: TeamRole): Promise<void> {
    const r = await this.run(() => this.hub.deleteRole(role.id));
    this.view = r;
    this.confirmDelete = '';
    this.flash(r.ok ? t('team.deleted', { name: role.name }) : t('team.err.working', { name: role.name }), r.ok ? 'ok' : 'error');
    this.render();
  }

  /** Saves the post being edited, if it changed; false (and the editor shows why) when it is refused. */
  private async saveDraft(): Promise<boolean> {
    const draft = this.draft;
    if (!draft || !this.draftDirty) {
      this.draft = null;
      return true;
    }
    const role = normalizeRole(draft);
    const others = this.view?.settings.team ?? [];
    const local = checkRole(role, others);
    if (local) return this.refuse(local);
    const r = await this.run(() => this.hub.saveRole(role));
    this.view = r;
    if (!r.ok) return this.refuse(r.error === 'working' ? 'working' : { field: r.field as RoleError['field'], problem: r.error as RoleError['problem'] });
    this.draft = null;
    this.draftDirty = false;
    this.flash(t(draft.id ? 'team.saved' : 'team.created', { name: role.name }), 'ok');
    this.render();
    return true;
  }

  private refuse(error: RoleError | 'working'): false {
    const name = this.draft?.name ?? '';
    const text =
      error === 'working'
        ? t('team.err.working', { name })
        : t('team.err', { field: t(`team.field.${error.field}`), problem: t(`team.problem.${error.problem}`, { max: error.field === 'team' ? TEAM_MAX : FOLDERS_MAX }) });
    this.draftError = { field: error === 'working' ? '' : error.field, text };
    this.note = { text, tone: 'error' };
    this.render();
    return false;
  }

  /** One post's fields; they save with Save, or when the dialog closes or another section opens. */
  private postEditor(el: HTMLElement, v: SettingsView, d: TeamRole): void {
    const s = v.settings;
    this.head(el, d.id ? t('team.editTitle', { name: d.name }) : t('team.newTitle'), t('team.editor.lead'));
    const changed = () => {
      this.draftDirty = true;
      this.draftError = null;
    };
    const mark = (field: string, f: HTMLElement, control: HTMLElement) => {
      const label = f.querySelector<HTMLElement>('.setup-label');
      const hint = f.querySelector<HTMLElement>('.setup-hint');
      if (label) control.setAttribute('aria-labelledby', (label.id = `team-${field}-label`));
      if (hint) control.setAttribute('aria-describedby', (hint.id = `team-${field}-hint`));
      if (this.draftError?.field === field) {
        f.classList.add('invalid');
        control.setAttribute('aria-invalid', 'true');
      }
    };

    const nameField = this.field(t('team.field.name'), t('team.name.hint', { session: sessionNameOf({ name: slugify(d.name, ROLE_LIMITS.name) || '…' }) }));
    const name = this.input(d.name, t('team.name.placeholder'));
    name.maxLength = 40;
    name.dataset.autofocus = '';
    name.addEventListener('input', () => {
      d.name = name.value;
      changed();
      const hint = nameField.querySelector('.setup-hint');
      if (hint) hint.textContent = t('team.name.hint', { session: sessionNameOf({ name: slugify(d.name, ROLE_LIMITS.name) || '…' }) });
    });
    nameField.append(name);
    mark('name', nameField, name);
    el.append(nameField);

    const descField = this.field(t('team.field.description'), t('team.description.hint'));
    const desc = h('textarea', 'setup-textarea');
    desc.rows = 2;
    desc.maxLength = ROLE_LIMITS.description;
    desc.value = d.description;
    desc.placeholder = t('team.description.placeholder');
    desc.addEventListener('input', () => {
      d.description = desc.value;
      changed();
    });
    descField.append(desc);
    mark('description', descField, desc);
    el.append(descField);

    const instrField = this.field(t('team.field.instructions'), t('team.instructions.hint'));
    const instr = h('textarea', 'setup-textarea');
    instr.rows = 7;
    instr.maxLength = ROLE_LIMITS.instructions;
    instr.spellcheck = false;
    instr.value = d.instructions;
    instr.placeholder = t('team.instructions.placeholder');
    instr.addEventListener('input', () => {
      d.instructions = instr.value;
      changed();
    });
    instrField.append(instr);
    mark('instructions', instrField, instr);
    el.append(instrField);

    el.append(this.postFolders(d, s, changed, mark));

    const grid = h('div', 'setup-grid');
    const runField = this.field(t('team.field.model'), t('team.model.hint'));
    const model = h('select', 'setup-select');
    // A post on an account with a list of its own (Codex) picks from that list.
    const own = this.catalog(d.account || s.workerAccount);
    const options = own ?? this.models();
    const known = [...new Set([...(own ? own.map((m) => m.value) : [...this.models().map((m) => m.value).filter((m) => m !== 'default'), ...MODEL_ALIASES]), d.model].filter(Boolean))];
    model.append(new Option(t('team.autoModelLong'), ''), ...known.map((m) => new Option(options.find((x) => x.value === m)?.label ?? m, m)));
    model.value = d.model;
    model.setAttribute('aria-label', t('team.field.model'));
    const effort = h('select', 'setup-select');
    effort.append(new Option(t('team.autoEffortLong'), ''), ...EFFORTS.map((e) => new Option(effortLabel(e), e)));
    effort.value = d.effort;
    effort.setAttribute('aria-label', t('team.field.effort'));
    model.addEventListener('change', () => {
      d.model = model.value;
      changed();
    });
    effort.addEventListener('change', () => {
      d.effort = effort.value as Effort | '';
      changed();
    });
    const runRow = h('div', 'setup-row');
    runRow.append(model, effort);
    runField.append(runRow);
    mark('model', runField, model);
    grid.append(runField);

    const modeField = this.field(t('team.field.mode'), this.modeHint(d.mode, s.permissionMode));
    const mode = h('select', 'setup-select');
    const hubMode = s.permissionMode ? t(`setup.mode.${s.permissionMode}` as Key) : t('setup.mode.inherit');
    mode.append(new Option(t('team.mode.inherit', { mode: hubMode }), ''), ...ROLE_MODES.map((m) => new Option(t(`setup.mode.${m}` as Key), m)));
    mode.value = this.confirmPostBypass ? 'bypassPermissions' : d.mode;
    mode.addEventListener('change', () => {
      const picked = mode.value as Mode | '';
      // Allow everything only once confirmed below, as everywhere else.
      if (picked === 'bypassPermissions' && d.mode !== picked) {
        this.confirmPostBypass = true;
        return this.render();
      }
      this.confirmPostBypass = false;
      d.mode = picked;
      changed();
      this.render();
    });
    modeField.append(mode);
    mark('mode', modeField, mode);
    if (this.confirmPostBypass) modeField.append(this.postBypassConfirm(d, changed));
    grid.append(modeField);
    el.append(grid);

    // Only once there is another account than the usual one to pick.
    if (s.accounts.length > 0) {
      const usual = s.accounts.find((a) => a.id === s.workerAccount)?.name ?? t('account.default');
      const accountField = this.accountSelect(t('team.field.account'), t('team.account.hint'), d.account, s, (id) => {
        const before = this.catalog(d.account || s.workerAccount) !== null;
        d.account = id;
        changed();
        // The model list follows the account's program: a model of the other one means nothing there.
        if (before !== (this.catalog(d.account || s.workerAccount) !== null)) {
          d.model = '';
          this.render();
        }
      }, t('team.account.inherit', { account: usual }));
      const control = accountField.querySelector('select');
      if (control) mark('account', accountField, control);
      el.append(accountField);
    }

    const on = h('label', 'setup-toggle');
    const box = h('input');
    box.type = 'checkbox';
    box.checked = d.enabled;
    box.addEventListener('change', () => {
      d.enabled = box.checked;
      changed();
    });
    const onText = h('span', 'setup-choice-text');
    onText.append(h('span', 'setup-choice-title', t('team.enabled')), h('span', 'setup-choice-hint', t('team.enabled.hint')));
    on.append(box, onText);
    el.append(on);

    const actions = h('div', 'setup-row team-editor-actions');
    actions.append(
      this.button(t('team.save'), 'btn primary', () => {
        this.draftDirty = true;
        void this.saveDraft();
      }),
      this.button(t('setup.cancel'), 'btn ghost', () => {
        this.draft = null;
        this.draftDirty = false;
        this.note = null;
        this.render();
      }),
    );
    el.append(actions);
  }

  private postFolders(d: TeamRole, s: HubSettings, changed: () => void, mark: (field: string, f: HTMLElement, control: HTMLElement) => void): HTMLElement {
    const f = this.field(t('team.field.folders'), t('team.folders.hint', { max: FOLDERS_MAX }));
    const list = h('div', 'setup-folders');
    const set = (folders: string[]) => {
      d.folders = folders;
      changed();
      this.render();
    };
    const names = folderNames(d.folders);
    d.folders.forEach((dir, i) => {
      const row = h('div', 'setup-folder');
      const name = h('span', 'setup-folder-path', names[i]);
      name.title = dir;
      row.append(name);
      if (i === 0) row.append(h('span', 'setup-pill', t('team.folders.main')));
      else row.append(this.button(t('team.folders.makeMain'), 'btn ghost small', () => set([dir, ...d.folders.filter((x) => x !== dir)])));
      const remove = this.iconButton(t('team.folders.remove', { path: names[i] }), ICONS.remove, () => set(d.folders.filter((x) => x !== dir)));
      row.append(remove);
      list.append(row);
    });
    const row = h('div', 'setup-row');
    const free = s.mainRepos.filter((r) => !d.folders.includes(r));
    const full = d.folders.length >= FOLDERS_MAX;
    if (free.length > 0) {
      const pick = h('select', 'setup-select');
      pick.setAttribute('aria-label', t('team.folders.repo'));
      pick.append(new Option(t('team.folders.repo'), ''), ...free.map((r) => new Option(r.split(/[\\/]/).filter(Boolean).pop() ?? r, r)));
      pick.disabled = full;
      pick.addEventListener('change', () => pick.value && set([...d.folders, pick.value]));
      row.append(pick);
    }
    row.append(
      this.button(
        t('team.folders.add'),
        'btn',
        async () => {
          const dir = await this.hub.pickFolder();
          if (dir && !d.folders.includes(dir)) set([...d.folders, dir]);
        },
        full,
      ),
    );
    f.append(list, row);
    mark('folders', f, list);
    return f;
  }

  /** What the chosen mode means next to the other sessions: a bypass mismatch holds their messages. */
  private modeHint(mode: Mode | '', hub: Mode | ''): string {
    const bypass = (m: Mode | '') => m === 'bypassPermissions';
    return mode && bypass(mode) !== bypass(hub) ? t('team.mode.mismatch') : t('team.mode.hint');
  }

  private postBypassConfirm(d: TeamRole, changed: () => void): HTMLElement {
    const box = h('div', 'setup-confirm');
    const label = h('label', 'setup-toggle');
    const check = h('input');
    check.type = 'checkbox';
    label.append(check, h('span', 'setup-choice-hint', t('team.mode.bypassConfirm', { name: d.name || '…' })));
    const enable = this.button(
      t('setup.mode.bypassEnable'),
      'btn danger',
      () => {
        this.confirmPostBypass = false;
        d.mode = 'bypassPermissions';
        changed();
        this.render();
      },
      true,
    );
    check.addEventListener('change', () => (enable.disabled = !check.checked));
    const cancel = this.button(t('setup.cancel'), 'btn ghost', () => {
      this.confirmPostBypass = false;
      this.render();
    });
    const row = h('div', 'setup-row');
    row.append(enable, cancel);
    box.append(label, row);
    return box;
  }

  private about(el: HTMLElement, v: SettingsView): void {
    this.head(el, APP_NAME, t('setup.about.lead'));
    const list = h('ul', 'setup-list');
    list.append(h('li', '', t('setup.about.version', { version: v.version })), h('li', '', t('setup.about.license')), h('li', '', t('setup.about.data')));
    el.append(list, updateSection(), h('p', 'setup-fine', t('setup.about.trademark')));
  }
}
