import { isProviderId } from '../shared/providers';
import type { AccountBadge, SessionView } from '../shared/types';

// Each provider's sessions wear its own mascot: the one place that says which.

export type MascotId = 'clawd' | 'codex' | 'gemini' | 'deepseek';

const BY_PROVIDER = { anthropic: 'clawd', openai: 'codex', gemini: 'gemini', deepseek: 'deepseek' } as const;

const saysDeepseek = (name: string) => /deep[\s_-]*seek(?!er)/i.test(name);

/**
 * A provider's mascot. An account no built-in provider stands for (one the user added, an older one) gets DeepSeek's
 * when its id or one of the `names` it goes by says so, else Clawd.
 */
export const mascotOf = (provider: string, ...names: string[]): MascotId => {
  if (isProviderId(provider)) return BY_PROVIDER[provider];
  return [provider, ...names].some(saysDeepseek) ? 'deepseek' : 'clawd';
};

/** The mascot of a provider's block. Its models count only all together: a server that hosts many is none of them. */
export const providerMascot = (provider: string, label: string, models: string[]): MascotId =>
  mascotOf(provider, label, ...(models.every(saysDeepseek) ? models : []));

/** The mascot of a session: the one of its account's provider, so it changes along with it. `modelLabel` is what a pinned account really runs. */
export function sessionMascot(s: SessionView, accounts: AccountBadge[]): MascotId {
  const account = accounts.find((a) => a.id === s.account);
  return mascotOf(account?.provider ?? '', account?.name ?? '', s.model, s.modelLabel);
}

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
 * provider the user added with no mascot of its own: its mark is the first letter of its name.
 */
export function mascotMark(provider: string, cls: string, label = '', models: string[] = []): HTMLElement {
  const mascot = providerMascot(provider, label, models);
  if (mascot === 'clawd' && provider && !isProviderId(provider) && label) {
    const mark = document.createElement('span');
    mark.className = `${cls} letter-mark`;
    mark.textContent = label.trim().charAt(0).toUpperCase();
    mark.setAttribute('aria-hidden', 'true');
    return mark;
  }
  return mascotPicture(mascot, cls, `${mascot}-mark`);
}
