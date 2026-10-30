import { OWN_ACCOUNT } from '../shared/accounts';
import { CLI_PACKAGES } from '../shared/news';
import { isProviderId, PROVIDER_DEFS, providerDef, type ProviderId, type ProviderMethod } from '../shared/providers';
import type { CustomProviderAction, HubApi, ProviderAccountView, ProviderView } from '../shared/types';
import { errorNote, h, icon, ICONS } from './dom';
import { t, type Key } from './i18n';
import { mascotMark } from './mascot';

// Settings › Accounts: one row per provider, all built the same way. A row says whether the provider is connected and
// offers one action; the way of connecting (an account or an API key, Anthropic's other accounts) waits behind its
// chevron. The program a sign-in runs in is installed by the app when it is missing: the user never types a command.

const WAIT_MS = 5 * 60_000;
const POLL_MS = 4000;

/** Codes that only say the program is not there yet: connecting installs it, so they are no error. */
const NOT_INSTALLED = new Set(['no-claude', 'no-codex', 'no-gemini']);

type Phase = 'check' | 'install' | 'connect' | 'disconnect';
type Waiting = { provider: ProviderId; until: number; account?: string; what: 'signIn' | 'browser' | 'install' };

/**
 * The form of a provider the user adds (`id` empty) or changes (its account's id): what is typed, kept across redraws,
 * and the last result of its buttons. The key is only what is typed here: the stored one never comes back.
 */
interface CustomForm {
  id: string;
  name: string;
  baseUrl: string;
  key: string;
  models: string;
  /** The server's own list, once asked for: the models to pick from. */
  listed: string[];
  busy: CustomProviderAction | '';
  /** The last error: its code, the field it is about, the server's words. */
  error: string;
  field: string;
  detail: string;
  /** The test's answer, once it worked. */
  passed: string;
}

const blankForm = (id: string): CustomForm => ({ id, name: '', baseUrl: '', key: '', models: '', listed: [], busy: '', error: '', field: '', detail: '', passed: '' });

/** The models typed in the form: one per line, or separated by commas or spaces. */
const parseModels = (text: string) => [...new Set(text.split(/[\s,]+/).filter(Boolean))];
/** More than this many models in a server's list: none is picked for the user, they choose. */
const PICK_ALL_MAX = 30;

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
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
  /** The rows unfolded to show the ways of connecting. */
  private readonly open = new Set<ProviderId>();
  /** The way of connecting each unfolded row shows. */
  private readonly shown: Partial<Record<ProviderId, ProviderMethod>> = {};
  /** The key being typed in each row, kept across redraws. */
  private readonly keys: Partial<Record<ProviderId, string>> = {};
  /** What failed last in each row, and how to try it again; a provider's error never shows in another's row. */
  private readonly errors: Record<string, { code: string; retry: () => void }> = {};
  private readonly phases = new Map<string, Phase>();
  private confirming = '';
  /** The provider the user adds or changes, while its form is open. */
  private form: CustomForm | null = null;
  /** The providers' state could not be read: every row says so and offers to try again. */
  private unreadable = false;
  private waiting: Waiting | null = null;
  /** The Anthropic account whose removal waits for a yes, and the one an action is running on. */
  private confirmAccount = '';
  private busyAccount = '';
  private focusKey: ProviderId | '' = '';
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
    this.form = null;
    for (const k of Object.keys(this.keys) as ProviderId[]) delete this.keys[k];
    for (const k of Object.keys(this.errors)) delete this.errors[k];
  }

  /** The rows as they are now; the first time their state is asked in the background. */
  mount(el: HTMLElement): void {
    if (!this.views && !this.loading) void this.refresh();
    const list = h('div', 'acct-list');
    for (const def of PROVIDER_DEFS) list.append(this.row(def.id));
    // The providers the user added, then the way to add one.
    for (const v of this.views ?? []) if (v.custom) list.append(this.customRow(v, v.custom));
    if (this.views) list.append(this.form?.id === '' ? this.customItem() : this.addRow());
    el.append(list);
    if (this.focusKey) {
      list.querySelector<HTMLInputElement>(`[data-provider="${this.focusKey}"] input`)?.focus();
      this.focusKey = '';
    }
  }

  async refresh(): Promise<void> {
    this.loading = true;
    try {
      this.views = await this.hub.providers();
      this.unreadable = false;
    } catch {
      this.unreadable = this.views === null;
    } finally {
      this.loading = false;
    }
    const w = this.waiting;
    const view = w ? this.view(w.provider) : undefined;
    if (w?.what === 'install' && view?.cli?.found) {
      // Anthropic's installer is done: the sign-in comes next, by itself.
      this.waiting = null;
      void this.signIn(w.provider, 'cli');
    } else if (w && (w.account ? view?.accounts?.find((a) => a.id === w.account)?.connected : view?.connected)) this.waiting = null;
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

  private wait(w: Omit<Waiting, 'until'>): void {
    this.waiting = { ...w, until: Date.now() + WAIT_MS };
    this.watch();
  }

  private view(id: string): ProviderView | undefined {
    return this.views?.find((v) => v.id === id);
  }

  /** The way of connecting a row stands for: the one connected, else the one picked, else the provider's first. */
  private methodOf(id: ProviderId, v: ProviderView | undefined): ProviderMethod {
    return this.shown[id] ?? (v?.method || providerDef(id).methods[0]);
  }

  /** The program has to be installed (or updated) before this way of connecting can work. */
  private needsTool(id: ProviderId, method: ProviderMethod): boolean {
    const cli = this.view(id)?.cli;
    if (!cli || (cli.found && !cli.outdated)) return false;
    return (id === 'anthropic' && method !== 'apikey') || id === 'gemini' || (id === 'openai' && method === 'chatgpt');
  }

  private fail(id: string, code: string, retry: () => void): void {
    this.errors[id] = { code, retry };
  }

  /** An error code of this provider, in one line that names it when the words alone would not say whose it is. */
  private errorText(id: string, code: string): string {
    const name = isProviderId(id) ? providerDef(id).label : (this.view(id)?.label ?? id);
    const tool = (isProviderId(id) && CLI_PACKAGES[id]?.tool) || name;
    if (code === 'timeout') return t('provider.err.timeout', { name });
    if (code === 'probe-failed') return t('provider.err.probe', { name });
    if (code === 'no-node') return t('provider.err.noNode', { tool });
    if (code === 'install-failed') return t('provider.err.install', { tool });
    if (code === 'no-terminal') return t('provider.err.noWindow');
    return this.host.errorText(code);
  }

  /** The error the row shows: its own last action's, else the one its state was checked with. */
  private errorOf(id: ProviderId, v: ProviderView | undefined): string {
    const own = this.errors[id];
    if (own) return this.errorText(id, own.code);
    if (!v || v.connected) return '';
    const code = v.methods[this.methodOf(id, v)]?.error ?? '';
    return code && !NOT_INSTALLED.has(code) ? this.errorText(id, code) : '';
  }

  // ---------- the row ----------

  private row(id: ProviderId): HTMLElement {
    const v = this.view(id);
    const def = providerDef(id);
    const error = this.errorOf(id, v);
    const phase = this.phases.get(id);
    const waiting = this.waiting?.provider === id && !this.waiting.account ? this.waiting : null;
    const open = this.open.has(id);

    const item = h('div', open ? 'acct open' : 'acct');
    item.dataset.provider = id;
    const row = h('div', 'acct-row');
    const mark = mascotMark(id, 'acct-mark');
    const text = h('div', 'acct-text');
    text.append(h('span', 'acct-name', def.label));
    const sub = this.subLine(id, v, error, waiting);
    if (sub) text.append(sub);

    const state = h('span', 'acct-state');
    const busy = (!v && !this.unreadable) || phase !== undefined || waiting !== null;
    if (!v && this.unreadable) {
      state.classList.add('err');
      state.append(h('span', 'acct-dot'), document.createTextNode(t('provider.error')));
      text.append(h('span', 'acct-sub err', t('provider.err.probe', { name: def.label })));
    } else if (busy) {
      state.classList.add('busy');
      state.append(h('span', 'acct-spin'), document.createTextNode(t(!v || phase === 'check' ? 'provider.checking' : phase === 'install' || waiting?.what === 'install' ? 'provider.installing' : phase === 'disconnect' ? 'provider.disconnecting' : 'provider.connecting')));
    } else if (v) {
      const tone = v.connected ? 'on' : error ? 'err' : 'off';
      state.classList.add(tone);
      state.append(h('span', 'acct-dot'), document.createTextNode(t(tone === 'on' ? 'provider.connected' : tone === 'err' ? 'provider.error' : 'provider.disconnected')));
    }

    const actions = h('div', 'acct-actions');
    if (v) actions.append(...this.mainActions(id, v, error, phase, waiting));
    else if (this.unreadable) actions.append(this.button(t('provider.retry'), 'btn small', () => void this.refresh()));
    const more = h('button', 'icon-btn acct-more');
    more.append(icon(ICONS.chevron));
    more.setAttribute('aria-expanded', String(open));
    more.setAttribute('aria-label', t(open ? 'provider.less' : 'provider.more', { name: def.label }));
    more.title = t('provider.options');
    more.disabled = !v;
    more.addEventListener('click', () => this.toggle(id));
    row.append(mark, text, state, actions, more);
    item.append(row);
    if (open && v) item.append(this.details(id, v));
    return item;
  }

  /** Under the name: who it is connected as, what to finish, what failed, or the question before a sign-out. */
  private subLine(id: ProviderId, v: ProviderView | undefined, error: string, waiting: Waiting | null): HTMLElement | null {
    if (!v) return null;
    if (this.confirming === id) return h('span', 'acct-sub', this.confirmText(id, v));
    if (waiting) return h('span', 'acct-sub', t(waiting.what === 'install' ? 'provider.waitInstall' : waiting.what === 'browser' ? 'provider.waitingBrowser' : 'provider.waiting'));
    if (error && !this.phases.has(id)) return h('span', 'acct-sub err', error);
    if (!v.connected) return null;
    return h('span', 'acct-sub', this.connectedAs(id, v));
  }

  /** "ChatGPT · ana@example.com", "API key", "Claude account · …": the way it is connected, and as whom. */
  private connectedAs(id: ProviderId, v: ProviderView): string {
    const method = v.method as ProviderMethod;
    if (method === 'apikey') return t('provider.method.apikey');
    const active = v.accounts?.find((a) => a.active);
    const who = id === 'anthropic' && active && active.id !== OWN_ACCOUNT ? [active.name, active.detail] : [v.methods[method]?.detail ?? ''];
    return [t(`provider.method.${method}` as Key), ...who].filter(Boolean).join(' · ');
  }

  private confirmText(id: ProviderId, v: ProviderView): string {
    const active = v.accounts?.find((a) => a.active);
    if (id === 'anthropic' && v.method === 'cli') return active?.removable ? t('provider.accounts.removeConfirm', { name: active.name }) : t('provider.anthropic.confirm');
    return t(v.method === 'apikey' ? 'provider.key.confirm' : 'provider.signOut.confirm', { name: providerDef(id).label });
  }

  /** The row's one action: connect, disconnect, try again (with its confirmation, while one is asked). */
  private mainActions(id: ProviderId, v: ProviderView, error: string, phase: Phase | undefined, waiting: Waiting | null): HTMLElement[] {
    if (phase) return [];
    if (waiting) {
      return [
        this.button(t('setup.cancel'), 'btn ghost small', () => {
          this.waiting = null;
          this.host.rerender();
        }),
      ];
    }
    if (this.confirming === id) {
      return [
        this.button(t('setup.cancel'), 'btn ghost small', () => {
          this.confirming = '';
          this.host.rerender();
        }),
        this.button(t('provider.disconnect'), 'btn danger small', () => void this.disconnect(id, v)),
      ];
    }
    if (v.connected) {
      return [
        this.button(t('provider.disconnect'), 'btn small', () => {
          this.confirming = id;
          this.host.rerender();
        }),
      ];
    }
    const own = this.errors[id];
    if (error) return [this.button(t('provider.retry'), 'btn small', () => (own ? own.retry() : void this.recheck(id)))];
    return [this.button(t('provider.connect'), 'btn small', () => this.start(id))];
  }

  private toggle(id: ProviderId): void {
    if (this.open.has(id)) this.open.delete(id);
    else this.open.add(id);
    delete this.shown[id];
    this.host.rerender();
  }

  // ---------- unfolded: the ways of connecting ----------

  private details(id: ProviderId, v: ProviderView): HTMLElement {
    const box = h('div', 'acct-details');
    const methods = providerDef(id).methods;
    const method = this.methodOf(id, v);
    if (methods.length > 1) {
      const seg = h('div', 'segmented acct-methods');
      seg.setAttribute('role', 'tablist');
      for (const m of methods) {
        const b = h('button', m === method ? 'seg active' : 'seg', t(`provider.method.${m}` as Key));
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', String(m === method));
        b.addEventListener('click', () => {
          this.shown[id] = m;
          delete this.errors[id];
          this.host.rerender();
        });
        seg.append(b);
      }
      box.append(seg);
    }
    box.append(h('p', 'acct-hint', t(`provider.${id}.${method}` as Key)));
    if (method === 'apikey') {
      if (!v.methods.apikey?.connected) box.append(this.keyForm(id));
    } else if (!v.methods[method]?.connected && v.connected) {
      // Connected another way: this one is offered here, the row's action being the sign-out.
      box.append(this.button(t('provider.connectWith', { method: t(`provider.method.${method}` as Key) }), 'btn ghost small', () => void this.signIn(id, method), this.phases.has(id)));
    }
    if (id === 'anthropic' && method === 'cli') box.append(this.anthropicAccounts(v));
    return box;
  }

  private keyForm(id: ProviderId): HTMLElement {
    const form = h('div', 'acct-keyrow');
    const input = h('input', 'setup-input');
    input.type = 'password';
    input.placeholder = id === 'anthropic' ? 'sk-ant-…' : id === 'gemini' ? 'AIza…' : 'sk-…';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.value = this.keys[id] ?? '';
    input.setAttribute('aria-label', t('provider.key.label', { name: providerDef(id).label }));
    input.addEventListener('input', () => (this.keys[id] = input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !this.phases.has(id)) void this.connectKey(id);
    });
    form.append(input, this.button(t('provider.key.save'), 'btn', () => void this.connectKey(id), this.phases.has(id)));
    const url = providerDef(id).keyUrl;
    if (url) {
      const link = h('button', 'setup-link', t('provider.key.where'));
      link.addEventListener('click', () => this.hub.openExternal(url));
      form.append(link);
    }
    return form;
  }

  // ---------- Anthropic: the user's own sign-in and the accounts added beside it ----------

  private anthropicAccounts(v: ProviderView): HTMLElement {
    const box = h('div', 'acct-sublist');
    const accounts = v.accounts ?? [];
    // The user's own account alone is the row itself: the list shows once there are others.
    if (accounts.some((a) => a.removable)) for (const a of accounts) box.append(this.accountRow(a));
    box.append(this.button(this.busyAccount === 'add' ? t('provider.connecting') : t('provider.accounts.add'), 'btn ghost small acct-add', () => void this.accountAction('add', ''), this.busyAccount !== '' || !v.cli?.found));
    return box;
  }

  private accountRow(a: ProviderAccountView): HTMLElement {
    const row = h('div', 'acct-subrow');
    const text = h('div', 'acct-text');
    text.append(h('span', 'acct-name', a.active ? `${a.name} · ${t('provider.accounts.active')}` : a.name));
    const waiting = this.waiting?.account === a.id;
    const sub = this.confirmAccount === a.id ? t('provider.accounts.removeConfirm', { name: a.name }) : waiting ? t('provider.waiting') : a.connected ? a.detail : t(a.removable ? 'provider.accounts.expired' : 'provider.disconnected');
    if (sub) text.append(h('span', 'acct-sub', sub));
    const actions = h('div', 'acct-actions');
    const busy = this.busyAccount !== '';
    if (this.confirmAccount === a.id) {
      actions.append(
        this.button(t('setup.cancel'), 'btn ghost small', () => {
          this.confirmAccount = '';
          this.host.rerender();
        }),
        this.button(t('provider.accounts.remove'), 'btn danger small', () => void this.accountAction('remove', a.id), busy),
      );
    } else {
      if (!a.active && a.connected) actions.append(this.button(t('provider.accounts.use'), 'btn ghost small', () => void this.accountAction('use', a.id), busy));
      if (!a.connected) actions.append(this.button(t('provider.accounts.relogin'), 'btn ghost small', () => void this.accountAction('login', a.id), busy || waiting));
      if (a.removable) {
        actions.append(
          this.button(t('provider.accounts.remove'), 'btn ghost small', () => {
            this.confirmAccount = a.id;
            this.host.rerender();
          }, busy),
        );
      }
    }
    row.append(text, actions);
    return row;
  }

  private async accountAction(action: 'use' | 'add' | 'login' | 'remove', id: string): Promise<void> {
    this.busyAccount = action === 'add' ? 'add' : id;
    this.confirmAccount = '';
    delete this.errors.anthropic;
    this.host.rerender();
    const r = await this.hub.anthropicAccount(action, id);
    this.busyAccount = '';
    if (r.views.length > 0) this.views = r.views;
    if (!r.ok) this.fail('anthropic', r.error || 'unknown', () => void this.accountAction(action, id));
    // A sign-in was opened in a terminal window: the account is looked at every few seconds until it is in.
    const account = action === 'add' ? this.view('anthropic')?.accounts?.at(-1)?.id : id;
    if (r.opened && account) this.wait({ provider: 'anthropic', account, what: 'signIn' });
    this.host.rerender();
  }

  // ---------- actions ----------

  /** The row's "Connect": a sign-in starts at once; a key is asked for in the unfolded row. */
  private start(id: ProviderId): void {
    const method = this.methodOf(id, this.view(id));
    if (method !== 'apikey') return void this.signIn(id, method);
    this.open.add(id);
    this.shown[id] = 'apikey';
    this.focusKey = id;
    this.host.rerender();
  }

  /** Installs the program first when it is missing or too old; false when that failed (the row says why). */
  private async ensureTool(id: ProviderId, method: ProviderMethod, retry: () => void): Promise<boolean> {
    if (!this.needsTool(id, method)) return true;
    this.phases.set(id, 'install');
    this.host.rerender();
    const r = await this.hub.installProvider(id);
    this.phases.delete(id);
    if (r.views.length > 0) this.views = r.views;
    if (!r.ok) {
      this.fail(id, r.error || 'install-failed', retry);
      this.host.rerender();
      return false;
    }
    if (r.opened) {
      // No Node.js: Anthropic's own installer runs in a terminal window, the sign-in follows once it is done.
      this.wait({ provider: id, what: 'install' });
      this.host.rerender();
      return false;
    }
    return true;
  }

  private async signIn(id: ProviderId, method: ProviderMethod): Promise<void> {
    const retry = () => void this.signIn(id, method);
    delete this.errors[id];
    this.confirming = '';
    if (!(await this.ensureTool(id, method, retry))) return;
    this.phases.set(id, 'connect');
    this.host.rerender();
    const opened = await this.hub.loginProvider(id, method);
    this.phases.delete(id);
    if (opened) this.wait({ provider: id, what: method === 'google' ? 'browser' : 'signIn' });
    else this.fail(id, 'no-terminal', retry);
    this.host.rerender();
  }

  private async connectKey(id: ProviderId): Promise<void> {
    const retry = () => void this.connectKey(id);
    const key = (this.keys[id] ?? '').trim();
    if (!key) {
      this.fail(id, 'required', retry);
      return this.host.rerender();
    }
    delete this.errors[id];
    if (!(await this.ensureTool(id, 'apikey', retry))) return;
    this.phases.set(id, 'connect');
    this.host.rerender();
    const r = await this.hub.connectProvider(id, 'apikey', key);
    this.phases.delete(id);
    if (r.views.length > 0) this.views = r.views;
    if (r.ok) {
      delete this.keys[id];
      delete this.shown[id];
      this.open.delete(id);
    } else this.fail(id, r.error || 'unknown', retry);
    this.host.rerender();
  }

  private async disconnect(id: ProviderId, v: ProviderView): Promise<void> {
    this.confirming = '';
    const active = v.accounts?.find((a) => a.active);
    // An account added beside the user's own is removed with its sign-in; the user's own is signed out.
    if (id === 'anthropic' && v.method === 'cli' && active?.removable) return this.accountAction('remove', active.id);
    const method = v.method as ProviderMethod;
    this.phases.set(id, 'disconnect');
    this.host.rerender();
    const r = await this.hub.disconnectProvider(id, method);
    this.phases.delete(id);
    if (r.views.length > 0) this.views = r.views;
    if (!r.ok) this.fail(id, r.error || 'unknown', () => void this.disconnect(id, v));
    this.host.rerender();
  }

  /** Checks the states again (an error that came from a check, not from an action of the row). */
  private async recheck(id: string): Promise<void> {
    delete this.errors[id];
    this.phases.set(id, 'check');
    this.host.rerender();
    await this.refresh();
    this.phases.delete(id);
    this.host.rerender();
  }

  // ---------- the providers the user added: any server that speaks OpenAI's Chat Completions ----------

  private customRow(v: ProviderView, c: NonNullable<ProviderView['custom']>): HTMLElement {
    const editing = this.form?.id === c.accountId;
    const phase = this.phases.get(v.id);
    const confirming = this.confirming === v.id;
    const code = this.errors[v.id]?.code ?? (v.connected ? '' : (v.methods.apikey?.error ?? ''));
    const error = code && !phase ? this.errorText(v.id, code) : '';

    const item = h('div', editing ? 'acct open' : 'acct');
    item.dataset.provider = v.id;
    const row = h('div', 'acct-row');
    const text = h('div', 'acct-text');
    text.append(h('span', 'acct-name', v.label));
    if (confirming) text.append(h('span', 'acct-sub', t('provider.custom.removeConfirm', { name: v.label })));
    else if (error) text.append(h('span', 'acct-sub err', error));
    else text.append(h('span', 'acct-sub', t(c.models.length === 1 ? 'provider.custom.detail1' : 'provider.custom.detail', { host: hostOf(c.baseUrl), count: c.models.length })));

    const state = h('span', 'acct-state');
    if (phase) {
      state.classList.add('busy');
      state.append(h('span', 'acct-spin'), document.createTextNode(t(phase === 'disconnect' ? 'provider.custom.removing' : 'provider.checking')));
    } else {
      const tone = v.connected ? 'on' : error ? 'err' : 'off';
      state.classList.add(tone);
      state.append(h('span', 'acct-dot'), document.createTextNode(t(tone === 'on' ? 'provider.connected' : tone === 'err' ? 'provider.error' : 'provider.disconnected')));
    }

    const actions = h('div', 'acct-actions');
    if (phase) {
      // Nothing to do while it runs.
    } else if (confirming) {
      actions.append(
        this.button(t('setup.cancel'), 'btn ghost small', () => {
          this.confirming = '';
          this.host.rerender();
        }),
        this.button(t('provider.custom.remove'), 'btn danger small', () => void this.removeCustom(v.id, c.accountId)),
      );
    } else {
      if (error && !editing) actions.append(this.button(t('provider.retry'), 'btn small', () => void this.recheck(v.id)));
      actions.append(
        this.button(t('provider.custom.edit'), 'btn small', () => this.editCustom(v, c), editing),
        this.button(t('provider.custom.remove'), 'btn ghost small', () => {
          this.confirming = v.id;
          this.host.rerender();
        }),
      );
    }
    row.append(mascotMark(v.id, 'acct-mark', v.label, c.models), text, state, actions);
    item.append(row);
    if (editing) item.append(this.customForm());
    return item;
  }

  /** The last line of the list: add a provider of one's own. */
  private addRow(): HTMLElement {
    const item = h('div', 'acct acct-addrow');
    const add = this.button(t('provider.custom.add'), 'btn ghost small', () => {
      this.form = blankForm('');
      this.confirming = '';
      this.host.rerender();
    });
    add.prepend(icon(ICONS.plus));
    item.append(add);
    return item;
  }

  /** A provider being added: its form in a row of its own, at the end of the list. */
  private customItem(): HTMLElement {
    const item = h('div', 'acct open');
    item.dataset.provider = 'new';
    const row = h('div', 'acct-row');
    const text = h('div', 'acct-text');
    text.append(h('span', 'acct-name', t('provider.custom.new')));
    row.append(mascotMark('custom', 'acct-mark', this.form?.name || '+'), text);
    item.append(row, this.customForm());
    return item;
  }

  private customForm(): HTMLElement {
    const f = this.form as CustomForm;
    const busy = f.busy !== '';
    const box = h('div', 'acct-details acct-custom');
    box.append(h('p', 'acct-hint', t('provider.custom.hint')));
    const field = (name: string, label: string, ...content: HTMLElement[]) => {
      const el = h('label', f.error && f.field === name ? 'setup-field acct-field invalid' : 'setup-field acct-field');
      el.append(h('span', 'setup-label', label), ...content);
      return el;
    };
    const input = (value: string, set: (v: string) => void, type = 'text') => {
      const i = h('input', 'setup-input');
      i.type = type;
      i.value = value;
      i.spellcheck = false;
      i.autocomplete = 'off';
      i.addEventListener('input', () => set(i.value));
      return i;
    };
    const name = input(f.name, (v) => (f.name = v));
    name.maxLength = 40;
    const url = input(f.baseUrl, (v) => (f.baseUrl = v));
    // The stored key never comes back: an empty field keeps it.
    const key = input(f.key, (v) => (f.key = v), 'password');
    if (f.id) key.placeholder = t('provider.custom.keyKept');
    const models = h('textarea', 'setup-textarea');
    models.rows = 3;
    models.value = f.models;
    models.spellcheck = false;
    models.addEventListener('input', () => (f.models = models.value));
    const modelsRow = h('div', 'acct-keyrow');
    modelsRow.append(models, this.button(t(f.busy === 'models' ? 'provider.custom.listing' : 'provider.custom.list'), 'btn ghost small', () => void this.customAction('models'), busy));
    box.append(
      field('name', t('provider.custom.name'), name),
      field('baseUrl', t('provider.custom.baseUrl'), url),
      field('key', t('provider.custom.key'), key),
      field('models', t('provider.custom.models'), modelsRow, h('span', 'setup-hint', t('provider.custom.modelsHint'))),
    );
    if (f.listed.length > 0) box.append(this.modelChips(f));

    const actions = h('div', 'acct-actions');
    actions.append(
      this.button(t(f.busy === 'test' ? 'provider.custom.testing' : 'provider.custom.test'), 'btn small', () => void this.customAction('test'), busy),
      this.button(t(f.busy === 'save' ? 'provider.custom.saving' : 'provider.key.save'), 'btn primary small', () => void this.customAction('save'), busy),
      this.button(
        t('setup.cancel'),
        'btn ghost small',
        () => {
          this.form = null;
          this.host.rerender();
        },
        busy,
      ),
    );
    box.append(actions);
    if (f.error) box.append(errorNote('acct-note', this.customError(f), f.detail));
    else if (f.passed) box.append(h('p', 'acct-hint acct-ok', f.passed));
    return box;
  }

  /** The server's list: each model a toggle, the ones in the field lit. */
  private modelChips(f: CustomForm): HTMLElement {
    const box = h('div', 'acct-chips');
    const picked = new Set(parseModels(f.models));
    for (const m of f.listed.slice(0, 300)) {
      const on = picked.has(m);
      const chip = h('button', on ? 'acct-chip on' : 'acct-chip', m);
      chip.setAttribute('aria-pressed', String(on));
      chip.addEventListener('click', () => {
        const now = parseModels(f.models);
        f.models = (on ? now.filter((x) => x !== m) : [...now, m]).join('\n');
        this.host.rerender();
      });
      box.append(chip);
    }
    return box;
  }

  /** A custom provider's error, said for the field it is about. */
  private customError(f: CustomForm): string {
    const byField: Record<string, Key> = {
      'name:required': 'provider.custom.err.name',
      'name:tooLong': 'provider.custom.err.name',
      'name:taken': 'provider.custom.err.nameTaken',
      'name:reserved': 'provider.custom.err.nameReserved',
      'baseUrl:format': 'provider.custom.err.url',
      'models:required': 'provider.custom.err.models',
      'models:format': 'provider.custom.err.modelFormat',
      'models:tooMany': 'provider.custom.err.modelsMany',
      'models:no-list': 'provider.custom.err.noList',
      'models:model-refused': 'provider.custom.err.modelRefused',
      'accounts:tooMany': 'provider.custom.err.tooMany',
    };
    const known = byField[`${f.field}:${f.error}`];
    if (known) return t(known);
    if (f.error === 'not-chat') return t('provider.custom.err.notChat');
    if (f.error === 'http-402') return t('provider.custom.err.credit');
    return this.host.errorText(f.error);
  }

  private editCustom(v: ProviderView, c: NonNullable<ProviderView['custom']>): void {
    this.form = { ...blankForm(c.accountId), name: v.label, baseUrl: c.baseUrl, models: c.models.join('\n') };
    this.confirming = '';
    delete this.errors[v.id];
    this.host.rerender();
  }

  /** The form's buttons: list the server's models, test a chat call, save. */
  private async customAction(action: 'models' | 'test' | 'save'): Promise<void> {
    const f = this.form;
    if (!f) return;
    Object.assign(f, { busy: action, error: '', field: '', detail: '', passed: '' });
    this.host.rerender();
    const models = parseModels(f.models);
    const r = await this.hub.customProvider(action, { id: f.id, name: f.name.trim(), baseUrl: f.baseUrl.trim(), models }, f.key.trim() || null);
    f.busy = '';
    if (r.views.length > 0) this.views = r.views;
    if (this.form !== f) return this.host.rerender();
    if (!r.ok) Object.assign(f, { error: r.error || 'unknown', field: r.field, detail: r.detail });
    else if (action === 'models') {
      f.listed = r.models;
      // A short list is taken whole when nothing was typed; a long one waits for the user's picks.
      if (models.length === 0 && r.models.length <= PICK_ALL_MAX) f.models = r.models.join('\n');
    } else if (action === 'test') f.passed = t('provider.custom.passed', { model: models[0] ?? '', reply: r.detail || '…' });
    else this.form = null;
    this.host.rerender();
  }

  private async removeCustom(id: string, accountId: string): Promise<void> {
    this.confirming = '';
    delete this.errors[id];
    this.phases.set(id, 'disconnect');
    this.host.rerender();
    const r = await this.hub.customProvider('remove', { id: accountId, name: '', baseUrl: '', models: [] }, null);
    this.phases.delete(id);
    if (r.views.length > 0) this.views = r.views;
    if (!r.ok) this.fail(id, r.error || 'unknown', () => void this.removeCustom(id, accountId));
    else if (this.form?.id === accountId) this.form = null;
    this.host.rerender();
  }

  private button(label: string, cls: string, run: () => void, disabled = false): HTMLButtonElement {
    const b = h('button', cls, label);
    b.disabled = disabled;
    b.addEventListener('click', run);
    return b;
  }
}
