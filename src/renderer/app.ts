import type { ChatItem, HubApi, HubSnapshot, RateLimits, SessionView } from '../shared/types';
import { Avatar, clawdEvent, forgetClawd, noteFleet } from './avatar';
import { ChatView } from './chat';
import { toggleCostPanel } from './cost';
import { asleep, displayName, failed, fmtCost, fmtPct, h, icon, ICONS, level, oneLine, statusDot, statusLabel } from './dom';
import { effortLabel, LANG, PLATFORM, t, translateDom } from './i18n';
import { isMod, paletteOpen, shortcut, showPalette, type Command } from './palette';
import { RepoPanel } from './repo';
import { SetupView } from './setup';
import { TopicsView } from './topics';
import './tooltip';
import { checkForUpdates, initUpdates } from './update';
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
const teamList = $('team-list');
const teamGroup = $('team-group');
const reposRoot = $('repos');

translateDom();
document.body.classList.add(`platform-${PLATFORM}`);

// Settings open from the end of the master's header, where its folder chip was (the folder is in its name's tooltip).
const settingsButton = h('button', 'ph-settings');
settingsButton.id = 'open-settings';
settingsButton.title = `${t('side.settings')} · ${shortcut(',')}`;
settingsButton.setAttribute('aria-haspopup', 'dialog');
settingsButton.append(icon(ICONS.gear), h('span', '', t('side.settings')));
const masterView = new ChatView($('pane-master'), hub, `${t('master.empty')}\n${t('palette.hint', { key: shortcut('K') })}`, undefined, false, settingsButton);
const workerView = new ChatView($('pane-worker'), hub, t('worker.empty'), () => openWorker(null), true);
const setup = new SetupView(hub, () => snapshot.models, (account) => snapshot.catalogs[account] ?? null);
const topicsView = new TopicsView($('pane-master'), masterView, hub);
settingsButton.addEventListener('click', () => void setup.open('settings'));

interface Card {
  root: HTMLDivElement;
  avatar: Avatar;
  /** Branch mark of a worker in its own worktree. */
  tree: HTMLSpanElement;
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
const repoPanel = new RepoPanel(hub);
const store = new Map<string, Map<string, ChatItem>>();
let snapshot: HubSnapshot = { sessions: [], models: [], catalogs: {}, rateLimits: null, topics: [], accounts: [] };
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

/**
 * Closed for good: its worktree was removed, or it is an instance of a post now off or deleted. Its conversation
 * stays readable.
 */
const ended = (s: SessionView) =>
  isClosed(s) && (s.tree?.state === 'removed' || (!!s.instance && !snapshot.sessions.some((p) => p.post?.id === s.instance?.postId)));

function renderActions(c: Card, s: SessionView): void {
  const key = `${s.role}:${isClosed(s)}:${s.post !== null}:${ended(s)}`;
  if (c.actionsKey === key) return;
  c.actionsKey = key;
  c.actions.replaceChildren();
  // A permanent worker sleeps and wakes; it goes away with its post, in the settings.
  if (s.post) {
    c.actions.append(isClosed(s) ? actionButton(t('card.wake'), ICONS.resume, () => hub.resume(s.id)) : actionButton(t('card.sleep'), ICONS.moon, () => hub.stop(s.id)));
    return;
  }
  if (!isClosed(s) && s.role === 'worker') c.actions.append(actionButton(t('card.close'), ICONS.stop, () => hub.stop(s.id)));
  if (isClosed(s) && !ended(s)) c.actions.append(actionButton(t('card.resume'), ICONS.resume, () => hub.resume(s.id)));
  if (isClosed(s) && s.role === 'worker') c.actions.append(actionButton(t('card.remove'), ICONS.remove, () => hub.remove(s.id)));
}

/** Who goes where in the sidebar: each post with its instances at work, the other active workers, the closed ones. */
function layout(sessions: SessionView[]): { team: SessionView[]; active: SessionView[]; closed: SessionView[] } {
  const posts = sessions.filter((s) => s.post).sort((a, b) => (a.post?.order ?? 0) - (b.post?.order ?? 0));
  const under = (p: SessionView) => sessions.filter((s) => s.instance && s.instance.postId === p.post?.id && !isClosed(s));
  const team = posts.flatMap((p) => [p, ...under(p)]);
  const rest = sessions.filter((s) => s.role === 'worker' && !team.includes(s));
  // Newest first: the latest missions are the ones worth a look.
  return { team, active: rest.filter((s) => !isClosed(s)), closed: rest.filter(isClosed).reverse() };
}

/** Nested under its post: an instance at work, its card in the team list. */
const nested = (s: SessionView) => !!s.instance && !isClosed(s) && snapshot.sessions.some((p) => p.post?.id === s.instance?.postId);

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
  const tree = h('span', 'card-tree');
  tree.append(icon(ICONS.branch));
  tree.setAttribute('aria-hidden', 'true');
  tree.hidden = true;
  const name = h('span', 'card-name');
  const cost = h('span', 'card-cost');
  row.append(tree, name, cost);
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
  const card = { root, avatar, tree, name, cost, model, pct, fill, sub, actions, actionsKey: '' };
  cards.set(s.id, card);
  return card;
}

/** Writes only what changed: a streamed reply re-renders the cards 25 times a second. */
function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** What the card says under the meter: live activity while working, else the latest news. */
function cardSub(s: SessionView, last: ChatItem | undefined): { text: string; cls: string } {
  if (s.status === 'attention') return { text: t('card.attention'), cls: 'warn' };
  if (s.tree?.install === 'running' && !isClosed(s)) return { text: t('card.installing'), cls: 'live' };
  if (s.tree?.state === 'kept' && isClosed(s)) return { text: t('card.treeKept', { reasons: s.tree.kept.map((k) => t(`tree.why.${k}`)).join(' · ') }), cls: 'warn' };
  if (s.compacting && !isClosed(s)) return { text: `▸ ${t('slash.compacting')}`, cls: 'live' };
  if (s.status === 'busy') {
    const activity = activityOf(last);
    return { text: activity ? `▸ ${activity}` : t('card.working'), cls: 'live' };
  }
  if (s.background.length > 0 && !isClosed(s)) return { text: t('card.background', { text: oneLine(s.background[0]) }), cls: 'live' };
  if (failed(s)) return { text: t('card.failed', { error: s.error }), cls: 'error' };
  if (s.post && asleep(s)) return { text: oneLine(s.post.description), cls: '' };
  if (s.lastMessage) return { text: oneLine(s.lastMessage), cls: '' };
  if (s.mission) return { text: oneLine(s.mission), cls: '' };
  return { text: s.role === 'master' ? t('master.yourConversation') : t(`status.${s.status}`), cls: '' };
}

function renderCard(s: SessionView): void {
  const c = ensureCard(s);
  const m = s.metrics;
  const last = lastOf(store.get(s.id));
  c.root.classList.toggle('selected', s.id === opened);
  // A resting permanent worker gets the compact card of a closed one, without its faded look.
  c.root.classList.toggle('closed', isClosed(s) && s.role === 'worker' && !s.post);
  c.root.classList.toggle('asleep', isClosed(s) && s.post !== null);
  // Under its post the job is enough ("agenda"); elsewhere the post goes with it ("brain · agenda").
  const inTeam = nested(s);
  c.root.classList.toggle('instance', inTeam);
  c.avatar.update(s, last, s.role === 'master' ? workersBusy() : 0);
  c.tree.hidden = s.tree?.state !== 'active';
  setText(c.name, inTeam && s.instance ? s.instance.topic : displayName(s));
  setText(c.cost, fmtCost(m?.costUsd));
  setText(c.model, [s.modelLabel, s.effort ? effortLabel(s.effort) : ''].filter(Boolean).join(' · '));
  setText(c.pct, fmtPct(m?.contextPct));
  // A scale on the compositor rather than a width: the meter moves without a layout.
  c.fill.style.transform = `scaleX(${Math.min(100, m?.contextPct ?? 0) / 100})`;
  c.fill.className = `meter-fill ${level(m?.contextPct)}`;
  const sub = cardSub(s, last);
  setText(c.sub, sub.text);
  c.sub.className = `card-sub ${sub.cls}`;
  // A worktree is named by its branch, never by its path.
  const tip = s.instance && s.tree ? t('card.instanceTip', { post: s.instance.post, branch: s.tree.branch }) : s.tree ? t('card.treeTip', { branch: s.tree.branch }) : s.cwd;
  if (c.root.title !== tip && c.root.dataset.tip !== tip) c.root.title = tip;
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
  repoPanel.setWorkers(snapshot.sessions);
  repoPanel.setFocus(snapshot.sessions.find((s) => s.id === opened)?.cwd ?? null);
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
  return t('sb.reset', { date: new Date(epochSeconds * 1000).toLocaleString(LANG, opts) });
}

let statusKey = '';

function renderStatusbar(rate: RateLimits | null): void {
  const workers = snapshot.sessions.filter((s) => s.role === 'worker' && !isClosed(s));
  const running = workers.filter((s) => s.status === 'busy').length;
  const attention = workers.filter((s) => s.status === 'attention').length;
  const master = snapshot.sessions.find((s) => s.role === 'master');
  const total = snapshot.sessions.reduce((sum, s) => sum + (s.metrics?.costUsd ?? 0), 0);
  const key = JSON.stringify([master && statusDot(master), master && statusLabel(master), workers.length, running, attention, fmtCost(total), rate]);
  if (key === statusKey) return;
  statusKey = key;

  const left: HTMLElement[] = [];
  if (master) {
    const item = h('div', 'sb-item');
    item.append(h('span', statusDot(master)), h('span', failed(master) ? 'sb-failed' : '', t('sb.master', { status: statusLabel(master) })));
    left.push(item);
  }
  left.push(h('span', 'sb-sep'), sbItem(t('sb.active'), String(workers.length)));
  if (running) left.push(sbItem(t('sb.running'), String(running)));
  if (attention) left.push(sbItem(t('sb.toApprove'), String(attention), 'warn'));
  $('sb-left').replaceChildren(...left);

  // The Σ opens the cost by period.
  const cost = h('button', 'sb-item sb-cost');
  cost.title = `${t('sb.costHint')}\n${t('cost.open')}`;
  cost.setAttribute('aria-haspopup', 'dialog');
  cost.append(h('span', '', t('sb.cost')), h('span', 'sb-num', fmtCost(total)));
  cost.addEventListener('click', () => toggleCostPanel(hub, cost));
  const right: HTMLElement[] = [cost];
  if (rate?.fiveHourPct != null) {
    right.push(h('span', 'sb-sep'), sbItem(t('sb.5h'), fmtPct(rate.fiveHourPct), level(rate.fiveHourPct), resetTime(rate.fiveHourResetsAt, false)));
  }
  if (rate?.sevenDayPct != null) right.push(sbItem(t('sb.7d'), fmtPct(rate.sevenDayPct), level(rate.sevenDayPct), resetTime(rate.sevenDayResetsAt, true)));
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
  const { team, active, closed } = layout(sessions);
  const posts = team.filter((s) => s.post).length;
  const nodeOf = (s: SessionView) => (cards.get(s.id) as Card).root;
  syncList(teamList, team.map(nodeOf));
  teamGroup.hidden = posts === 0;
  $('team-count').textContent = posts ? String(posts) : '';
  syncList(activeList, active.map(nodeOf));
  syncList(closedList, closed.map(nodeOf));
  closedGroup.hidden = closed.length === 0;
  $('closed-count').textContent = String(closed.length);
  // Instances at work under their post count as active workers: "no active worker" would be wrong.
  $('worker-empty').hidden = active.length > 0 || team.length > posts;
  $('worker-count').textContent = active.length ? String(active.length) : '';

  workspace.classList.toggle('expanded', opened !== null);
  const master = sessions.find((s) => s.role === 'master');
  masterView.show(master, master && store.get(master.id), models, snapshot.accounts, snapshot.catalogs);
  topicsView.update(snapshot.topics, master && store.get(master.id));
  const worker = sessions.find((s) => s.id === opened);
  workerView.show(worker, worker && store.get(worker.id), models, snapshot.accounts, snapshot.catalogs);
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

// ---------- keyboard ----------

/** The team (posts and their instances), then the active workers, as the sidebar shows them: Ctrl/Cmd+2 to 9 open them in that order. */
function sidebarOrder(): SessionView[] {
  const { team, active } = layout(snapshot.sessions);
  return [...team, ...active];
}

/** Everything the hub can do from the keyboard, with its shortcut when it has one. */
function commands(): Command[] {
  const list: Command[] = [{ title: t('palette.master'), keys: shortcut('1'), run: () => openWorker(null) }];
  sidebarOrder().forEach((s, i) => list.push({ title: t('palette.openWorker', { name: displayName(s) }), hint: statusLabel(s), keys: i < 8 ? shortcut(String(i + 2)) : undefined, run: () => openWorker(s.id) }));
  if (opened) list.push({ title: t('palette.hideWorker'), run: () => openWorker(null) });
  list.push(
    { title: t('side.settings'), keys: shortcut(','), run: () => void setup.open('settings') },
    { title: t('palette.cost'), run: () => document.querySelector<HTMLElement>('.sb-cost')?.click() },
    { title: t('palette.git'), keys: shortcut('G', true), run: () => repoPanel.toggle() },
    { title: t('palette.repos'), run: () => void setup.open('settings', 'repos') },
    { title: t('update.check'), run: checkForUpdates },
  );
  for (const s of layout(snapshot.sessions).closed) list.push({ title: t('palette.openWorker', { name: displayName(s) }), hint: t('palette.closedWorker'), run: () => openWorker(s.id) });
  return list;
}

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.isComposing || setup.isOpen) return;
  if (isMod(e) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    showPalette(commands());
  } else if (paletteOpen()) {
    return;
  } else if (isMod(e) && e.key === ',') {
    e.preventDefault();
    void setup.open('settings');
  } else if (isMod(e, true) && e.code === 'KeyG') {
    e.preventDefault();
    repoPanel.toggle();
  } else if (isMod(e) && /^(Digit|Numpad)[1-9]$/.test(e.code)) {
    // 1: the master; 2 to 9: the team and the active workers, in the sidebar's order. Physical keys: on an AZERTY
    // keyboard the digits are shifted.
    e.preventDefault();
    const n = Number(e.code.slice(-1));
    const target = n === 1 ? null : sidebarOrder()[n - 2];
    if (n === 1 || target) openWorker(target ? target.id : null);
  }
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
  // An approval asked in the master's conversation adds to the badge of its topic.
  if (s?.role === 'master' && (fresh || items.some((i) => i.kind === 'permission'))) topicsView.update(snapshot.topics, map);
  if (s) renderCard(s);
});
hub.onEvent((id, kind) => clawdEvent(id, kind));
reposRoot.append(repoPanel.root);
hub.onRepo((status) => repoPanel.update(status));
// The master changed the team: an open Team section shows it.
hub.onTeam(() => setup.teamChanged());
// A notice that points to a section of the settings (Claude Code missing, for one).
window.addEventListener('hub:open-settings', (e) => {
  const section = (e as CustomEvent<unknown>).detail;
  void setup.open('settings', section === 'claude' ? 'claude' : section === 'accounts' ? 'accounts' : 'general');
});
// The git panel's own buttons to follow another repo or stop following one.
window.addEventListener('hub:add-repo', () => void setup.open('settings', 'repos'));
window.addEventListener('hub:remove-repo', (e) => {
  const path = (e as CustomEvent<unknown>).detail;
  if (typeof path !== 'string') return;
  void hub.getSettings().then((v) => hub.saveSettings({ mainRepos: v.settings.mainRepos.filter((p) => p !== path) }));
});
// The repos the settings follow: the panel forgets the others.
hub.onRepos((paths) => {
  repoPanel.setRepos(paths);
  $('repos-empty').hidden = paths.length > 0;
});
hub.ready();
// An unattended restart waits while a message is being written or the settings are open.
initUpdates(hub, () => setup.isOpen || paletteOpen() || [...document.querySelectorAll('textarea')].some((el) => el.value.trim() !== ''));
masterView.focus();
// A first run opens the setup; so does a language change made in the middle of it (the page reloads).
if (!setup.resume()) {
  void hub.getSettings().then((v) => {
    if (!v.settings.onboarded) void setup.open('onboarding');
  });
}
