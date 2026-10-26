import type { ProviderId } from '../shared/providers';
import type { AccountBadge, SessionView } from '../shared/types';

// Each provider's sessions wear its own mascot: the one place that says which.

export type MascotId = 'clawd' | 'codex' | 'gemini' | 'deepseek';

const BY_PROVIDER: Record<ProviderId, MascotId> = { anthropic: 'clawd', openai: 'codex', gemini: 'gemini', deepseek: 'deepseek' };

/** A provider's mascot; Clawd for an account no provider stands for. */
export const mascotOf = (provider: ProviderId | ''): MascotId => (provider ? BY_PROVIDER[provider] : 'clawd');

/** The mascot of a session: the one of its account's provider, so it changes along with it. */
export const sessionMascot = (s: SessionView, accounts: AccountBadge[]): MascotId => mascotOf(accounts.find((a) => a.id === s.account)?.provider ?? '');

/** A still picture of a mascot (copied next to the page by build.mjs); `mascotPicture(mascotOf(provider))` for a provider's. */
export function mascotPicture(mascot: MascotId, cls = 'mascot-pic'): HTMLImageElement {
  const img = document.createElement('img');
  img.className = cls;
  img.src = `mascots/${mascot}.png`;
  img.alt = '';
  img.draggable = false;
  return img;
}
