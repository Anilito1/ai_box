// Which models of a provider's catalog are shown first. No list by provider: a model is "recent" when no model of its
// own family (Opus, Sonnet, GPT, GPT mini, Gemini Pro, Flash…) has a higher version; the rest wait behind "See more".

interface Named {
  value: string;
  label: string;
}

const NOISE = /\([^)]*\)|\[[^\]]*\]/g;
const VERSION = /\d+(?:\.\d+)*/;
const TAGS = /\b(preview|latest|exp|experimental)\b/g;

/** The family and version of a model, read from its name ("Opus 5.5", "gpt-5.4-mini", "gemini-3-pro-preview"). */
export function modelIdentity(m: Named): { family: string; version: number[] } {
  const text = [m.label, m.value].map((s) => s.replace(NOISE, ' ')).find((s) => VERSION.test(s)) ?? m.label.replace(NOISE, ' ');
  const found = VERSION.exec(text)?.[0];
  const family = text
    .replace(VERSION, ' ')
    .toLowerCase()
    .replace(TAGS, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return { family: family || m.value.toLowerCase(), version: found ? found.split('.').map(Number) : [] };
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * The models to show first and the older ones. The default choice, a model with no version and the `keep` model (the one
 * in use) are always among the first.
 */
export function splitRecent<T extends Named>(models: T[], keep = ''): { recent: T[]; older: T[] } {
  const ids = models.map((m) => modelIdentity(m));
  const newest = new Map<string, number[]>();
  for (const { family, version } of ids) {
    const best = newest.get(family);
    if (!best || compare(version, best) > 0) newest.set(family, version);
  }
  const recent: T[] = [];
  const older: T[] = [];
  models.forEach((m, i) => {
    const current = m.value === 'default' || m.value === keep || compare(ids[i].version, newest.get(ids[i].family) ?? []) >= 0;
    (current ? recent : older).push(m);
  });
  return { recent, older };
}
