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
import { fmtCost, h, icon, ICONS, openMenu } from './dom';
import { LANG, t, tn } from './i18n';

const exactUsd = (v: number) => `$${v.toFixed(4)}`;
const compact = new Intl.NumberFormat(LANG, { notation: 'compact', maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat(LANG);
/** Rows of a list shown before "more": the rest of the period is in the total. */
const ROWS_SHOWN = 5;
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
/** Short mark of a part without a known price; what it is, on hover. */
function unpricedMark(u: Unpriced): HTMLElement {
  const mark = h('span', 'cost-unpriced', '+?');
  mark.title = `${t('cost.unpriced', { what: unpricedText(u) })}\n${t('cost.unpricedHint')}`;
  return mark;
}

let openPanel: CostPanel | null = null;

/** Opens the cost popover above the status bar's cost, or closes it when it is open. `providers`: the snapshot's. */
export function toggleCostPanel(hub: HubApi, anchor: HTMLElement, providers: () => ProviderBadge[] = () => []): void {
  if (openPanel) return openPanel.close();
  openPanel = new CostPanel(hub, anchor, providers);
}

/** A line of a list: its name, its share of the period as a thin bar, its amount. */
interface Line {
  name: string;
  share: number;
  amount: HTMLElement;
  title: string;
  /** Under the line, shown on a click (a mission's facts). */
  facts?: string;
  more?: string;
  open?: () => void;
}

/**
 * The cost of a period, all providers together (by provider, by repo, by mission) or one provider's (by model, by
 * repo, by mission), read from the turn log when the popover opens or the period changes. One header: the provider
 * (a menu, Total by default) and the period.
 */
class CostPanel {
  private readonly root = h('div', 'cost-panel');
  private readonly body = h('div', 'cost-body');
  private readonly providerBtn = h('button', 'cost-provider');
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
    this.providerBtn.setAttribute('aria-haspopup', 'menu');
    this.providerBtn.setAttribute('aria-label', t('cost.provider'));
    this.providerBtn.addEventListener('click', () => this.providerMenu());
    const info = h('span', 'cost-info');
    info.append(icon(ICONS.info));
    info.title = `${t('cost.title')}\n${t('cost.note')}`;
    info.tabIndex = 0;
    info.setAttribute('aria-label', t('cost.note'));

    this.periodSeg.setAttribute('role', 'radiogroup');
    this.periodSeg.setAttribute('aria-label', t('cost.period'));
    this.periodSeg.addEventListener('keydown', this.onArrow);
    for (const p of PERIODS) {
      const b = h('button', 'seg', t(`cost.periodShort.${p}`));
      b.dataset.period = p;
      b.title = t(`cost.period.${p}`);
      b.setAttribute('role', 'radio');
      b.addEventListener('click', () => this.setPeriod(p));
      this.periodSeg.append(b);
    }
    head.append(this.providerBtn, info, this.periodSeg);

    this.root.append(head, this.body);
    document.body.append(this.root);
    this.renderProvider();
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

  /** The provider menu is open: Escape and clicks are its own. */
  private readonly menuOpen = () => document.getElementById('menu')?.hidden === false;

  private readonly onDown = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    // The status bar's cost toggles the popover on its own click; the provider menu is part of it.
    if (!this.root.contains(target) && !target.closest('.sb-cost, #menu')) this.close();
  };

  private readonly onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || this.menuOpen()) return;
    e.stopPropagation();
    e.preventDefault();
    this.close();
  };

  /** Arrows move between the periods, as in any radio group. */
  private readonly onArrow = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    this.setPeriod(PERIODS[(PERIODS.indexOf(this.period) + step + PERIODS.length) % PERIODS.length]);
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
    if (id === TOTAL) return t('cost.total');
    return this.providers().find((p) => p.id === id)?.label ?? PROVIDER_DEFS.find((p) => p.id === id)?.label ?? id;
  }

  /**
   * Total, then the providers that spent in the period or have an account, in the order of the settings' blocks (a
   * stable order: the period does not move them), the ones known by their spending alone last.
   */
  private choices(spent: ProviderCostRow[]): string[] {
    const listed = this.providers().filter((p) => p.connected || spent.some((r) => r.key === p.id)).map((p) => p.id);
    const others = spent.map((r) => r.key).filter((k) => !listed.includes(k)).sort((a, b) => a.localeCompare(b));
    return [TOTAL, ...listed, ...others];
  }

  private renderProvider(): void {
    this.providerBtn.replaceChildren(h('span', 'cost-provider-name', this.label(this.provider)), icon(ICONS.chevron));
  }

  /** The providers, each with what it spent in the period: a pick shows its detail. */
  private providerMenu(): void {
    if (!this.data) return;
    const { records, range } = this.data;
    const spent = byProvider(records, range);
    const total = summarize(records, range);
    openMenu(
      this.providerBtn,
      (menu, close) => {
        menu.classList.add('cost-provider-menu');
        for (const id of this.choices(spent)) {
          const row = spent.find((r) => r.key === id);
          const cost = id === TOTAL ? total.total.cost : (row?.usage.cost ?? 0);
          const none = id === TOTAL ? total.unpriced : (row?.unpriced ?? { tokens: 0, videos: 0 });
          const b = h('button', id === this.provider ? 'menu-row checked' : 'menu-row');
          b.append(id === this.provider ? icon(ICONS.check) : h('span', 'ico'), h('span', 'menu-title', this.label(id)), h('span', 'menu-hint', fmtCost(cost)));
          if (hasUnpriced(none)) b.append(unpricedMark(none));
          b.addEventListener('click', () => {
            close();
            this.setProvider(id);
            this.providerBtn.focus();
          });
          menu.append(b);
        }
        window.requestAnimationFrame(() => menu.querySelector<HTMLElement>('.menu-row.checked')?.focus());
      },
      true,
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
    // A provider with neither spending in this period nor an account: back to Total.
    if (!this.choices(providers).includes(this.provider)) this.provider = TOTAL;
    this.renderProvider();
    const mine = this.provider === TOTAL ? records : ofProvider(records, this.provider);
    // Missions are counted on the provider's turns alone.
    this.render(summarize(mine, range), range.from < since ? since : 0, missionRows(mine, missions), this.provider === TOTAL ? providers : null);
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
    total.append(value);
    if (hasUnpriced(s.unpriced)) total.append(unpricedMark(s.unpriced));
    total.append(h('span', 'cost-sub', counts.join(' · ')));
    this.body.title = '';
    this.body.replaceChildren(total);
    if (s.turns === 0 && s.videos === 0 && s.total.cost === 0 && !hasUnpriced(s.unpriced)) {
      this.body.append(h('div', 'cost-empty', t('cost.none')));
    } else {
      const sum = s.total.cost;
      // The split by provider says something only when there are two of them.
      if (providers && providers.length > 1) this.body.append(this.section(t('cost.byProvider'), providers.map((r) => this.providerLine(r, sum)), providers.length));
      if (!providers) this.body.append(this.section(t('cost.byModel'), s.models.map((r) => this.modelLine(r, sum))));
      this.body.append(this.section(t('cost.byRepo'), s.repos.map((r) => this.repoLine(r, sum))));
      if (missions.length > 0) this.body.append(this.section(t('cost.missions'), missions.map((m) => this.missionLine(m, sum))));
    }
    if (since) {
      const date = new Date(since).toLocaleDateString(LANG, { day: 'numeric', month: 'long', year: 'numeric' });
      const note = h('div', 'cost-since', t('cost.since', { date }));
      note.title = t('cost.sinceHint');
      this.body.append(note);
    }
  }

  /** A titled list, its first rows only until "more" (`shown`: how many). */
  private section(title: string, lines: Line[], shown = ROWS_SHOWN): HTMLElement {
    const box = h('div', 'cost-section');
    const list = h('ul', 'cost-list');
    const fill = (n: number) => list.replaceChildren(...lines.slice(0, n).map((l) => this.line(l)));
    fill(shown);
    box.append(h('div', 'cost-section-title', title), list);
    if (lines.length > shown) {
      const more = h('button', 'cost-show-more', t('cost.showMore', { n: lines.length - shown }));
      more.addEventListener('click', () => {
        fill(lines.length);
        more.remove();
      });
      box.append(more);
    }
    return box;
  }

  private line(l: Line): HTMLElement {
    const li = h('li', 'cost-row');
    li.append(h('span', 'cost-name', l.name));
    // Nothing priced (a price unknown): no share to show, the words take its room.
    if (l.amount.classList.contains('cost-amount-unknown')) l.amount.classList.add('cost-amount-wide');
    else {
      const bar = h('span', 'cost-share');
      bar.style.setProperty('--share', String(Math.min(1, Math.max(0, l.share))));
      li.append(bar);
    }
    li.append(l.amount);
    li.title = l.title;
    const facts = l.facts ? h('span', 'cost-facts', l.facts) : null;
    if (facts) {
      facts.hidden = true;
      li.append(facts);
    }
    const open = l.open ?? (facts ? () => (facts.hidden = !facts.hidden) : null);
    if (open) {
      li.classList.add('cost-pick');
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      li.addEventListener('click', open);
      li.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        open();
      });
    }
    return li;
  }

  /** A line's amount, and "+?" when a part has no known price; nothing priced at all says so instead of $0.00. */
  private amount(cost: number, unpriced: Unpriced, tokens: number, videos: number): HTMLElement {
    const box = h('span', 'cost-amount');
    const none = cost === 0 && hasUnpriced(unpriced) && unpriced.tokens >= tokens && unpriced.videos >= videos;
    if (none) {
      box.classList.add('cost-amount-unknown');
      // What was used, then that its price is not known: "970 k · prix inconnu", "1 vidéo · prix inconnu".
      const used = unpriced.tokens > 0 ? compact.format(unpriced.tokens) : tn('cost.videos', unpriced.videos, { n: unpriced.videos });
      box.textContent = `${used} · ${t('cost.unknownPrice')}`;
      box.title = `${unpricedText(unpriced)}\n${t('cost.unpricedHint')}`;
      return box;
    }
    box.textContent = fmtCost(cost);
    if (hasUnpriced(unpriced)) box.append(unpricedMark(unpriced));
    return box;
  }

  private providerLine(row: ProviderCostRow, total: number): Line {
    const facts = [tn('cost.turns', row.turns, { n: whole.format(row.turns) }), t('cost.tokens', { n: compact.format(tokenCount(row.usage)) }), ...(row.videos > 0 ? [tn('cost.videos', row.videos, { n: row.videos })] : [])];
    return {
      name: this.label(row.key),
      share: total > 0 ? row.usage.cost / total : 0,
      amount: this.amount(row.usage.cost, row.unpriced, tokenCount(row.usage), row.videos),
      title: [`${this.label(row.key)} · ${exactUsd(row.usage.cost)}`, facts.join(' · '), t('cost.providerHint')].join('\n'),
      open: () => this.setProvider(row.key),
    };
  }

  /** One provider's model: its cost at its prices; one without a price shows its tokens. */
  private modelLine(row: ModelCostRow, total: number): Line {
    const u = row.usage;
    const tokens = tokenCount(u);
    const what = [...(tokens > 0 ? [t('cost.tokens', { n: compact.format(tokens) })] : []), ...(row.videos > 0 ? [tn('cost.videos', row.videos, { n: row.videos })] : [])].join(' · ');
    return {
      name: modelName(row.model),
      share: total > 0 ? u.cost / total : 0,
      amount: this.amount(u.cost, row.unpriced, tokens, row.videos),
      title: [
        `${row.model} · ${hasUnpriced(row.unpriced) && u.cost === 0 ? t('cost.unknownPrice') : exactUsd(u.cost)}`,
        what,
        `${t('cost.input')} ${compact.format(u.input)} · ${t('cost.output')} ${compact.format(u.output)}`,
        `${t('cost.cacheRead')} ${compact.format(u.cacheRead)} · ${t('cost.cacheWrite')} ${compact.format(u.cacheWrite)}`,
        ...(hasUnpriced(row.unpriced) ? [t('cost.unpricedHint')] : []),
      ].filter(Boolean).join('\n'),
    };
  }

  private repoLine(row: RepoCostRow, total: number): Line {
    const share = total > 0 ? row.usage.cost / total : 0;
    const u = row.usage;
    const amount = h('span', 'cost-amount', fmtCost(u.cost));
    return {
      name: row.key ? row.label : t('cost.otherRepos'),
      share,
      amount,
      title: [
        row.key || t('cost.otherReposHint'),
        `${tn('cost.turns', row.turns, { n: whole.format(row.turns) })} · ${exactUsd(u.cost)} · ${Math.round(share * 100)}%`,
        row.sessions.map((s) => (s.role === 'master' ? t('master') : s.label.replace(/^hub-/, ''))).join(', '),
        `${t('cost.input')} ${compact.format(u.input)} · ${t('cost.output')} ${compact.format(u.output)}`,
        `${t('cost.cacheRead')} ${compact.format(u.cacheRead)} · ${t('cost.cacheWrite')} ${compact.format(u.cacheWrite)}`,
      ].join('\n'),
    };
  }

  /** A mission of the period: the worker, then on a click its model and who chose it, relaunches, errors, length. */
  private missionLine(m: MissionRow, total: number): Line {
    const facts = [`${m.model || '—'}${m.effort ? `/${m.effort}` : ''} · ${t(`cost.by.${m.by}`)}`];
    if (m.follows > 0) facts.push(tn('cost.follows', m.follows, { n: m.follows }));
    if (m.retries > 0) facts.push(tn('cost.retries', m.retries, { n: m.retries }));
    if (m.errors > 0) facts.push(tn('cost.errors', m.errors, { n: m.errors }));
    if (m.ms > 0) facts.push(t('cost.minutes', { n: Math.max(1, Math.round(m.ms / 60_000)) }));
    return {
      name: m.name.replace(/^hub-/, ''),
      share: total > 0 ? m.cost / total : 0,
      amount: h('span', 'cost-amount', fmtCost(m.cost)),
      title: [`${m.mission} · ${tn('cost.turns', m.turns, { n: whole.format(m.turns) })} · ${exactUsd(m.cost)}`, tn('cost.tools', m.tools, { n: whole.format(m.tools) })].join('\n'),
      facts: facts.join(' · '),
    };
  }
}
