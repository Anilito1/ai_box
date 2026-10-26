import type { AccountKind } from './types';

// Providers that need no code, only an address: the settings pre-fill an account from one of these. Data, not logic:
// a provider missing here is added by typing its address (kind "OpenAI or compatible" or "Anthropic-compatible").

export interface Preset {
  id: string;
  label: string;
  kind: Extract<AccountKind, 'openai' | 'anthropic-compatible'>;
  baseUrl: string;
  /** Suggested models; empty = the server picks (an Anthropic-compatible server maps Claude's names itself). */
  model: string;
  smallModel: string;
  /** Where to create an API key. */
  keyUrl: string;
}

export const PRESETS: Preset[] = [
  // DeepSeek's endpoint speaks Anthropic's Messages API: Claude Code runs on it as it is, and DeepSeek maps the
  // names that start with "claude" (opus → deepseek-v4-pro, sonnet and haiku → the flash model).
  { id: 'deepseek', label: 'DeepSeek', kind: 'anthropic-compatible', baseUrl: 'https://api.deepseek.com/anthropic', model: '', smallModel: '', keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'openai', label: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: '', smallModel: '', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'openrouter', label: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: '', smallModel: '', keyUrl: 'https://openrouter.ai/keys' },
  { id: 'groq', label: 'Groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', model: '', smallModel: '', keyUrl: 'https://console.groq.com/keys' },
  { id: 'mistral', label: 'Mistral', kind: 'openai', baseUrl: 'https://api.mistral.ai/v1', model: '', smallModel: '', keyUrl: 'https://console.mistral.ai/api-keys' },
  { id: 'ollama', label: 'Ollama (local)', kind: 'openai', baseUrl: 'http://localhost:11434/v1', model: '', smallModel: '', keyUrl: '' },
  { id: 'lmstudio', label: 'LM Studio (local)', kind: 'openai', baseUrl: 'http://localhost:1234/v1', model: '', smallModel: '', keyUrl: '' },
];

export const presetsOf = (kind: AccountKind): Preset[] => PRESETS.filter((p) => p.kind === kind);
