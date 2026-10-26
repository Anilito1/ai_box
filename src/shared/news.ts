import type { ProviderId } from './providers';

// What is new at a provider the user connected: a model that can be used now, a newer version of its program. The logic
// here is pure (the main process feeds it with what it read); main/news.ts keeps the memory and the clock.

/** How a program got on this computer, which tells how it is updated. */
export type InstallMethod = 'brew' | 'npm' | 'native' | 'app' | 'unknown';

/** The install offered when a program's own method cannot reach the latest: Anthropic's official installer, the app's copy. */
export type SwitchTarget = 'native' | 'app';

/** A newer version of a provider's program than the one installed. */
export interface CliUpdate {
  /** The program's name (claude, codex, gemini). */
  tool: string;
  current: string;
  latest: string;
  method: InstallMethod;
  /** What to type in a terminal to update it, as its install method does. */
  command: string;
  /** The program as found, links followed: what the one-click update works on. */
  path: string;
  /** The newest version its install method offers, '' when not known (Homebrew's can be behind npm's). */
  reach: string;
  /** Its own method brings it forward (Homebrew may have nothing newer yet). */
  upgrade: boolean;
  /** Offered when its own method cannot reach the latest. */
  switchTo: SwitchTarget | '';
}

/** What is new at a provider: the models not seen before (by name as the menu shows them), the program's update. */
export interface ProviderNews {
  models: string[];
  cli: CliUpdate | null;
  /** Something the user has not looked at yet: the dots show, the models are tagged "New". */
  unseen: boolean;
}

export const NO_NEWS: ProviderNews = { models: [], cli: null, unseen: false };

/** The npm package of each provider's program, and the command name it installs. */
export const CLI_PACKAGES: Partial<Record<ProviderId, { tool: string; npm: string; brew: string }>> = {
  anthropic: { tool: 'claude', npm: '@anthropic-ai/claude-code', brew: 'claude-code' },
  openai: { tool: 'codex', npm: '@openai/codex', brew: 'codex' },
  gemini: { tool: 'gemini', npm: '@google/gemini-cli', brew: 'gemini-cli' },
};

/** The numbers of a version ("2.1.311", "codex-cli 0.163.0-alpha.2" → [0, 163, 0]); empty when it has none. */
export function versionParts(version: string): number[] {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [];
}

/** `latest` is a newer release than `current`; an unreadable version, a pre-release of the same one: no. */
export function isNewer(latest: string, current: string): boolean {
  const a = versionParts(latest);
  const b = versionParts(current);
  if (a.length === 0 || b.length === 0 || /-/.test(latest.trim().split(/\s/)[0])) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** The version a program prints for `--version` ("2.1.287 (Claude Code)", "codex-cli 0.163.0"). */
export const parseVersion = (text: string): string => /\d+\.\d+\.\d+[\w.-]*/.exec(text)?.[0] ?? '';

/** How the program at `path` (resolved: symlinks followed) was installed; `appDir` is the app's own tools folder. */
export function installMethod(path: string, appDir = ''): InstallMethod {
  const p = path.replace(/\\/g, '/');
  if (!p) return 'unknown';
  const dir = appDir.replace(/\\/g, '/').replace(/\/+$/, '');
  if (dir && p.startsWith(`${dir}/`)) return 'app';
  if (/\/(Caskroom|Cellar)\//.test(p)) return 'brew';
  if (/\/\.local\/share\/claude\/|\/\.claude\/local\/|\/AppData\/Local\/(Programs\/)?claude/i.test(p)) return 'native';
  if (/\/node_modules\/|\/\.nvm\/|\/\.volta\/|\/\.npm|\/\.fnm\/|\/npm\/|\/\.bun\//i.test(p)) return 'npm';
  if (/\/\.local\/bin\/claude$/.test(p)) return 'native';
  return 'unknown';
}

/** A Homebrew install read from its path: a cask (Caskroom) or a formula (Cellar), its name, and the brew that owns it. */
export interface BrewPackage {
  kind: 'cask' | 'formula';
  name: string;
  brew: string;
}

export function brewPackage(path: string): BrewPackage | null {
  const m = /^(.*)\/(Caskroom|Cellar)\/([^/]+)\//.exec(path.replace(/\\/g, '/'));
  return m ? { kind: m[2] === 'Caskroom' ? 'cask' : 'formula', name: m[3], brew: `${m[1]}/bin/brew` } : null;
}

/** The command that updates a provider's program, as its install method does it; `path` (resolved) names the brew package. */
export function updateCommand(provider: ProviderId, method: InstallMethod, appDir = '', path = ''): string {
  const pkg = CLI_PACKAGES[provider];
  if (!pkg) return '';
  const brew = brewPackage(path);
  if (method === 'brew' && brew) return brew.kind === 'cask' ? `brew upgrade --cask ${brew.name}` : `brew upgrade ${brew.name}`;
  if (method === 'brew') return provider === 'anthropic' ? `brew upgrade --cask ${pkg.brew}` : `brew upgrade ${pkg.brew}`;
  if (method === 'native' && provider === 'anthropic') return 'claude update';
  if (method === 'app') return `npm install --prefix "${appDir}" ${pkg.npm}@latest`;
  return `npm install -g ${pkg.npm}@latest`;
}

/** What the models of a provider are called in the diff: a concrete id as it is, an alias ("opus") by what it stands for. */
export const modelKey = (m: { value: string; label: string }): string => (/\d/.test(m.value) ? m.value : m.label || m.value);

export type SeenModels = Partial<Record<ProviderId, string[]>>;

/**
 * Compares the models offered now with the ones already seen. A provider with no memory yet is only recorded (no
 * alert at the first launch, nor when a provider is just connected); a provider that is not connected, or whose list
 * is empty (not loaded yet), is left as it was. The memory only grows: a model that goes and comes back is not new.
 */
export function diffModels(seen: SeenModels, offered: Partial<Record<ProviderId, string[]>>, connected: Partial<Record<ProviderId, boolean>>): { seen: SeenModels; fresh: Partial<Record<ProviderId, string[]>> } {
  const next: SeenModels = { ...seen };
  const fresh: Partial<Record<ProviderId, string[]>> = {};
  for (const id of Object.keys(offered) as ProviderId[]) {
    const now = [...new Set(offered[id] ?? [])];
    if (!connected[id] || now.length === 0) continue;
    const before = seen[id];
    if (before) {
      const added = now.filter((m) => !before.includes(m));
      if (added.length > 0) {
        fresh[id] = added;
        next[id] = [...before, ...added];
      }
    } else next[id] = now;
  }
  return { seen: next, fresh };
}

/** What the main process remembers between runs. */
export interface NewsMemory {
  /** Every model ever offered by a provider, by key. */
  seen: SeenModels;
  /** The new ones the user has not looked at yet. */
  pending: Partial<Record<ProviderId, string[]>>;
  /** The program version the user was told about (one toast per version), and the one whose menu line was looked at. */
  toasted: Partial<Record<ProviderId, string>>;
  acked: Partial<Record<ProviderId, string>>;
}

export const emptyMemory = (): NewsMemory => ({ seen: {}, pending: {}, toasted: {}, acked: {} });

/** What one check read: who is connected, the models offered, the update each program has (null: up to date or unknown). */
export interface NewsInput {
  connected: Partial<Record<ProviderId, boolean>>;
  offered: Partial<Record<ProviderId, { value: string; label: string }[]>>;
  cli: Partial<Record<ProviderId, CliUpdate | null>>;
}

/** A discovery to tell the user about, once. */
export interface NewsToast {
  provider: ProviderId;
  /** Names of the new models. */
  models: string[];
  cli: CliUpdate | null;
}

export interface NewsStep {
  memory: NewsMemory;
  news: Partial<Record<ProviderId, ProviderNews>>;
  toasts: NewsToast[];
}

/** One check: what is new for each connected provider, and what has not been told yet. */
export function advance(memory: NewsMemory, input: NewsInput): NewsStep {
  const keys: Partial<Record<ProviderId, string[]>> = {};
  const names = new Map<string, string>();
  for (const id of Object.keys(input.offered) as ProviderId[]) {
    keys[id] = (input.offered[id] ?? []).map((m) => {
      names.set(`${id}:${modelKey(m)}`, m.label || m.value);
      return modelKey(m);
    });
  }
  const { seen, fresh } = diffModels(memory.seen, keys, input.connected);
  const next: NewsMemory = { seen, pending: { ...memory.pending }, toasted: { ...memory.toasted }, acked: { ...memory.acked } };
  const news: Partial<Record<ProviderId, ProviderNews>> = {};
  const toasts: NewsToast[] = [];
  for (const id of Object.keys(input.connected) as ProviderId[]) {
    if (!input.connected[id]) continue;
    next.pending[id] = [...new Set([...(next.pending[id] ?? []), ...(fresh[id] ?? [])])];
    const cli = input.cli[id] ?? null;
    const addedCli = cli && next.toasted[id] !== cli.latest ? cli : null;
    if (addedCli) next.toasted[id] = addedCli.latest;
    if ((fresh[id]?.length ?? 0) > 0 || addedCli) {
      toasts.push({ provider: id, models: (fresh[id] ?? []).map((k) => names.get(`${id}:${k}`) ?? k), cli: addedCli });
    }
    // Only what the menu can still show: a pending model that left the list is dropped.
    const offeredNow = new Set(keys[id] ?? []);
    const pending = (next.pending[id] ?? []).filter((k) => offeredNow.has(k) || offeredNow.size === 0);
    next.pending[id] = pending;
    news[id] = { models: pending, cli, unseen: pending.length > 0 || (!!cli && next.acked[id] !== cli.latest) };
  }
  return { memory: next, news, toasts };
}

/** The user opened the provider's menu (or picked its new model): its models are no longer new. */
export function acknowledge(memory: NewsMemory, provider: ProviderId, cli: CliUpdate | null): NewsMemory {
  const acked = { ...memory.acked };
  if (cli) acked[provider] = cli.latest;
  return { ...memory, pending: { ...memory.pending, [provider]: [] }, acked };
}
