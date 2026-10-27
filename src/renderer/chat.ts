import DOMPurify from 'dompurify';
import { marked } from 'marked';
import {
  ATTACH_LIMITS,
  base64Bytes,
  MENU_MODES,
  type AccountBadge,
  type ChatItem,
  type Effort,
  type Mode,
  type HubApi,
  type ModelOption,
  type ProviderBadge,
  type SessionView,
} from '../shared/types';
import { effortsFor, splitRecent } from '../shared/models';
import { modelKey } from '../shared/news';
import { isProviderId } from '../shared/providers';
import { toAttachment, type Attachment } from './attachments';
import { Avatar } from './avatar';
import { cliUpdateBox } from './cliUpdate';
import { copyButton, displayName, failed, fmtPct, fmtTokens, h, icon, ICONS, level, oneLine, openLightbox, openMenu, statusDot, statusLabel, techDetails } from './dom';
import { effortLabel, PLATFORM, t } from './i18n';
import { mascotMark, sessionMascot } from './mascot';
import { SlashMenu } from './slash';
import { activityOf, lastOf, WorkingLine } from './working';

// Model output is untrusted: no inline styles, app classes or form controls, so it cannot overlay or mimic the app's own UI.
const markdown = (text: string): string =>
  DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true }), {
    FORBID_ATTR: ['style', 'class'],
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select'],
  });

// Rendered Markdown by item, so switching back to a conversation or re-sending an unchanged item skips the parser.
const HTML_CACHE_MAX = 4000;
const htmlCache = new Map<string, { text: string; html: string }>();

function cachedMarkdown(key: string, text: string): string {
  const hit = htmlCache.get(key);
  if (hit?.text === text) return hit.html;
  const html = markdown(text);
  htmlCache.delete(key);
  htmlCache.set(key, { text, html });
  if (htmlCache.size > HTML_CACHE_MAX) htmlCache.delete(htmlCache.keys().next().value as string);
  return html;
}

/**
 * End of the reply's last finished block: what comes before it no longer changes as the reply streams. A block ends at
 * a blank line or a closing fence, once the next line starts flush left outside any fence (an indented line may still
 * belong to the block above: a list item's paragraph or code).
 */
function stableEnd(text: string): number {
  let end = 0;
  let candidate = -1;
  let fence = '';
  let at = 0;
  for (;;) {
    const nl = text.indexOf('\n', at);
    if (nl < 0) return end; // The last line is still being written.
    const line = text.slice(at, nl);
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1] ?? '';
    if (fence) {
      // Closed by the same character, at least as long, with nothing after it.
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) {
        fence = '';
        candidate = nl + 1;
      }
    } else if (line.trim() === '') {
      candidate = nl + 1;
    } else {
      if (candidate >= 0 && !/^\s/.test(line)) end = candidate;
      candidate = -1;
      if (marker) fence = marker;
    }
    at = nl + 1;
  }
}

/** The newest items render at once; older ones follow in batches, so opening a long conversation never freezes. */
const FIRST_BATCH = 60;
const LATER_BATCH = 40;

type Items = Map<string, ChatItem>;

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

const modeLabel = (mode: Mode) => t(`mode.${mode}`);
const modeHint = (mode: Mode) => (mode === 'dontAsk' ? '' : t(`modeHint.${mode}`));

/** One conversation panel: header, message stream and composer (VS Code extension layout). */
export class ChatView {
  private readonly head: { dot: HTMLSpanElement; name: HTMLSpanElement; status: HTMLSpanElement; mission: HTMLSpanElement; cwd: HTMLSpanElement };
  private readonly scroller: HTMLDivElement;
  private readonly stream: HTMLDivElement;
  private readonly empty: HTMLDivElement;
  private readonly input: HTMLTextAreaElement;
  private readonly modeBtn: HTMLButtonElement;
  private readonly modelBtn: HTMLButtonElement;
  private readonly ctx: { root: HTMLSpanElement; arc: SVGCircleElement; text: HTMLSpanElement };
  private readonly sendBtn: HTMLButtonElement;
  private readonly attachStrip = h('div', 'attachments');
  private readonly attachNote = h('div', 'attach-note');
  private readonly fileInput = h('input');
  private readonly working = new WorkingLine();
  private readonly slash: SlashMenu;
  /** The session's Clawd, large, in the header of a panel that asks for one. */
  private readonly mascot: Avatar | null;
  private readonly nodes = new Map<string, HTMLElement>();
  /** Older items not drawn yet, oldest first (see FIRST_BATCH). */
  private pending: string[] = [];
  private pendingSet = new Set<string>();
  private pendingTimer = 0;
  /** At the end of the stream: it stays there as the stream grows (see the ResizeObserver). */
  private pinned = true;
  /** The reply being streamed: its finished blocks stay put, only the block being written is redrawn. */
  private live: { id: string; stable: HTMLElement; tail: HTMLElement; source: string } | null = null;
  /** Rebuilding the stream (a conversation opens): its items appear without the arrival animation. */
  private resetting = false;
  private readonly drafts = new Map<string, { text: string; attachments: Attachment[] }>();
  private attachments: Attachment[] = [];
  /** Images still being decoded or re-encoded: sending waits for them so none is dropped. */
  private preparing = 0;
  private submitting = false;
  private noteTimer = 0;
  private session: SessionView | null = null;
  private items: Items | undefined;
  private models: ModelOption[] = [];
  /** The models of the accounts that list their own (Codex), by account id. */
  private catalogs: Record<string, ModelOption[]> = {};
  /** The providers, connected or not: what the provider button offers. */
  private providers: ProviderBadge[] = [];
  /** Accounts a worker can be moved to; the menu only shows with more than the usual one. */
  private accounts: AccountBadge[] = [];
  /** The master's topic shown (its items only) and written in; null: everything. */
  private topic: { id: string; title: string } | null = null;

  constructor(
    pane: HTMLElement,
    private readonly hub: HubApi,
    private readonly emptyText: string,
    /** Given for a panel that can be hidden: adds a close button to its header. */
    onClose?: () => void,
    mascot = false,
    /** Takes the place of the folder chip at the end of the header; the folder moves to the name's tooltip. */
    private readonly action?: HTMLElement,
  ) {
    this.mascot = mascot ? new Avatar('stage') : null;
    const head = h('div', this.mascot ? 'pane-head portrait' : 'pane-head');
    this.head = { dot: h('span', 'dot'), name: h('span', 'ph-name'), status: h('span', 'ph-status'), mission: h('span', 'ph-mission'), cwd: h('span', 'ph-cwd') };
    if (this.mascot) {
      // The mascot stands for the status dot; the mission gets a line of its own beside it.
      const title = h('div', 'ph-title');
      title.append(this.head.name, this.head.status, this.head.cwd);
      const text = h('div', 'ph-text');
      text.append(title, this.head.mission);
      head.append(this.mascot.root, text);
    } else {
      head.append(this.head.dot, this.head.name, this.head.status, this.head.mission, action ?? this.head.cwd);
    }
    if (onClose) {
      const close = h('button', 'icon-btn ph-close');
      close.title = t('chat.hide');
      close.setAttribute('aria-label', close.title);
      close.append(icon(ICONS.remove));
      close.addEventListener('click', onClose);
      head.append(close);
    }

    this.scroller = h('div', 'chat');
    this.stream = h('div', 'chat-inner');
    this.empty = h('div', 'chat-empty', emptyText);
    this.stream.append(this.empty, this.working.root);
    this.scroller.append(this.stream);
    // Pinned to the end while the stream grows (a reply streaming, an image loading, messages laid out as they
    // scroll into view), measured after layout: no script forces one.
    this.scroller.addEventListener('scroll', () => (this.pinned = this.atBottom()), { passive: true });
    new ResizeObserver(() => {
      if (this.pinned) this.scroller.scrollTop = this.scroller.scrollHeight;
    }).observe(this.stream);
    this.scroller.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('a');
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute('href');
      if (href) this.hub.openExternal(href);
    });

    // Grows with its text through CSS (field-sizing), without measuring on every keystroke.
    this.input = h('textarea', 'composer-input');
    this.input.rows = 1;
    this.slash = new SlashMenu(this.input, hub, {
      session: () => this.session,
      models: () => (this.session ? this.modelsFor(this.session) : this.models),
      openModelMenu: () => this.openModelMenu(),
      openModeMenu: (bypass) => this.openModeMenu(bypass),
      // A sentence on where to do it instead: longer to read than an attachment's error.
      note: (text) => this.attachError(text, 8000),
      clearText: () => {
        this.input.value = '';
        this.syncSend();
      },
    });
    this.input.addEventListener('input', () => {
      this.syncSend();
      this.slash.update();
    });
    this.input.addEventListener('blur', () => this.slash.close());
    this.input.addEventListener('keydown', (e) => {
      if (this.slash.onKey(e)) return;
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.submit();
      } else if (e.key === 'Escape' && this.isBusy()) {
        e.preventDefault();
        this.interrupt();
      }
    });
    this.input.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
      if (files.length === 0) return;
      // A screenshot comes alone; an image copied from a page may also carry text, which still pastes as usual.
      if (!e.clipboardData?.getData('text/plain')) e.preventDefault();
      void this.addFiles(files);
    });

    this.fileInput.type = 'file';
    this.fileInput.accept = 'image/*';
    this.fileInput.multiple = true;
    this.fileInput.hidden = true;
    this.fileInput.addEventListener('change', () => {
      void this.addFiles([...(this.fileInput.files ?? [])]);
      this.fileInput.value = '';
    });
    const attachBtn = h('button', 'cbtn cbtn-icon');
    attachBtn.title = t('chat.attach', { mod: PLATFORM === 'darwin' ? '⌘' : 'Ctrl' });
    attachBtn.setAttribute('aria-label', t('chat.attachShort'));
    attachBtn.append(icon(ICONS.attach));
    attachBtn.addEventListener('click', () => this.fileInput.click());
    this.attachStrip.hidden = true;
    this.attachNote.hidden = true;

    pane.dataset.drop = t('chat.drop');
    pane.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      pane.classList.add('drop-target');
    });
    pane.addEventListener('dragleave', (e) => {
      if (!pane.contains(e.relatedTarget as Node | null)) pane.classList.remove('drop-target');
    });
    pane.addEventListener('drop', (e) => {
      pane.classList.remove('drop-target');
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      const files = [...e.dataTransfer.files];
      const images = files.filter((f) => f.type.startsWith('image/'));
      if (images.length < files.length) this.attachError(t('chat.onlyImages'));
      void this.addFiles(images);
      this.input.focus();
    });

    this.modeBtn = h('button', 'cbtn');
    this.modeBtn.addEventListener('click', () => this.openModeMenu());
    this.modelBtn = h('button', 'cbtn cbtn-model');
    this.modelBtn.addEventListener('click', () => this.openModelMenu());
    // The same "/" menu as typing it, for those who look for the commands rather than know them.
    const slashBtn = h('button', 'cbtn cbtn-icon cbtn-slash', '/');
    slashBtn.title = t('slash.button');
    slashBtn.setAttribute('aria-label', t('slash.title'));
    slashBtn.setAttribute('aria-haspopup', 'listbox');
    // The field keeps the focus: the menu reads its keys.
    slashBtn.addEventListener('mousedown', (e) => e.preventDefault());
    slashBtn.addEventListener('click', () => this.slash.toggle());

    const ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ring.setAttribute('viewBox', '0 0 18 18');
    ring.setAttribute('class', 'ring');
    const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    const arc = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    for (const c of [track, arc]) {
      c.setAttribute('cx', '9');
      c.setAttribute('cy', '9');
      c.setAttribute('r', '7');
    }
    track.setAttribute('class', 'ring-track');
    arc.setAttribute('class', 'ring-arc');
    ring.append(track, arc);
    const ctxRoot = h('span', 'ctx');
    const ctxText = h('span');
    ctxRoot.append(ring, ctxText);
    this.ctx = { root: ctxRoot, arc, text: ctxText };

    this.sendBtn = h('button', 'send');
    this.sendBtn.addEventListener('click', () => (this.isBusy() && !this.hasContent() ? this.interrupt() : this.submit()));

    const bar = h('div', 'composer-bar');
    bar.append(attachBtn, this.modeBtn, this.modelBtn, slashBtn, h('span', 'spacer'), ctxRoot, this.sendBtn);
    const box = h('div', 'composer-box');
    box.append(this.slash.root, this.attachStrip, this.attachNote, this.slash.confirmation, this.input, bar, this.fileInput);
    box.addEventListener('mousedown', (e) => {
      if (e.target === box) e.preventDefault();
    });
    box.addEventListener('click', (e) => {
      if (e.target === box) this.input.focus();
    });
    const composer = h('div', 'composer');
    composer.append(box);

    pane.append(head, this.scroller, composer);
  }

  get sessionId(): string | null {
    return this.session?.id ?? null;
  }

  /** Releases the draft (and its images) of a session that no longer exists. */
  forget(id: string): void {
    this.drafts.delete(id);
    for (const key of htmlCache.keys()) if (key.startsWith(`${id}\n`)) htmlCache.delete(key);
  }

  focus(): void {
    this.input.focus();
  }

  /** Shows only the items of one of the master's topics (null: all of them); what is sent then is written in it. */
  setTopic(topic: { id: string; title: string } | null): void {
    const changed = topic?.id !== this.topic?.id;
    this.topic = topic;
    this.renderChrome();
    if (!changed) return;
    this.empty.textContent = topic ? t('topics.empty', { title: topic.title }) : this.emptyText;
    this.reset(this.items);
  }

  private shows(item: ChatItem): boolean {
    return !this.topic || item.topic === this.topic.id || !!item.also?.includes(this.topic.id);
  }

  /** Shows a session; switching to another one rebuilds the stream and restores its draft. */
  show(session: SessionView | undefined, items: Items | undefined, models: ModelOption[], accounts: AccountBadge[] = [], catalogs: Record<string, ModelOption[]> = {}, providers: ProviderBadge[] = []): void {
    this.models = models;
    this.providers = providers;
    this.catalogs = catalogs;
    this.accounts = accounts;
    const switched = (session?.id ?? null) !== this.sessionId;
    const previous = this.session;
    if (switched && previous) this.drafts.set(previous.id, { text: this.input.value, attachments: this.attachments });
    this.session = session ?? null;
    this.items = items;
    if (!session) this.mascot?.dispose(); // Hidden panel: its Clawd leaves the stage.
    if (switched) {
      // Another conversation in the same panel: it fades in rather than replacing the last one in a flash.
      if (session && previous && !reducedMotion.matches) this.scroller.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
      const draft = session ? this.drafts.get(session.id) : undefined;
      this.input.value = draft?.text ?? '';
      this.attachments = draft?.attachments ?? [];
      this.renderAttachments();
      this.slash.reset();
      this.reset(items);
    }
    this.renderChrome();
    this.syncWorking();
  }

  reset(items: Items | undefined): void {
    this.items = items;
    for (const node of this.nodes.values()) node.remove();
    this.nodes.clear();
    this.live = null;
    window.clearTimeout(this.pendingTimer);
    const all = [...(items?.values() ?? [])].filter((item) => this.shows(item));
    const first = all.slice(-FIRST_BATCH);
    this.pending = all.slice(0, all.length - first.length).map((item) => item.id);
    this.pendingSet = new Set(this.pending);
    this.resetting = true;
    for (const item of first) this.place(item);
    this.resetting = false;
    this.empty.hidden = all.length > 0;
    this.syncWorking();
    this.scrollToEnd();
    if (this.pending.length > 0) this.pendingTimer = window.setTimeout(() => this.drawOlder(), 0);
  }

  /** Draws the next batch of older items above the ones shown; scroll anchoring keeps the view where it is. */
  private drawOlder(): void {
    const batch = this.pending.splice(Math.max(0, this.pending.length - LATER_BATCH));
    let before = this.empty.nextElementSibling;
    for (let i = batch.length - 1; i >= 0; i--) {
      this.pendingSet.delete(batch[i]);
      const item = this.items?.get(batch[i]);
      // Filed under another topic since the view opened: out of it.
      if (!item || !this.shows(item)) continue;
      const node = this.render(item);
      this.stream.insertBefore(node, before);
      this.nodes.set(item.id, node);
      before = node;
    }
    if (this.pending.length > 0) this.pendingTimer = window.setTimeout(() => this.drawOlder(), 16);
  }

  upsert(items: ChatItem[]): void {
    for (const item of items) this.place(item);
    this.empty.hidden = this.nodes.size + this.pending.length > 0;
    this.syncWorking();
  }

  private atBottom(): boolean {
    return this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 48;
  }

  private scrollToEnd(): void {
    this.pinned = true;
    this.scroller.scrollTop = this.scroller.scrollHeight;
  }

  /** Working line at the end of the stream, driven by the session status and its latest item. */
  private syncWorking(): void {
    const s = this.session;
    const last = lastOf(this.items);
    this.working.update(s?.status, s?.busySince ?? null, activityOf(last), s?.background, s?.compacting);
    if (s) this.mascot?.update(s, last, sessionMascot(s, this.accounts));
  }

  // ---------- chrome (header + composer state) ----------

  private isBusy(): boolean {
    return this.session?.status === 'busy' || this.session?.status === 'attention';
  }

  private renderChrome(): void {
    const s = this.session;
    if (!s) return;
    this.head.dot.className = statusDot(s);
    this.head.name.textContent = displayName(s);
    this.head.status.textContent = statusLabel(s);
    this.head.status.classList.toggle('error', failed(s));
    this.head.mission.textContent = s.role === 'worker' ? oneLine(s.mission) : '';
    this.head.mission.title = s.mission;
    this.head.cwd.textContent = s.cwd.split(/[\\/]/).filter(Boolean).pop() ?? s.cwd;
    this.head.cwd.title = s.cwd;
    this.head.name.title = this.action ? t('chat.cwdTitle', { cwd: s.cwd }) : '';

    this.input.placeholder =
      s.status === 'exited'
        ? t(s.post ? 'chat.asleepPlaceholder' : 'chat.closedPlaceholder')
        : s.role === 'master'
          ? this.topic
            ? t('topics.placeholder', { title: this.topic.title })
            : t('chat.masterPlaceholder')
          : t('chat.workerPlaceholder');

    this.modeBtn.replaceChildren(icon(ICONS.shield), h('span', '', s.mode ? modeLabel(s.mode) : t('chat.modeDefault')));
    this.modeBtn.classList.toggle('danger', s.mode === 'bypassPermissions');
    this.modeBtn.title = s.mode ? modeHint(s.mode) : t('chat.modeTitle');
    // One button for the provider and the model: "DeepSeek · V4 Pro", the effort beside it.
    const badge = this.accounts.find((a) => a.id === s.account);
    const provider = this.providers.find((p) => p.id === badge?.provider)?.label ?? badge?.name ?? '';
    const shown = provider && s.modelLabel.startsWith(provider) ? s.modelLabel.slice(provider.length).trim() || s.modelLabel : s.modelLabel;
    const note = s.fallbackFrom ? t('chat.fallbackFrom', { name: this.accounts.find((a) => a.id === s.fallbackFrom)?.name ?? s.fallbackFrom }) : s.accountPending ? t('chat.accountPending') : '';
    this.modelBtn.replaceChildren(
      ...(provider ? [h('span', 'cbtn-provider', provider)] : []),
      h('span', '', shown),
      h('span', 'cbtn-muted', [s.effort ? effortLabel(s.effort) : '', s.ultracode && s.ultracodeAccess === 'allowed' ? t('chat.ultracode') : '', note].filter(Boolean).join(' · ')),
      icon(ICONS.chevron, 'ico small'),
      ...(this.providers.some((p) => p.connected && p.news.unseen) ? [h('span', 'news-dot')] : []),
    );
    this.modelBtn.title = t('chat.modelTitle');
    this.modelBtn.classList.toggle('warn', s.fallbackFrom !== '');

    const m = s.metrics;
    const pct = m?.contextPct ?? null;
    const circumference = 2 * Math.PI * 7;
    this.ctx.arc.setAttribute('stroke-dasharray', `${(circumference * Math.min(100, pct ?? 0)) / 100} ${circumference}`);
    this.ctx.root.className = `ctx ${level(pct)}`;
    this.ctx.text.textContent = fmtPct(pct);
    this.ctx.root.title = m && m.contextSize ? t('chat.context', { used: fmtTokens(m.contextTokens), size: fmtTokens(m.contextSize) }) : t('chat.contextShort');
    this.syncSend();
  }

  private hasContent(): boolean {
    return this.input.value.trim() !== '' || this.attachments.length > 0;
  }

  private syncSend(): void {
    const stop = this.isBusy() && !this.hasContent() && this.preparing === 0;
    this.sendBtn.replaceChildren(icon(stop ? ICONS.stop : ICONS.send));
    this.sendBtn.classList.toggle('stop', stop);
    this.sendBtn.disabled = !stop && (!this.hasContent() || this.preparing > 0);
    this.sendBtn.title = stop ? t('chat.interrupt') : this.preparing > 0 ? t('chat.preparing') : t('chat.send');
  }

  /** A "/" command runs here (or is refused with a note, nothing sent); anything else goes to the session. */
  private submit(): void {
    if (!this.hasContent() || this.preparing > 0 || !this.session || this.submitting) return;
    const id = this.session.id;
    const text = this.input.value;
    const attachments = [...this.attachments];
    const topic = this.topic?.id ?? null;
    // Claude Code's commands may still be loading: one submit at a time.
    this.submitting = true;
    void this.slash
      .intercept(text.trim())
      .then((r) => {
        // Another conversation was opened while the commands loaded: the draft stays where it was.
        if (r.handled || this.session?.id !== id) return;
        this.hub.send(
          id,
          r.text,
          attachments.map((a) => a.image),
          topic,
        );
        // Only what was sent leaves the composer: text typed or images added meanwhile stay.
        if (this.input.value === text) this.input.value = '';
        for (const a of attachments) {
          const i = this.attachments.indexOf(a);
          if (i >= 0) this.attachments.splice(i, 1);
        }
        this.renderAttachments();
        this.syncSend();
        this.scrollToEnd();
      })
      .finally(() => (this.submitting = false));
  }

  /** Adds images to the draft they were picked for, even if another session is shown by the time they are ready. */
  private async addFiles(files: File[]): Promise<void> {
    const target = this.attachments;
    const batch = files.slice(0, ATTACH_LIMITS.count);
    if (files.length > batch.length) this.attachError(t('chat.maxImages', { n: ATTACH_LIMITS.count }));
    this.preparing += batch.length;
    this.syncSend();
    for (const file of batch) {
      try {
        const attachment = await toAttachment(file);
        // Checked once ready: concurrent pastes or drops all fill the same draft.
        const total = target.reduce((sum, a) => sum + base64Bytes(a.image.data), base64Bytes(attachment.image.data));
        if (target.length >= ATTACH_LIMITS.count) this.attachError(t('chat.maxImages', { n: ATTACH_LIMITS.count }));
        else if (total > ATTACH_LIMITS.totalBytes) this.attachError(t('chat.tooHeavy'));
        else target.push(attachment);
      } catch (err) {
        this.attachError(err instanceof Error ? err.message : String(err));
      }
      this.preparing--;
      this.renderAttachments();
      this.syncSend();
    }
  }

  private renderAttachments(): void {
    this.attachStrip.hidden = this.attachments.length === 0;
    this.attachStrip.replaceChildren(
      ...this.attachments.map((a) => {
        const chip = h('div', 'attach');
        const img = h('img');
        img.src = a.url;
        img.alt = t('chat.image');
        img.addEventListener('click', () => openLightbox(a.url));
        const remove = h('button', 'attach-remove');
        remove.title = t('chat.removeShort');
        remove.setAttribute('aria-label', t('chat.removeImage'));
        remove.append(icon(ICONS.remove));
        remove.addEventListener('click', () => {
          this.attachments.splice(this.attachments.indexOf(a), 1);
          this.renderAttachments();
          this.syncSend();
          this.input.focus();
        });
        chip.append(img, remove);
        return chip;
      }),
    );
  }

  private attachError(text: string, ms = 4000): void {
    this.attachNote.textContent = text;
    this.attachNote.hidden = false;
    window.clearTimeout(this.noteTimer);
    this.noteTimer = window.setTimeout(() => (this.attachNote.hidden = true), ms);
  }

  private interrupt(): void {
    if (this.session) this.hub.interrupt(this.session.id);
  }

  /** `bypass`: opens straight on the confirmation that "Allow everything" asks for (/mode bypass). */
  private openModeMenu(bypass = false): void {
    const s = this.session;
    if (!s) return;
    let confirm = () => {};
    openMenu(this.modeBtn, (menu, close) => {
      confirm = () => this.confirmBypass(menu, s.id, close);
      menu.append(h('div', 'menu-label', t('chat.modeMenu')));
      for (const mode of MENU_MODES) {
        const row = this.menuRow(modeLabel(mode), modeHint(mode), s.mode === mode);
        row.classList.toggle('danger', mode === 'bypassPermissions');
        row.addEventListener('click', () => {
          if (mode === 'bypassPermissions' && s.mode !== mode) return this.confirmBypass(menu, s.id, close);
          this.hub.setMode(s.id, mode);
          close();
        });
        menu.append(row);
      }
    });
    if (bypass) confirm();
  }

  /** Same explicit confirmation as in the settings before a session runs without any approval. */
  private confirmBypass(menu: HTMLElement, id: string, close: () => void): void {
    const box = h('div', 'menu-confirm');
    const label = h('label', 'menu-confirm-text');
    const check = h('input');
    check.type = 'checkbox';
    label.append(check, h('span', '', t('setup.mode.bypassConfirm')));
    const enable = h('button', 'btn danger', t('setup.mode.bypassEnable'));
    enable.disabled = true;
    check.addEventListener('change', () => (enable.disabled = !check.checked));
    enable.addEventListener('click', () => {
      this.hub.setMode(id, 'bypassPermissions');
      close();
    });
    const cancel = h('button', 'btn ghost', t('setup.cancel'));
    cancel.addEventListener('click', close);
    const row = h('div', 'menu-confirm-actions');
    row.append(enable, cancel);
    box.append(label, row);
    menu.replaceChildren(h('div', 'menu-label', t('mode.bypassPermissions')), box);
    check.focus();
  }

  /** The models a session can pick: its account's own list (Codex), else Claude's. */
  private modelsFor(s: SessionView): ModelOption[] {
    return this.catalogs[s.account] ?? this.models;
  }

  private openModelMenu(): void {
    const s = this.session;
    if (!s) return;
    const badge = this.accounts.find((a) => a.id === s.account);
    // A session on an older, hand-made account that pins its model: only its effort is picked here.
    const pinned = !!badge?.pinned;
    const current = badge?.provider ?? '';
    let tab: string = current || this.providers.find((p) => p.connected)?.id || '';
    const openSettings = (close: () => void) => {
      close();
      window.dispatchEvent(new CustomEvent('hub:open-settings', { detail: 'accounts' }));
    };
    // The providers whose older models are unfolded behind "See more".
    const unfolded = new Set<string>();
    // The effort picked on a provider's tab the session is not on yet: it goes with the model picked next.
    let nextEffort: Effort | null = null;
    // The effort just picked for the session itself: the menu stays open, the button shows it before the session reports back.
    let applied: Effort | null = null;
    // Same for Ultracode, a switch of the session itself.
    let ultracode: boolean | null = null;
    // What was new at each provider when its tab was first shown: the tags stay while the menu is open, though the
    // providers are told they were seen at once (the next menu has none).
    const looked = new Map<string, string[]>();
    const lookAt = (id: string) => {
      const p = this.providers.find((x) => x.id === id);
      if (!p?.connected || looked.has(id)) return;
      looked.set(id, p.news.models);
      if (p.news.unseen && isProviderId(p.id)) this.hub.ackNews(p.id);
    };
    openMenu(this.modelBtn, (menu, close) => {
      const draw = () => {
        lookAt(tab);
        menu.replaceChildren();
        // Only the models list scrolls: the provider above and the effort below stay in view, however long the list.
        const root = h('div', 'model-menu');
        menu.append(root);
        // The provider first: the models below are its models. One that is not connected is greyed, and leads to Settings.
        const tabs = h('div', 'segmented provider-tabs');
        for (const p of this.providers) {
          const b = h('button', p.id === tab ? 'seg active' : 'seg');
          b.append(mascotMark(p.id, 'seg-pic', p.label), p.label);
          b.classList.toggle('off', !p.connected);
          b.title = p.connected ? '' : t('chat.providerOff');
          if (p.connected && p.id !== tab && !looked.has(p.id) && p.news.unseen) {
            b.append(h('span', 'news-dot'));
            b.title = t('chat.newTip', { provider: p.label });
          }
          b.addEventListener('click', () => {
            if (!p.connected) return openSettings(close);
            tab = p.id;
            draw();
          });
          tabs.append(b);
        }
        root.append(tabs);
        const models = tab === current ? this.modelsFor(s) : (this.providers.find((p) => p.id === tab)?.models ?? []);
        root.append(h('div', 'menu-label', t('chat.model')));
        const list = h('div', 'menu-models');
        root.append(list);
        if (pinned && tab === current) list.append(h('div', 'menu-note', t('chat.modelBridged', { model: s.modelLabel })));
        else if (models.length === 0) list.append(h('div', 'menu-note', t('chat.modelsLater')));
        // The newest models of each family first, the model in use among them; the others behind "See more".
        const split = splitRecent(pinned && tab === current ? [] : models, tab === current ? s.model : '');
        // A new model is shown at once, even if it would be under "See more".
        const newKeys = new Set(looked.get(tab) ?? []);
        const isNew = (m: ModelOption) => newKeys.has(modelKey(m));
        const shownFirst = new Set([...split.recent, ...split.older.filter(isNew)]);
        const recent = models.filter((m) => shownFirst.has(m));
        const older = split.older.filter((m) => !isNew(m));
        const open = unfolded.has(tab);
        const box = isProviderId(tab) ? cliUpdateBox(tab, this.providers.find((p) => p.id === tab)?.news.cli ?? null) : null;
        if (box) list.append(box);
        const addModel = (model: ModelOption) => {
          const row = this.menuRow(model.label, model.description, tab === current && model.value === s.model, isNew(model));
          row.addEventListener('click', () => {
            // Provider and model in one go: the session moves to the provider if it is not there already.
            if (tab === current) this.hub.setModel(s.id, model.value);
            else if (nextEffort) {
              this.hub.setEffort(s.id, nextEffort);
              this.hub.setProviderModel(s.id, tab, model.value);
            } else this.hub.setProviderModel(s.id, tab, model.value);
            close();
          });
          list.append(row);
        };
        for (const model of open ? [...recent, ...older] : recent) addModel(model);
        if (older.length) {
          const more = h('button', 'menu-more', open ? t('chat.modelsLess') : t('chat.modelsMore', { n: older.length }));
          more.setAttribute('aria-expanded', String(open));
          more.addEventListener('click', () => {
            if (open) unfolded.delete(tab);
            else unfolded.add(tab);
            draw();
          });
          list.append(more);
        }
        // The effort of the model the session runs, on its provider's tab. On another provider's tab it is the effort the
        // session takes when a model of that provider is picked: chosen first, applied with the model.
        const fresh = tab !== current;
        const shown = fresh ? (recent.find((m) => m.value !== 'default') ?? models[0]) : models.find((m) => m.value === s.model);
        const efforts = effortsFor(models, shown?.value ?? s.model);
        if (efforts.length > 0 && !(fresh && models.length === 0)) {
          root.append(h('div', 'menu-sep'), h('div', 'menu-label', t('chat.effort')));
          const seg = h('div', 'segmented efforts');
          const active = fresh ? nextEffort : (applied ?? s.effort);
          for (const effort of efforts) {
            const b = h('button', effort === active ? 'seg active' : 'seg', effortLabel(effort));
            b.addEventListener('click', () => {
              if (fresh) {
                nextEffort = effort;
                return draw();
              }
              this.hub.setEffort(s.id, effort);
              applied = effort;
              draw();
            });
            seg.append(b);
          }
          root.append(seg);
        }
        // Ultracode belongs to Claude Code: on Anthropic's tab, for a session that runs there. Hidden on a Pro plan; shown
        // but off when the plan is not known.
        if (tab === current && current === 'anthropic' && s.ultracodeAccess !== 'hidden') {
          const known = s.ultracodeAccess === 'allowed';
          const on = known && (ultracode ?? s.ultracode);
          const old = s.ultracodeAccess === 'outdated';
          const row = this.menuRow(t('chat.ultracode'), t(known ? 'chat.ultracode.hint' : old ? 'chat.ultracode.old' : 'chat.ultracode.unknown'), on);
          row.setAttribute('role', 'switch');
          row.setAttribute('aria-checked', String(on));
          row.disabled = !known;
          if (!known) row.title = t(old ? 'chat.ultracode.old' : 'chat.ultracode.unknownTip');
          row.addEventListener('click', () => {
            ultracode = !on;
            this.hub.setUltracode(s.id, ultracode);
            draw();
          });
          root.append(h('div', 'menu-sep'), row);
        }
        if (s.userAccount) {
          const back = this.menuRow(t('chat.accountUsual'), t('chat.accountUsual.hint'), false);
          back.addEventListener('click', () => {
            this.hub.setAccount(s.id, '');
            close();
          });
          root.append(h('div', 'menu-sep'), back);
        }
        if (this.providers.some((p) => !p.connected)) {
          const add = this.menuRow(t('chat.providerConnect'), t('chat.providerConnect.hint'), false);
          add.addEventListener('click', () => openSettings(close));
          root.append(h('div', 'menu-sep'), add);
        }
        root.append(h('div', 'menu-note', t('chat.accountNote')));
      };
      draw();
    });
  }

  private menuRow(label: string, hint: string, checked: boolean, isNew = false): HTMLButtonElement {
    const row = h('button', checked ? 'menu-row checked' : 'menu-row');
    const text = h('span', 'menu-text');
    const title = h('span', 'menu-title', label);
    if (isNew) title.append(h('span', 'news-tag', t('chat.new')));
    text.append(title);
    if (hint) text.append(h('span', 'menu-hint', hint));
    row.append(checked ? icon(ICONS.check) : h('span', 'ico'), text);
    return row;
  }

  // ---------- stream ----------

  private place(item: ChatItem): void {
    if (this.pendingSet.has(item.id)) return; // Drawn with its latest state when its batch comes.
    if (!this.shows(item)) {
      // Filed under another topic (or not yet): out of this view.
      this.nodes.get(item.id)?.remove();
      this.nodes.delete(item.id);
      if (this.live?.id === item.id) this.live = null;
      return;
    }
    if (item.kind === 'assistant' && item.live && this.live?.id === item.id) return this.streamLive(item.text);
    const old = this.nodes.get(item.id);
    const node = this.render(item);
    if (old instanceof HTMLDetailsElement && node instanceof HTMLDetailsElement) node.open = old.open;
    if (old) old.replaceWith(node);
    else {
      if (!this.resetting) node.classList.add('enter');
      // In a topic's view, an earlier message filed into it late takes its place in the conversation.
      this.stream.insertBefore(node, this.topic && !this.resetting ? this.nodeAfter(item.id) : this.working.root);
    }
    this.nodes.set(item.id, node);
  }

  /** The drawn node of the first item after this one, else the end of the stream. */
  private nodeAfter(id: string): Node {
    let after = false;
    for (const key of this.items?.keys() ?? []) {
      const node = after ? this.nodes.get(key) : undefined;
      if (node) return node;
      if (key === id) after = true;
    }
    return this.working.root;
  }

  private render(item: ChatItem): HTMLElement {
    switch (item.kind) {
      case 'user': {
        const wrap = h('div', 'msg msg-user');
        const col = h('div', 'user-col');
        if (item.images.length > 0) {
          const grid = h('div', 'user-images');
          for (const src of item.images) {
            const img = h('img', 'user-image');
            img.src = src;
            img.alt = t('chat.image');
            img.title = t('chat.enlarge');
            img.addEventListener('click', () => openLightbox(src));
            grid.append(img);
          }
          col.append(grid);
        }
        if (item.text) col.append(h('div', 'bubble', item.text), this.actions(item.text));
        wrap.append(col);
        return wrap;
      }
      case 'peer': {
        const wrap = h('div', 'msg msg-peer');
        const label = h('div', 'peer-head');
        label.append(h('span', '', t('chat.from')), h('b', '', item.from));
        const body = h('div', 'md');
        body.innerHTML = cachedMarkdown(this.cacheKey(item.id), item.text);
        this.addCodeCopy(body);
        wrap.append(label, body, this.actions(item.text));
        return wrap;
      }
      case 'assistant': {
        const el = h('div', item.live ? 'msg msg-assistant live' : 'msg msg-assistant');
        const body = h('div', 'md');
        el.append(body);
        if (item.live) {
          const stable = h('div', 'md-part');
          const tail = h('div', 'md-part md-tail');
          body.append(stable, tail);
          this.live = { id: item.id, stable, tail, source: '' };
          this.streamLive(item.text);
          return el;
        }
        if (this.live?.id === item.id) this.live = null;
        body.innerHTML = cachedMarkdown(this.cacheKey(item.id), item.text);
        this.addCodeCopy(body);
        el.append(this.actions(item.text));
        return el;
      }
      case 'thinking': {
        const d = h('details', 'step thinking');
        const sum = h('summary');
        sum.append(icon(ICONS.chevron, 'ico caret'), h('span', 'step-name', t('chat.thinking')));
        d.append(sum, h('div', 'step-body thinking-text', item.text));
        return d;
      }
      case 'tool': {
        const state = item.result === null ? 'running' : item.isError ? 'error' : 'done';
        const d = h('details', `step tool ${state}`);
        const sum = h('summary');
        sum.append(h('span', 'step-dot'), h('span', 'step-name', item.name), h('span', 'step-summary', item.summary));
        const body = h('div', 'step-body');
        if (item.detail && item.detail !== item.summary) body.append(this.code(item.detail, item.diff));
        if (item.result) {
          body.append(h('div', 'step-label', item.isError ? t('chat.error') : t('chat.result')));
          body.append(this.code(item.result, false, item.isError ? 'result error' : 'result'));
        }
        d.append(sum, body);
        return d;
      }
      case 'permission':
        return item.state === 'pending' ? this.permissionCard(item) : this.permissionDone(item);
      case 'notice': {
        const el = h('div', `notice ${item.tone}`, item.text);
        if (item.action === 'accounts-settings') {
          const open = h('button', 'btn small notice-action', t('notice.openAccountsSettings'));
          open.addEventListener('click', () => window.dispatchEvent(new CustomEvent('hub:open-settings', { detail: 'accounts' })));
          el.append(open);
        }
        if (item.detail) el.append(techDetails(item.detail));
        return el;
      }
    }
  }

  private cacheKey(id: string): string {
    return `${this.session?.id ?? ''}\n${id}`;
  }

  /** Appends the blocks the reply finished since the last frame, then redraws only the block being written. */
  private streamLive(text: string): void {
    const live = this.live;
    if (!live) return;
    if (!text.startsWith(live.source)) {
      live.stable.replaceChildren(); // Rewritten rather than extended: start over.
      live.source = '';
    }
    const end = stableEnd(text);
    if (end > live.source.length) {
      live.stable.insertAdjacentHTML('beforeend', markdown(text.slice(live.source.length, end)));
      live.source = text.slice(0, end);
    }
    live.tail.innerHTML = markdown(text.slice(live.source.length));
  }

  /** Hover row under a message; copies its raw text (markdown source for Claude's replies). */
  private actions(text: string): HTMLDivElement {
    const row = h('div', 'msg-actions');
    row.append(copyButton(() => text, t('chat.copyMessage')));
    return row;
  }

  private addCodeCopy(body: HTMLElement): void {
    for (const pre of body.querySelectorAll('pre')) {
      const wrap = h('div', 'code-wrap');
      pre.replaceWith(wrap);
      const btn = copyButton(() => pre.textContent ?? '', t('chat.copyCode'));
      btn.classList.add('code-copy');
      wrap.append(pre, btn);
    }
  }

  private code(text: string, diff: boolean, cls = ''): HTMLPreElement {
    const pre = h('pre', `code ${cls}`);
    if (!diff) {
      pre.textContent = text;
      return pre;
    }
    for (const line of text.split('\n')) {
      pre.append(h('span', line.startsWith('+ ') ? 'add' : line.startsWith('- ') ? 'del' : '', `${line}\n`));
    }
    return pre;
  }

  private permissionCard(item: Extract<ChatItem, { kind: 'permission' }>): HTMLElement {
    const sessionId = this.session?.id ?? '';
    const card = h('div', 'perm');
    const title = h('div', 'perm-title');
    title.append(icon(ICONS.shield));
    if (item.title) title.append(h('span', '', item.title));
    else {
      const [before, after] = t('perm.question').split('{tool}');
      title.append(h('span', '', before), h('b', '', item.tool), h('span', '', after));
    }
    card.append(title);
    if (item.summary) card.append(h('div', item.title ? 'perm-summary human' : 'perm-summary', item.summary));
    // A command or an edit is what is being allowed: in view. Any other raw input, and the CLI's own reason (English),
    // fold under "Details".
    const detail = item.detail && item.detail !== item.summary ? item.detail : '';
    if (detail && (item.showDetail || item.diff)) card.append(this.code(detail, item.diff));
    const raw = [item.showDetail || item.diff ? '' : detail, item.reason].filter(Boolean).join('\n\n');
    if (raw) card.append(techDetails(raw));

    const decide = (behavior: 'allow' | 'always' | 'deny', message?: string) => this.hub.decide(sessionId, item.id, { behavior, message });
    const actions = h('div', 'perm-actions');
    const allow = h('button', 'btn primary', item.allowLabel ?? t('perm.allow'));
    allow.addEventListener('click', () => decide('allow'));
    actions.append(allow);
    if (item.canAlways) {
      const always = h('button', 'btn', t('perm.always'));
      always.title = t('perm.alwaysHint');
      always.addEventListener('click', () => decide('always'));
      actions.append(always);
    }
    const deny = h('button', 'btn ghost', item.denyLabel ?? t('perm.deny'));
    deny.addEventListener('click', () => decide('deny'));
    actions.append(deny);

    const other = h('input', 'perm-input');
    other.placeholder = t('perm.other');
    other.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && other.value.trim()) decide('deny', other.value.trim());
    });
    card.append(actions, other);
    return card;
  }

  private permissionDone(item: Extract<ChatItem, { kind: 'permission' }>): HTMLElement {
    const labels = { allowed: t('perm.allowed'), denied: t('perm.denied'), expired: t('perm.expired'), pending: '' };
    const row = h('div', `perm-done ${item.state}`);
    // "Allowed · Command": the outcome first, so it reads the same whatever the tool's name.
    row.append(icon(item.state === 'allowed' ? ICONS.check : ICONS.remove), h('span', '', labels[item.state]), h('span', 'perm-done-sep', '·'), h('b', '', item.tool));
    if (item.summary) row.append(h('span', 'perm-done-summary', item.summary));
    return row;
  }
}
