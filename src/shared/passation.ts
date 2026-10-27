import type { Lang } from './i18n';
import type { ChatItem } from './types';

// The note a session carries to another account when its own cannot go on, and the one it carries back. The hub writes
// it itself: the account that is limited cannot be asked for a summary, and the next one has none of the conversation.

const TAG = 'hub-handoff';
const BUDGET = 24_000;
const KEEP = 60;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
const flat = (text: string) => text.replace(/\s+/g, ' ').trim();
const safe = (text: string) => text.replace(new RegExp(`</?${TAG}[^>]*>`, 'gi'), '');

/** The conversation, last items first kept, as lines: who said what, which tools ran and whether they failed. */
export function digest(items: ChatItem[], budget = BUDGET): string {
  const lines: string[] = [];
  let size = 0;
  for (const item of items.slice(-KEEP).reverse()) {
    let line = '';
    if (item.kind === 'user') line = `User: ${clip(flat(item.text), 1500)}`;
    else if (item.kind === 'peer') line = `${item.from}: ${clip(flat(item.text), 1500)}`;
    else if (item.kind === 'assistant') line = item.text.trim() ? `You: ${clip(flat(item.text), 1200)}` : '';
    else if (item.kind === 'tool') line = `[${item.name}] ${clip(flat(item.summary), 160)}${item.isError ? ' (failed)' : ''}`;
    if (!line) continue;
    if (size + line.length > budget) break;
    size += line.length;
    lines.push(line);
  }
  return lines.reverse().join('\n');
}

/**
 * The handoff note of a permanent worker woken after its prompt cache expired, written by the hub: asking the model for
 * one would reread its whole conversation at full price. Its last note, then the last steps of the conversation.
 */
export function staleNote(previous: string, items: ChatItem[], l: Lang): string {
  const fr = l === 'fr';
  return [
    fr
      ? 'Note écrite par le hub : ta conversation précédente dormait depuis plus d’une heure.'
      : 'Note written by the hub: your previous conversation had been asleep for over an hour.',
    previous.trim() ? `${fr ? 'Ta note précédente' : 'Your previous note'}:\n${clip(previous.trim(), 2500)}` : '',
    `${fr ? 'Dernières étapes' : 'Latest steps'}:\n${digest(items, 2500) || (fr ? '(rien)' : '(nothing)')}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export interface Handoff {
  lang: Lang;
  /** `away`: the session leaves its account; `back`: it returns to it. */
  kind: 'away' | 'back';
  fromName: string;
  toName: string;
  reason: 'rate' | 'quota' | 'auth' | 'ready';
  /** Epoch ms when the account it left opens again, when known. */
  opensAt: number | null;
  mission: string;
  items: ChatItem[];
  /** `git status --short` and `git diff --stat` of its folder, else empty. */
  git: string;
  now: number;
}

const WHY = {
  fr: { rate: 'la limite de débit', quota: 'la limite d’usage', auth: 'un problème de connexion', ready: 'sa disponibilité retrouvée' },
  en: { rate: 'a rate limit', quota: 'a usage limit', auth: 'a sign-in problem', ready: 'it being available again' },
};

/** The text a session gets as its first message on another account (or back on its own). */
export function buildHandoff(h: Handoff): string {
  const fr = h.lang === 'fr';
  const when = h.opensAt ? new Date(h.opensAt).toLocaleTimeString(fr ? 'fr-FR' : 'en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
  const away = h.kind === 'away';
  const head = away
    ? fr
      ? `Tu reprends le travail d’une session interrompue par ${WHY.fr[h.reason]} de « ${h.fromName} »${when ? ` (rouverte vers ${when})` : ''}. Tu tournes maintenant sur « ${h.toName} » ; tu n’as pas sa conversation, seulement ce résumé. Avant d’agir, vérifie l’état du dépôt : un outil a pu être coupé en plein travail. Puis continue la demande en cours sans refaire ce qui est fait.`
      : `You are taking over the work of a session interrupted by ${WHY.en[h.reason]} on “${h.fromName}”${when ? ` (open again around ${when})` : ''}. You now run on “${h.toName}”; you do not have its conversation, only this summary. Before acting, check the state of the repository: a tool may have been cut mid-way. Then carry on with the request in progress without redoing what is done.`
    : fr
      ? `Tu reviens sur « ${h.toName} » avec ta conversation d’avant, après ${WHY.fr.ready}. Pendant ton absence, le travail a continué sur « ${h.fromName} » : voici ce qui s’y est passé. Vérifie l’état du dépôt avant d’agir.`
      : `You are back on “${h.toName}” with your earlier conversation, after ${WHY.en.ready}. While you were away the work went on on “${h.fromName}”: this is what happened there. Check the state of the repository before acting.`;
  const parts = [
    head,
    h.mission ? `${fr ? 'Mission d’origine' : 'Original mission'}:\n${clip(h.mission, 3000)}` : '',
    `${fr ? 'Dernières étapes' : 'Latest steps'}:\n${digest(h.items) || (fr ? '(rien)' : '(nothing)')}`,
    h.git.trim() ? `${fr ? 'État du dépôt' : 'Repository state'}:\n${clip(h.git.trim(), 3000)}` : '',
  ].filter(Boolean);
  return `<${TAG}>\n${safe(parts.join('\n\n'))}\n</${TAG}>`;
}
