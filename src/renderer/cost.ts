import { PERIODS, periodRange, summarize, type CostSummary, type Period, type RepoCostRow } from '../shared/costs';
import type { HubApi } from '../shared/types';
import { fmtCost, h, icon, ICONS } from './dom';
import { LANG, t, tn } from './i18n';

const exactUsd = (v: number) => `$${v.toFixed(4)}`;
const compact = new Intl.NumberFormat(LANG, { notation: 'compact', maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat(LANG);

function storedPeriod(): Period {
  try {
    const v = localStorage.getItem('costPeriod') as Period | null;
    return v && PERIODS.includes(v) ? v : 'today';
  } catch {
    return 'today';
  }
}

let openPanel: CostPanel | null = null;

/** Opens the cost popover above the status bar's Σ, or closes it when it is open. */
export function toggleCostPanel(hub: HubApi, anchor: HTMLElement): void {
  if (openPanel) return openPanel.close();
  openPanel = new CostPanel(hub, anchor);
}

/** The cost of a period and its split by repo, read from the turn log when the popover opens or the period changes. */
class CostPanel {
  private readonly root = h('div', 'cost-panel');
  private readonly body = h('div', 'cost-body');
  private readonly periodSeg = h('div', 'segmented cost-periods');
  private period = storedPeriod();
  private request = 0;

  constructor(
    private readonly hub: HubApi,
    private readonly anchor: HTMLElement,
  ) {
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', t('cost.title'));
    const head = h('div', 'cost-head');
    const info = h('span', 'cost-info');
    info.append(icon(ICONS.info));
    info.title = t('cost.note');
    info.tabIndex = 0;
    info.setAttribute('aria-label', t('cost.note'));
    head.append(h('h2', 'cost-title', t('cost.title')), info);

    this.periodSeg.setAttribute('role', 'radiogroup');
    this.periodSeg.setAttribute('aria-label', t('cost.period'));
    this.periodSeg.addEventListener('keydown', this.onArrow);
    for (const p of PERIODS) {
      const b = h('button', 'seg', t(`cost.period.${p}`));
      b.dataset.period = p;
      b.setAttribute('role', 'radio');
      b.addEventListener('click', () => this.setPeriod(p));
      this.periodSeg.append(b);
    }

    this.root.append(head, this.periodSeg, this.body);
    document.body.append(this.root);
    this.place();
    document.addEventListener('mousedown', this.onDown, true);
    document.addEventListener('keydown', this.onKey, true);
    window.addEventListener('resize', this.place);
    this.setPeriod(this.period);
    this.periodSeg.querySelector<HTMLElement>('.seg.active')?.focus();
  }

  /** Above the Σ, its right edge on the Σ's, inside the window. */
  private readonly place = () => {
    const r = this.anchorEl().getBoundingClientRect();
    this.root.style.right = `${Math.max(12, window.innerWidth - r.right - 8)}px`;
    this.root.style.bottom = `${window.innerHeight - r.top + 6}px`;
    this.root.style.maxHeight = `${Math.max(200, r.top - 18)}px`;
  };

  private readonly onDown = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    // The Σ toggles the popover on its own click.
    if (!this.root.contains(target) && !target.closest('.sb-cost')) this.close();
  };

  private readonly onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    e.preventDefault();
    this.close();
  };

  /** Arrows move between the periods, as in any radio group. */
  private readonly onArrow = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = PERIODS[(PERIODS.indexOf(this.period) + step + PERIODS.length) % PERIODS.length];
    this.setPeriod(next);
    this.periodSeg.querySelector<HTMLElement>('.seg.active')?.focus();
  };

  close(): void {
    if (openPanel === this) openPanel = null;
    this.request++;
    document.removeEventListener('mousedown', this.onDown, true);
    document.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('resize', this.place);
    this.root.classList.add('closing');
    window.setTimeout(() => this.root.remove(), 160);
    this.anchorEl().focus();
  }

  /** The status bar redraws its Σ when the total moves: the one in the window now. */
  private anchorEl(): HTMLElement {
    return this.anchor.isConnected ? this.anchor : (document.querySelector<HTMLElement>('.sb-cost') ?? this.anchor);
  }

  private setPeriod(p: Period): void {
    this.period = p;
    try {
      localStorage.setItem('costPeriod', p);
    } catch {
      // Not kept: the default next time.
    }
    for (const b of this.periodSeg.querySelectorAll<HTMLElement>('.seg')) {
      const on = b.dataset.period === p;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    void this.load();
  }

  private async load(): Promise<void> {
    const range = periodRange(this.period, new Date());
    const request = ++this.request;
    this.body.classList.add('loading');
    try {
      const { records, since } = await this.hub.costHistory(range.from, range.to);
      if (request !== this.request) return;
      this.render(summarize(records, range), range.from < since ? since : 0);
    } catch (err) {
      if (request !== this.request) return;
      this.body.replaceChildren(h('div', 'cost-empty', t('cost.failed')));
      this.body.title = err instanceof Error ? err.message : String(err);
    } finally {
      if (request === this.request) this.body.classList.remove('loading');
    }
  }

  /** `since`: when the log started, only if it starts inside the period (earlier days are then not counted). */
  private render(s: CostSummary, since: number): void {
    const total = h('div', 'cost-total');
    const value = h('span', 'cost-total-value', fmtCost(s.total.cost));
    value.title = exactUsd(s.total.cost);
    total.append(value, h('span', 'cost-sub', tn('cost.turns', s.turns, { n: whole.format(s.turns) })));
    this.body.title = '';
    this.body.replaceChildren(total, s.turns === 0 ? h('div', 'cost-empty', t('cost.none')) : this.list(s));
    if (since) {
      const date = new Date(since).toLocaleDateString(LANG, { day: 'numeric', month: 'long', year: 'numeric' });
      const note = h('div', 'cost-since', t('cost.since', { date }));
      note.title = t('cost.sinceHint');
      this.body.append(note);
    }
  }

  private list(s: CostSummary): HTMLElement {
    const list = h('ul', 'cost-list');
    for (const row of s.repos) list.append(this.row(row, s.total.cost));
    const li = h('li', 'cost-row cost-sum');
    const sum = h('span', 'cost-amount', fmtCost(s.total.cost));
    sum.title = exactUsd(s.total.cost);
    li.append(h('span', 'cost-name', t('cost.total')), sum);
    list.append(li);
    return list;
  }

  private row(row: RepoCostRow, total: number): HTMLElement {
    const li = h('li', row.key ? 'cost-row' : 'cost-row cost-more');
    const share = total > 0 ? row.usage.cost / total : 0;
    li.append(h('span', 'cost-name', row.key ? row.label : t('cost.otherRepos')), h('span', 'cost-amount', fmtCost(row.usage.cost)));
    const bar = h('span', 'cost-share');
    bar.style.setProperty('--share', String(share));
    li.append(bar);
    const u = row.usage;
    li.title = [
      row.key || t('cost.otherReposHint'),
      `${tn('cost.turns', row.turns, { n: whole.format(row.turns) })} · ${exactUsd(u.cost)} · ${Math.round(share * 100)}%`,
      row.sessions.map((s) => (s.role === 'master' ? t('master') : s.label.replace(/^hub-/, ''))).join(', '),
      `${t('cost.input')} ${compact.format(u.input)} · ${t('cost.output')} ${compact.format(u.output)}`,
      `${t('cost.cacheRead')} ${compact.format(u.cacheRead)} · ${t('cost.cacheWrite')} ${compact.format(u.cacheWrite)}`,
    ].join('\n');
    return li;
  }
}
