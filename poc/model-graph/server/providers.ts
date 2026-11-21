import { readCapped } from '../../../src/main/accounts';
import { veniceError } from '../../../src/main/video/venice';
import { videoApiOf } from '../../../src/shared/video';
import { PRESET_IDS, type ModelSpec } from '../shared/capabilities';
import { applyManual, detectModels, type ManualModel } from '../shared/detect';
import type { ProviderInfo } from '../shared/protocol';
import type { Access } from './runners/real';
import { SIM, SIM_MODELS } from './runners/sim';

// The providers of this run of the POC: read from the .env file or typed in the page, kept in memory only.
// A key never leaves this file except towards its provider's address: the page only learns that there is one.

interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  key: string;
  listed: ModelSpec[];
  manual: ManualModel[];
  error: string;
  fromEnv: boolean;
}

/** KEY=value lines; # starts a comment, quotes around a value are dropped. */
export function readEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/** POC_PROVIDER_<n>_NAME / _URL / _KEY, for n from 1 to 9. */
export function providersFromEnv(env: Record<string, string | undefined>): { name: string; baseUrl: string; key: string }[] {
  const out = [];
  for (let n = 1; n <= 9; n++) {
    const baseUrl = env[`POC_PROVIDER_${n}_URL`]?.trim();
    if (baseUrl) out.push({ name: env[`POC_PROVIDER_${n}_NAME`]?.trim() || `Fournisseur ${n}`, baseUrl, key: env[`POC_PROVIDER_${n}_KEY`]?.trim() ?? '' });
  }
  return out;
}

export class Providers {
  private readonly list: Provider[] = [];

  constructor(private readonly fetchImpl: typeof fetch) {}

  /** Adds a provider and reads its list of models. A list that cannot be read leaves it there, with why. */
  async add(name: string, baseUrl: string, key: string, fromEnv = false): Promise<void> {
    let url: URL;
    try {
      url = new URL(baseUrl.trim());
    } catch {
      throw new Error('Adresse invalide : elle s’écrit comme https://api.exemple.com/v1');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Adresse invalide : http ou https seulement.');
    const base = (name.trim() || url.hostname).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'api';
    let id = base === SIM ? `${base}-2` : base;
    for (let i = 2; this.list.some((p) => p.id === id); i++) id = `${base}-${i}`;
    const provider: Provider = { id, name: name.trim() || url.hostname, baseUrl: url.toString().replace(/\/+$/, ''), key: key.trim(), listed: [], manual: [], error: '', fromEnv };
    this.list.push(provider);
    await this.refresh(provider);
  }

  private async refresh(p: Provider): Promise<void> {
    try {
      // Venice lists only its text models unless every type is asked for.
      const res = await this.fetchImpl(`${p.baseUrl}/models${videoApiOf(p.baseUrl) === 'venice' ? '?type=all' : ''}`, {
        headers: p.key ? { authorization: `Bearer ${p.key}` } : {},
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      const text = await readCapped(res, 16 * 1024 * 1024);
      if (!res.ok) throw new Error(`${res.status} : ${veniceError(text, p.key) || 'sans explication'}`);
      p.listed = detectModels(p.id, JSON.parse(text));
      p.error = p.listed.length ? '' : 'la liste est vide : déclare les modèles à la main';
    } catch (err) {
      p.listed = [];
      const why = err instanceof Error ? err.message : String(err);
      p.error = `liste des modèles illisible (${p.key ? why.split(p.key).join('••••') : why}) : déclare les modèles à la main`;
    }
  }

  remove(id: string): void {
    const at = this.list.findIndex((p) => p.id === id);
    if (at >= 0) this.list.splice(at, 1);
  }

  /** The user says what a model takes and gives: it replaces what the list said, or adds a model the list lacks. */
  declare(id: string, manual: ManualModel): void {
    const p = this.list.find((x) => x.id === id);
    if (!p) throw new Error('Fournisseur inconnu.');
    const model = manual.model.trim();
    if (!model || model.length > 200) throw new Error('Nom de modèle invalide.');
    if (!PRESET_IDS.includes(manual.preset)) throw new Error('Type de modèle inconnu.');
    p.manual = [...p.manual.filter((m) => m.model.toLowerCase() !== model.toLowerCase()), { model, preset: manual.preset, ...(manual.maxImages ? { maxImages: manual.maxImages } : {}) }];
  }

  models(): ModelSpec[] {
    return [...SIM_MODELS, ...this.list.flatMap((p) => applyManual(p.id, p.listed, p.manual))];
  }

  /** What a real call needs; null for the simulated provider or one that is gone. */
  access(id: string): Access | null {
    const p = this.list.find((x) => x.id === id);
    return p ? { baseUrl: p.baseUrl, key: p.key, fetch: this.fetchImpl } : null;
  }

  info(): ProviderInfo[] {
    return this.list.map((p) => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, hasKey: p.key !== '', error: p.error, models: applyManual(p.id, p.listed, p.manual).length, manual: p.manual, fromEnv: p.fromEnv }));
  }
}
