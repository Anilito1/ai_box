import { APP_NAME } from './brand';

export const LANGS = ['en', 'fr'] as const;
export type Lang = (typeof LANGS)[number];
export const LANG_NAMES: Record<Lang, string> = { en: 'English', fr: 'Français' };

export const isLang = (v: unknown): v is Lang => LANGS.includes(v as Lang);

export type Params = Record<string, string | number>;

/** Replaces each `{name}` with its value (`{app}`: the product's name); an unknown name stays as is. */
export const fill = (text: string, params: Params = {}): string => {
  const values: Params = { app: APP_NAME, ...params };
  return text.replace(/\{(\w+)\}/g, (m, key: string) => (key in values ? String(values[key]) : m));
};

/**
 * `t(key, params)` over one dictionary per language; `tn(key, n)` picks `key_one` or `key_other` and passes `{n}`.
 * Every language must define every key of the English one: the type checks it.
 */
export function translator<K extends string>(dicts: Record<Lang, Record<K, string>>, lang: () => Lang) {
  const t = (key: K, params?: Params) => fill(dicts[lang()][key] ?? dicts.en[key] ?? key, params);
  // The language's own rule: 0 takes the singular in French, the plural in English.
  const rules = new Map<Lang, Intl.PluralRules>();
  const plural = (n: number) => {
    const l = lang();
    if (!rules.has(l)) rules.set(l, new Intl.PluralRules(l));
    return (rules.get(l) as Intl.PluralRules).select(n) === 'one' ? 'one' : 'other';
  };
  const tn = (key: string, n: number, params: Params = {}) => t(`${key}_${plural(n)}` as K, { n, ...params });
  return { t, tn };
}
