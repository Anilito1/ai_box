import { STATUS_LABEL, type ChatItem, type HubApi, type HubSnapshot, type RateLimits, type SessionView } from '../shared/types';
import { Avatar, clawdEvent, forgetClawd, noteFleet } from './avatar';
import { ChatView } from './chat';
import { displayName, fmtCost, fmtPct, h, icon, ICONS, level, oneLine } from './dom';
import { RepoPanel } from './repo';
import { activityOf, lastOf } from './working';

declare global {
  interface Window {
    hub: HubApi;
  }
}

const hub = window.hub;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const workspace = $('workspace');
const masterSlot = $('master-slot');
const activeList = $('active-list');
const closedList = $('closed-list');
const closedGroup = $<HTMLDetailsElement>('closed-group');
const reposRoot = $('repos');

const masterView = new ChatView($('pane-master'), hub, 'Parle au maître : il découpe, délègue les missions à des workers et te fait les rapports.');
const workerView = new ChatView($('pane-worker'), hub, 'Ce worker n’a encore rien produit.', () => openWorker(null), true);

interface Card {
  root: HTMLDivElement;
  avatar: Avatar;
  name: HTMLSpanElement;
  cost: HTMLSpanElement;
  model: HTMLSpanElement;
  pct: HTMLSpanElement;
  fill: HTMLDivElement;
  sub: HTMLDivElement;
  actions: HTMLDivElement;
  actionsKey: string;
}

const cards = new Map<string, Card>();
const repoPanels = new Map<string, RepoPanel>();
const store = new Map<string, Map<string, ChatItem>>();
let snapshot: HubSnapshot = { sessions: [], models: [], rateLimits: null };
// Worker whose conversation is open beside the master; null = the master alone.
let opened: string | null = null;

const viewFor = (id: string) => (masterView.sessionId === id ? masterView : workerView.sessionId === id ? workerView : null);
const isClosed = (s: SessionView) => s.status === 'exited';
/** Workers at work: the master's Clawd conducts them. */
const workersBusy = () => snapshot.sessions.filter((s) => s.role === 'worker' && s.status === 'busy').length;

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

function renderActions(c: Card, s: SessionView): void {
  const key = `${s.role}:${isClosed(s)}`;
  if (c.actionsKey === key) return;
  c.actionsKey = key;
  c.actions.replaceChildren();
  if (!isClosed(s) && s.role === 'worker') c.actions.append(actionButton('Fermer ce worker', ICONS.stop, () => hub.stop(s.id)));
  if (isClosed(s)) c.actions.append(actionButton('Reprendre', ICONS.resume, () => hub.resume(s.id)));
  if (isClosed(s) && s.role === 'worker') c.actions.append(actionButton('Retirer de la liste', ICONS.remove, () => hub.remove(s.id)));
}

/** Shows a worker's conversation beside the master (a closed one is read from its transcript), or hides it. */
function openWorker(id: string | null): void {
  opened = id;
  if (id) hub.open(id);
  render();
  if (id) workerView.focus();
  else masterView.focus();
}

// ---------- sidebar ----------

function ensureCard(s: SessionView): Card {
  const existing = cards.get(s.id);
  if (existing) return existing;
  const root = h('div', s.role === 'master' ? 'card master' : 'card');
  const row = h('div', 'card-row');
  const avatar = new Avatar('card');
  const name = h('span', 'card-name');
  const cost = h('span', 'card-cost');
  row.append(name, cost);
  const meta = h('div', 'card-meta');
  const model = h('span');
  const pct = h('span', 'card-pct');
  meta.append(model, pct);
  const meter = h('div', 'meter');
  const fill = h('div', 'meter-fill');
  meter.append(fill);
  const sub = h('div', 'card-sub');
  const actions = h('div', 'card-actions');
  root.append(avatar.root, row, meta, meter, sub, actions);
  root.addEventListener('click', () => {
    if (s.role === 'master') masterView.focus();
    else openWorker(opened === s.id ? null : s.id);
  });
  if (s.role === 'master') masterSlot.append(root);
  const card = { root, avatar, name, cost, model, pct, fill, sub, actions, actionsKey: '' };
  cards.set(s.id, card);
  return card;
}

/** What the card says under the meter: live activity while working, else the latest news. */
function cardSub(s: SessionView, last: ChatItem | undefined): { text: string; cls: string } {
  if (s.status === 'attention') return { text: 'Attend ta validation', cls: 'warn' };
  if (s.status === 'busy') {
    const activity = activityOf(last);
    return { text: activity ? `▸ ${activity}` : '▸ au travail', cls: 'live' };
  }
  if (s.background.length > 0 && !isClosed(s)) return { text: `Tâche de fond : ${oneLine(s.background[0])}`, cls: 'live' };
  if (s.lastMessage) return { text: oneLine(s.lastMessage), cls: '' };
  if (s.mission) return { text: oneLine(s.mission), cls: '' };
  return { text: s.role === 'master' ? 'Ta conversation principale' : STATUS_LABEL[s.status], cls: '' };
}

function renderCard(s: SessionView): void {
  const c = ensureCard(s);
  const m = s.metrics;
  const last = lastOf(store.get(s.id));
  c.root.classList.toggle('selected', s.id === opened);
  c.root.classList.toggle('closed', isClosed(s) && s.role === 'worker');
  c.avatar.update(s, last, s.role === 'master' ? workersBusy() : 0);
  c.name.textContent = displayName(s);
  c.cost.textContent = fmtCost(m?.costUsd);
  c.model.textContent = [s.modelLabel, s.effort].filter(Boolean).join(' · ');
  c.pct.textContent = fmtPct(m?.contextPct);
  c.fill.style.width = `${Math.min(100, m?.contextPct ?? 0)}%`;
  c.fill.className = `meter-fill ${level(m?.contextPct)}`;
  const sub = cardSub(s, last);
  c.sub.textContent = sub.text;
  c.sub.className = `card-sub ${sub.cls}`;
  c.root.title = s.cwd;
  renderActions(c, s);
}

/** Re-inserts the cards only when their order or list changed, so hover and focus survive renders. */
function syncList(list: HTMLElement, nodes: HTMLElement[]): void {
  const current = [...list.children];
  if (current.length !== nodes.length || current.some((n, i) => n !== nodes[i])) list.replaceChildren(...nodes);
}

try {
  closedGroup.open = localStorage.getItem('closedOpen') === '1';
} catch {
  // Storage unavailable: collapsed.
}
closedGroup.addEventListener('toggle', () => {
  try {
    localStorage.setItem('closedOpen', closedGroup.open ? '1' : '0');
  } catch {
    // Not persisted: fine.
  }
});

function renderRepos(): void {
  for (const panel of repoPanels.values()) panel.setWorkers(snapshot.sessions);
}

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
  const workers = snapshot.sessions.filter((s) => s.role === 'worker' && !isClosed(s));
  const running = workers.filter((s) => s.status === 'busy').length;
  const attention = workers.filter((s) => s.status === 'attention').length;
  const master = snapshot.sessions.find((s) => s.role === 'master');

  const left: HTMLElement[] = [];
  if (master) {
    const item = h('div', 'sb-item');
    item.append(h('span', `dot s-${master.status}`), h('span', '', `Maître · ${STATUS_LABEL[master.status]}`));
    left.push(item);
  }
  left.push(h('span', 'sb-sep'), sbItem('Workers actifs', String(workers.length)));
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
    card.avatar.dispose();
    cards.delete(id);
    store.delete(id);
    workerView.forget(id);
    forgetClawd(id);
  }
  noteFleet(sessions);
  if (opened && !ids.has(opened)) opened = null;

  for (const s of sessions) renderCard(s);
  const workers = sessions.filter((s) => s.role === 'worker');
  const active = workers.filter((s) => !isClosed(s));
  // Newest first: the latest missions are the ones worth a look.
  const closed = workers.filter(isClosed).reverse();
  const nodeOf = (s: SessionView) => (cards.get(s.id) as Card).root;
  syncList(activeList, active.map(nodeOf));
  syncList(closedList, closed.map(nodeOf));
  closedGroup.hidden = closed.length === 0;
  $('closed-count').textContent = String(closed.length);
  $('worker-empty').hidden = active.length > 0;
  $('worker-count').textContent = active.length ? String(active.length) : '';

  workspace.classList.toggle('expanded', opened !== null);
  const master = sessions.find((s) => s.role === 'master');
  masterView.show(master, master && store.get(master.id), models);
  const worker = sessions.find((s) => s.id === opened);
  workerView.show(worker, worker && store.get(worker.id), models);
  renderStatusbar(snapshot.rateLimits);
  renderRepos();
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
    splitter.removeEventListener('pointercancel', up);
    try {
      localStorage.setItem('dockWidth', workspace.style.getPropertyValue('--dock-width'));
    } catch {
      // Not persisted: fine.
    }
  };
  splitter.addEventListener('pointermove', move);
  splitter.addEventListener('pointerup', up);
  splitter.addEventListener('pointercancel', up);
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
  // The card's activity line follows the latest step.
  const s = snapshot.sessions.find((x) => x.id === id);
  if (s) renderCard(s);
});
hub.onEvent((id, kind) => clawdEvent(id, kind));
hub.onRepo((status) => {
  let panel = repoPanels.get(status.path);
  if (!panel) {
    panel = new RepoPanel(hub);
    repoPanels.set(status.path, panel);
    reposRoot.append(panel.root);
  }
  panel.update(status);
  panel.setWorkers(snapshot.sessions);
});
hub.ready();
masterView.focus();
