import { dayKey, modelName, PERIODS, periodRange, summarize, toCsv, type Bucket, type CostRow, type CostSummary, type Period, type Range, type TurnRecord, type Usage } from '../shared/costs';
import type { HubApi } from '../shared/types';
import { fmtCost, h, icon, ICONS } from './dom';
import { LANG, t, tn } from './i18n';

type View = 'sessions' | 'models' | 'days';
const VIEWS: View[] = ['sessions', 'models', 'days'];

const exactUsd = (v: number) => `$${v.toFixed(4)}`;
const compact = new Intl.NumberFormat(LANG, { notation: 'compact', maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat(LANG);
const tokens = (n: number) => compact.format(n);

/** A clean top for the axis: 1, 2 or 5 times a power of ten. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 5, 10].find((m) => m * p >= v) ?? 10) * p;
}

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not kept: the default next time.
  }
}

let openPanel: CostPanel | null = null;

/** Opens the cost panel above the status bar's Σ, or closes it when it is open. */
export function toggleCostPanel(hub: HubApi, anchor: HTMLElement): void {
  if (openPanel) return openPanel.close();
  openPanel = new CostPanel(hub, anchor);
}

/**
 * Cost and tokens per period, read from the turn log when the panel opens or the period changes (never while it
 * rests): totals, a column per day (per hour for one day), and the split by session, model or day.
 */
class CostPanel {
  private readonly root = h('div', 'cost-panel');
  private readonly body = h('div', 'cost-body');
  private readonly customRow = h('div', 'cost-custom');
  private readonly fromInput = h('input', 'cost-date');
  private readonly toInput = h('input', 'cost-date');
  private readonly periodSeg = h('div', 'segmented cost-periods');
  private readonly footer = h('div', 'cost-footer');
  private period: Period = stored('costPeriod', PERIODS, '7d');
  private view: View = stored('costView', VIEWS, 'sessions');
  private records: TurnRecord[] = [];
  private range: Range | null = null;
  private since = 0;
  private request = 0;

  constructor(
    private readonly hub: HubApi,
    private readonly anchor: HTMLElement,
  ) {
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', t('cost.title'));
    const head = h('div', 'cost-head');
    const title = h('h2', 'cost-title', t('cost.title'));
    const info = h('span', 'cost-info');
    info.append(icon(ICONS.info));
    info.title = t('cost.note');
    info.tabIndex = 0;
    info.setAttribute('aria-label', t('cost.note'));
    const close = h('button', 'icon-btn');
    close.title = t('cost.close');
    close.setAttribute('aria-label', close.title);
    close.append(icon(ICONS.remove));
    close.addEventListener('click', () => this.close());
    head.append(title, info, h('span', 'spacer'), close);

    this.periodSeg.setAttribute('role', 'radiogroup');
    this.periodSeg.setAttribute('aria-label', t('cost.period'));
    for (const p of PERIODS) {
      const b = h('button', 'seg', t(`cost.period.${p}`));
      b.dataset.period = p;
      b.setAttribute('role', 'radio');
      b.addEventListener('click', () => this.setPeriod(p));
      this.periodSeg.append(b);
    }
    const today = dayKey(Date.now());
    for (const input of [this.fromInput, this.toInput]) {
      input.type = 'date';
      input.max = today;
      input.addEventListener('change', () => this.load());
    }
    this.fromInput.value = dayKey(Date.now() - 6 * 86_400_000);
    this.toInput.value = today;
    this.fromInput.setAttribute('aria-label', t('cost.from'));
    this.toInput.setAttribute('aria-label', t('cost.to'));
    this.customRow.append(h('span', '', t('cost.from')), this.fromInput, h('span', '', t('cost.to')), this.toInput);

    this.root.append(head, this.periodSeg, this.customRow, this.body, this.footer);
    document.body.append(this.root);
    this.place();
    document.addEventListener('mousedown', this.onDown, true);
    document.addEventListener('keydown', this.onKey, true);
    window.addEventListener('resize', this.place);
    this.setPeriod(this.period);
    (this.periodSeg.querySelector('.seg.active') as HTMLElement | null)?.focus();
  }

  /** Above the Σ, its right edge on the Σ's, inside the window. */
  private readonly place = () => {
    const r = this.anchorEl().getBoundingClientRect();
    this.root.style.right = `${Math.max(12, window.innerWidth - r.right - 8)}px`;
    this.root.style.bottom = `${window.innerHeight - r.top + 6}px`;
    this.root.style.maxHeight = `${Math.max(240, r.top - 18)}px`;
  };

  private readonly onDown = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    // The Σ toggles the panel on its own click.
    if (!this.root.contains(target) && !target.closest('.sb-cost')) this.close();
  };

  private readonly onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    e.preventDefault();
    this.close();
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
    store('costPeriod', p);
    for (const b of this.periodSeg.querySelectorAll<HTMLElement>('.seg')) {
      const on = b.dataset.period === p;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    }
    this.customRow.hidden = p !== 'custom';
    void this.load();
  }

  private async load(): Promise<void> {
    const range = periodRange(this.period, new Date(), { from: this.fromInput.value, to: this.toInput.value });
    if (!range) {
      this.range = null;
      this.body.replaceChildren(h('div', 'cost-empty', t('cost.badDates')));
      return;
    }
    const request = ++this.request;
    this.body.classList.add('loading');
    try {
      const { records, since } = await this.hub.costHistory(range.from, range.to);
      if (request !== this.request) return;
      Object.assign(this, { records, since, range });
      this.render();
    } catch (err) {
      if (request !== this.request) return;
      this.body.replaceChildren(h('div', 'cost-empty', t('cost.failed')));
      this.body.title = err instanceof Error ? err.message : String(err);
    } finally {
      if (request === this.request) this.body.classList.remove('loading');
    }
  }

  private render(): void {
    const range = this.range;
    if (!range) return;
    const s = summarize(this.records, range);
    this.body.replaceChildren(this.totals(s), this.chart(s), this.split(s));
    this.renderFooter(range, s);
  }

  // ---------- totals ----------

  private totals(s: CostSummary): HTMLElement {
    const box = h('div', 'cost-totals');
    const hero = h('div', 'cost-hero');
    const value = h('div', 'cost-hero-value', fmtCost(s.total.cost));
    value.title = exactUsd(s.total.cost);
    hero.append(h('div', 'cost-label', t('cost.total')), value, h('div', 'cost-sub', tn('cost.turns', s.turns, { n: whole.format(s.turns) })));
    const tile = (label: string, n: number) => {
      const el = h('div', 'cost-tile');
      const v = h('div', 'cost-tile-value', tokens(n));
      v.title = `${whole.format(n)} ${t('cost.tokens')}`;
      el.append(h('div', 'cost-label', label), v);
      return el;
    };
    const tiles = h('div', 'cost-tiles');
    tiles.append(tile(t('cost.input'), s.total.input), tile(t('cost.output'), s.total.output), tile(t('cost.cacheRead'), s.total.cacheRead), tile(t('cost.cacheWrite'), s.total.cacheWrite));
    box.append(hero, tiles);
    return box;
  }

  // ---------- chart: one series, so no legend; the title says what it shows ----------

  private bucketLabel(b: Bucket, unit: 'day' | 'hour', long: boolean): string {
    if (unit === 'hour') return LANG === 'fr' ? `${b.key} h` : `${b.key}:00`;
    const d = new Date(b.start);
    return long ? d.toLocaleDateString(LANG, { weekday: 'short', day: 'numeric', month: 'short' }) : d.toLocaleDateString(LANG, { day: 'numeric', month: 'short' });
  }

  private chart(s: CostSummary): HTMLElement {
    const wrap = h('figure', 'cost-chart');
    wrap.append(h('figcaption', 'cost-label', t(s.unit === 'hour' ? 'cost.byHour' : 'cost.byDay')));
    const top = niceMax(Math.max(0, ...s.buckets.map((b) => b.usage.cost)));
    const plot = h('div', 'cost-plot');
    for (const f of [1, 0.5]) {
      const line = h('div', 'cost-grid');
      line.style.bottom = `${f * 100}%`;
      line.append(h('span', 'cost-grid-label', `$${+(top * f).toPrecision(3)}`));
      plot.append(line);
    }
    const bars = h('div', 'cost-bars');
    const axis = h('div', 'cost-axis');
    const n = s.buckets.length;
    // A few labels, never one per column: first, last, and evenly in between.
    const every = s.unit === 'hour' ? 6 : n <= 7 ? 1 : Math.ceil(n / 5);
    s.buckets.forEach((b, i) => {
      const col = h('div', 'cost-col');
      const bar = h('div', 'cost-bar');
      const pct = (b.usage.cost / top) * 100;
      bar.style.height = b.usage.cost > 0 ? `max(2px, ${pct}%)` : '0';
      col.append(bar);
      const end = s.buckets[i + 1]?.start ?? this.range?.to ?? b.start;
      const untracked = end <= this.since;
      col.classList.toggle('untracked', untracked);
      col.title = `${this.bucketLabel(b, s.unit, true)} · ${untracked ? t('cost.untracked') : fmtCost(b.usage.cost)}`;
      bars.append(col);
      const label = h('span', 'cost-tick', i % every === 0 || i === n - 1 ? this.bucketLabel(b, s.unit, n <= 7) : '');
      axis.append(label);
    });
    plot.append(bars);
    if (s.turns === 0) plot.append(h('div', 'cost-plot-empty', t('cost.none')));
    wrap.append(plot, axis);
    return wrap;
  }

  // ---------- split: the table view of the same numbers ----------

  private split(s: CostSummary): HTMLElement {
    const box = h('div', 'cost-split');
    const tabs = h('div', 'segmented cost-views');
    tabs.setAttribute('role', 'tablist');
    for (const v of VIEWS) {
      const b = h('button', v === this.view ? 'seg active' : 'seg', t(`cost.view.${v}`));
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(v === this.view));
      b.addEventListener('click', () => {
        this.view = v;
        store('costView', v);
        this.render();
      });
      tabs.append(b);
    }
    box.append(tabs, this.table(s));
    return box;
  }

  private table(s: CostSummary): HTMLElement {
    const rows: CostRow[] =
      this.view === 'sessions'
        ? s.sessions
        : this.view === 'models'
          ? s.models
          : s.buckets
              .filter((b) => b.usage.cost > 0)
              .reverse()
              .map((b) => ({ key: b.key, label: this.bucketLabel(b, s.unit, true), role: null, usage: b.usage, turns: 0 }));
    if (rows.length === 0) return h('div', 'cost-empty', t('cost.none'));
    const table = h('table', 'cost-table');
    const head = h('tr');
    const first = this.view === 'sessions' ? t('cost.col.session') : this.view === 'models' ? t('cost.col.model') : s.unit === 'hour' ? t('cost.col.hour') : t('cost.col.day');
    for (const label of [first, t('cost.col.cost'), t('cost.input'), t('cost.output'), t('cost.cacheRead'), t('cost.cacheWrite')]) head.append(h('th', '', label));
    const thead = h('thead');
    thead.append(head);
    const tbody = h('tbody');
    for (const row of rows) tbody.append(this.row(row, s.total.cost));
    table.append(thead, tbody);
    return table;
  }

  private row(row: CostRow, total: number): HTMLTableRowElement {
    const tr = h('tr');
    const name = h('td', 'cost-name');
    if (this.view === 'sessions') {
      name.append(h('span', 'cost-name-text', row.role === 'master' ? t('master') : row.label.replace(/^hub-/, '')));
      if (row.role) name.append(h('span', `cost-role ${row.role}`, t(`cost.role.${row.role}`)));
      name.title = tn('cost.turns', row.turns, { n: whole.format(row.turns) });
    } else if (this.view === 'models') {
      name.append(h('span', 'cost-name-text', modelName(row.key)));
      name.title = row.key;
    } else name.append(h('span', 'cost-name-text', row.label));
    const cost = h('td', 'num');
    // The share of the period, as a thin bar under the amount.
    const share = total > 0 ? row.usage.cost / total : 0;
    cost.append(h('span', '', fmtCost(row.usage.cost)));
    const meter = h('span', 'cost-share');
    meter.style.setProperty('--share', String(share));
    cost.append(meter);
    cost.title = `${exactUsd(row.usage.cost)} · ${Math.round(share * 100)}%`;
    tr.append(name, cost);
    const u: Usage = row.usage;
    for (const n of [u.input, u.output, u.cacheRead, u.cacheWrite]) {
      const td = h('td', 'num', tokens(n));
      td.title = whole.format(n);
      tr.append(td);
    }
    return tr;
  }

  // ---------- footer ----------

  private renderFooter(range: Range, s: CostSummary): void {
    const date = new Date(this.since).toLocaleDateString(LANG, { day: 'numeric', month: 'long', year: 'numeric' });
    const since = h('span', 'cost-since', t(range.from < this.since ? 'cost.sincePartial' : 'cost.since', { date }));
    since.title = t('cost.sinceHint');
    const exportBtn = h('button', 'btn small', t('cost.export'));
    exportBtn.disabled = s.turns === 0;
    exportBtn.addEventListener('click', () => void this.export(range));
    this.footer.replaceChildren(since, h('span', 'spacer'), exportBtn);
  }

  private async export(range: Range): Promise<void> {
    const header = t('cost.csvHeader').split('|');
    const csv = toCsv(this.records, range, header, LANG === 'fr' ? ';' : ',');
    const last = dayKey(range.to - 1);
    const name = `claude-hub-cost-${dayKey(range.from)}${last !== dayKey(range.from) ? `_${last}` : ''}.csv`;
    await this.hub.exportCost(csv, name);
  }
}

