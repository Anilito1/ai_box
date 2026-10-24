import DOMPurify from 'dompurify';
import { marked } from 'marked';
import {
  ATTACH_LIMITS,
  base64Bytes,
  EFFORTS,
  MENU_MODES,
  type ChatItem,
  type Effort,
  type Mode,
  type HubApi,
  type ModelOption,
  type SessionView,
} from '../shared/types';
import { toAttachment, type Attachment } from './attachments';
import { Avatar } from './avatar';
import { copyButton, displayName, failed, fmtCost, fmtPct, fmtTokens, h, icon, ICONS, level, oneLine, openLightbox, openMenu, statusDot, statusLabel } from './dom';
import { effortLabel, PLATFORM, t } from './i18n';
import { activityOf, lastOf, WorkingLine } from './working';

// Model output is untrusted: no inline styles, app classes or form controls, so it cannot overlay or mimic the app's own UI.
const markdown = (text: string): string =>
  DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true }), {
    FORBID_ATTR: ['style', 'class'],
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select'],
  });

type Items = Map<string, ChatItem>;

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
  private readonly cost: HTMLSpanElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly attachStrip = h('div', 'attachments');
  private readonly attachNote = h('div', 'attach-note');
  private readonly fileInput = h('input');
  private readonly working = new WorkingLine();
  /** The session's Clawd, large, in the header of a panel that asks for one. */
  private readonly mascot: Avatar | null;
  private readonly nodes = new Map<string, HTMLElement>();
  private readonly drafts = new Map<string, { text: string; attachments: Attachment[] }>();
  private attachments: Attachment[] = [];
  /** Images still being decoded or re-encoded: sending waits for them so none is dropped. */
  private preparing = 0;
  private noteTimer = 0;
  private session: SessionView | null = null;
  private items: Items | undefined;
  private models: ModelOption[] = [];

  constructor(
    pane: HTMLElement,
    private readonly hub: HubApi,
    emptyText: string,
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
    this.scroller.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('a');
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute('href');
      if (href) this.hub.openExternal(href);
    });

    this.input = h('textarea', 'composer-input');
    this.input.rows = 1;
    this.input.addEventListener('input', () => {
      this.autosize();
      this.syncSend();
    });
    this.input.addEventListener('keydown', (e) => {
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
    this.modelBtn = h('button', 'cbtn');
    this.modelBtn.addEventListener('click', () => this.openModelMenu());

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

    this.cost = h('span', 'cost');
    this.cost.title = t('chat.cost');
    this.sendBtn = h('button', 'send');
    this.sendBtn.addEventListener('click', () => (this.isBusy() && !this.hasContent() ? this.interrupt() : this.submit()));

    const bar = h('div', 'composer-bar');
    bar.append(attachBtn, this.modeBtn, this.modelBtn, h('span', 'spacer'), ctxRoot, this.cost, this.sendBtn);
    const box = h('div', 'composer-box');
    box.append(this.attachStrip, this.attachNote, this.input, bar, this.fileInput);
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
  }

  focus(): void {
    this.input.focus();
  }

  /** Shows a session; switching to another one rebuilds the stream and restores its draft. */
  show(session: SessionView | undefined, items: Items | undefined, models: ModelOption[]): void {
    this.models = models;
    const switched = (session?.id ?? null) !== this.sessionId;
    if (switched && this.session) this.drafts.set(this.session.id, { text: this.input.value, attachments: this.attachments });
    this.session = session ?? null;
    this.items = items;
    if (!session) this.mascot?.dispose(); // Hidden panel: its Clawd leaves the stage.
    if (switched) {
      const draft = session ? this.drafts.get(session.id) : undefined;
      this.input.value = draft?.text ?? '';
      this.attachments = draft?.attachments ?? [];
      this.renderAttachments();
      this.autosize();
      this.reset(items);
    }
    this.renderChrome();
    this.syncWorking();
  }

  reset(items: Items | undefined): void {
    this.items = items;
    for (const node of this.nodes.values()) node.remove();
    this.nodes.clear();
    for (const item of items?.values() ?? []) this.place(item);
    this.empty.hidden = this.nodes.size > 0;
    this.syncWorking();
    this.scroller.scrollTop = this.scroller.scrollHeight;
  }

  upsert(items: ChatItem[]): void {
    const stick = this.atBottom();
    for (const item of items) this.place(item);
    this.empty.hidden = this.nodes.size > 0;
    this.syncWorking();
    if (stick) this.scroller.scrollTop = this.scroller.scrollHeight;
  }

  private atBottom(): boolean {
    return this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 48;
  }

  /** Working line at the end of the stream, driven by the session status and its latest item. */
  private syncWorking(): void {
    const stick = this.atBottom();
    const s = this.session;
    const last = lastOf(this.items);
    this.working.update(s?.status, s?.busySince ?? null, activityOf(last), s?.background);
    if (s) this.mascot?.update(s, last);
    if (stick) this.scroller.scrollTop = this.scroller.scrollHeight;
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
          ? t('chat.masterPlaceholder')
          : t('chat.workerPlaceholder');

    this.modeBtn.replaceChildren(icon(ICONS.shield), h('span', '', s.mode ? modeLabel(s.mode) : t('chat.modeDefault')));
    this.modeBtn.classList.toggle('danger', s.mode === 'bypassPermissions');
    this.modeBtn.title = s.mode ? modeHint(s.mode) : t('chat.modeTitle');
    this.modelBtn.replaceChildren(h('span', '', s.modelLabel), h('span', 'cbtn-muted', s.effort ? effortLabel(s.effort) : ''), icon(ICONS.chevron, 'ico small'));
    this.modelBtn.title = t('chat.modelTitle');

    const m = s.metrics;
    const pct = m?.contextPct ?? null;
    const circumference = 2 * Math.PI * 7;
    this.ctx.arc.setAttribute('stroke-dasharray', `${(circumference * Math.min(100, pct ?? 0)) / 100} ${circumference}`);
    this.ctx.root.className = `ctx ${level(pct)}`;
    this.ctx.text.textContent = fmtPct(pct);
    this.ctx.root.title = m && m.contextSize ? t('chat.context', { used: fmtTokens(m.contextTokens), size: fmtTokens(m.contextSize) }) : t('chat.contextShort');
    this.cost.textContent = fmtCost(m?.costUsd);
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

  private autosize(): void {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(this.input.scrollHeight, 240)}px`;
  }

  private submit(): void {
    if (!this.hasContent() || this.preparing > 0 || !this.session) return;
    this.hub.send(
      this.session.id,
      this.input.value.trim(),
      this.attachments.map((a) => a.image),
    );
    this.input.value = '';
    this.attachments = [];
    this.renderAttachments();
    this.autosize();
    this.syncSend();
    this.scroller.scrollTop = this.scroller.scrollHeight;
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

  private attachError(text: string): void {
    this.attachNote.textContent = text;
    this.attachNote.hidden = false;
    window.clearTimeout(this.noteTimer);
    this.noteTimer = window.setTimeout(() => (this.attachNote.hidden = true), 4000);
  }

  private interrupt(): void {
    if (this.session) this.hub.interrupt(this.session.id);
  }

  private openModeMenu(): void {
    const s = this.session;
    if (!s) return;
    openMenu(this.modeBtn, (menu, close) => {
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

  private openModelMenu(): void {
    const s = this.session;
    if (!s) return;
    openMenu(this.modelBtn, (menu, close) => {
      menu.append(h('div', 'menu-label', t('chat.model')));
      if (this.models.length === 0) menu.append(h('div', 'menu-note', t('chat.modelsLater')));
      for (const model of this.models) {
        const row = this.menuRow(model.label, model.description, model.value === s.model);
        row.addEventListener('click', () => {
          this.hub.setModel(s.id, model.value);
          close();
        });
        menu.append(row);
      }
      const current = this.models.find((m) => m.value === s.model);
      const efforts: Effort[] = current?.efforts.length ? current.efforts : EFFORTS;
      menu.append(h('div', 'menu-sep'), h('div', 'menu-label', t('chat.effort')));
      const seg = h('div', 'segmented');
      for (const effort of efforts) {
        const b = h('button', effort === s.effort ? 'seg active' : 'seg', effortLabel(effort));
        b.addEventListener('click', () => {
          this.hub.setEffort(s.id, effort);
          close();
        });
        seg.append(b);
      }
      menu.append(seg);
    });
  }

  private menuRow(label: string, hint: string, checked: boolean): HTMLButtonElement {
    const row = h('button', checked ? 'menu-row checked' : 'menu-row');
    const text = h('span', 'menu-text');
    text.append(h('span', 'menu-title', label));
    if (hint) text.append(h('span', 'menu-hint', hint));
    row.append(checked ? icon(ICONS.check) : h('span', 'ico'), text);
    return row;
  }

  // ---------- stream ----------

  private place(item: ChatItem): void {
    const old = this.nodes.get(item.id);
    const node = this.render(item);
    if (old instanceof HTMLDetailsElement && node instanceof HTMLDetailsElement) node.open = old.open;
    if (old) old.replaceWith(node);
    else this.stream.insertBefore(node, this.working.root);
    this.nodes.set(item.id, node);
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
        body.innerHTML = markdown(item.text);
        this.addCodeCopy(body);
        wrap.append(label, body, this.actions(item.text));
        return wrap;
      }
      case 'assistant': {
        const el = h('div', item.live ? 'msg msg-assistant live' : 'msg msg-assistant');
        const body = h('div', 'md');
        body.innerHTML = markdown(item.text);
        this.addCodeCopy(body);
        el.append(body);
        if (!item.live) el.append(this.actions(item.text));
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
        if (item.action === 'claude-settings') {
          const open = h('button', 'btn small notice-action', t('notice.openClaudeSettings'));
          open.addEventListener('click', () => window.dispatchEvent(new CustomEvent('hub:open-settings', { detail: 'claude' })));
          el.append(open);
        }
        return el;
      }
    }
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
    const [before, after] = t('perm.question').split('{tool}');
    title.append(icon(ICONS.shield), h('span', '', before), h('b', '', item.tool), h('span', '', after));
    card.append(title);
    if (item.summary) card.append(h('div', 'perm-summary', item.summary));
    if (item.detail && item.detail !== item.summary) card.append(this.code(item.detail, item.diff));
    if (item.reason) card.append(h('div', 'perm-reason', item.reason));

    const decide = (behavior: 'allow' | 'always' | 'deny', message?: string) => this.hub.decide(sessionId, item.id, { behavior, message });
    const actions = h('div', 'perm-actions');
    const allow = h('button', 'btn primary', t('perm.allow'));
    allow.addEventListener('click', () => decide('allow'));
    actions.append(allow);
    if (item.canAlways) {
      const always = h('button', 'btn', t('perm.always'));
      always.title = t('perm.alwaysHint');
      always.addEventListener('click', () => decide('always'));
      actions.append(always);
    }
    const deny = h('button', 'btn ghost', t('perm.deny'));
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
    row.append(icon(item.state === 'allowed' ? ICONS.check : ICONS.remove), h('b', '', item.tool), h('span', '', ` ${labels[item.state]}`));
    if (item.summary) row.append(h('span', 'perm-done-summary', item.summary));
    return row;
  }
}
