import { isProviderId } from '../shared/providers';
import type { AccountBadge, SessionView } from '../shared/types';

// Each provider's sessions wear its own mascot: the one place that says which.

export type MascotId = 'clawd' | 'codex' | 'gemini' | 'deepseek';

const BY_PROVIDER = { anthropic: 'clawd', openai: 'codex', gemini: 'gemini', deepseek: 'deepseek' } as const;

/** A provider's mascot; Clawd for an account no built-in provider stands for (one the user added, an older one). */
export const mascotOf = (provider: string): MascotId => (isProviderId(provider) ? BY_PROVIDER[provider] : 'clawd');

/** The mascot of a session: the one of its account's provider, so it changes along with it. */
export const sessionMascot = (s: SessionView, accounts: AccountBadge[]): MascotId => mascotOf(accounts.find((a) => a.id === s.account)?.provider ?? '');

/** A still picture of a mascot (copied next to the page by build.mjs), framed like the 3D one of a card. */
export function mascotPicture(mascot: MascotId, cls = 'mascot-pic', file: string = mascot): HTMLImageElement {
  const img = document.createElement('img');
  img.className = cls;
  img.src = `mascots/${file}.png`;
  img.alt = '';
  img.draggable = false;
  return img;
}

/**
 * A provider's mascot as a small mark beside its name: cut out close, without the room a card keeps for its hats. A
 * provider the user added has no mascot: its mark is the first letter of its name.
 */
export function mascotMark(provider: string, cls: string, label = ''): HTMLElement {
  if (provider && !isProviderId(provider) && label) {
    const mark = document.createElement('span');
    mark.className = `${cls} letter-mark`;
    mark.textContent = label.trim().charAt(0).toUpperCase();
    mark.setAttribute('aria-hidden', 'true');
    return mark;
  }
  return mascotPicture(mascotOf(provider), cls, `${mascotOf(provider)}-mark`);
}
