import { PROVIDER_DEFS, providerDef, type ProviderId, type ProviderMethod } from '../shared/providers';
import type { HubApi, ProviderAccountView, ProviderView } from '../shared/types';
import { h } from './dom';
import { t } from './i18n';

// Settings › Accounts: one block per provider, always there. Each says whether it is connected and offers one main
// action. The accounts the hub keeps behind them, the programs and the models are none of the user's business here.

const WAIT_MS = 5 * 60_000;
const POLL_MS = 4000;

/** Monograms standing for the providers' logos: a letter on the colour each is known by. */
const MARK: Record<ProviderId, { letter: string; color: string }> = {
  anthropic: { letter: 'A', color: '#d97757' },
  openai: { letter: 'O', color: '#10a37f' },
  deepseek: { letter: 'D', color: '#4d6bfe' },
  gemini: { letter: 'G', color: '#4285f4' },
};

/** The providers that offer their program's own sign-in beside an API key: how each says it. */
const TWO_WAYS: Partial<Record<ProviderId, { login: ProviderMethod; install: string }>> = {
  openai: { login: 'chatgpt', install: 'npm install -g @openai/codex' },
  gemini: { login: 'google', install: 'npm install -g @google/gemini-cli' },
};

export interface PanelHost {
  /** Draws the section again (after a state change). */
  rerender(): void;
  /** An error code of the main process, in words. */
  errorText(code: string): string;
  /** The user is still on this section: polling goes on only then. */
  visible(): boolean;
}

export class ProvidersPanel {
  private views: ProviderView[] | null = null;
  private loading = false;
  private readonly busy = new Set<ProviderId>();
  /** Which way of connecting a provider the block shows (OpenAI offers two). */
  private readonly shown: Partial<Record<ProviderId, ProviderMethod>> = {};
  /** The key being typed in each block, kept across redraws. */
  private readonly keys: Partial<Record<ProviderId, string>> = {};
  private readonly errors: Partial<Record<ProviderId, string>> = {};
  private confirming: ProviderId | '' = '';
  private waiting: { provider: ProviderId; until: number; account?: string } | null = null;
  /** The Anthropic account whose removal or sign-out waits for a yes, and the one an action is running on. */
  private confirmAccount = '';
  private busyAccount = '';
  private timer = 0;

  constructor(
    private readonly hub: HubApi,
    private readonly host: PanelHost,
  ) {}

  /** Leaving the section: nothing keeps polling, nothing typed stays. */
  reset(): void {
    window.clearTimeout(this.timer);
    this.waiting = null;
    this.confirming = '';
    this.confirmAccount = '';
    for (const k of Object.keys(this.keys) as ProviderId[]) delete this.keys[k];
    for (const k of Object.keys(this.errors) as ProviderId[]) delete this.errors[k];
  }

  /** The blocks as they are now; the first time (or after an action) their state is asked in the background. */
  mount(el: HTMLElement): void {
    if (!this.views && !this.loading) void this.refresh();
    const wrap = h('div', 'provider-cards');
    for (const def of PROVIDER_DEFS) wrap.append(this.card(def.id));
    el.append(wrap);
  }

  async refresh(): Promise<void> {
    this.loading = true;
    try {
      this.views = await this.hub.providers();
    } catch {
      this.views ??= [];
    } finally {
      this.loading = false;
    }
    const w = this.waiting;
    const view = w ? this.views.find((v) => v.id === w.provider) : undefined;
    if (w && (w.account ? view?.accounts?.find((a) => a.id === w.account)?.connected : view?.connected)) this.waiting = null;
    this.host.rerender();
  }

  private watch(): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.poll(), POLL_MS);
  }

  private async poll(): Promise<void> {
    const w = this.waiting;
    if (!w) return;
    if (Date.now() > w.until || !this.host.visible()) {
      this.waiting = null;
      return;
    }
    await this.refresh();
    if (this.waiting) this.watch();
  }

  private view(id: ProviderId): ProviderView | undefined {
    return this.views?.find((v) => v.id === id);
  }

  private card(id: ProviderId): HTMLElement {
    const v = this.view(id);
    const def = providerDef(id);
    const card = h('div', 'provider-card');
    card.dataset.provider = id;

    const head = h('div', 'provider-head');
    const logo = h('span', 'provider-logo', MARK[id].letter);
    logo.style.background = MARK[id].color;
    logo.setAttribute('aria-hidden', 'true');
    const title = h('div', 'provider-title');
    const detail = v?.connected ? (v.methods[v.method as ProviderMethod]?.detail ?? '') : '';
    title.append(h('b', '', def.label), ...(detail ? [h('span', 'provider-sub', detail)] : []));
    const error = this.errorOf(id, v);
    const pill = !v ? h('span', 'setup-pill', t('provider.checking')) : v.connected ? h('span', 'setup-pill ok', t('provider.connected')) : error ? h('span', 'setup-pill warn', t('provider.error')) : h('span', 'setup-pill muted', t('provider.disconnected'));
    head.append(logo, title, pill);
    card.append(head);

    const body = h('div', 'provider-body');
    if (id === 'anthropic') this.anthropicBody(body, v);
    else if (TWO_WAYS[id]) this.twoWaysBody(body, id, v);
    else this.keyBody(body, id, v, 'apikey');
    if (error) body.append(h('div', 'provider-error', error));
    card.append(body);
    return card;
  }

  private errorOf(id: ProviderId, v: ProviderView | undefined): string {
    const own = this.errors[id];
    if (own) return this.host.errorText(own);
    if (!v || v.connected) return '';
    const method = this.shown[id] ?? v.method ?? def0(id);
    const code = v.methods[method as ProviderMethod]?.error ?? '';
    return code ? this.host.errorText(code) : '';
  }

  // ---------- Anthropic: Claude Code's own sign-in ----------

  private anthropicBody(el: HTMLElement, v: ProviderView | undefined): void {
    if (!v) return;
    if (v.cli && !v.cli.found) {
      el.append(h('p', 'provider-hint', t('provider.anthropic.missing')), this.button(t('provider.anthropic.install'), 'btn primary small', () => void this.install()));
      return;
    }
    // Several accounts: the active one serves the master and the new workers; one at work keeps its own.
    const accounts = v.accounts ?? [];
    el.append(h('p', 'provider-hint', t(accounts.length > 1 ? 'provider.accounts.hint' : 'provider.anthropic.hint')));
    const list = h('div', 'provider-accounts');
    for (const a of accounts) list.append(this.accountRow(a));
    el.append(list);
    el.append(this.button(this.busyAccount === 'add' ? t('provider.connecting') : t('provider.accounts.add'), 'btn ghost small', () => void this.accountAction('add', ''), this.busyAccount !== ''));
  }

  private accountRow(a: ProviderAccountView): HTMLElement {
    const row = h('div', a.active ? 'provider-account active' : 'provider-account');
    const text = h('div', 'provider-account-text');
    const title = h('div', 'provider-account-title');
    title.append(h('b', '', a.name));
    if (a.active) title.append(h('span', 'setup-pill', t('provider.accounts.active')));
    title.append(a.connected ? h('span', 'setup-pill ok', t('provider.connected')) : h('span', 'setup-pill warn', t(a.removable ? 'provider.accounts.expired' : 'provider.disconnected')));
    text.append(title);
    if (a.detail) text.append(h('span', 'provider-sub', a.detail));
    if (this.waiting?.account === a.id) text.append(h('span', 'provider-wait', t('provider.waiting')));
    const actions = h('div', 'provider-account-actions');
    const busy = this.busyAccount !== '';
    if (this.confirmAccount === a.id) {
      actions.append(
        h('span', 'provider-hint', t(a.removable ? 'provider.accounts.removeConfirm' : 'provider.anthropic.confirm', { name: a.name })),
        this.button(t(a.removable ? 'provider.accounts.remove' : 'provider.disconnect'), 'btn danger small', () => void this.accountAction(a.removable ? 'remove' : 'logout', a.id), busy),
        this.button(t('setup.cancel'), 'btn ghost small', () => {
          this.confirmAccount = '';
          this.host.rerender();
        }),
      );
    } else {
      if (!a.active && a.connected) actions.append(this.button(t('provider.accounts.use'), 'btn primary small', () => void this.accountAction('use', a.id), busy));
      if (!a.connected) actions.append(this.button(t('provider.accounts.relogin'), 'btn primary small', () => void this.accountAction('login', a.id), busy));
      if (a.removable || a.connected) {
        actions.append(
          this.button(t(a.removable ? 'provider.accounts.remove' : 'provider.disconnect'), 'btn ghost small', () => {
            this.confirmAccount = a.id;
            this.host.rerender();
          }, busy),
        );
      }
    }
    row.append(text, actions);
    return row;
  }

  private async accountAction(action: 'use' | 'add' | 'login' | 'remove' | 'logout', id: string): Promise<void> {
    this.busyAccount = action === 'add' ? 'add' : id;
    this.confirmAccount = '';
    delete this.errors.anthropic;
    this.host.rerender();
    // Signing the user's own account out is the provider's own sign-out.
    const r = action === 'logout' ? { ...(await this.hub.disconnectProvider('anthropic', 'cli')), opened: false } : await this.hub.anthropicAccount(action, id);
    this.busyAccount = '';
    if (r.views.length > 0) this.views = r.views;
    if (!r.ok) this.errors.anthropic = r.error || 'unknown';
    // A sign-in was opened in a terminal window: the account is looked at every few seconds until it is in.
    const account = action === 'add' ? this.views?.find((v) => v.id === 'anthropic')?.accounts?.at(-1)?.id : id;
    if (r.opened && account) {
      this.waiting = { provider: 'anthropic', until: Date.now() + WAIT_MS, account };
      this.watch();
    }
    this.host.rerender();
  }

  private async install(): Promise<void> {
    await this.hub.claudeTerminal('install');
    this.waiting = { provider: 'anthropic', until: Date.now() + WAIT_MS };
    this.watch();
    this.host.rerender();
  }

  // ---------- OpenAI, Gemini: the program's own sign-in (ChatGPT, Google) or an API key ----------

  private twoWaysBody(el: HTMLElement, id: ProviderId, v: ProviderView | undefined): void {
    const way = TWO_WAYS[id];
    if (!v || !way) return;
    const pre = `provider.${id}`;
    const method: ProviderMethod = this.shown[id] ?? (v.method || way.login);
    const seg = h('div', 'provider-methods');
    for (const m of [way.login, 'apikey'] as ('chatgpt' | 'google' | 'apikey')[]) {
      const on = v.methods[m]?.connected;
      const b = h('button', m === method ? 'seg active' : 'seg', `${t(`provider.method.${m}`)}${on ? ' ✓' : ''}`);
      b.addEventListener('click', () => {
        this.shown[id] = m;
        delete this.errors[id];
        this.host.rerender();
      });
      seg.append(b);
    }
    el.append(seg);
    if (method === 'apikey') return this.keyBody(el, id, v, 'apikey');

    const cli = v.cli;
    if (cli && !cli.found) {
      el.append(h('p', 'provider-hint', t(`${pre}.missing` as Parameters<typeof t>[0])), h('code', 'provider-code', way.install));
      return;
    }
    if (cli?.outdated) el.append(h('p', 'provider-hint warn', t(`${pre}.outdated` as Parameters<typeof t>[0], { version: cli.version })));
    if (v.methods[way.login]?.connected) return el.append(this.disconnectRow(id, way.login, t(`${pre}.confirm` as Parameters<typeof t>[0])));
    el.append(h('p', 'provider-hint', t(`${pre}.hint` as Parameters<typeof t>[0])), this.signIn(id, way.login, t(`${pre}.signIn` as Parameters<typeof t>[0])));
  }

  // ---------- API key (DeepSeek, OpenAI's key) ----------

  private keyBody(el: HTMLElement, id: ProviderId, v: ProviderView | undefined, method: ProviderMethod): void {
    if (!v) return;
    if (v.methods[method]?.connected) return el.append(this.disconnectRow(id, method, t('provider.key.confirm')));
    const row = h('div', 'provider-keyrow');
    const input = h('input', 'setup-input');
    input.type = 'password';
    input.placeholder = 'sk-…';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.value = this.keys[id] ?? '';
    input.setAttribute('aria-label', t('provider.key.label', { name: providerDef(id).label }));
    input.addEventListener('input', () => (this.keys[id] = input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void this.connect(id, method);
    });
    const go = this.button(this.busy.has(id) ? t('provider.connecting') : t('provider.connect'), 'btn primary', () => void this.connect(id, method), this.busy.has(id));
    row.append(input, go);
    el.append(h('p', 'provider-hint', t(`provider.${id}.${id === 'deepseek' ? 'hint' : 'keyHint'}` as Parameters<typeof t>[0])), row);
    const url = providerDef(id).keyUrl;
    if (url) {
      const link = h('button', 'setup-link', t('provider.key.where', { name: providerDef(id).label }));
      link.addEventListener('click', () => this.hub.openExternal(url));
      el.append(link);
    }
  }

  private async connect(id: ProviderId, method: ProviderMethod): Promise<void> {
    const key = (this.keys[id] ?? '').trim();
    if (!key) {
      this.errors[id] = 'required';
      return this.host.rerender();
    }
    this.busy.add(id);
    delete this.errors[id];
    this.host.rerender();
    const r = await this.hub.connectProvider(id, method, key);
    this.busy.delete(id);
    if (r.views.length > 0) this.views = r.views;
    if (r.ok) delete this.keys[id];
    else this.errors[id] = r.error || 'unknown';
    this.host.rerender();
  }

  // ---------- shared ----------

  private signIn(id: ProviderId, method: ProviderMethod, label: string): HTMLElement {
    const box = h('div', 'provider-actions');
    const waiting = this.waiting?.provider === id;
    box.append(this.button(label, 'btn primary', () => void this.login(id, method), this.busy.has(id)));
    if (waiting) box.append(h('span', 'provider-wait', t(method === 'google' ? 'provider.waitingBrowser' : 'provider.waiting')));
    return box;
  }

  private async login(id: ProviderId, method: ProviderMethod): Promise<void> {
    this.busy.add(id);
    delete this.errors[id];
    this.host.rerender();
    const opened = await this.hub.loginProvider(id, method);
    this.busy.delete(id);
    if (opened) {
      this.waiting = { provider: id, until: Date.now() + WAIT_MS };
      this.watch();
    } else this.errors[id] = id === 'openai' ? 'no-codex' : id === 'gemini' ? 'no-gemini' : 'no-terminal';
    this.host.rerender();
  }

  private disconnectRow(id: ProviderId, method: ProviderMethod, confirmText: string): HTMLElement {
    const row = h('div', 'provider-actions');
    if (this.confirming === id) {
      row.append(
        h('span', 'provider-hint', confirmText),
        this.button(t('provider.disconnect'), 'btn danger small', () => void this.disconnect(id, method), this.busy.has(id)),
        this.button(t('setup.cancel'), 'btn ghost small', () => {
          this.confirming = '';
          this.host.rerender();
        }),
      );
      return row;
    }
    row.append(
      this.button(t('provider.disconnect'), 'btn ghost small', () => {
        this.confirming = id;
        this.host.rerender();
      }),
    );
    return row;
  }

  private async disconnect(id: ProviderId, method: ProviderMethod): Promise<void> {
    this.busy.add(id);
    this.confirming = '';
    this.host.rerender();
    const r = await this.hub.disconnectProvider(id, method);
    this.busy.delete(id);
    if (r.views.length > 0) this.views = r.views;
    if (!r.ok) this.errors[id] = r.error || 'unknown';
    this.host.rerender();
  }

  private button(label: string, cls: string, run: () => void, disabled = false): HTMLButtonElement {
    const b = h('button', cls, label);
    b.disabled = disabled;
    b.addEventListener('click', run);
    return b;
  }
}

const def0 = (id: ProviderId): ProviderMethod => providerDef(id).methods[0];
