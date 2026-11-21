import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { HarnessId } from '../../shared/types';
import { addUsage, tokenCount, type Usage } from '../../shared/costs';

/** USD per million tokens: input, output, cache read (else the input's), cache written (else the input's). */
export type Rate = readonly [input: number, output: number, cacheRead?: number, cacheWrite?: number];

// USD / million tokens, standard API text rates checked 2026-11-03.
// https://developers.openai.com/api/docs/pricing
// https://ai.google.dev/gemini-api/docs/pricing
// Estimates, not subscription invoices. Unknown models deliberately have no guessed rate.
const RATES: Record<string, [number, number, number]> = {
  'gpt-6-astra': [10, 50, 1],
  'gpt-6.1-sol': [2, 10, .1],
  'gpt-6.1-terra': [1, 5, .05],
  'gpt-6-luna': [.1, .5, .01],
  'gpt-5.3-codex': [1.75, 14, .175],
  'gpt-5.2-codex': [1.75, 14, .175],
  'gemini-2.5-flash': [.3, 2.5, .03],
  'gemini-2.5-pro': [1.25, 10, .125],
  'gemini-3.1-pro-preview': [2, 12, .2],
  'gemini-3.1-pro-preview-customtools': [2, 12, .2],
  'gemini-3-flash-preview': [.5, 3, .05],
};

export function estimateUsage(model: string, tokens: Omit<Usage, 'cost'>, promptTokens = tokens.input + tokens.cacheRead): Usage {
  let rate = Object.hasOwn(RATES, model) ? RATES[model] : undefined;
  if (promptTokens > 200_000) {
    if (model === 'gemini-2.5-pro') rate = [2.5, 15, .25];
    if (model === 'gemini-3.1-pro-preview' || model === 'gemini-3.1-pro-preview-customtools') rate = [4, 18, .4];
  }
  const cost = rate ? (tokens.input * rate[0] + tokens.output * rate[1] + tokens.cacheRead * rate[2]) / 1_000_000 : 0;
  return { ...tokens, cost };
}

// DeepSeek, USD / million tokens at peak hours (cache hit, cache miss, output), checked 2026-11-21:
// https://api-docs.deepseek.com/quick_start/pricing — off-peak is half. A cache write is a miss.
const DEEPSEEK: Record<string, Rate> = {
  'deepseek-v4-pro': [1.32, 3.96, 0.044],
  'deepseek-flash': [0.3, 1.2, 0.006],
  // Retired, answered by the Flash model at its price.
  'deepseek-v4-flash': [0.3, 1.2, 0.006],
};

/** DeepSeek's peak hours: 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday (its Chinese public holidays are not known here). */
export function deepseekPeak(at: number): boolean {
  const d = new Date(at);
  const day = d.getUTCDay();
  const h = d.getUTCHours();
  return day >= 1 && day <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10));
}

/** The model of DeepSeek's that answered a Claude name: its Anthropic endpoint gives claude-opus… to V4 Pro, any other claude… to Flash. */
export const deepseekModelOf = (model: string): string => (!/^claude/i.test(model) ? model : /^claude-opus/i.test(model) ? 'deepseek-v4-pro' : 'deepseek-flash');

const own = <T>(table: Record<string, T>, key: string): T | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);

/** A price the hub keeps itself, for the providers whose list gives none (OpenAI, Gemini, DeepSeek); `at` picks DeepSeek's hours. */
export function builtinRate(provider: string, model: string, at: number): Rate | undefined {
  if (provider === 'openai' || provider === 'gemini') return own(RATES, model);
  if (provider !== 'deepseek') return undefined;
  const r = own(DEEPSEEK, model);
  return r && !deepseekPeak(at) ? (r.map((v) => (v === undefined ? v : v / 2)) as unknown as Rate) : r;
}

const usd = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
};
/** A price per token as a price per million, without the float's tail (0.00000012 → 0.12). */
const perMillion = (v: unknown) => {
  const n = usd(v);
  return n === undefined ? undefined : Number((n * 1_000_000).toPrecision(12));
};

/**
 * The prices a model list gives, by model: Venice's (`model_spec.pricing`, USD per million, `{ usd }` each) or
 * OpenRouter's (`pricing`, USD per token, as strings; "-1" for a router whose price depends on the model it picks). A
 * list that gives none, or one in another shape, gives nothing: its models have no known price.
 */
export function listedRates(data: unknown): Record<string, Rate> {
  const out: Record<string, Rate> = {};
  for (const raw of Array.isArray(data) ? data : []) {
    const m = (raw ?? {}) as { id?: unknown; model_spec?: { pricing?: Record<string, { usd?: unknown } | undefined> }; pricing?: Record<string, unknown> };
    if (typeof m.id !== 'string' || !m.id) continue;
    const venice = m.model_spec?.pricing;
    const or = m.pricing;
    let rate: (number | undefined)[] | null = null;
    if (venice && typeof venice === 'object') rate = [usd(venice.input?.usd), usd(venice.output?.usd), usd(venice.cache_input?.usd), usd(venice.cache_write?.usd)];
    else if (or && typeof or === 'object') rate = [perMillion(or.prompt), perMillion(or.completion), perMillion(or.input_cache_read), perMillion(or.input_cache_write)];
    if (!rate || rate[0] === undefined || rate[1] === undefined) continue;
    const [input, output, cacheRead, cacheWrite] = rate as [number, number, number | undefined, number | undefined];
    out[m.id] = cacheWrite !== undefined ? [input, output, cacheRead ?? input, cacheWrite] : cacheRead !== undefined ? [input, output, cacheRead] : [input, output];
  }
  return out;
}

/** What tokens cost at a rate; a cache read or write without a price of its own costs the input's. */
export const costAt = (u: Omit<Usage, 'cost'>, r: Rate) => (u.input * r[0] + u.output * r[1] + u.cacheRead * (r[2] ?? r[0]) + u.cacheWrite * (r[3] ?? r[0])) / 1_000_000;

export interface PricedTurn {
  models: Record<string, Usage>;
  /** Models whose price at the provider is not known: their cost is 0, not a price. */
  unpriced: string[];
}

/**
 * What a turn cost at its provider. Claude Code prices each model at Anthropic's rates, and one it does not know (a
 * DeepSeek, Venice or OpenAI model) at those of its default model: its figure stands for Anthropic only. Codex and
 * Gemini price their own turns (estimateUsage). Anywhere else each model's tokens are priced at the provider's rate,
 * under the name the provider gave it (DeepSeek answers Claude's names with its own models); a model without a rate
 * is unpriced.
 */
export function priceTurn(provider: string, harness: HarnessId, models: Record<string, Usage>, rate: (model: string) => Rate | undefined): PricedTurn {
  const priced = (model: string, u: Usage) => tokenCount(u) === 0 || rate(model) !== undefined;
  if (provider === 'anthropic') return { models, unpriced: [] };
  if (harness !== 'claude') return { models, unpriced: Object.entries(models).filter(([m, u]) => !priced(m, u)).map(([m]) => m) };
  const out: Record<string, Usage> = {};
  for (const [asked, u] of Object.entries(models)) {
    const model = provider === 'deepseek' ? deepseekModelOf(asked) : asked;
    const r = rate(model);
    const spent = { ...u, cost: r ? costAt(u, r) : 0 };
    out[model] = out[model] ? addUsage(out[model], spent) : spent;
  }
  return { models: out, unpriced: Object.entries(out).filter(([m, u]) => !priced(m, u)).map(([m]) => m) };
}

const isRate = (v: unknown): v is Rate => Array.isArray(v) && v.length >= 2 && v.length <= 4 && v.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0);

/**
 * The prices the providers' model lists gave, by provider, kept in a file so that a turn ending before the next
 * reading (at start, the provider not checked yet) is priced all the same.
 */
export class PriceBook {
  private book: Record<string, Record<string, Rate>> = {};

  constructor(private readonly file: string) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> | null;
      for (const [provider, rates] of Object.entries(raw ?? {})) {
        if (!rates || typeof rates !== 'object') continue;
        const kept = Object.fromEntries(Object.entries(rates as Record<string, unknown>).filter(([, r]) => isRate(r))) as Record<string, Rate>;
        if (Object.keys(kept).length > 0) this.book[provider] = kept;
      }
    } catch {
      // None yet, or unreadable: the next readings fill it.
    }
  }

  /** A provider's list as read now replaces the one before; a list that gives no price changes nothing. */
  set(provider: string, rates: Record<string, Rate>): void {
    if (!provider || Object.keys(rates).length === 0 || JSON.stringify(this.book[provider]) === JSON.stringify(rates)) return;
    this.book[provider] = rates;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.book));
    } catch {
      // Not written: kept for this run, read again from the provider at the next start.
    }
  }

  /** A model's price at a provider: its list's, else the one the hub keeps. */
  rate(provider: string, model: string, at = Date.now()): Rate | undefined {
    const listed = own(this.book, provider);
    return (listed ? own(listed, model) : undefined) ?? builtinRate(provider, model, at);
  }
}
