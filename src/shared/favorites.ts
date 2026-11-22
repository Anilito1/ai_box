import { isProviderId } from './providers';
import type { ModelOption, ProviderBadge } from './types';

// The user's favourite models, by provider: starred in Settings › Providers, offered first in each conversation's
// model menu (its Favourites tab), and named to the master. A built-in provider keeps them in the settings
// (favoriteModels); a provider the user added has its chosen models as its favourites. No Node and no DOM.

export const FAVORITES_MAX = 40;
/** A provider's list of models older than this is asked for again when its form opens. */
export const LIST_FRESH_MS = 24 * 3600_000;
/** A model id as the providers write them: Claude's aliases ("opus[1m]"), OpenAI-compatible ones ("openai/gpt-5"). */
const MODEL = /^\w[\w.:/@+[\]-]{0,119}$/;
export const isModelName = (v: unknown): v is string => typeof v === 'string' && MODEL.test(v);

/** The favourites of the built-in providers, as the settings file keeps them. */
export function isFavoriteMap(v: unknown): v is Record<string, string[]> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.entries(v).every(([id, list]) => isProviderId(id) && Array.isArray(list) && list.length <= FAVORITES_MAX && list.every(isModelName) && new Set(list).size === list.length);
}

/** A favourite added (at the end) or taken out; the list is never longer than FAVORITES_MAX. */
export function toggleFavorite(list: string[], model: string, on: boolean): string[] {
  const rest = list.filter((m) => m !== model);
  return on && rest.length < FAVORITES_MAX ? [...rest, model] : rest;
}

export interface FavoriteGroup {
  /** The provider: a built-in one, or the slug of one the user added. */
  id: string;
  label: string;
  models: ModelOption[];
}

/**
 * The favourites of each connected provider, in the order its model list gives them. Before the provider has said
 * its models, a favourite goes by its id; once it has, one it no longer offers is left out.
 */
export function favoriteGroups(providers: ProviderBadge[]): FavoriteGroup[] {
  return providers
    .filter((p) => p.connected && p.favorites.length > 0)
    .map((p) => {
      const listed = p.models.filter((m) => m.value !== 'default');
      const models = listed.length > 0 ? listed.filter((m) => p.favorites.includes(m.value)) : p.favorites.map((value) => ({ value, label: value, description: '', efforts: [] }));
      return { id: p.id, label: p.label, models };
    })
    .filter((g) => g.models.length > 0);
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** The favourites a typed filter keeps: every word of it is in the provider's name, the model's name or its id. */
export function filterFavorites(groups: FavoriteGroup[], query: string): FavoriteGroup[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return groups;
  return groups
    .map((g) => ({ ...g, models: g.models.filter((m) => words.every((w) => fold(`${g.label} ${g.id} ${m.label} ${m.value}`).includes(w))) }))
    .filter((g) => g.models.length > 0);
}

/** A provider as the master reads it: connected or not, the models it may ask for, the user's favourites among them. */
export interface ProviderLine {
  id: string;
  label: string;
  connected: boolean;
  models: string[];
  favorites: string[];
}

/** A provider's models for the master, the user's favourites starred: "opus★, sonnet". */
export const starred = (p: ProviderLine) => p.models.map((m) => (p.favorites.includes(m) ? `${m}★` : m)).join(', ');

/** The models section of list_capabilities: each provider, connected or not, its models, the favourites starred. */
export function modelsText(lines: ProviderLine[]): string {
  if (lines.length === 0) return '';
  const out = ['Models by provider (★ = a favourite of the user). To run a worker on one: provider and model of spawn_worker or message_worker.'];
  for (const p of lines) out.push(`- ${p.id} (${p.label}): ${p.connected ? starred(p) || 'its default model' : 'not connected'}`);
  return out.join('\n');
}
