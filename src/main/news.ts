import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brewApiVersion, planUpdate, updateChoice } from '../shared/cliUpdate';
import { acknowledge, advance, brewPackage, CLI_PACKAGES, emptyMemory, installMethod, isNewer, updateCommand, type CliUpdate, type NewsMemory, type NewsToast, type ProviderNews } from '../shared/news';
import type { ProviderId } from '../shared/providers';

// What is new at the providers the user connected: a model the menu can offer now, a newer version of a provider's
// program. The memory (the models already seen) lives in a file of its own; the registry of npm is asked every few hours,
// and a network that fails says nothing.

const FILE = 'provider-news.json';
const REGISTRY_EVERY_MS = 6 * 60 * 60_000;
const REGISTRY_TIMEOUT_MS = 8_000;

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').slice(0, 500) : []);
const record = <T>(v: unknown, pick: (x: unknown) => T): Record<string, T> => Object.fromEntries(Object.entries(obj(v)).map(([k, x]) => [k, pick(x)]));

/** Reads the memory file; anything unreadable starts over (the first check records without telling). */
export function loadMemory(dir: string): NewsMemory {
  try {
    const raw = obj(JSON.parse(readFileSync(join(dir, FILE), 'utf8')));
    const str = (x: unknown) => (typeof x === 'string' ? x : '');
    return { seen: record(raw.seen, strings), pending: record(raw.pending, strings), toasted: record(raw.toasted, str), acked: record(raw.acked, str) };
  } catch {
    return emptyMemory();
  }
}

function saveMemory(dir: string, memory: NewsMemory): void {
  try {
    const tmp = join(dir, `${FILE}.tmp`);
    writeFileSync(tmp, JSON.stringify(memory));
    renameSync(tmp, join(dir, FILE));
  } catch {
    // The memory is a convenience: a failed write only means the news may be told twice.
  }
}

/** The latest published version of an npm package, empty when the registry cannot be reached. */
export async function latestVersion(pkg: string): Promise<string> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}/latest`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
    if (!res.ok) return '';
    const body = obj(await res.json());
    return typeof body.version === 'string' ? body.version : '';
  } catch {
    return '';
  }
}

/** The version Homebrew offers for a cask or a formula (its public API: no brew run), empty when it cannot be told. */
export async function brewVersion(kind: 'cask' | 'formula', name: string): Promise<string> {
  try {
    const res = await fetch(`https://formulae.brew.sh/api/${kind}/${encodeURIComponent(name)}.json`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
    return res.ok ? brewApiVersion(kind, await res.json()) : '';
  } catch {
    return '';
  }
}

/** The program at a path with its links followed (a Homebrew `bin/claude` points into the Caskroom). */
export function resolved(path: string): string {
  try {
    return existsSync(path) ? realpathSync(path) : path;
  } catch {
    return path;
  }
}

export interface NewsDeps {
  /** The folder the memory is kept in, and the app's own tools folder. */
  dataDir: string;
  toolsDir: string;
  /** Tells the session manager (the composer's dots, the menu) and the window (the toast). */
  publish(news: Partial<Record<ProviderId, ProviderNews>>): void;
  notify(toast: NewsToast): void;
}

/** What one check hands over: who is connected, the models they offer, the programs found with their version. */
export interface NewsReading {
  connected: Partial<Record<ProviderId, boolean>>;
  offered: Partial<Record<ProviderId, { value: string; label: string }[]>>;
  programs: Partial<Record<ProviderId, { path: string; version: string }>>;
}

export class ProviderNewsWatch {
  private memory: NewsMemory;
  private latest: Partial<Record<ProviderId, string>> = {};
  private asked = 0;
  /** What Homebrew offers, by "cask/claude-code", asked at the same pace as the registry. */
  private brew = new Map<string, { version: string; at: number }>();
  private programs: NewsReading['programs'] = {};
  private last: { cli: Partial<Record<ProviderId, CliUpdate | null>> } = { cli: {} };
  private lastNews: Partial<Record<ProviderId, ProviderNews>> = {};

  constructor(private readonly deps: NewsDeps) {
    this.memory = loadMemory(deps.dataDir);
  }

  /** The update each program has, from the installed version and the registry's. */
  private async updates(programs: NewsReading['programs'], connected: NewsReading['connected']): Promise<Partial<Record<ProviderId, CliUpdate | null>>> {
    if (Date.now() - this.asked > REGISTRY_EVERY_MS) {
      const ids = (Object.keys(CLI_PACKAGES) as ProviderId[]).filter((id) => connected[id]);
      const found = await Promise.all(ids.map((id) => latestVersion(CLI_PACKAGES[id]?.npm ?? '')));
      // A registry that did not answer for all of them is asked again at the next check.
      ids.forEach((id, i) => {
        if (found[i]) this.latest[id] = found[i];
      });
      if (found.every(Boolean)) this.asked = Date.now();
    }
    const out: Partial<Record<ProviderId, CliUpdate | null>> = {};
    for (const id of Object.keys(CLI_PACKAGES) as ProviderId[]) {
      const prog = programs[id];
      const latest = this.latest[id] ?? '';
      if (!prog || !prog.version || !latest || !isNewer(latest, prog.version)) {
        out[id] = null;
        continue;
      }
      const path = resolved(prog.path);
      const method = installMethod(path, this.deps.toolsDir);
      const reach = method === 'brew' ? await this.brewReach(path) : '';
      const command = updateCommand(id, method, this.deps.toolsDir, path);
      const base = { tool: CLI_PACKAGES[id]?.tool ?? '', current: prog.version, latest, method, command, path, reach, ...updateChoice(id, method, prog.version, latest, reach) };
      // A button only where one click has steps to run (else the command stays to copy).
      const can = (action: 'upgrade' | 'switch') => planUpdate({ provider: id, action, update: base, home: '', tmp: '', npmWritable: true }).length > 0;
      out[id] = { ...base, upgrade: base.upgrade && can('upgrade'), switchTo: base.switchTo && can('switch') ? base.switchTo : '' };
    }
    return out;
  }

  /** The version Homebrew has for the package a program came from; a failed ask is tried again at the next check. */
  private async brewReach(path: string): Promise<string> {
    const pkg = brewPackage(path);
    if (!pkg) return '';
    const key = `${pkg.kind}/${pkg.name}`;
    const known = this.brew.get(key);
    if (known && Date.now() - known.at < REGISTRY_EVERY_MS) return known.version;
    const version = await brewVersion(pkg.kind, pkg.name);
    if (version) this.brew.set(key, { version, at: Date.now() });
    return version || known?.version || '';
  }

  /** The update a provider's program has now (null: up to date or not known). */
  update(provider: ProviderId): CliUpdate | null {
    return this.last.cli[provider] ?? null;
  }

  /** The program found at the last check, with its version. */
  program(provider: ProviderId): { path: string; version: string } | null {
    return this.programs[provider] ?? null;
  }

  async check(reading: NewsReading): Promise<void> {
    this.programs = reading.programs;
    const cli = await this.updates(reading.programs, reading.connected);
    this.last = { cli };
    const step = advance(this.memory, { connected: reading.connected, offered: reading.offered, cli });
    this.memory = step.memory;
    this.lastNews = step.news;
    saveMemory(this.deps.dataDir, this.memory);
    this.deps.publish(step.news);
    for (const toast of step.toasts) this.deps.notify(toast);
  }

  /** The user opened the provider's menu, or picked its new model. */
  acknowledge(provider: ProviderId): void {
    const news = this.lastNews[provider];
    if (!news?.unseen) return;
    this.memory = acknowledge(this.memory, provider, this.last.cli[provider] ?? null);
    this.lastNews = { ...this.lastNews, [provider]: { ...news, models: [], unseen: false } };
    saveMemory(this.deps.dataDir, this.memory);
    this.deps.publish(this.lastNews);
  }
}
