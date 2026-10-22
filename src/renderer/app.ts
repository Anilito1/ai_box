import { STATUS_LABEL, type ChatItem, type HubApi, type HubSnapshot, type RateLimits, type SessionView } from '../shared/types';
import { ChatView } from './chat';
import { displayName, fmtCost, fmtPct, h, icon, ICONS, level, oneLine } from './dom';
import { RepoPanel } from './repo';
import { activityOf, WorkingLine } from './working';

declare global {
  interface Window {
    hub: HubApi;
  }
}

const hub = window.hub;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const workspace = $('workspace');
const masterSlot = $('master-slot');
const workerList = $('worker-list');
const dockTiles = $('dock-tiles');
const dockTabs = $('dock-tabs');

const masterView = new ChatView($('pane-master'), hub, 'Parle au maître : il découpe, délègue les missions à des workers et te fait les rapports.');
const workerView = new ChatView($('pane-worker'), hub, 'Ce worker n’a encore rien produit.');
const repoPanel = new RepoPanel($('repo'), hub);

const FEED_LINES = 3;

interface Actions {
  actions: HTMLDivElement;
  actionsKey: string;
}

interface Card extends Actions {
  root: HTMLDivElement;
  dot: HTMLSpanElement;
  name: HTMLSpanElement;
  cost: HTMLSpanElement;
  model: HTMLSpanElement;
  pct: HTMLSpanElement;
  fill: HTMLDivElement;
  sub: HTMLDivElement;
}

/** A worker's mini window in the dock: live preview of its latest steps; a click opens the conversation. */
interface Tile extends Actions {
  root: HTMLDivElement;
  dot: HTMLSpanElement;
  name: HTMLSpanElement;
  nums: HTMLSpanElement;
  meta: HTMLDivElement;
  feed: HTMLDivElement;
  working: WorkingLine;
}

interface Tab {
  root: HTMLButtonElement;
  dot: HTMLSpanElement;
  name: HTMLSpanElement;
}

const cards = new Map<string, Card>();
const tiles = new Map<string, Tile>();
const tabs = new Map<string, Tab>();
const store = new Map<string, Map<string, ChatItem>>();
let snapshot: HubSnapshot = { sessions: [], models: [], rateLimits: null };
// Worker whose conversation is open in the dock; null = every worker shows as a mini window.
let expanded: string | null = null;

const viewFor = (id: string) => (masterView.sessionId === id ? masterView : workerView.sessionId === id ? workerView : null);
const folderOf = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;

function actionButton(label: string, path: string, run: () => void): HTMLButtonElement {
  const btn = h('button', 'icon-btn');
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.append(icon(path));
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    run();
  });
  return btn;
}

function renderActions(target: Actions, s: SessionView): void {
  const running = s.status !== 'exited';
  const key = `${s.role}:${running}`;
  if (target.actionsKey === key) return;
  target.actionsKey = key;
  target.actions.replaceChildren();
  if (running && s.role === 'worker') target.actions.append(actionButton('Arrêter', ICONS.stop, () => hub.stop(s.id)));
  if (!running) target.actions.append(actionButton('Reprendre', ICONS.resume, () => hub.resume(s.id)));
  if (!running && s.role === 'worker') target.actions.append(actionButton('Retirer', ICONS.remove, () => hub.remove(s.id)));
}

function expand(id: string | null): void {
  expanded = id;
  render();
  if (id) {
    tabs.get(id)?.root.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    workerView.focus();
  } else {
    masterView.focus();
  }
}

// ---------- sidebar ----------

function ensureCard(s: SessionView): Card {
  const existing = cards.get(s.id);
  if (existing) return existing;
  const root = h('div', s.role === 'master' ? 'card master' : 'card');
  const row = h('div', 'card-row');
  const dot = h('span', 'dot');
  const name = h('span', 'card-name');
  const cost = h('span', 'card-cost');
  row.append(dot, name, cost);
  const meta = h('div', 'card-meta');
  const model = h('span');
  const pct = h('span', 'card-pct');
  meta.append(model, pct);
  const meter = h('div', 'meter');
  const fill = h('div', 'meter-fill');
  meter.append(fill);
  const sub = h('div', 'card-sub');
  const actions = h('div', 'card-actions');
  root.append(row, meta, meter, sub, actions);
  root.addEventListener('click', () => (s.role === 'worker' ? expand(s.id) : masterView.focus()));
  (s.role === 'master' ? masterSlot : workerList).append(root);
  const card = { root, dot, name, cost, model, pct, fill, sub, actions, actionsKey: '' };
  cards.set(s.id, card);
  return card;
}

function renderCard(s: SessionView): void {
  const c = ensureCard(s);
  const m = s.metrics;
  c.root.classList.toggle('selected', s.id === expanded);
  c.dot.className = `dot s-${s.status}`;
  c.dot.title = STATUS_LABEL[s.status];
  c.name.textContent = displayName(s);
  c.cost.textContent = fmtCost(m?.costUsd);
  c.model.textContent = [s.modelLabel, s.effort].filter(Boolean).join(' · ');
  c.pct.textContent = fmtPct(m?.contextPct);
  c.fill.style.width = `${Math.min(100, m?.contextPct ?? 0)}%`;
  c.fill.className = `meter-fill ${level(m?.contextPct)}`;

  let sub = STATUS_LABEL[s.status];
  if (s.status === 'attention') sub = 'Attend ta validation';
  else if (s.lastMessage) sub = oneLine(s.lastMessage);
  else if (s.mission) sub = oneLine(s.mission);
  else if (s.role === 'master') sub = 'Ta conversation principale';
  c.sub.textContent = sub;
  c.sub.classList.toggle('warn', s.status === 'attention');
  c.root.title = s.cwd;
  renderActions(c, s);
}

// ---------- dock: mini windows + tabs of the open worker ----------

function ensureTile(s: SessionView): Tile {
  const existing = tiles.get(s.id);
  if (existing) return existing;
  const root = h('div', 'tile');
  const head = h('div', 'tile-head');
  const dot = h('span', 'dot');
  const name = h('span', 'tile-name');
  const nums = h('span', 'tile-nums');
  const actions = h('div', 'tile-actions');
  head.append(dot, name, nums, actions, icon(ICONS.expand, 'ico tile-open'));
  const body = h('div', 'tile-body');
  const meta = h('div', 'tile-meta');
  const feed = h('div', 'tile-feed');
  const working = new WorkingLine(true);
  body.append(meta, feed, working.root);
  root.append(head, body);
  root.addEventListener('click', () => expand(s.id));
  dockTiles.append(root);
  const tile = { root, dot, name, nums, meta, feed, working, actions, actionsKey: '' };
  tiles.set(s.id, tile);
  return tile;
}

function renderTile(s: SessionView): void {
  const t = ensureTile(s);
  t.root.className = `tile s-${s.status}`;
  t.root.title = `Ouvrir la conversation · ${s.cwd}`;
  t.dot.className = `dot s-${s.status}`;
  t.dot.title = STATUS_LABEL[s.status];
  t.name.textContent = displayName(s);
  t.nums.textContent = s.metrics ? `${fmtPct(s.metrics.contextPct)} · ${fmtCost(s.metrics.costUsd)}` : '';
  t.meta.textContent = [folderOf(s.cwd), s.modelLabel, s.effort].filter(Boolean).join(' · ');
  renderActions(t, s);
  renderFeed(s);
}

function feedLine(item: ChatItem): HTMLElement | null {
  switch (item.kind) {
    case 'tool': {
      const line = h('div', 'feed-line');
      line.append(h('span', `feed-dot ${item.result === null ? 'running' : item.isError ? 'error' : ''}`), h('b', '', item.name));
      line.append(h('span', 'feed-muted', item.summary));
      return line;
    }
    case 'assistant':
      return h('div', 'feed-line', oneLine(item.text).slice(0, 240));
    case 'user':
      return h('div', 'feed-line feed-muted', `↳ ${oneLine(item.text).slice(0, 240)}`);
    case 'peer':
      return h('div', 'feed-line feed-muted', `↳ ${item.from} : ${oneLine(item.text).slice(0, 240)}`);
    case 'permission':
      return item.state === 'pending' ? h('div', 'feed-line feed-warn', `Autoriser ${item.tool} ?`) : null;
    default:
      return null;
  }
}

/** Latest steps of a worker, refreshed on every item batch so the mini window stays live. */
function renderFeed(s: SessionView): void {
  const t = tiles.get(s.id);
  if (!t) return;
  const all = [...(store.get(s.id)?.values() ?? [])];
  const lines: HTMLElement[] = [];
  for (let i = all.length - 1; i >= 0 && lines.length < FEED_LINES; i--) {
    const line = feedLine(all[i]);
    if (line) lines.unshift(line);
  }
  if (lines.length === 0) lines.push(h('div', 'feed-line feed-muted', s.mission ? oneLine(s.mission).slice(0, 240) : STATUS_LABEL[s.status]));
  t.feed.replaceChildren(...lines);
  t.working.update(s.status, s.busySince, activityOf(all.at(-1)));
}

function renderTab(s: SessionView): void {
  let tab = tabs.get(s.id);
  if (!tab) {
    const root = h('button', 'dock-tab');
    const dot = h('span', 'dot');
    const name = h('span', 'dock-tab-name');
    root.append(dot, name);
    root.addEventListener('click', () => expand(s.id));
    dockTabs.append(root);
    tab = { root, dot, name };
    tabs.set(s.id, tab);
  }
  tab.root.classList.toggle('active', s.id === expanded);
  tab.dot.className = `dot s-${s.status}`;
  tab.name.textContent = displayName(s);
  tab.root.title = `${displayName(s)} · ${STATUS_LABEL[s.status]}`;
}

const collapse = $('dock-collapse');
collapse.append(icon(ICONS.collapse));
collapse.addEventListener('click', () => expand(null));

// ---------- status bar ----------

function sbItem(label: string, value: string, cls = '', title = ''): HTMLDivElement {
  const item = h('div', 'sb-item');
  item.title = title;
  if (label) item.append(h('span', '', label));
  item.append(h('span', `sb-num ${cls}`, value));
  return item;
}

function resetTime(epochSeconds: number | null, withDay: boolean): string {
  if (!epochSeconds) return '';
  const opts: Intl.DateTimeFormatOptions = withDay ? { weekday: 'short', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' };
  return `Réinitialisation : ${new Date(epochSeconds * 1000).toLocaleString('fr-FR', opts)}`;
}

function renderStatusbar(rate: RateLimits | null): void {
  const workers = snapshot.sessions.filter((s) => s.role === 'worker');
  const running = workers.filter((s) => s.status === 'busy').length;
  const attention = workers.filter((s) => s.status === 'attention').length;
  const master = snapshot.sessions.find((s) => s.role === 'master');

  const left: HTMLElement[] = [];
  if (master) {
    const item = h('div', 'sb-item');
    item.append(h('span', `dot s-${master.status}`), h('span', '', `Maître · ${STATUS_LABEL[master.status]}`));
    left.push(item);
  }
  left.push(h('span', 'sb-sep'), sbItem('Workers', String(workers.length)));
  if (running) left.push(sbItem('en cours', String(running)));
  if (attention) left.push(sbItem('à valider', String(attention), 'warn'));
  $('sb-left').replaceChildren(...left);

  const total = snapshot.sessions.reduce((sum, s) => sum + (s.metrics?.costUsd ?? 0), 0);
  const right: HTMLElement[] = [sbItem('Σ coût API', fmtCost(total), '', 'Estimation au tarif API, toutes sessions du hub')];
  if (rate?.fiveHourPct != null) {
    right.push(h('span', 'sb-sep'), sbItem('5 h', fmtPct(rate.fiveHourPct), level(rate.fiveHourPct), resetTime(rate.fiveHourResetsAt, false)));
  }
  if (rate?.sevenDayPct != null) right.push(sbItem('7 j', fmtPct(rate.sevenDayPct), level(rate.sevenDayPct), resetTime(rate.sevenDayResetsAt, true)));
  $('sb-right').replaceChildren(...right);
}

// ---------- render ----------

function render(): void {
  const { sessions, models } = snapshot;
  const ids = new Set(sessions.map((s) => s.id));
  for (const [id, card] of cards) {
    if (ids.has(id)) continue;
    card.root.remove();
    cards.delete(id);
    store.delete(id);
  }
  for (const [id, tile] of tiles) {
    if (ids.has(id)) continue;
    tile.working.stop();
    tile.root.remove();
    tiles.delete(id);
  }
  for (const [id, tab] of tabs) {
    if (ids.has(id)) continue;
    tab.root.remove();
    tabs.delete(id);
  }
  const workers = sessions.filter((s) => s.role === 'worker');
  if (expanded && !ids.has(expanded)) expanded = null;

  workspace.classList.toggle('solo', workers.length === 0);
  workspace.classList.toggle('expanded', expanded !== null);
  $('worker-empty').hidden = workers.length > 0;
  $('worker-count').textContent = workers.length ? String(workers.length) : '';
  for (const s of sessions) renderCard(s);
  for (const s of workers) {
    renderTile(s);
    renderTab(s);
  }

  const master = sessions.find((s) => s.role === 'master');
  masterView.show(master, master && store.get(master.id), models);
  const worker = sessions.find((s) => s.id === expanded);
  workerView.show(worker, worker && store.get(worker.id), models);
  renderStatusbar(snapshot.rateLimits);
}

// ---------- splitter (master | open worker) ----------

const splitter = $('splitter');
try {
  const saved = localStorage.getItem('dockWidth');
  if (saved) workspace.style.setProperty('--dock-width', saved);
} catch {
  // Storage unavailable: default split.
}
splitter.addEventListener('pointerdown', (e) => {
  splitter.setPointerCapture(e.pointerId);
  splitter.classList.add('dragging');
  workspace.classList.add('resizing');
  const rect = workspace.getBoundingClientRect();
  const move = (ev: PointerEvent) => {
    // The master always keeps at least half of the workspace.
    const pct = Math.min(50, Math.max(28, ((rect.right - ev.clientX) / rect.width) * 100));
    workspace.style.setProperty('--dock-width', `${pct.toFixed(1)}%`);
  };
  const up = () => {
    splitter.classList.remove('dragging');
    workspace.classList.remove('resizing');
    splitter.removeEventListener('pointermove', move);
    splitter.removeEventListener('pointerup', up);
    try {
      localStorage.setItem('dockWidth', workspace.style.getPropertyValue('--dock-width'));
    } catch {
      // Not persisted: fine.
    }
  };
  splitter.addEventListener('pointermove', move);
  splitter.addEventListener('pointerup', up);
});

// ---------- boot ----------

hub.onSnapshot((next) => {
  snapshot = next;
  render();
});
hub.onItems((id, items, reset) => {
  let map = store.get(id);
  const fresh = !map || reset;
  if (!map || reset) store.set(id, (map = new Map()));
  for (const item of items) map.set(item.id, item);
  const view = viewFor(id);
  if (view && fresh) view.reset(map);
  else view?.upsert(items);
  const s = snapshot.sessions.find((x) => x.id === id);
  if (s?.role === 'worker') renderFeed(s);
});
hub.onRepo((status) => repoPanel.update(status));
hub.ready();
masterView.focus();
