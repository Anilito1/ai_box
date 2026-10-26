import type { NewsToast } from '../shared/news';
import { providerDef } from '../shared/providers';
import type { HubApi } from '../shared/types';
import { h, icon, ICONS } from './dom';
import { t } from './i18n';

// A discreet notice when a connected provider has something new (a model that can be used now, a newer program): a card
// at the bottom of the window that goes away by itself. The main process tells each discovery once.

const SHOWN_MS = 12_000;
const NAMES = 3;

let stack: HTMLElement | null = null;

/** The sentence of a discovery: the models first, the program's update after. */
export function newsLines(toast: NewsToast, providerLabel: string): string[] {
  const lines: string[] = [];
  if (toast.models.length > 0) {
    const shown = toast.models.slice(0, NAMES).join(', ') + (toast.models.length > NAMES ? ` +${toast.models.length - NAMES}` : '');
    lines.push(t(toast.models.length > 1 ? 'news.models.many' : 'news.models', { provider: providerLabel, models: shown }));
  }
  if (toast.cli) lines.push(t('news.cli', { tool: toast.cli.tool, latest: toast.cli.latest, current: toast.cli.current }));
  return lines;
}

export function initNews(hub: HubApi): void {
  hub.onNews((toast) => {
    const lines = newsLines(toast, providerDef(toast.provider).label);
    if (lines.length === 0) return;
    stack ??= document.body.appendChild(h('div', 'news-stack'));
    const card = h('div', 'news-toast');
    card.setAttribute('role', 'status');
    const text = h('div', 'news-toast-text');
    text.append(...lines.map((l) => h('div', '', l)));
    card.append(icon(ICONS.sparkle, 'ico'), text);
    const close = h('button', 'icon-btn news-toast-close');
    close.title = t('news.close');
    close.setAttribute('aria-label', t('news.close'));
    close.append(icon(ICONS.remove));
    const dismiss = () => card.remove();
    close.addEventListener('click', dismiss);
    card.append(close);
    stack.append(card);
    window.setTimeout(dismiss, SHOWN_MS);
  });
}
