import { ACCOUNT_KINDS, type Account, type AccountKind, type HarnessId } from './types';

// Accounts sessions can run on: checks shared by the settings screen and the main process. No Node and no DOM.

/** The Claude access of Settings › Claude: always there, never stored in the account list. */
export const DEFAULT_ACCOUNT = 'default';
export const ACCOUNTS_MAX = 20;
export const ACCOUNT_ID = /^a-[a-z0-9]{8}$/;
export const ACCOUNT_LIMITS = { name: 40, baseUrl: 300, model: 120 } as const;
/** OpenAI's own API: the server of an OpenAI account unless the user names another. */
export const OPENAI_URL = 'https://api.openai.com/v1';
/** A model as OpenAI and compatible servers write it ("gpt-5", "openai/gpt-5", "qwen2.5-coder:14b"); never a leading dash. */
const MODEL = /^\w[\w.:/@+-]{0,119}$/;
const URL_RE = /^https?:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/i;

export const isAccountRef = (v: unknown): v is string => typeof v === 'string' && (v === DEFAULT_ACCOUNT || ACCOUNT_ID.test(v));
/** The account runs Claude models: Claude Code talks to Anthropic itself, no bridge in between. */
export const runsClaude = (kind: AccountKind | 'default') => kind !== 'openai' && kind !== 'codex';
/** The account has a server address of its own, and models to name. */
export const hasServer = (kind: AccountKind | 'default') => kind === 'openai' || kind === 'anthropic-compatible';
/** Its sessions run one model of the account's, whatever model is asked for. An Anthropic-compatible account without one leaves Claude's names to its server. */
export const pinsModel = (a: Pick<Account, 'kind' | 'model'>) => a.kind === 'openai' || (a.kind === 'anthropic-compatible' && a.model !== '');
/** The program that runs the sessions of an account. */
export const harnessOf = (kind: AccountKind | 'default'): HarnessId => (kind === 'codex' ? 'codex' : 'claude');
/** A server on this computer (LM Studio, llama.cpp, Ollama…): it usually needs no key. */
export const isLocalUrl = (url: string) => /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(url);
/** OpenAI's own API names the output limit max_completion_tokens; most compatible servers, max_tokens. */
export const isOpenAIHost = (url: string) => /^https:\/\/api\.openai\.com(\/|$)/i.test(url);

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** An account as the user typed it, trimmed; wrong types become empty values, an unknown kind a Claude account. */
export function normalizeAccount(raw: unknown): Account {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const kind = ACCOUNT_KINDS.includes(o.kind as AccountKind) ? (o.kind as AccountKind) : 'claude';
  const server = hasServer(kind);
  return {
    id: str(o.id),
    kind,
    name: str(o.name).trim().replace(/\s+/g, ' '),
    baseUrl: server ? str(o.baseUrl).trim().replace(/\/+$/, '') || (kind === 'openai' ? OPENAI_URL : '') : '',
    model: server ? str(o.model).trim() : '',
    smallModel: server ? str(o.smallModel).trim() : '',
    isolated: kind === 'codex' && o.isolated === true,
  };
}

export type AccountField = 'name' | 'baseUrl' | 'model' | 'smallModel' | 'key' | 'accounts';
export type AccountProblem = 'required' | 'tooLong' | 'format' | 'taken' | 'tooMany' | 'reserved';
export interface AccountError {
  field: AccountField;
  problem: AccountProblem;
}

/** First problem of a normalized account among the others, or null. Its key is checked apart (main process). */
export function checkAccount(a: Account, others: Account[]): AccountError | null {
  const fail = (field: AccountField, problem: AccountProblem): AccountError => ({ field, problem });
  const rest = others.filter((o) => o.id !== a.id || !a.id);
  if (!a.id && rest.length >= ACCOUNTS_MAX) return fail('accounts', 'tooMany');
  if (!a.name) return fail('name', 'required');
  if (a.name.length > ACCOUNT_LIMITS.name) return fail('name', 'tooLong');
  // The master and the commands name accounts: "default" is the Claude access of Settings › Claude.
  if (a.name.toLowerCase() === DEFAULT_ACCOUNT) return fail('name', 'reserved');
  if (rest.some((o) => o.name.toLowerCase() === a.name.toLowerCase())) return fail('name', 'taken');
  if (!hasServer(a.kind)) return null;
  if (a.baseUrl.length > ACCOUNT_LIMITS.baseUrl || !URL_RE.test(a.baseUrl)) return fail('baseUrl', 'format');
  // An Anthropic-compatible server maps Claude's names itself: a model is optional there.
  if (!a.model && a.kind === 'openai') return fail('model', 'required');
  if (a.model && !MODEL.test(a.model)) return fail('model', 'format');
  if (a.smallModel && !MODEL.test(a.smallModel)) return fail('smallModel', 'format');
  return null;
}

/** An account by id or by name (any case), as the master or a command writes it; "default" for the usual access. */
export function findAccount(accounts: Account[], ref: string): Account | typeof DEFAULT_ACCOUNT | null {
  const r = ref.trim().toLowerCase();
  if (!r) return null;
  if (r === DEFAULT_ACCOUNT) return DEFAULT_ACCOUNT;
  return accounts.find((a) => a.id === r || a.name.toLowerCase() === r) ?? null;
}

/** The first of these accounts that still exists, else "default". */
export function firstAccount(accounts: Account[], ...refs: (string | null | undefined)[]): string {
  for (const ref of refs) if (ref && (ref === DEFAULT_ACCOUNT || accounts.some((a) => a.id === ref))) return ref;
  return DEFAULT_ACCOUNT;
}
