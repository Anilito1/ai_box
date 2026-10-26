import { switchCommand, type CliRun, type UpdateAction } from '../shared/cliUpdate';
import type { CliUpdate } from '../shared/news';
import type { ProviderId } from '../shared/providers';
import type { HubApi } from '../shared/types';
import { h, icon, ICONS } from './dom';
import { t, tn, type Key } from './i18n';

// The one-click update of a provider's program, as the window shows it: the offer in the model menu, then its progress,
// its result and the restart it may ask for. The main process runs it (main/cliUpdate.ts); the menu can close in the
// meantime, so the same box is shown in a card at the corner of the window.

const DONE_SHOWN_MS = 12_000;

let api: HubApi | null = null;
const runs = new Map<ProviderId, CliRun>();
/** The boxes on screen, each redrawn when its provider's update moves. */
const boxes = new Set<{ provider: ProviderId; el: HTMLElement; update: CliUpdate | null; card: boolean }>();
/** The cards the user closed while their update ran: shown again when it ends. */
const hidden = new Set<ProviderId>();
let stack: HTMLElement | null = null;

const anyRunning = () => [...runs.values()].some((r) => r.phase === 'running');

export function initCliUpdates(hub: HubApi): void {
  api = hub;
  hub.onCliUpdate((run) => {
    const before = runs.get(run.provider);
    runs.set(run.provider, run);
    if (before?.phase !== run.phase) hidden.delete(run.provider);
    redrawAll();
    if (!shownInMenu(run.provider) && !hidden.has(run.provider)) card(run.provider);
  });
  void hub.cliUpdates().then((list) => {
    for (const run of list) runs.set(run.provider, run);
    redrawAll();
  });
}

const shownInMenu = (provider: ProviderId) => [...boxes].some((b) => b.provider === provider && !b.card && b.el.isConnected);

function redrawAll(): void {
  for (const b of [...boxes]) {
    if (!b.el.isConnected) boxes.delete(b);
    else fill(b.el, b.provider, b.update, b.card);
  }
}

/** The box of the model menu: the offer, or the update running or just ended. Null when there is neither. */
export function cliUpdateBox(provider: ProviderId, update: CliUpdate | null): HTMLElement | null {
  if (!update && !runs.has(provider)) return null;
  const el = h('div', 'cli-update');
  // A click in the box must not pick a model nor close the menu.
  el.addEventListener('click', (e) => e.stopPropagation());
  boxes.add({ provider, el, update, card: false });
  fill(el, provider, update, false);
  return el;
}

/** The same box in a card at the corner of the window, while the menu is closed. */
function card(provider: ProviderId): void {
  if ([...boxes].some((b) => b.provider === provider && b.card && b.el.isConnected)) return;
  stack ??= document.body.appendChild(h('div', 'news-stack'));
  const wrap = h('div', 'news-toast cli-update-card');
  wrap.setAttribute('role', 'status');
  const el = h('div', 'cli-update');
  const close = h('button', 'icon-btn news-toast-close');
  close.title = t('news.close');
  close.setAttribute('aria-label', t('news.close'));
  close.append(icon(ICONS.remove));
  close.addEventListener('click', () => {
    const run = runs.get(provider);
    if (run && run.phase !== 'running' && !run.restart) dismiss(provider);
    else hidden.add(provider);
    wrap.remove();
  });
  wrap.append(el, close);
  stack.append(wrap);
  boxes.add({ provider, el, update: null, card: true });
  fill(el, provider, null, true);
}

function dismiss(provider: ProviderId): void {
  // Up to date now: the offer the menu was opened with is gone too.
  const updated = runs.get(provider)?.phase === 'done';
  runs.delete(provider);
  api?.dismissCliUpdate(provider);
  for (const b of [...boxes]) {
    if (b.provider !== provider) continue;
    if (b.card) b.el.parentElement?.remove();
    else {
      if (updated) b.update = null;
      fill(b.el, provider, b.update, false);
    }
  }
}

function start(provider: ProviderId, action: UpdateAction): void {
  void api?.updateCli(provider, action);
}

function button(label: string, cls: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const b = h('button', `btn small ${cls}`, label);
  b.disabled = disabled;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

const switchLabel = (to: string): string => t(to === 'native' ? 'cliUpdate.switch.native' : 'cliUpdate.switch.app');

/** A discreet link that copies the command, for those who would rather type it. */
function copyLink(command: string): HTMLElement {
  const b = h('button', 'cli-update-copy', t('chat.cliUpdate.copy'));
  b.title = command;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(command).then(() => {
      b.textContent = t('chat.cliUpdate.copied');
      window.setTimeout(() => (b.textContent = t('chat.cliUpdate.copy')), 1500);
    });
  });
  return b;
}

function logOf(run: CliRun, open = false): HTMLElement {
  const details = h('details', 'cli-update-log');
  details.open = open;
  details.append(h('summary', '', t('cliUpdate.log')), h('pre', '', run.log.trim() || '—'));
  return details;
}

function fill(el: HTMLElement, provider: ProviderId, update: CliUpdate | null, inCard: boolean): void {
  // The log stays unfolded across redraws if the user opened it.
  const logOpen = !!el.querySelector<HTMLDetailsElement>('details.cli-update-log')?.open;
  el.replaceChildren();
  const run = runs.get(provider);
  const busy = anyRunning();
  const row = (...items: HTMLElement[]) => {
    const r = h('div', 'cli-update-actions');
    r.append(...items);
    return r;
  };
  if (run?.phase === 'running') {
    const title = h('div', 'cli-update-title running');
    title.append(icon(ICONS.sync, 'ico spin'), h('span', '', t('cliUpdate.running', { tool: run.tool, latest: run.latest })));
    el.append(title, h('div', 'cli-update-note', t('cliUpdate.step', { index: run.index, total: run.total, step: t(`cliUpdate.step.${run.step}` as Key) })), logOf(run, logOpen));
    return;
  }
  if (run?.phase === 'done') {
    const title = h('div', 'cli-update-title ok');
    title.append(icon(ICONS.check), h('span', '', t('cliUpdate.done', { tool: run.tool, version: run.to || run.latest })));
    el.append(title);
    if (run.shadowed) el.append(h('div', 'cli-update-note warn', t('cliUpdate.shadowed', { tool: run.tool })));
    if (run.switchTo) {
      el.append(h('div', 'cli-update-note', t('cliUpdate.partial', { latest: run.latest })));
      el.append(row(button(switchLabel(run.switchTo), 'primary', () => start(provider, 'switch'), busy)));
    }
    if (run.restart > 0) {
      el.append(h('div', 'cli-update-note', tn('cliUpdate.restart', run.restart, { tool: run.tool })));
      el.append(row(button(t('cliUpdate.restartNow'), 'primary', () => api?.relaunch()), button(t('cliUpdate.later'), 'ghost', () => dismiss(provider))));
    } else {
      el.append(h('div', 'cli-update-note', t('cliUpdate.nextSessions')));
      el.append(row(button(t('update.ok'), 'ghost', () => dismiss(provider))));
      if (inCard && !run.switchTo && !run.shadowed) window.setTimeout(() => runs.get(provider) === run && dismiss(provider), DONE_SHOWN_MS);
    }
    el.append(logOf(run, logOpen));
    return;
  }
  if (run?.phase === 'failed') {
    const title = h('div', 'cli-update-title failed');
    title.append(icon(ICONS.info), h('span', '', t('cliUpdate.failed', { tool: run.tool })));
    el.append(title, h('div', 'cli-update-note', t(`cliUpdate.error.${run.error || 'failed'}` as Key, { tool: run.tool, version: run.to, latest: run.latest })));
    const actions = [button(t('cliUpdate.retry'), run.switchTo ? 'ghost' : 'primary', () => start(provider, run.action), busy)];
    if (run.switchTo) actions.unshift(button(switchLabel(run.switchTo), 'primary', () => start(provider, 'switch'), busy));
    actions.push(button(t('news.close'), 'ghost', () => dismiss(provider)));
    el.append(row(...actions), logOf(run, logOpen));
    if (update?.command) el.append(copyLink(update.command));
    return;
  }
  if (!update) {
    el.remove();
    return;
  }
  el.append(h('div', 'cli-update-title', t('chat.cliUpdate', { tool: update.tool, current: update.current, latest: update.latest })));
  if (update.switchTo) {
    // Its own method cannot reach the latest (Homebrew behind npm): the other install first, its own upgrade after.
    const note = update.method === 'brew' ? t(update.reach ? 'cliUpdate.behind' : 'cliUpdate.behind.unknown', { version: update.reach, latest: update.latest }) : t('cliUpdate.elsewhere');
    el.append(h('div', 'cli-update-note', note), h('div', 'cli-update-note', t(update.switchTo === 'native' ? 'cliUpdate.native.hint' : 'cliUpdate.app.hint')));
    const actions = [button(switchLabel(update.switchTo), 'primary', () => start(provider, 'switch'), busy)];
    if (update.upgrade && update.reach) actions.push(button(t('cliUpdate.upgradeTo', { version: update.reach }), 'ghost', () => start(provider, 'upgrade'), busy));
    el.append(row(...actions));
  } else if (update.upgrade) {
    if (update.method === 'app') el.append(h('div', 'cli-update-note', t('chat.cliUpdate.app')));
    el.append(row(button(t('cliUpdate.update'), 'primary', () => start(provider, 'upgrade'), busy)));
  }
  const command = update.switchTo === 'native' && !update.upgrade ? switchCommand(provider, update) : update.command;
  if (command) el.append(copyLink(command));
}
