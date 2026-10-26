import { implicitWorker, type Topic } from '../shared/topics';
import type { ChatItem, HubApi } from '../shared/types';
import type { ChatView } from './chat';
import { h, icon, ICONS, openMenu } from './dom';
import { t, tn } from './i18n';

/** Narrower than this, the master's conversation keeps its width: the column folds into a menu in its header. */
const FOLD_BELOW = 720;

/** A red count, read out by its row's label. */
function badge(n: number): HTMLSpanElement {
  const mark = h('span', 'topic-badge', n > 9 ? '9+' : String(n));
  mark.setAttribute('aria-hidden', 'true');
  return mark;
}

/**
 * The topics of the master's conversation, in a column that the master's card opens into: "All", then one per job,
 * a red badge where the master waits for the user. A topic shows only its messages and what is written goes to it.
 * Nothing runs at rest: it redraws when the snapshot or an approval of the master changes, or the window is resized.
 */
export class TopicsView {
  private readonly column = h('nav', 'topics');
  private readonly pick = h('button', 'topics-pick');
  private topics: Topic[] = [];
  private items: Map<string, ChatItem> | undefined;
  private selected: string | null = null;
  private folded = false;
  private key = '';

  constructor(
    private readonly pane: HTMLElement,
    private readonly view: ChatView,
    private readonly hub: HubApi,
  ) {
    this.column.setAttribute('aria-label', t('topics.nav'));
    this.column.hidden = true;
    this.column.addEventListener('keydown', (e) => this.onKey(e));
    this.pick.type = 'button';
    this.pick.hidden = true;
    this.pick.setAttribute('aria-haspopup', 'menu');
    this.pick.addEventListener('click', () => this.openPicker());
    pane.append(this.column);
    view.insertHead(this.pick);
    new ResizeObserver(([entry]) => {
      const folded = (entry?.contentRect.width ?? 0) < FOLD_BELOW;
      if (folded === this.folded) return;
      this.folded = folded;
      this.render();
    }).observe(pane);
  }

  /** The master's topics (most recent first) and its items, for the approvals it waits on. */
  update(topics: Topic[], items: Map<string, ChatItem> | undefined): void {
    this.topics = topics;
    this.items = items;
    const current = topics.find((x) => x.id === this.selected);
    if (this.selected && !current) this.select(null);
    else if (current) this.view.setTopic({ id: current.id, title: current.title });
    this.render();
  }

  private select(id: string | null): void {
    this.selected = id;
    const topic = this.topics.find((x) => x.id === id);
    this.view.setTopic(topic ? { id: topic.id, title: topic.title } : null);
    this.render();
  }

  /** What waits for the user, by topic: the master's question, and the approvals asked in its conversation. */
  private waiting(): { by: Map<string, number>; total: number } {
    const by = new Map<string, number>();
    let total = 0;
    const add = (id: string | undefined) => {
      total++;
      if (id) by.set(id, (by.get(id) ?? 0) + 1);
    };
    for (const topic of this.topics) if (topic.awaiting) add(topic.id);
    for (const item of this.items?.values() ?? []) if (item.kind === 'permission' && item.state === 'pending') add(item.topic);
    return { by, total };
  }

  private render(): void {
    const { by, total } = this.waiting();
    const any = this.topics.length > 0;
    const column = any && !this.folded;
    const key = JSON.stringify([column, any, this.selected, total, this.topics.map((x) => [x.id, x.title, by.get(x.id) ?? 0, x.question, x.workers])]);
    if (key === this.key) return;
    this.key = key;
    this.column.hidden = !column;
    this.pick.hidden = !any || column;
    this.pane.classList.toggle('has-topics', column);
    // The master's card reaches over to the column (styles.css).
    document.body.classList.toggle('topics-open', column);
    if (column) this.renderColumn(by, total);
    else if (any) this.renderPick(total);
  }

  private renderColumn(by: Map<string, number>, total: number): void {
    const focused = this.column.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.index : undefined;
    const all = this.row(null, t('topics.all'), total, t('topics.allTip'));
    const slots = this.topics.map((x) => this.slot(x, by.get(x.id) ?? 0));
    const rows = [all, ...slots.map((slot) => slot.firstElementChild as HTMLButtonElement)];
    rows.forEach((row, i) => (row.dataset.index = String(i)));
    this.column.replaceChildren(all, h('div', 'topics-sep'), ...slots);
    if (focused !== undefined) rows[Math.min(Number(focused), rows.length - 1)]?.focus();
  }

  /** A topic's row and its delete button, shown on hover or keyboard focus ("All" has none). */
  private slot(x: Topic, waiting: number): HTMLDivElement {
    const row = this.row(x.id, x.title, waiting, this.tip(x));
    const remove = h('button', 'topic-remove');
    remove.type = 'button';
    // Reached with Tab from the topic shown; on any row, Delete asks the same.
    remove.tabIndex = row.tabIndex;
    remove.title = t('topics.delete', { title: x.title });
    remove.setAttribute('aria-label', remove.title);
    remove.append(icon(ICONS.remove));
    remove.addEventListener('click', () => this.askDelete(x, remove));
    const slot = h('div', 'topic-slot');
    slot.append(row, remove);
    return slot;
  }

  /** A confirmation first: a stray click never takes a topic's history away. */
  private askDelete(x: Topic, anchor: HTMLElement): void {
    openMenu(
      anchor,
      (menu, close) => {
        const box = h('div', 'menu-confirm topic-confirm');
        box.setAttribute('role', 'alertdialog');
        const text = h('div', 'topic-confirm-text', t('topics.deleteAsk', { title: x.title }));
        text.id = 'topic-confirm-text';
        box.setAttribute('aria-labelledby', text.id);
        const yes = h('button', 'btn danger small', t('topics.deleteYes'));
        yes.addEventListener('click', () => {
          close();
          this.delete(x.id);
        });
        const no = h('button', 'btn ghost small', t('setup.cancel'));
        no.addEventListener('click', () => {
          close();
          this.focusRow(x.id);
        });
        const actions = h('div', 'menu-confirm-actions');
        actions.append(yes, no);
        box.append(text, h('div', 'topic-confirm-hint', t('topics.deleteHint')), actions);
        menu.append(box);
      },
      true,
    );
    document.querySelector<HTMLElement>('#menu .topic-confirm .btn.ghost')?.focus();
  }

  /** Gone from the list once the hub has taken it out; the one shown, "All" comes back at once. */
  private delete(id: string): void {
    if (this.selected === id) this.select(null);
    this.hub.deleteTopic(id);
    this.focusRow(null);
  }

  private focusRow(id: string | null): void {
    const rows = [...this.column.querySelectorAll<HTMLButtonElement>('.topic')];
    (rows.find((r) => (r.dataset.topic ?? null) === id) ?? rows[0])?.focus();
  }

  private row(id: string | null, title: string, waiting: number, tip: string): HTMLButtonElement {
    const current = id === this.selected;
    const row = h('button', id === null ? 'topic topic-all' : 'topic');
    row.type = 'button';
    // One stop in the tab order, on the topic shown; the arrows move between the others.
    row.tabIndex = current ? 0 : -1;
    if (id) row.dataset.topic = id;
    if (current) row.setAttribute('aria-current', 'true');
    row.append(h('span', 'topic-title', title));
    if (waiting > 0) row.append(badge(waiting));
    row.setAttribute('aria-label', waiting > 0 ? `${title}, ${tn('topics.waiting', waiting)}` : title);
    row.title = tip;
    row.addEventListener('click', () => this.select(id));
    return row;
  }

  private tip(x: Topic): string {
    const worker = implicitWorker(x.id);
    return [
      x.title,
      worker ? t('topics.ofWorker', { name: worker }) : '',
      x.awaiting ? (x.question ? t('topics.asks', { question: x.question }) : t('topics.asksShort')) : '',
      x.workers.length > 0 && !worker ? t('topics.workers', { list: x.workers.map((w) => w.replace(/^hub-/, '')).join(', ') }) : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private onKey(e: KeyboardEvent): void {
    const rows = [...this.column.querySelectorAll<HTMLButtonElement>('.topic')];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const remove = rows[at]?.nextElementSibling;
    if ((e.key === 'Delete' || e.key === 'Backspace') && remove instanceof HTMLButtonElement) {
      e.preventDefault();
      remove.click();
      return;
    }
    const to = e.key === 'ArrowDown' ? at + 1 : e.key === 'ArrowUp' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : -2;
    if (to === -2) return;
    e.preventDefault();
    rows[Math.max(0, Math.min(rows.length - 1, to))]?.focus();
  }

  /** Folded: the topic shown and the total waiting, in the header; a menu lists the topics. */
  private renderPick(total: number): void {
    const title = this.topics.find((x) => x.id === this.selected)?.title ?? t('topics.all');
    this.pick.replaceChildren(icon(ICONS.filter), h('span', 'topics-pick-title', title));
    if (total > 0) this.pick.append(badge(total));
    this.pick.append(icon(ICONS.chevron, 'ico small'));
    const label = t('topics.pick', { title });
    this.pick.setAttribute('aria-label', total > 0 ? `${label}, ${tn('topics.waiting', total)}` : label);
    this.pick.title = t('topics.nav');
  }

  private openPicker(): void {
    const { by, total } = this.waiting();
    openMenu(
      this.pick,
      (menu, close) => {
        menu.append(h('div', 'menu-label', t('topics.nav')));
        const entries: [string | null, string, number, string][] = [
          [null, t('topics.all'), total, t('topics.allTip')],
          ...this.topics.map((x): [string, string, number, string] => [x.id, x.title, by.get(x.id) ?? 0, this.tip(x)]),
        ];
        for (const [id, title, waiting, tip] of entries) {
          const current = id === this.selected;
          const row = h('button', current ? 'menu-row checked topics-menu-row' : 'menu-row topics-menu-row');
          row.type = 'button';
          if (current) row.setAttribute('aria-current', 'true');
          const text = h('span', 'menu-text');
          text.append(h('span', 'menu-title', title));
          row.append(current ? icon(ICONS.check) : h('span', 'ico'), text);
          if (waiting > 0) row.append(badge(waiting));
          row.setAttribute('aria-label', waiting > 0 ? `${title}, ${tn('topics.waiting', waiting)}` : title);
          row.title = tip;
          row.addEventListener('click', () => {
            this.select(id);
            close();
          });
          row.addEventListener('keydown', (e) => {
            const next = e.key === 'ArrowDown' ? row.nextElementSibling : e.key === 'ArrowUp' ? row.previousElementSibling : null;
            if (!(next instanceof HTMLButtonElement)) return;
            e.preventDefault();
            next.focus();
          });
          menu.append(row);
        }
      },
      true,
    );
    document.querySelector<HTMLElement>('#menu [aria-current]')?.focus();
  }
}
