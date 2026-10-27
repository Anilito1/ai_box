import { DEFAULT_ACCOUNT, OPENAI_URL } from './accounts';
import type { Account, AccountKind } from './types';

// The providers the user sees: one block each in Settings › Accounts, one choice each in the composer and the post
// editor. Under a provider there is an account of the hub (what sessions actually run on): the user never sees it.
// To add a provider (a local model, say), add an entry here, a way to connect it in main/providers.ts, and its card.

export type ProviderId = 'anthropic' | 'openai' | 'deepseek' | 'gemini';
/** How a provider is connected: its program's own sign-in (`cli`, `chatgpt`, `google`), or an API key. */
export type ProviderMethod = 'cli' | 'chatgpt' | 'google' | 'apikey';

export interface ProviderDef {
  id: ProviderId;
  label: string;
  /** In the order the card offers them; the first is the one shown first. */
  methods: ProviderMethod[];
  /** Where to create an API key, for the methods that take one. */
  keyUrl: string;
}

export const PROVIDER_DEFS: ProviderDef[] = [
  { id: 'anthropic', label: 'Anthropic', methods: ['cli', 'apikey'], keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'openai', label: 'OpenAI', methods: ['chatgpt', 'apikey'], keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'deepseek', label: 'DeepSeek', methods: ['apikey'], keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'gemini', label: 'Gemini', methods: ['google', 'apikey'], keyUrl: 'https://aistudio.google.com/apikey' },
];

export const PROVIDER_IDS: ProviderId[] = PROVIDER_DEFS.map((p) => p.id);
export const isProviderId = (v: unknown): v is ProviderId => typeof v === 'string' && (PROVIDER_IDS as string[]).includes(v);
export const providerDef = (id: ProviderId): ProviderDef => PROVIDER_DEFS.find((p) => p.id === id) as ProviderDef;

/** The names of the accounts the hub makes for a provider; the user does not choose them. */
export const MANAGED_NAMES = { chatgpt: 'OpenAI (ChatGPT)', openaiKey: 'OpenAI (API)', deepseek: 'DeepSeek', google: 'Gemini (Google)', geminiKey: 'Gemini (API)' } as const;
export const DEEPSEEK_URL = 'https://api.deepseek.com/anthropic';

const host = (url: string) => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
};

/** The provider an account belongs to, null for an account none of the blocks stands for (an older, hand-made one). */
export function providerOfAccount(a: (Pick<Account, 'kind' | 'baseUrl'> & Partial<Pick<Account, 'slug'>>) | typeof DEFAULT_ACCOUNT | 'own'): string | null {
  if (typeof a === 'string') return 'anthropic';
  const kind: AccountKind = a.kind;
  if (kind === 'claude' || kind === 'anthropic-key') return 'anthropic';
  if (kind === 'codex') return 'openai';
  if (kind === 'gemini' || kind === 'gemini-key') return 'gemini';
  if (kind === 'openai') return a.slug || (host(a.baseUrl) === host(OPENAI_URL) ? 'openai' : null);
  return host(a.baseUrl) === host(DEEPSEEK_URL) ? 'deepseek' : null;
}

/** An account that stands for a provider the user added (any OpenAI-compatible server), reached through the bridge. */
export const isCustomAccount = (a: Pick<Account, 'kind' | 'slug'>) => a.kind === 'openai' && a.slug !== '';

/** The method an account of a provider stands for. */
export function methodOfAccount(a: Pick<Account, 'kind'> | typeof DEFAULT_ACCOUNT | 'own'): ProviderMethod {
  if (typeof a === 'string') return 'cli';
  return a.kind === 'codex' ? 'chatgpt' : a.kind === 'gemini' ? 'google' : a.kind === 'claude' ? 'cli' : 'apikey';
}

/**
 * DeepSeek's endpoint speaks Anthropic's API and maps the model names that start with "claude" to its own: Claude
 * Code is asked for an alias and DeepSeek answers with the model behind it.
 */
export interface FixedModel {
  value: string;
  label: string;
  description: string;
  /** What Claude Code is asked for. */
  alias: string;
}
export const DEEPSEEK_MODELS: FixedModel[] = [
  { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', description: 'The strongest: hard problems, long work.', alias: 'opus' },
  { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', description: 'Fast and cheap: simple tasks.', alias: 'sonnet' },
];

/** Claude Code's name for a model of DeepSeek; a name that is not one of DeepSeek's passes as it is. */
export const deepseekAlias = (model: string): string => DEEPSEEK_MODELS.find((m) => m.value === model)?.alias ?? model;

export interface ProviderState {
  connected: boolean;
  /** The account sessions of this provider run on. */
  accountId: string;
  method: ProviderMethod | '';
}

/**
 * The account a provider's sessions run on, or why there is none: `unknown` provider, `disconnected`. A provider that
 * has not been checked yet is not connected, except Anthropic, whose usual access is there from the start.
 */
export function resolveProvider(states: Record<string, ProviderState>, id: unknown): { account: string } | { error: 'unknown' | 'disconnected' } {
  const key = typeof id === 'string' ? id.trim().toLowerCase() : '';
  const alias: Record<string, ProviderId> = { claude: 'anthropic', codex: 'openai', chatgpt: 'openai', google: 'gemini' };
  // A provider the user added is known by the state the main process gave it.
  const provider = isProviderId(key) ? key : Object.hasOwn(alias, key) ? alias[key] : Object.hasOwn(states, key) ? key : undefined;
  if (!provider) return { error: 'unknown' };
  const state = states[provider] ?? (provider === 'anthropic' ? { connected: true, accountId: DEFAULT_ACCOUNT, method: 'cli' as const } : null);
  return state?.connected && state.accountId ? { account: state.accountId } : { error: 'disconnected' };
}

/** The model OpenAI's API gets by default: a recent general model, else the first chat model there is. */
export function pickOpenAIModel(ids: string[]): string {
  const chat = chatModels(ids);
  const preferred = ['gpt-5.5', 'gpt-5.4', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'gpt-4.1', 'gpt-4o'];
  return preferred.find((m) => chat.includes(m)) ?? chat.find((m) => /^gpt-\d/.test(m) && !/mini|nano/.test(m)) ?? chat[0] ?? '';
}

/** The models of an OpenAI-style list that write text and call tools (not embeddings, images, audio, moderation). */
export function chatModels(ids: string[]): string[] {
  return ids.filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !/embed|image|audio|realtime|tts|whisper|transcribe|moderation|search|instruct|dall|codex-mini-latest|-\d{4}-\d{2}-\d{2}$/.test(id));
}
