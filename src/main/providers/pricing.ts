import type { Usage } from '../../shared/costs';

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
