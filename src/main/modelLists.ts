import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/** Addresses kept, the most recently listed first. */
const KEEP = 20;
const MODELS_MAX = 1000;

export interface KeptList {
  at: number;
  models: string[];
}

/** An address as the lists are kept by: its case and trailing slashes do not count. */
export const listKey = (baseUrl: string) => baseUrl.trim().replace(/\/+$/, '').toLowerCase();

const isKept = (v: unknown): v is KeptList => {
  const o = v as KeptList;
  return !!o && typeof o.at === 'number' && Array.isArray(o.models) && o.models.every((m) => typeof m === 'string' && m.length <= 200);
};

/**
 * The text models each address of a provider the user added listed last (its "Get the list"), kept across starts:
 * its form shows them at once and asks again only once they are a day old. Never a key, only model ids.
 */
export class ModelLists {
  private lists: Record<string, KeptList> = {};

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {
    try {
      if (!existsSync(file)) return;
      const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      if (raw && typeof raw === 'object') this.lists = Object.fromEntries(Object.entries(raw).filter(([, v]) => isKept(v)).slice(0, KEEP)) as Record<string, KeptList>;
    } catch {
      // Unreadable: the lists are asked for again.
    }
  }

  get(baseUrl: string): KeptList | null {
    return this.lists[listKey(baseUrl)] ?? null;
  }

  set(baseUrl: string, models: string[]): void {
    const kept = { at: this.now(), models: models.slice(0, MODELS_MAX) };
    const others = Object.entries(this.lists).filter(([k]) => k !== listKey(baseUrl));
    others.sort((a, b) => b[1].at - a[1].at);
    this.lists = Object.fromEntries([[listKey(baseUrl), kept], ...others.slice(0, KEEP - 1)]);
    try {
      writeFileSync(`${this.file}.tmp`, JSON.stringify(this.lists));
      renameSync(`${this.file}.tmp`, this.file);
    } catch {
      // Kept for this run only.
    }
  }
}
