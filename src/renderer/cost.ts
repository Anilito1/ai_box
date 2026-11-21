import {
  byProvider,
  missionRows,
  modelName,
  ofProvider,
  PERIODS,
  periodRange,
  summarize,
  tokenCount,
  type CostSummary,
  type MissionEvent,
  type MissionRow,
  type ModelCostRow,
  type Period,
  type ProviderCostRow,
  type Range,
  type RepoCostRow,
  type TurnRecord,
  type Unpriced,
} from '../shared/costs';
import { PROVIDER_DEFS } from '../shared/providers';
import type { HubApi, ProviderBadge } from '../shared/types';
import { fmtCost, h, icon, ICONS } from './dom';
import { LANG, t, tn } from './i18n';

const exactUsd = (v: number) => `$${v.toFixed(4)}`;
const compact = new Intl.NumberFormat(LANG, { notation: 'compact', maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat(LANG);
/** Missions shown, costliest first: the rest of the period is in the total. */
const MISSIONS_SHOWN = 8;
/** The view of every provider together. */
const TOTAL = '';

function storedPeriod(): Period {
  try {
    const v = localStorage.getItem('costPeriod') as Period | null;
    return v && PERIODS.includes(v) ? v : 'today';
  } catch {
    return 'today';
  }
}

/** "1.2M tokens · 1 video", what has no known price. */
const unpricedText = (u: Unpriced) =>
  [u.tokens > 0 ? t('cost.tokens', { n: compact.format(u.tokens) }) : '', u.videos > 0 ? tn('cost.videos', u.videos, { n: u.videos }) : ''].filter(Boolean).join(' · ');
const hasUnpriced = (u: Unpriced) => u.tokens > 0 || u.videos > 0;

let openPanel: CostPanel | null = null;

/** Opens the cost popover above the status bar's cost, or closes it when it is open. `providers`: the snapshot's. */
export function toggleCostPanel(hub: HubApi, anchor: HTMLElement, providers: () => ProviderBadge[] = () => []): void {
  if (openPanel) return openPanel.close();
  openPanel = new CostPanel(hub, anchor, providers);
}

/**
 * The cost of a period, all providers together (by provider and by repo) or one provider's (by model and by repo),
 * read from the turn log when the popover opens or the period changes; a provider is picked among the turns read.
 */
class CostPanel {
  private readonly root = h('div', 'cost-panel');
  private readonly body = h('div', 'cost-body');
  private readonly providerSeg = h('div', 'segmented cost-providers');
  private readonly periodSeg = h('div', 'segmented cost-periods');
  private period = storedPeriod();
  /** Total each time it opens. */
  private provider = TOTAL;
  private request = 0;
  /** The period read last: a change of provider shows it again without reading it. */
  private data: { records: TurnRecord[]; missions: MissionEvent[]; since: number; range: Range } | null = null;

  constructor(
    private readonly hub: HubApi,
    private readonly anchor: HTMLElement,
    private readonly providers: () => ProviderBadge[],
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

    this.providerSeg.setAttribute('role', 'radiogroup');
    this.providerSeg.setAttribute('aria-label', t('cost.provider'));
    this.providerSeg.addEventListener('keydown', (e) => this.onArrow(e, this.providerSeg, (b) => this.setProvider(b.dataset.provider ?? TOTAL)));

    this.periodSeg.setAttribute('role', 'radiogroup');
    this.periodSeg.setAttribute('aria-label', t('cost.period'));
    this.periodSeg.addEventListener('keydown', (e) => this.onArrow(e, this.periodSeg, (b) => this.setPeriod(b.dataset.period as Period)));
    for (const p of PERIODS) {
      const b = h('button', 'seg', t(`cost.period.${p}`));
      b.dataset.period = p;
      b.setAttribute('role', 'radio');
      b.addEventListener('click', () => this.setPeriod(p));
      this.periodSeg.append(b);
    }

    this.root.append(head, this.providerSeg, this.periodSeg, this.body);
    document.body.append(this.root);
    this.renderProviders([]);
    this.place();
    document.addEventListener('mousedown', this.onDown, true);
    document.addEventListener('keydown', this.onKey, true);
    window.addEventListener('resize', this.place);
    this.setPeriod(this.period);
    this.periodSeg.querySelector<HTMLElement>('.seg.active')?.focus();
  }

  /** Above the status bar's cost, its right edge on the cost's, inside the window. */
  private readonly place = () => {
    const r = this.anchorEl().getBoundingClientRect();
    this.root.style.right = `${Math.max(12, window.innerWidth - r.right - 8)}px`;
    this.root.style.bottom = `${window.innerHeight - r.top + 6}px`;
    this.root.style.maxHeight = `${Math.max(200, r.top - 18)}px`;
  };

  private readonly onDown = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    // The status bar's cost toggles the popover on its own click.
    if (!this.root.contains(target) && !target.closest('.sb-cost')) this.close();
  };

  private readonly onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    e.preventDefault();
    this.close();
  };

  /** Arrows move between the choices of a group, as in any radio group. */
  private onArrow(e: KeyboardEvent, seg: HTMLElement, pick: (b: HTMLElement) => void): void {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const segs = [...seg.querySelectorAll<HTMLElement>('.seg')];
    const at = segs.findIndex((b) => b.classList.contains('active'));
    pick(segs[(at + step + segs.length) % segs.length]);
    seg.querySelector<HTMLElement>('.seg.active')?.focus();
  }

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

  /** The status bar redraws its cost when the figure moves: the one in the window now. */
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

  private setProvider(id: string): void {
    this.provider = id;
    this.show();
  }

  /** A provider's name: its block's, the one the user gave a provider they added, else its id (an older account's server). */
  private label(id: string): string {
    return this.providers().find((p) => p.id === id)?.label ?? PROVIDER_DEFS.find((p) => p.id === id)?.label ?? id;
  }

  /**
   * Total, then the providers that spent in the period or have an account, in the order of the settings' blocks (a
   * stable order: the period does not move them), the ones known by their spending alone last.
   */
  private renderProviders(spent: ProviderCostRow[]): void {
    const listed = this.providers().filter((p) => p.connected || spent.some((r) => r.key === p.id)).map((p) => p.id);
    const others = spent.map((r) => r.key).filter((k) => !listed.includes(k)).sort((a, b) => a.localeCompare(b));
    const ids = [TOTAL, ...listed, ...others];
    if (!ids.includes(this.provider)) this.provider = TOTAL;
    this.providerSeg.replaceChildren(
      ...ids.map((id) => {
        const b = h('button', 'seg', id === TOTAL ? t('cost.total') : this.label(id));
        b.dataset.provider = id;
        b.setAttribute('role', 'radio');
        const on = id === this.provider;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
        b.addEventListener('click', () => this.setProvider(id));
        return b;
      }),
    );
  }

  private async load(): Promise<void> {
    const range = periodRange(this.period, new Date());
    const request = ++this.request;
    this.body.classList.add('loading');
    try {
      const { records, since, missions } = await this.hub.costHistory(range.from, range.to);
      if (request !== this.request) return;
      this.data = { records, missions: missions ?? [], since, range };
      this.show();
    } catch (err) {
      if (request !== this.request) return;
      this.body.replaceChildren(h('div', 'cost-empty', t('cost.failed')));
      this.body.title = err instanceof Error ? err.message : String(err);
    } finally {
      if (request === this.request) this.body.classList.remove('loading');
    }
  }

  /** The period read, for the provider picked: all of them by provider, one of them by model. */
  private show(): void {
    if (!this.data) return;
    const { records, missions, since, range } = this.data;
    const providers = byProvider(records, range);
    this.renderProviders(providers);
    const mine = this.provider === TOTAL ? records : ofProvider(records, this.provider);
    const s = summarize(mine, range);
    // Missions are counted on the provider's turns alone.
    this.render(s, range.from < since ? since : 0, missionRows(mine, missions), this.provider === TOTAL ? providers : null);
  }

  /**
   * `since`: when the log started, only if it starts inside the period (earlier days are then not counted).
   * `providers`: the split by provider of the Total view; null in a provider's.
   */
  private render(s: CostSummary, since: number, missions: MissionRow[], providers: ProviderCostRow[] | null): void {
    const total = h('div', 'cost-total');
    const value = h('span', 'cost-total-value', fmtCost(s.total.cost));
    value.title = exactUsd(s.total.cost);
    const counts = [tn('cost.turns', s.turns, { n: whole.format(s.turns) }), ...(s.videos > 0 ? [tn('cost.videos', s.videos, { n: s.videos })] : [])];
    total.append(value, h('span', 'cost-sub', counts.join(' · ')));
    this.body.title = '';
    this.body.replaceChildren(total);
    if (hasUnpriced(s.unpriced)) {
      const note = h('div', 'cost-unpriced', t('cost.unpriced', { what: unpricedText(s.unpriced) }));
      note.title = t('cost.unpricedHint');
      this.body.append(note);
    }
    if (s.turns === 0 && s.videos === 0 && s.total.cost === 0 && !hasUnpriced(s.unpriced)) {
      this.body.append(h('div', 'cost-empty', t('cost.none')));
    } else {
      // The split by provider says something only when there are two of them.
      if (providers && providers.length > 1) this.body.append(this.section(t('cost.byProvider'), this.providerList(providers, s.total.cost)));
      if (!providers) this.body.append(this.section(t('cost.byModel'), this.modelList(s.models, s.total.cost)));
      this.body.append(this.section(t('cost.byRepo'), this.list(s)));
    }
    if (missions.length > 0) this.body.append(this.missions(missions, s.total.cost));
    if (since) {
      const date = new Date(since).toLocaleDateString(LANG, { day: 'numeric', month: 'long', year: 'numeric' });
      const note = h('div', 'cost-since', t('cost.since', { date }));
      note.title = t('cost.sinceHint');
      this.body.append(note);
    }
  }

  private section(title: string, list: HTMLElement): HTMLElement {
    const box = h('div', 'cost-section');
    box.append(h('div', 'cost-section-title', title), list);
    return box;
  }

  /** A row's amount; nothing priced at all (an unknown price only) says so instead of $0.00. */
  private amount(cost: number, unpriced: Unpriced, tokens: number, videos: number): HTMLElement {
    const none = cost === 0 && hasUnpriced(unpriced) && unpriced.tokens >= tokens && unpriced.videos >= videos;
    const el = h('span', none ? 'cost-amount cost-amount-unknown' : 'cost-amount', none ? t('cost.unknownPrice') : fmtCost(cost));
    if (!none) el.title = exactUsd(cost);
    return el;
  }

  /** Each provider at its own prices; a click opens its detail. */
  private providerList(rows: ProviderCostRow[], total: number): HTMLElement {
    const list = h('ul', 'cost-list');
    for (const row of rows) {
      const li = h('li', 'cost-row cost-pick');
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      li.append(h('span', 'cost-name', this.label(row.key)), this.amount(row.usage.cost, row.unpriced, tokenCount(row.usage), row.videos));
      this.share(li, total > 0 ? row.usage.cost / total : 0);
      const facts = [tn('cost.turns', row.turns, { n: whole.format(row.turns) }), t('cost.tokens', { n: compact.format(tokenCount(row.usage)) }), ...(row.videos > 0 ? [tn('cost.videos', row.videos, { n: row.videos })] : [])];
      if (hasUnpriced(row.unpriced)) li.append(h('span', 'cost-sub cost-facts cost-row-unpriced', t('cost.unpricedRow', { what: unpricedText(row.unpriced) })));
      li.title = [`${this.label(row.key)} · ${exactUsd(row.usage.cost)}`, facts.join(' · '), t('cost.providerHint')].join('\n');
      const open = () => this.setProvider(row.key);
      li.addEventListener('click', open);
      li.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        open();
      });
      list.append(li);
    }
    return list;
  }

  /** One provider's models: their cost at its prices, their tokens, and a model without a price said as such. */
  private modelList(rows: ModelCostRow[], total: number): HTMLElement {
    const list = h('ul', 'cost-list');
    for (const row of rows) {
      const li = h('li', 'cost-row');
      const name = modelName(row.model);
      li.append(h('span', 'cost-name', name), this.amount(row.usage.cost, row.unpriced, tokenCount(row.usage), row.videos));
      this.share(li, total > 0 ? row.usage.cost / total : 0);
      const tokens = tokenCount(row.usage);
      const facts = [...(tokens > 0 ? [t('cost.tokens', { n: compact.format(tokens) })] : []), ...(row.videos > 0 ? [tn('cost.videos', row.videos, { n: row.videos })] : [])];
      if (hasUnpriced(row.unpriced) && (row.usage.cost > 0 || row.unpriced.tokens < tokens || row.unpriced.videos < row.videos)) facts.push(t('cost.unpricedRow', { what: unpricedText(row.unpriced) }));
      li.append(h('span', `cost-sub cost-facts${hasUnpriced(row.unpriced) ? ' cost-row-unpriced' : ''}`, facts.join(' · ')));
      const u = row.usage;
      li.title = [
        `${row.model} · ${hasUnpriced(row.unpriced) && u.cost === 0 ? t('cost.unknownPrice') : exactUsd(u.cost)}`,
        `${t('cost.input')} ${compact.format(u.input)} · ${t('cost.output')} ${compact.format(u.output)}`,
        `${t('cost.cacheRead')} ${compact.format(u.cacheRead)} · ${t('cost.cacheWrite')} ${compact.format(u.cacheWrite)}`,
        ...(hasUnpriced(row.unpriced) ? [t('cost.unpricedHint')] : []),
      ].join('\n');
      list.append(li);
    }
    return list;
  }

  /** Its share of the period: a thin bar under the line. */
  private share(li: HTMLElement, share: number): void {
    const bar = h('span', 'cost-share');
    bar.style.setProperty('--share', String(share));
    li.append(bar);
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

  /** The costliest missions of the period: the worker, its model and who chose it, relaunches, errors, length. */
  private missions(rows: MissionRow[], total: number): HTMLElement {
    const box = h('div', 'cost-missions');
    box.append(h('div', 'cost-missions-title', t('cost.missions')));
    const list = h('ul', 'cost-list');
    for (const m of rows.slice(0, MISSIONS_SHOWN)) {
      const li = h('li', 'cost-row');
      const by = t(`cost.by.${m.by}`);
      const facts = [`${m.model || '—'}${m.effort ? `/${m.effort}` : ''} · ${by}`];
      if (m.follows > 0) facts.push(tn('cost.follows', m.follows, { n: m.follows }));
      if (m.retries > 0) facts.push(tn('cost.retries', m.retries, { n: m.retries }));
      if (m.errors > 0) facts.push(tn('cost.errors', m.errors, { n: m.errors }));
      if (m.ms > 0) facts.push(t('cost.minutes', { n: Math.max(1, Math.round(m.ms / 60_000)) }));
      li.append(h('span', 'cost-name', m.name.replace(/^hub-/, '')), h('span', 'cost-amount', fmtCost(m.cost)));
      this.share(li, total > 0 ? m.cost / total : 0);
      li.append(h('span', 'cost-sub cost-mission-facts', facts.join(' · ')));
      li.title = [`${m.mission} · ${tn('cost.turns', m.turns, { n: whole.format(m.turns) })} · ${exactUsd(m.cost)}`, tn('cost.tools', m.tools, { n: whole.format(m.tools) })].join('\n');
      list.append(li);
    }
    box.append(list);
    return box;
  }

  private row(row: RepoCostRow, total: number): HTMLElement {
    const li = h('li', row.key ? 'cost-row' : 'cost-row cost-more');
    const share = total > 0 ? row.usage.cost / total : 0;
    li.append(h('span', 'cost-name', row.key ? row.label : t('cost.otherRepos')), h('span', 'cost-amount', fmtCost(row.usage.cost)));
    this.share(li, share);
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
