import { providerDef, type ProviderId, type ProviderMethod } from '../shared/providers';
import type { HubApi, ProviderView } from '../shared/types';
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
  private waiting: { provider: ProviderId; until: number } | null = null;
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
    for (const k of Object.keys(this.keys) as ProviderId[]) delete this.keys[k];
    for (const k of Object.keys(this.errors) as ProviderId[]) delete this.errors[k];
  }

  /** The blocks as they are now; the first time (or after an action) their state is asked in the background. */
  mount(el: HTMLElement): void {
    if (!this.views && !this.loading) void this.refresh();
    const wrap = h('div', 'provider-cards');
    for (const def of ['anthropic', 'openai', 'deepseek'] as ProviderId[]) wrap.append(this.card(def));
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
    if (w && this.views.find((v) => v.id === w.provider)?.connected) this.waiting = null;
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
    else if (id === 'openai') this.openaiBody(body, v);
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
    if (v.connected) return el.append(this.disconnectRow('anthropic', 'cli', t('provider.anthropic.confirm')));
    el.append(h('p', 'provider-hint', t('provider.anthropic.hint')), this.signIn('anthropic', 'cli', t('provider.anthropic.signIn')));
  }

  private async install(): Promise<void> {
    await this.hub.claudeTerminal('install');
    this.waiting = { provider: 'anthropic', until: Date.now() + WAIT_MS };
    this.watch();
    this.host.rerender();
  }

  // ---------- OpenAI: ChatGPT sign-in or an API key ----------

  private openaiBody(el: HTMLElement, v: ProviderView | undefined): void {
    if (!v) return;
    const method: ProviderMethod = this.shown.openai ?? (v.method || 'chatgpt');
    const seg = h('div', 'provider-methods');
    for (const m of ['chatgpt', 'apikey'] as const) {
      const on = v.methods[m]?.connected;
      const b = h('button', m === method ? 'seg active' : 'seg', `${t(`provider.method.${m}`)}${on ? ' ✓' : ''}`);
      b.addEventListener('click', () => {
        this.shown.openai = m;
        delete this.errors.openai;
        this.host.rerender();
      });
      seg.append(b);
    }
    el.append(seg);
    if (method === 'apikey') return this.keyBody(el, 'openai', v, 'apikey');

    const cli = v.cli;
    if (cli && !cli.found) {
      el.append(h('p', 'provider-hint', t('provider.openai.missing')), h('code', 'provider-code', 'npm install -g @openai/codex'));
      return;
    }
    if (cli?.outdated) el.append(h('p', 'provider-hint warn', t('provider.openai.outdated', { version: cli.version })));
    if (v.methods.chatgpt?.connected) return el.append(this.disconnectRow('openai', 'chatgpt', t('provider.openai.confirm')));
    el.append(h('p', 'provider-hint', t('provider.openai.hint')), this.signIn('openai', 'chatgpt', t('provider.openai.signIn')));
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
    el.append(h('p', 'provider-hint', t(id === 'openai' ? 'provider.openai.keyHint' : 'provider.deepseek.hint')), row);
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
    if (waiting) box.append(h('span', 'provider-wait', t('provider.waiting')));
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
    } else this.errors[id] = id === 'openai' ? 'no-codex' : 'no-terminal';
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
