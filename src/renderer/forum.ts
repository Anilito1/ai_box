import {
  AREAS,
  charCount,
  checkPost,
  checkPseudo,
  filterPosts,
  isEmptyDraft,
  KINDS,
  LIMITS,
  rank,
  readDrafts,
  STATUSES,
  type FieldError,
  type ForumAction,
  type ForumArea,
  type ForumError,
  type ForumField,
  type ForumKind,
  type ForumPost,
  type ForumResult,
  type ForumState,
  type StoredDraft,
} from '../shared/forum';
import type { HubApi } from '../shared/types';
import { ago, errorNote, h, icon, ICONS } from './dom';
import { LANG, t, tn, type Key } from './i18n';

type View = 'list' | 'compose' | 'drafts';

const DRAFTS_KEY = 'forumDrafts';
const SAVE_MS = 400;
const NOTE_MS = 3500;

const PLATFORM_NAMES: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux', other: '' };

const loadDrafts = () => readDrafts(localStorage.getItem(DRAFTS_KEY));
const storeDrafts = (drafts: StoredDraft[]) => localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));

const time = (at: number) => new Date(at).toLocaleTimeString(LANG, { hour: '2-digit', minute: '2-digit' });
const date = (at: number) => new Date(at).toLocaleString(LANG, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const ERROR_KEYS: Record<ForumError, Key> = {
  offline: 'forum.err.offline',
  unavailable: 'forum.err.unavailable',
  unauthorized: 'forum.err.unauthorized',
  banned: 'forum.err.banned',
  invalid: 'forum.err.invalid',
  quota_posts: 'forum.err.quotaPosts',
  quota_ip: 'forum.err.quotaPosts',
  too_soon: 'forum.err.tooSoon',
  quota_votes: 'forum.err.quotaVotes',
  quota_reports: 'forum.err.quotaReports',
  not_found: 'forum.err.notFound',
  too_late: 'forum.err.tooLate',
  own_post: 'forum.err.ownPost',
  pseudo_taken: 'forum.err.pseudoTaken',
  registrations: 'forum.err.registrations',
  rate_limited: 'forum.err.rateLimited',
  no_keychain: 'forum.err.noKeychain',
  unexpected: 'forum.err.unexpected',
};

const fieldText = (field: ForumField, e: FieldError): string => {
  if (e === 'long') return t('forum.field.long', { max: field === 'title' ? LIMITS.titleMax : field === 'pseudo' ? LIMITS.pseudoMax : LIMITS.bodyMax });
  if (e === 'short') return t('forum.field.short', { min: field === 'title' ? LIMITS.titleMin : field === 'pseudo' ? LIMITS.pseudoMin : LIMITS.bodyMin });
  return t(`forum.field.${e}` as Key);
};

/**
 * The ideas forum, in a sheet like the MCP panel: the messages of every user (filters, search, +1, reports), a
 * structured form whose drafts stay on this computer, and the day's quota as the forum counts it.
 */
export class ForumView {
  private readonly root = document.getElementById('forum') as HTMLDivElement;
  private readonly card = h('div', 'setup-card caps-card forum-card');
  private view: View = 'list';
  private state: ForumState | null = null;
  private loading = false;
  private busy = false;
  private query = '';
  private kind: ForumKind | 'all' = 'all';
  private area: ForumArea | 'all' = 'all';
  private mine = false;
  private sort: 'top' | 'new' = 'top';
  private openId = '';
  /** `delete:<id>` or `ban:<id>`: the action waiting for its confirmation. */
  private confirm = '';
  /** A vote or report waits for a pseudo. */
  private askPseudo = false;
  private pseudo = '';
  private pseudoError: FieldError | null = null;
  private note: { text: string; tone: 'ok' | 'error' } | null = null;
  private noteTimer = 0;
  private drafts: StoredDraft[] = [];
  private draft: StoredDraft = this.blank();
  private touched = new Set<ForumField>();
  private serverFields: Partial<Record<ForumField, FieldError>> = {};
  private saveTimer = 0;
  private savedShown = false;
  private replies = new Map<string, string>();
  private returnFocus: HTMLElement | null = null;

  constructor(private readonly hub: HubApi) {
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-labelledby', 'forum-title');
    document.addEventListener('keydown', (e) => {
      if (this.root.hidden) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        this.escape();
      } else if (e.key === 'Tab') this.trapFocus(e);
    });
    window.addEventListener('beforeunload', () => this.flushDraft());
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  async open(): Promise<void> {
    if (this.root.hidden) this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.drafts = loadDrafts();
    this.root.hidden = false;
    this.render();
    if (!this.state) this.state = (await this.hub.forum({ type: 'state' })).state;
    await this.refresh();
  }

  close(): void {
    this.flushDraft();
    this.root.hidden = true;
    this.root.replaceChildren();
    this.returnFocus?.focus();
    this.returnFocus = null;
  }

  private escape(): void {
    if (this.confirm) {
      this.confirm = '';
      return this.render();
    }
    if (this.view !== 'list') return this.go('list');
    if (this.openId) {
      this.openId = '';
      return this.render();
    }
    this.close();
  }

  private trapFocus(e: KeyboardEvent): void {
    const items = [...this.root.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex="0"]')].filter((el) => !(el as HTMLButtonElement).disabled && el.offsetParent !== null);
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

  private go(view: View): void {
    if (this.view === 'compose') this.flushDraft();
    this.view = view;
    this.confirm = '';
    this.askPseudo = false;
    this.render();
  }

  private setNote(note: ForumView['note']): void {
    window.clearTimeout(this.noteTimer);
    this.note = note;
    if (note?.tone === 'ok')
      this.noteTimer = window.setTimeout(() => {
        this.note = null;
        if (!this.root.hidden) this.render();
      }, NOTE_MS);
  }

  private async refresh(): Promise<void> {
    this.loading = true;
    this.render();
    const r = await this.hub.forum({ type: 'refresh' });
    this.loading = false;
    this.state = r.state;
    if (!this.root.hidden) this.render();
  }

  /** Runs an action; the forum answers with its state. Returns whether it worked. */
  private async act(action: ForumAction, done = ''): Promise<ForumResult> {
    this.busy = true;
    this.render();
    let r: ForumResult;
    try {
      r = await this.hub.forum(action);
    } finally {
      this.busy = false;
    }
    this.state = r.state;
    this.confirm = '';
    this.setNote(r.ok ? (done ? { text: done, tone: 'ok' } : null) : { text: this.errorText(r), tone: 'error' });
    if (!this.root.hidden) this.render();
    return r;
  }

  private errorText(r: Extract<ForumResult, { ok: false }>): string {
    if (r.error === 'too_soon' && r.retryAt) return t('forum.err.tooSoonAt', { time: time(r.retryAt) });
    return t(ERROR_KEYS[r.error]);
  }

  // ---------- frame ----------

  private render(): void {
    if (this.root.hidden) return;
    const nav = h('nav', 'setup-nav');
    nav.append(h('div', 'setup-nav-title', t('forum.title')));
    const items: [View, string, string][] = [
      ['list', t('forum.nav.list'), ICONS.bulb],
      ['compose', t('forum.nav.write'), ICONS.edit],
      ['drafts', this.drafts.length ? `${t('forum.nav.drafts')} · ${this.drafts.length}` : t('forum.nav.drafts'), ICONS.folder],
    ];
    for (const [view, label, path] of items) {
      const b = h('button', `setup-nav-item${view === this.view ? ' active' : ''}`);
      b.append(icon(path), h('span', '', label));
      b.dataset.focus = `nav:${view}`;
      b.addEventListener('click', () => (view === 'compose' && this.view !== 'compose' ? this.compose(null) : this.go(view)));
      nav.append(b);
    }
    nav.append(this.quotaBox());

    const body = h('div', 'setup-body');
    const content = h('div', 'setup-content caps-content forum-content');
    if (this.view === 'compose') this.form(content);
    else if (this.view === 'drafts') this.draftList(content);
    else this.list(content);
    body.append(content);
    if (this.note) body.append(this.note.tone === 'error' ? errorNote('setup-note', this.note.text) : h('div', 'setup-note ok', this.note.text));
    const foot = h('div', 'setup-foot');
    foot.append(h('span', 'setup-hint', t('forum.foot')), h('span', 'spacer'));
    const done = h('button', 'btn', t('setup.close'));
    done.addEventListener('click', () => this.close());
    foot.append(done);
    body.append(foot);

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

  /** The day's allowance as the forum counted it at its last answer; nothing when it cannot be known. */
  private quotaBox(): HTMLElement {
    const box = h('div', 'forum-quota');
    const me = this.state?.online ? this.state.listing?.me : null;
    if (!me) {
      box.append(h('div', 'forum-quota-title', t('forum.quota.rules')), h('div', 'forum-quota-line', t('forum.quota.rulesLine', { posts: LIMITS.postsPerDay, votes: LIMITS.votesPerDay })));
      return box;
    }
    box.append(h('div', 'forum-quota-title', t('forum.quota.today')));
    const line = (n: number, key: string) => {
      const el = h('div', `forum-quota-line${n === 0 ? ' empty' : ''}`, tn(key, n));
      return el;
    };
    box.append(line(me.quota.posts, 'forum.quota.posts'), line(me.quota.votes, 'forum.quota.votes'));
    if (me.quota.posts > 0 && me.quota.nextPostAt > Date.now()) box.append(h('div', 'forum-quota-line', t('forum.quota.next', { time: time(me.quota.nextPostAt) })));
    box.append(h('div', 'forum-quota-who', t('forum.quota.as', { pseudo: me.pseudo })));
    return box;
  }

  private heading(el: HTMLElement, title: string, count: number | null, tools: HTMLElement[]): void {
    const head = h('div', 'caps-head');
    const heading = h('h2', 'caps-title', title);
    heading.id = 'forum-title';
    head.append(heading);
    if (count !== null) head.append(h('span', 'caps-total', String(count)));
    head.append(h('span', 'spacer'), ...tools);
    el.append(head);
  }

  private chips<T extends string>(options: [T, string][], value: T, pick: (v: T) => void, label: string): HTMLElement {
    const bar = h('div', 'caps-chips');
    bar.setAttribute('role', 'radiogroup');
    bar.setAttribute('aria-label', label);
    for (const [id, text] of options) {
      const b = h('button', `caps-chip${id === value ? ' active' : ''}`, text);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(id === value));
      b.dataset.focus = `chip:${label}:${id}`;
      b.addEventListener('click', () => pick(id));
      bar.append(b);
    }
    return bar;
  }

  private select<T extends string>(options: [T, string][], value: T, label: string, pick: (v: T) => void, focus: string): HTMLSelectElement {
    const s = h('select', 'setup-select forum-select');
    s.setAttribute('aria-label', label);
    s.dataset.focus = focus;
    for (const [id, text] of options) {
      const o = h('option', '', text);
      o.value = id;
      o.selected = id === value;
      s.append(o);
    }
    s.addEventListener('change', () => pick(s.value as T));
    return s;
  }

  // ---------- reading ----------

  private list(el: HTMLElement): void {
    const s = this.state;
    const listing = s?.listing ?? null;
    const search = h('input', 'setup-input caps-search');
    search.type = 'search';
    search.placeholder = t('forum.search');
    search.setAttribute('aria-label', t('forum.search'));
    search.value = this.query;
    search.spellcheck = false;
    search.dataset.focus = 'search';
    search.addEventListener('input', () => {
      this.query = search.value;
      this.fillRows();
    });
    const sort = this.select<'top' | 'new'>([['top', t('forum.sort.top')], ['new', t('forum.sort.new')]], this.sort, t('forum.sort'), (v) => {
      this.sort = v;
      this.fillRows();
    }, 'sort');
    const reload = h('button', 'icon-btn');
    reload.type = 'button';
    reload.title = t('forum.refresh');
    reload.setAttribute('aria-label', t('forum.refresh'));
    reload.dataset.focus = 'refresh';
    reload.disabled = this.loading || !s?.available;
    reload.append(icon(ICONS.sync));
    reload.addEventListener('click', () => void this.refresh());
    this.heading(el, t('forum.nav.list'), listing ? listing.posts.length : null, listing ? [search, sort, reload] : []);

    if (s && !s.available) return this.unavailable(el, 'forum.unavailable.build');
    if (s && !s.online && !this.loading) {
      if (!listing) return this.unavailable(el, 'forum.unavailable.lead');
      el.append(h('div', 'forum-banner', t('forum.offline', { when: date(s.listedAt ?? Date.now()) })));
    }
    if (!listing) return this.skeleton(el);
    if (listing.admin) el.append(h('div', 'forum-banner mod', t('forum.mod.on')));
    if (this.askPseudo && !s?.signedIn) el.append(this.pseudoBox(true));

    const filters = h('div', 'forum-filters');
    filters.append(
      this.chips<ForumKind | 'all'>([['all', t('forum.all')], ...KINDS.map((k): [ForumKind, string] => [k, t(`forum.kind.${k}` as Key)])], this.kind, (v) => {
        this.kind = v;
        this.render();
      }, t('forum.filter.kind')),
      this.select<ForumArea | 'all'>([['all', t('forum.area.all')], ...AREAS.map((a): [ForumArea, string] => [a, t(`forum.area.${a}` as Key)])], this.area, t('forum.filter.area'), (v) => {
        this.area = v;
        this.fillRows();
      }, 'area'),
    );
    if (s?.signedIn) {
      const mine = h('button', `caps-chip forum-mine${this.mine ? ' active' : ''}`, t('forum.mine'));
      mine.type = 'button';
      mine.setAttribute('aria-pressed', String(this.mine));
      mine.dataset.focus = 'mine';
      mine.addEventListener('click', () => {
        this.mine = !this.mine;
        this.render();
      });
      filters.append(mine);
    }
    el.append(filters);
    const rows = h('div', 'caps-list forum-list');
    rows.setAttribute('aria-busy', String(this.loading));
    el.append(rows);
    this.fillRows(rows);
  }

  private fillRows(box = this.card.querySelector<HTMLElement>('.forum-list')): void {
    const listing = this.state?.listing;
    if (!box || !listing) return;
    const posts = rank(filterPosts(listing.posts, { query: this.query, kind: this.kind, area: this.area, mine: this.mine }), this.sort);
    box.replaceChildren(...posts.map((p) => this.row(p)));
    if (posts.length) return;
    const e = h('div', 'caps-empty');
    if (listing.posts.length === 0) {
      e.append(h('p', '', t('forum.empty')));
      const write = h('button', 'btn primary', t('forum.nav.write'));
      write.addEventListener('click', () => this.compose(null));
      e.append(write);
    } else e.append(h('p', '', this.query.trim() ? t('caps.noMatch', { q: this.query.trim() }) : t('caps.emptyFilter')));
    box.append(e);
  }

  private row(p: ForumPost): HTMLElement {
    const open = this.openId === p.id;
    const row = h('div', `forum-row${open ? ' open' : ''}${p.hidden ? ' hidden-post' : ''}`);
    const vote = h('button', `forum-vote${p.voted ? ' on' : ''}`);
    vote.type = 'button';
    vote.dataset.focus = `vote:${p.id}`;
    vote.setAttribute('aria-pressed', String(p.voted));
    vote.setAttribute('aria-label', t(p.voted ? 'forum.vote.undo' : 'forum.vote', { n: p.votes }));
    vote.title = p.mine ? t('forum.vote.own') : t(p.voted ? 'forum.vote.undo' : 'forum.vote', { n: p.votes });
    vote.disabled = this.busy || p.mine || p.hidden || !this.state?.online;
    vote.append(icon(ICONS.up), h('span', 'forum-vote-n', String(p.votes)));
    vote.addEventListener('click', () => this.needPseudo() && void this.act({ type: 'vote', id: p.id, on: !p.voted }));

    const main = h('button', 'forum-main');
    main.type = 'button';
    main.dataset.focus = `post:${p.id}`;
    main.setAttribute('aria-expanded', String(open));
    const top = h('span', 'forum-line');
    top.append(h('span', `forum-kind k-${p.kind}`, t(`forum.kind.${p.kind}` as Key)), h('span', 'forum-title', p.title));
    const meta = h('span', 'forum-meta');
    meta.append(h('span', '', t(`forum.area.${p.area}` as Key)));
    if (p.status !== 'new') meta.append(h('span', `forum-status st-${p.status}`, t(`forum.status.${p.status}` as Key)));
    if (p.hidden) meta.append(h('span', 'forum-status st-hidden', t('forum.hidden')));
    if (p.reply) meta.append(h('span', 'forum-replied', t('forum.replied')));
    meta.append(h('span', '', `${p.mine ? t('forum.you') : p.author} · ${ago(p.createdAt)}`));
    main.append(top, meta);
    main.addEventListener('click', () => {
      this.openId = open ? '' : p.id;
      this.confirm = '';
      this.render();
    });
    row.append(vote, main);
    if (open) row.append(this.detail(p));
    return row;
  }

  private detail(p: ForumPost): HTMLElement {
    const d = h('div', 'forum-detail');
    d.append(h('p', 'forum-body', p.body));
    if (p.reply) {
      const reply = h('div', 'forum-reply');
      reply.append(h('div', 'forum-reply-head', t('forum.reply.head', { when: date(p.replyAt ?? p.createdAt) })), h('p', 'forum-body', p.reply));
      d.append(reply);
    }
    const foot = h('div', 'forum-detail-foot');
    foot.append(h('span', 'forum-fine', [date(p.createdAt), p.version && `v${p.version}`, PLATFORM_NAMES[p.platform]].filter(Boolean).join(' · ')), h('span', 'spacer'));
    const online = !!this.state?.online;
    if (p.mine && Date.now() - p.createdAt < LIMITS.deleteWindowMs) {
      if (this.confirm === `delete:${p.id}`) foot.append(this.confirmRow(t('forum.delete.ask'), t('forum.delete'), () => void this.act({ type: 'delete', id: p.id }, t('forum.delete.done'))));
      else foot.append(this.small(t('forum.delete'), () => this.ask(`delete:${p.id}`), !online));
    } else if (!p.mine && !p.hidden) {
      const report = this.small(p.reported ? t('forum.reported') : t('forum.report'), () => this.needPseudo() && void this.act({ type: 'report', id: p.id }, t('forum.report.done')), !online || p.reported);
      foot.append(report);
    }
    d.append(foot);
    if (this.state?.listing?.admin) d.append(this.moderation(p));
    return d;
  }

  private small(text: string, run: () => void, disabled = false): HTMLButtonElement {
    const b = h('button', 'btn small', text);
    b.type = 'button';
    b.disabled = disabled || this.busy;
    b.dataset.focus = `btn:${text}`;
    b.addEventListener('click', run);
    return b;
  }

  private ask(key: string): void {
    this.confirm = key;
    this.render();
  }

  private confirmRow(question: string, yes: string, run: () => void): HTMLElement {
    const box = h('span', 'forum-confirm');
    const go = h('button', 'btn small danger', yes);
    go.type = 'button';
    go.dataset.autofocus = '';
    go.disabled = this.busy;
    go.addEventListener('click', run);
    box.append(h('span', '', question), this.small(t('forum.cancel'), () => this.ask('')), go);
    return box;
  }

  private moderation(p: ForumPost): HTMLElement {
    const box = h('div', 'forum-mod');
    box.append(h('div', 'setup-label', t('forum.mod.title', { n: p.reports ?? 0 })));
    const row = h('div', 'setup-row');
    row.append(
      this.select(STATUSES.map((s): [string, string] => [s, t(`forum.status.${s}` as Key)]), p.status, t('forum.mod.status'), (v) => void this.act({ type: 'moderate', id: p.id, status: v as ForumPost['status'] }, t('forum.mod.saved')), `status:${p.id}`),
      this.small(p.hidden ? t('forum.mod.show') : t('forum.mod.hide'), () => void this.act({ type: 'moderate', id: p.id, hidden: !p.hidden }, t('forum.mod.saved'))),
    );
    if (this.confirm === `ban:${p.id}`) row.append(this.confirmRow(t('forum.mod.banAsk', { pseudo: p.author }), t('forum.mod.ban'), () => void this.act({ type: 'ban', id: p.id }, t('forum.mod.saved'))));
    else row.append(this.small(t('forum.mod.ban'), () => this.ask(`ban:${p.id}`)));
    const reply = h('textarea', 'setup-textarea forum-reply-input');
    reply.rows = 3;
    reply.placeholder = t('forum.mod.replyHint');
    reply.value = this.replies.get(p.id) ?? p.reply ?? '';
    reply.dataset.focus = `reply:${p.id}`;
    reply.addEventListener('input', () => this.replies.set(p.id, reply.value));
    const actions = h('div', 'setup-row');
    actions.append(
      this.small(t('forum.mod.replySave'), () => {
        const text = reply.value.trim();
        void this.act({ type: 'moderate', id: p.id, reply: text || null }, t('forum.mod.saved')).then((r) => r.ok && this.replies.delete(p.id));
      }),
    );
    box.append(row, reply, actions);
    return box;
  }

  /** Voting and reporting need a pseudo: asked once, above the list. */
  private needPseudo(): boolean {
    if (this.state?.signedIn) return true;
    this.askPseudo = true;
    this.render();
    this.card.querySelector<HTMLElement>('[data-focus="pseudo"]')?.focus();
    return false;
  }

  private pseudoBox(standalone: boolean): HTMLElement {
    const f = h('div', `setup-field forum-pseudo${standalone ? ' standalone' : ''}`);
    f.append(h('div', 'setup-label', t('forum.pseudo')), h('div', 'setup-hint', t('forum.pseudo.hint')));
    const row = h('div', 'setup-row');
    const input = h('input', 'setup-input forum-input');
    input.value = this.pseudo;
    input.maxLength = 60;
    input.placeholder = t('forum.pseudo.placeholder');
    input.spellcheck = false;
    input.dataset.focus = 'pseudo';
    input.setAttribute('aria-label', t('forum.pseudo'));
    const error = h('div', 'forum-error');
    error.setAttribute('role', 'alert');
    const show = () => {
      error.textContent = this.pseudoError ? fieldText('pseudo', this.pseudoError) : '';
      input.setAttribute('aria-invalid', String(!!this.pseudoError));
    };
    input.addEventListener('input', () => {
      this.pseudo = input.value;
      this.pseudoError = null;
      show();
    });
    row.append(input);
    if (standalone) {
      const ok = h('button', 'btn primary small', t('forum.pseudo.ok'));
      ok.type = 'button';
      ok.disabled = this.busy;
      ok.addEventListener('click', () => void this.register().then((done) => done && ((this.askPseudo = false), this.render())));
      input.addEventListener('keydown', (e) => e.key === 'Enter' && ok.click());
      row.append(ok);
    }
    show();
    f.append(row, error);
    return f;
  }

  private async register(): Promise<boolean> {
    const c = checkPseudo(this.pseudo);
    if (!c.ok) {
      this.pseudoError = c.fields.pseudo ?? 'invalid';
      this.render();
      return false;
    }
    const r = await this.act({ type: 'register', pseudo: c.value });
    if (r.ok) return true;
    if (r.error === 'pseudo_taken' || r.error === 'invalid') {
      this.pseudoError = r.error === 'pseudo_taken' ? 'taken' : (r.fields?.pseudo ?? 'invalid');
      this.render();
    }
    return false;
  }

  private unavailable(el: HTMLElement, lead: Key): void {
    const e = h('div', 'caps-empty forum-down');
    e.append(h('p', 'forum-down-title', t('forum.unavailable')), h('p', '', t(lead)));
    const row = h('div', 'setup-row');
    if (this.state?.available) {
      const retry = h('button', 'btn', this.loading ? t('forum.retrying') : t('caps.retry'));
      retry.disabled = this.loading;
      retry.addEventListener('click', () => void this.refresh());
      row.append(retry);
    }
    const write = h('button', 'btn', t('forum.down.write'));
    write.addEventListener('click', () => this.compose(null));
    row.append(write);
    e.append(row);
    el.append(e);
  }

  private skeleton(el: HTMLElement): void {
    const list = h('div', 'caps-list caps-loading');
    list.setAttribute('aria-busy', 'true');
    for (let i = 0; i < 6; i++) {
      const row = h('div', 'caps-row caps-skel');
      row.append(h('span', 'caps-skel-bar'), h('span', 'caps-skel-bar short'));
      list.append(row);
    }
    el.append(list);
  }

  // ---------- writing ----------

  private blank(): StoredDraft {
    return { id: crypto.randomUUID(), kind: '', area: '', title: '', body: '', updatedAt: 0 };
  }

  private compose(draft: StoredDraft | null): void {
    this.draft = draft ? { ...draft } : this.blank();
    this.touched = new Set(draft ? (['title', 'body'] as ForumField[]) : []);
    this.serverFields = {};
    this.savedShown = false;
    this.go('compose');
  }

  /** Saves the draft being written now (a pending autosave included). An empty one is not kept. */
  private flushDraft(): void {
    if (!this.saveTimer) return;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    this.saveDraft();
  }

  private saveDraft(): void {
    const others = loadDrafts().filter((d) => d.id !== this.draft.id);
    if (isEmptyDraft(this.draft)) this.drafts = others;
    else {
      this.draft.updatedAt = Date.now();
      this.drafts = [{ ...this.draft }, ...others];
    }
    storeDrafts(this.drafts);
  }

  private scheduleSave(status: HTMLElement): void {
    window.clearTimeout(this.saveTimer);
    status.textContent = '';
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = 0;
      this.saveDraft();
      this.savedShown = !isEmptyDraft(this.draft);
      status.textContent = this.savedShown ? t('forum.draft.saved') : '';
      const nav = this.card.querySelector('[data-focus="nav:drafts"] span');
      if (nav) nav.textContent = this.drafts.length ? `${t('forum.nav.drafts')} · ${this.drafts.length}` : t('forum.nav.drafts');
    }, SAVE_MS);
  }

  private form(el: HTMLElement): void {
    const s = this.state;
    const saved = this.drafts.some((d) => d.id === this.draft.id);
    this.heading(el, saved ? t('forum.form.draft') : t('forum.form.new'), null, []);
    const scroll = h('div', 'caps-list forum-form');
    if (s && !s.signedIn) scroll.append(this.pseudoBox(false));

    const kindField = h('div', 'setup-field');
    kindField.append(h('div', 'setup-label', t('forum.form.kind')));
    const kinds = this.chips<ForumKind | ''>(KINDS.map((k): [ForumKind, string] => [k, t(`forum.kind.${k}` as Key)]), this.draft.kind, (v) => {
      this.draft.kind = v;
      this.touched.add('kind');
      this.flushAfterChange();
    }, t('forum.form.kind'));
    kindField.append(kinds, this.errorSlot('kind'));

    const titleField = h('div', 'setup-field');
    const title = h('input', 'setup-input wide forum-input');
    title.value = this.draft.title;
    title.placeholder = t('forum.form.titleHint');
    title.dataset.focus = 'title';
    title.setAttribute('aria-label', t('forum.form.title'));
    titleField.append(this.labelWithCount(t('forum.form.title'), 'title', LIMITS.titleMax), title, this.errorSlot('title'));

    const areaField = h('div', 'setup-field');
    areaField.append(
      h('div', 'setup-label', t('forum.form.area')),
      this.select<ForumArea | ''>([['', t('forum.form.areaPick')], ...AREAS.map((a): [ForumArea, string] => [a, t(`forum.area.${a}` as Key)])], this.draft.area, t('forum.form.area'), (v) => {
        this.draft.area = v;
        this.touched.add('area');
        this.flushAfterChange();
      }, 'form-area'),
      this.errorSlot('area'),
    );

    const bodyField = h('div', 'setup-field');
    const body = h('textarea', 'setup-textarea forum-text');
    body.rows = 7;
    body.value = this.draft.body;
    body.placeholder = t(`forum.form.bodyHint.${this.draft.kind || 'idea'}` as Key);
    body.dataset.focus = 'body';
    body.setAttribute('aria-label', t('forum.form.body'));
    bodyField.append(this.labelWithCount(t('forum.form.body'), 'body', LIMITS.bodyMax), body, this.errorSlot('body'));
    bodyField.append(h('div', 'setup-hint', t('forum.form.rules')));
    scroll.append(kindField, titleField, areaField, bodyField);
    el.append(scroll);

    const bar = h('div', 'forum-send');
    const status = h('span', 'forum-saved', this.savedShown ? t('forum.draft.saved') : '');
    status.setAttribute('role', 'status');
    const blocked = this.sendBlock();
    const send = h('button', 'btn primary', t('forum.form.send'));
    send.type = 'button';
    send.dataset.focus = 'send';
    send.disabled = this.busy || !!blocked;
    send.addEventListener('click', () => void this.send());
    bar.append(status, h('span', 'spacer'));
    if (blocked) bar.append(h('span', 'forum-blocked', blocked));
    if (saved) {
      if (this.confirm === `draft:${this.draft.id}`) bar.append(this.confirmRow(t('forum.draft.deleteAsk'), t('forum.draft.delete'), () => this.deleteDraft(this.draft.id, true)));
      else bar.append(this.small(t('forum.draft.delete'), () => this.ask(`draft:${this.draft.id}`)));
    }
    bar.append(send);
    el.append(bar);

    for (const [input, field] of [
      [title, 'title'],
      [body, 'body'],
    ] as const) {
      input.addEventListener('input', () => {
        this.draft[field] = input.value;
        delete this.serverFields[field];
        this.updateChecks();
        this.scheduleSave(status);
      });
      input.addEventListener('blur', () => {
        if (input.value) this.touched.add(field);
        this.updateChecks();
      });
    }
    if (!this.card.contains(document.activeElement)) (this.draft.kind ? title : kinds.querySelector<HTMLElement>('button'))?.setAttribute('data-autofocus', '');
    this.updateChecks(el);
  }

  /** A chip or a select changed: the draft is saved at once, the form drawn again. */
  private flushAfterChange(): void {
    this.saveDraft();
    this.savedShown = !isEmptyDraft(this.draft);
    this.render();
  }

  private labelWithCount(text: string, field: 'title' | 'body', max: number): HTMLElement {
    const label = h('div', 'setup-label forum-label');
    const count = h('span', 'forum-count');
    count.dataset.count = field;
    count.dataset.max = String(max);
    label.append(h('span', '', text), count);
    return label;
  }

  private errorSlot(field: ForumField): HTMLElement {
    const e = h('div', 'forum-error');
    e.dataset.error = field;
    e.setAttribute('role', 'alert');
    return e;
  }

  /** Counters and messages under the fields, updated in place while typing (no redraw: the caret stays). */
  private updateChecks(root: HTMLElement = this.card): void {
    const check = checkPost(this.draft);
    const fields = check.ok ? {} : check.fields;
    for (const c of root.querySelectorAll<HTMLElement>('[data-count]')) {
      const n = charCount(this.draft[c.dataset.count as 'title' | 'body']);
      const max = Number(c.dataset.max);
      c.textContent = `${n} / ${max}`;
      c.classList.toggle('over', n > max);
    }
    for (const slot of root.querySelectorAll<HTMLElement>('[data-error]')) {
      const field = slot.dataset.error as ForumField;
      const e = this.serverFields[field] ?? fields[field];
      // While a field is being filled, "too short" or "missing" would only nag: shown once it has been left.
      const shown = e && (this.touched.has(field) || (e !== 'required' && e !== 'short')) ? e : null;
      slot.textContent = shown ? fieldText(field, shown) : '';
      slot.previousElementSibling?.setAttribute('aria-invalid', String(!!shown));
    }
  }

  /** Why the message cannot leave now, as the forum last counted; null when it can. */
  private sendBlock(): string | null {
    const s = this.state;
    if (!s?.available || !s.online) return t('forum.send.offline');
    if (!s.secureStorage) return t('forum.err.noKeychain');
    const q = s.listing?.me?.quota;
    if (q && q.posts === 0) return t('forum.send.quota');
    if (q && q.nextPostAt > Date.now()) return t('forum.err.tooSoonAt', { time: time(q.nextPostAt) });
    return null;
  }

  private async send(): Promise<void> {
    this.touched = new Set(['kind', 'area', 'title', 'body']);
    const check = checkPost(this.draft);
    if (!check.ok) return this.updateChecks();
    if (!this.state?.signedIn && !(await this.register())) return;
    const r = await this.act({ type: 'post', draft: check.value }, t('forum.sent'));
    if (!r.ok) {
      this.serverFields = r.fields ?? {};
      return this.updateChecks();
    }
    this.deleteDraft(this.draft.id, false);
    this.draft = this.blank();
    this.sort = 'new';
    this.kind = 'all';
    this.area = 'all';
    this.query = '';
    this.mine = false;
    this.go('list');
  }

  // ---------- drafts ----------

  private deleteDraft(id: string, show: boolean): void {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    this.drafts = loadDrafts().filter((d) => d.id !== id);
    storeDrafts(this.drafts);
    if (!show) return;
    this.setNote({ text: t('forum.draft.deleted'), tone: 'ok' });
    if (this.view === 'compose' && this.draft.id === id) {
      this.draft = this.blank();
      this.go('drafts');
    } else this.render();
  }

  private draftList(el: HTMLElement): void {
    this.heading(el, t('forum.nav.drafts'), this.drafts.length, []);
    const list = h('div', 'caps-list');
    if (this.drafts.length === 0) {
      const e = h('div', 'caps-empty');
      e.append(h('p', '', t('forum.draft.none')));
      list.append(e);
    }
    for (const d of this.drafts) {
      const row = h('div', 'forum-draft');
      const open = h('button', 'forum-main');
      open.type = 'button';
      open.dataset.focus = `draft:${d.id}`;
      const top = h('span', 'forum-line');
      if (d.kind) top.append(h('span', `forum-kind k-${d.kind}`, t(`forum.kind.${d.kind}` as Key)));
      top.append(h('span', `forum-title${d.title.trim() ? '' : ' untitled'}`, d.title.trim() || t('forum.draft.untitled')));
      const meta = h('span', 'forum-meta');
      if (d.area) meta.append(h('span', '', t(`forum.area.${d.area}` as Key)));
      meta.append(h('span', '', t('forum.draft.edited', { when: ago(d.updatedAt) })));
      open.append(top, meta);
      open.addEventListener('click', () => this.compose(d));
      const remove = h('button', 'icon-btn');
      remove.type = 'button';
      remove.title = t('forum.draft.delete');
      remove.setAttribute('aria-label', t('forum.draft.delete'));
      remove.dataset.focus = `draft-rm:${d.id}`;
      remove.append(icon(ICONS.remove));
      remove.addEventListener('click', () => this.deleteDraft(d.id, true));
      row.append(open, remove);
      list.append(row);
    }
    el.append(list);
  }
}

/** Settings › About: where a developer pastes the moderators' key (kept encrypted, checked by the forum first). */
export function forumModeration(hub: HubApi): HTMLElement {
  const el = h('div', 'setup-field forum-admin');
  const draw = (s: ForumState, error = '') => {
    el.replaceChildren(h('div', 'setup-label', t('forum.admin.title')), h('div', 'setup-hint', t(s.moderator ? 'forum.admin.on' : 'forum.admin.lead')));
    const row = h('div', 'setup-row');
    if (s.moderator) {
      const remove = h('button', 'btn small', t('forum.admin.remove'));
      remove.addEventListener('click', () => void hub.forum({ type: 'adminKey', key: null }).then((r) => draw(r.state)));
      row.append(remove);
    } else {
      const key = h('input', 'setup-input');
      key.type = 'password';
      key.placeholder = t('forum.admin.placeholder');
      key.setAttribute('aria-label', t('forum.admin.placeholder'));
      key.autocomplete = 'off';
      const save = h('button', 'btn small', t('forum.admin.save'));
      save.disabled = !s.available;
      save.addEventListener('click', () => {
        save.disabled = true;
        void hub.forum({ type: 'adminKey', key: key.value.trim() }).then((r) => draw(r.state, r.ok ? '' : t(r.error === 'unauthorized' ? 'forum.admin.refused' : ERROR_KEYS[r.error])));
      });
      row.append(key, save);
    }
    el.append(row);
    if (error) el.append(errorNote('setup-note', error));
  };
  void hub.forum({ type: 'state' }).then((r) => draw(r.state));
  return el;
}
