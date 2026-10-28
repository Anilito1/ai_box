/**
 * The user's own background colour (settings): the window's surfaces are derived from it, and the text takes the tone
 * that reads on it (light text on a dark colour, dark text on a light one), whatever the system's appearance.
 */

export type Tone = 'dark' | 'light';

/** "#RRGGBB", "RRGGBB", "#RGB" or "RGB", any case, as "#rrggbb"; null for anything else. */
export function parseHex(input: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (!m) return null;
  const hex = m[1].toLowerCase();
  return `#${hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex}`;
}

type Rgb = [number, number, number];
const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const toHex = (c: Rgb) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
/** `a` moved by `amount` (0 to 1) towards `b`. */
const mix = (a: string, b: string, amount: number) => {
  const x = rgb(a);
  const y = rgb(b);
  return toHex(x.map((v, i) => v + (y[i] - v) * amount) as Rgb);
};
const alpha = (hex: string, a: number) => `rgba(${rgb(hex).join(', ')}, ${a})`;

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = rgb(hex).map((v) => lin(v / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The text colours on these surfaces: the theme's own when it reads (4.5:1), else pure black or white; the secondary
 * ones are it faded towards the window by `fades`, less when the full fade would drop below 4.5:1.
 */
function texts(base: string, pure: string, bg: string, surfaces: string[], fades: [number, number]): [string, string, string] {
  const reads = (c: string) => surfaces.every((s) => contrast(c, s) >= 4.5);
  const text = reads(base) ? base : pure;
  const faded = (fade: number) => {
    let f = fade;
    while (f > 0 && !reads(mix(text, bg, f))) f -= 0.01;
    return mix(text, bg, Math.max(f, 0));
  };
  return [text, faded(fades[0]), faded(fades[1])];
}

/** Above it, dark text has more contrast than light text on the colour. */
export const toneOf = (hex: string): Tone => (luminance(hex) > 0.179 ? 'light' : 'dark');

/**
 * The design tokens of styles.css a background colour replaces: the surfaces keep the steps of the built-in themes
 * (lighter layers above a dark window, white-washed ones above a light one), the secondary text is the main one faded
 * towards the colour, so it keeps its contrast on any hue.
 */
export function backgroundTokens(hex: string): { tone: Tone; vars: Record<string, string> } {
  const bg = parseHex(hex) ?? '#0d0e11';
  const tone = toneOf(bg);
  const W = '#ffffff';
  const B = '#000000';
  if (tone === 'dark') {
    const elevated = mix(bg, W, 0.065);
    const [chat, panel] = [mix(bg, W, 0.01), mix(bg, W, 0.02)];
    const [text, text2, text3] = texts('#ececef', W, bg, [bg, chat, panel], [0.25, 0.33]);
    return {
      tone,
      vars: {
        '--bg': bg,
        '--chat': chat,
        '--panel': panel,
        '--field': mix(bg, W, 0.03),
        '--raise': mix(bg, W, 0.055),
        '--elevated': elevated,
        '--hover': elevated,
        '--hover-strong': mix(bg, W, 0.105),
        '--pressed': mix(bg, W, 0.13),
        '--selected': mix(bg, '#6e8ef5', 0.14),
        '--line': mix(bg, W, 0.08),
        '--line-strong': mix(bg, W, 0.135),
        '--hairline': 'rgba(255, 255, 255, 0.08)',
        '--code-bg': mix(bg, B, 0.15),
        '--material': alpha(elevated, 0.84),
        '--btn': mix(bg, W, 0.1),
        '--btn-hover': mix(bg, W, 0.13),
        '--btn-border': 'rgba(255, 255, 255, 0.06)',
        '--scroll-thumb': mix(bg, W, 0.12),
        '--scroll-thumb-hover': mix(bg, W, 0.19),
        '--text': text,
        '--text-2': text2,
        '--text-3': text3,
        '--accent-text': '#93b0ff',
        '--danger-text': '#f5a39e',
      },
    };
  }
  const elevated = mix(bg, W, 0.85);
  const [chat, panel] = [mix(bg, W, 0.45), mix(bg, W, 0.25)];
  const [text, text2, text3] = texts('#1d1d20', B, bg, [bg, chat, panel], [0.25, 0.32]);
  const lineStrong = mix(bg, B, 0.14);
  return {
    tone,
    vars: {
      '--bg': bg,
      '--chat': chat,
      '--panel': panel,
      '--field': elevated,
      '--raise': mix(bg, W, 0.3),
      '--elevated': elevated,
      '--hover': mix(bg, B, 0.05),
      '--hover-strong': mix(bg, B, 0.09),
      '--pressed': mix(bg, B, 0.13),
      '--selected': mix(mix(bg, W, 0.45), '#2f5bd9', 0.12),
      '--line': mix(bg, B, 0.07),
      '--line-strong': lineStrong,
      '--hairline': 'rgba(0, 0, 0, 0.1)',
      '--code-bg': mix(bg, W, 0.65),
      '--material': alpha(elevated, 0.84),
      '--btn': elevated,
      '--btn-hover': mix(bg, W, 0.7),
      '--btn-border': lineStrong,
      '--scroll-thumb': mix(bg, B, 0.16),
      '--scroll-thumb-hover': mix(bg, B, 0.26),
      '--text': text,
      '--text-2': text2,
      '--text-3': text3,
      '--accent-text': '#2552c9',
      '--danger-text': '#b52f28',
    },
  };
}
