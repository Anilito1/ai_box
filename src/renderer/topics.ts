import { GENERAL, groupName, groupTopics, reorderGroups, toggled, type TopicGroup, type TopicGroupPrefs } from '../shared/topicGroups';
import { implicitWorker, type Topic } from '../shared/topics';
import type { ChatItem, HubApi } from '../shared/types';
import type { ChatView } from './chat';
import { h, icon, ICONS, openMenu } from './dom';
import { t, tn } from './i18n';

/** A red count, read out by its row's label. */
function badge(n: number): HTMLSpanElement {
  const mark = h('span', 'topic-badge', n > 9 ? '9+' : String(n));
  mark.setAttribute('aria-hidden', 'true');
  return mark;
}

/**
 * The topics of the master's conversation, in a column that the master's card opens into: "All", then the jobs grouped
 * by repo (a group folds on a click on its header, its badge then adds those of its topics; it moves by drag and drop,
 * or Alt+↑/↓), a red badge where the master waits for the user. A topic shows only its messages and what is written goes
 * to it; dragged to another group, it stays there. Nothing runs at rest: it redraws when the snapshot or an approval
 * of the master changes.
 */
export class TopicsView {
  private readonly column = h('nav', 'topics');
  private topics: Topic[] = [];
  private items: Map<string, ChatItem> | undefined;
  private selected: string | null = null;
  private key = '';
  /** Order and folded groups, saved in the settings. */
  private prefs: TopicGroupPrefs = { order: [], collapsed: [] };
  /** What is being dragged: a whole group or a topic. */
  private drag: { kind: 'group' | 'topic'; id: string } | null = null;

  constructor(
    private readonly pane: HTMLElement,
    private readonly view: ChatView,
    private readonly hub: HubApi,
  ) {
    this.column.setAttribute('aria-label', t('topics.nav'));
    this.column.hidden = true;
    this.column.addEventListener('keydown', (e) => this.onKey(e));
    pane.append(this.column);
    void hub.getSettings().then((v) => {
      this.prefs = { order: [...v.settings.topicGroups.order], collapsed: [...v.settings.topicGroups.collapsed] };
      this.render();
    });
  }

  private savePrefs(): void {
    void this.hub.saveSettings({ topicGroups: this.prefs });
    this.render();
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
    const column = this.topics.length > 0;
    const key = JSON.stringify([column, this.selected, total, this.topics.map((x) => [x.id, x.title, by.get(x.id) ?? 0, x.question, x.workers, x.repo, x.moved]), this.prefs]);
    if (key === this.key) return;
    this.key = key;
    this.column.hidden = !column;
    this.pane.classList.toggle('has-topics', column);
    // The master's card reaches over to the column (styles.css).
    document.body.classList.toggle('topics-open', column);
    if (column) this.renderColumn(by, total);
  }

  private renderColumn(by: Map<string, number>, total: number): void {
    const focused = this.column.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.nav : undefined;
    const all = this.row(null, t('topics.all'), total, t('topics.allTip'));
    all.dataset.nav = 'all';
    const groups = groupTopics(this.topics, this.prefs.order);
    const sections = groups.map((g) => this.section(g, groups, by));
    this.column.replaceChildren(all, h('div', 'topics-sep'), ...sections);
    // One stop in the tab order: the topic shown, else the header of its folded group, else "All".
    const rows = this.rows();
    const shown = this.selected ? `t:${this.selected}` : 'all';
    const stop = rows.some((r) => r.dataset.nav === shown) ? shown : `g:${groups.find((g) => g.topics.some((x) => x.id === this.selected))?.key ?? ''}`;
    for (const row of rows) {
      row.tabIndex = row.dataset.nav === stop ? 0 : -1;
      const remove = row.nextElementSibling;
      if (remove instanceof HTMLButtonElement) remove.tabIndex = row.tabIndex;
    }
    if (focused !== undefined) (rows.find((r) => r.dataset.nav === focused) ?? rows[0])?.focus();
  }

  /** The rows that take the arrows: "All", the headers and the topics of the open groups, in order. */
  private rows(): HTMLButtonElement[] {
    return [...this.column.querySelectorAll<HTMLButtonElement>('.topic, .topic-group-head')];
  }

  /** A group: its header (a folded one adds the badges of its topics) and, open, its topics. */
  private section(group: TopicGroup, groups: TopicGroup[], by: Map<string, number>): HTMLElement {
    const folded = this.prefs.collapsed.includes(group.key);
    const name = group.key === GENERAL ? t('topics.general') : groupName(group.key) || group.key;
    const waiting = group.topics.reduce((n, x) => n + (by.get(x.id) ?? 0), 0);
    const head = h('button', 'topic-group-head');
    head.type = 'button';
    head.dataset.nav = `g:${group.key}`;
    head.draggable = true;
    head.setAttribute('aria-expanded', String(!folded));
    head.append(icon(ICONS.chevron, 'ico small topic-chevron'), h('span', 'topic-group-name', name));
    if (folded && waiting > 0) head.append(badge(waiting));
    const label = `${name}, ${tn('topics.inGroup', group.topics.length)}`;
    head.setAttribute('aria-label', folded && waiting > 0 ? `${label}, ${tn('topics.waiting', waiting)}` : label);
    head.title = [group.key === GENERAL ? t('topics.generalTip') : group.key, t('topics.groupHint')].join('\n');
    head.addEventListener('click', () => {
      this.prefs = { ...this.prefs, collapsed: toggled(this.prefs.collapsed, group.key, !folded) };
      this.savePrefs();
    });
    head.addEventListener('dragstart', (e) => this.dragStart(e, 'group', group.key, head));
    head.addEventListener('dragend', () => this.endDrag());
    const section = h('section', 'topic-group');
    section.dataset.group = group.key;
    section.setAttribute('aria-label', name);
    section.append(head);
    if (!folded) section.append(...group.topics.map((x) => this.slot(x, by.get(x.id) ?? 0)));
    this.dropTarget(section, group, groups);
    return section;
  }

  private dragStart(e: DragEvent, kind: 'group' | 'topic', id: string, from: HTMLElement): void {
    this.drag = { kind, id };
    from.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id);
    }
  }

  private endDrag(): void {
    this.drag = null;
    for (const el of this.column.querySelectorAll('.dragging, .drop-before, .drop-after, .drop-into')) el.classList.remove('dragging', 'drop-before', 'drop-after', 'drop-into');
  }

  /** A group takes a group dragged onto it (it goes to its place) and a topic dragged onto it (it joins it). */
  private dropTarget(section: HTMLElement, group: TopicGroup, groups: TopicGroup[]): void {
    const mark = () => {
      const drag = this.drag;
      if (!drag) return null;
      if (drag.kind === 'topic') return group.topics.some((x) => x.id === drag.id) ? null : 'drop-into';
      if (drag.id === group.key) return null;
      const keys = groups.map((g) => g.key);
      return keys.indexOf(drag.id) < keys.indexOf(group.key) ? 'drop-after' : 'drop-before';
    };
    section.addEventListener('dragover', (e) => {
      const cls = mark();
      if (!cls) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      section.classList.add(cls);
    });
    section.addEventListener('dragleave', (e) => {
      if (!section.contains(e.relatedTarget as Node | null)) section.classList.remove('drop-before', 'drop-after', 'drop-into');
    });
    section.addEventListener('drop', (e) => {
      const drag = this.drag;
      const cls = mark();
      this.endDrag();
      if (!drag || !cls) return;
      e.preventDefault();
      if (drag.kind === 'topic') this.hub.moveTopic(drag.id, group.key);
      else this.moveGroup(groups.map((g) => g.key), drag.id, group.key);
    });
  }

  private moveGroup(shown: string[], key: string, target: string): void {
    const order = reorderGroups(shown, this.prefs.order, key, target);
    if (order === this.prefs.order) return;
    this.prefs = { ...this.prefs, order };
    this.savePrefs();
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
    row.dataset.nav = `t:${x.id}`;
    const slot = h('div', 'topic-slot');
    slot.draggable = true;
    slot.addEventListener('dragstart', (e) => this.dragStart(e, 'topic', x.id, slot));
    slot.addEventListener('dragend', () => this.endDrag());
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
    const rows = this.rows();
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

  /** Arrows move between rows; on a header Left folds and Right opens; Alt+↑/↓ moves the group, or the topic to the next group. */
  private onKey(e: KeyboardEvent): void {
    const rows = this.rows();
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const row = rows[at] as HTMLButtonElement;
    const remove = row.nextElementSibling;
    if ((e.key === 'Delete' || e.key === 'Backspace') && remove instanceof HTMLButtonElement) {
      e.preventDefault();
      remove.click();
      return;
    }
    const nav = row.dataset.nav ?? '';
    const groups = groupTopics(this.topics, this.prefs.order);
    const keys = groups.map((g) => g.key);
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const step = e.key === 'ArrowUp' ? -1 : 1;
      if (nav.startsWith('g:')) {
        const key = nav.slice(2);
        const target = keys[keys.indexOf(key) + step];
        if (target !== undefined) this.moveGroup(keys, key, target);
      } else if (nav.startsWith('t:')) {
        const id = nav.slice(2);
        const target = keys[keys.indexOf(groups.find((g) => g.topics.some((x) => x.id === id))?.key ?? '') + step];
        if (target !== undefined) this.hub.moveTopic(id, target);
      }
      return;
    }
    if (nav.startsWith('g:') && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const folded = row.getAttribute('aria-expanded') === 'false';
      if (folded === (e.key === 'ArrowRight')) {
        e.preventDefault();
        row.click();
      }
      return;
    }
    const to = e.key === 'ArrowDown' ? at + 1 : e.key === 'ArrowUp' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : -2;
    if (to === -2) return;
    e.preventDefault();
    rows[Math.max(0, Math.min(rows.length - 1, to))]?.focus();
  }
}
