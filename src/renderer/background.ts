import { backgroundTokens, parseHex } from '../shared/background';

let applied: string[] = [];

/** Puts the tokens of a background colour on the page (a preview while the user picks it); '' restores the theme's. */
export function applyBackground(hex: string): void {
  const root = document.documentElement;
  for (const name of applied) root.style.removeProperty(name);
  applied = [];
  const bg = parseHex(hex);
  if (!bg) {
    root.style.removeProperty('color-scheme');
    return;
  }
  const { tone, vars } = backgroundTokens(bg);
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  applied = Object.keys(vars);
  // Scroll bars, form controls and the native colour picker follow the colour's tone, not the system's.
  root.style.setProperty('color-scheme', tone);
}

// The main process passes the saved colour in the URL: the first paint has it.
applyBackground(new URLSearchParams(location.search).get('bg') ?? '');
