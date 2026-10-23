import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Effort } from '../shared/types';

export interface HubConfig {
  /** Claude Code executable; empty = the binary bundled with the Agent SDK. */
  claudePath: string;
  /** Master's folder; also the root scanned by `list_repos`. */
  masterCwd: string;
  /** Empty model/effort = exactly like a normal Claude Code session (settings.json: model, effortLevel). */
  master: { model: string; effort: Effort | '' };
  worker: { model: string; effort: Effort | '' };
  /** Models the master may pick explicitly for a worker (default: inherit). */
  workerModels: string[];
  /** Permission mode of every session at launch; empty = bypassPermissions (nothing waits for a validation). */
  permissionMode: string;
  /** Repos the user mainly works on (folders under masterCwd): known to the master, git state shown in the sidebar. */
  mainRepos: string[];
}

const DEFAULTS: HubConfig = {
  claudePath: '',
  masterCwd: join(homedir(), 'Desktop'),
  master: { model: '', effort: '' },
  worker: { model: '', effort: '' },
  workerModels: ['opus', 'sonnet'],
  permissionMode: '',
  mainRepos: [],
};

export function loadConfig(dataDir: string): HubConfig {
  const file = join(dataDir, 'config.json');
  if (!existsSync(file)) {
    writeFileSync(file, JSON.stringify(DEFAULTS, null, 2));
    return DEFAULTS;
  }
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<HubConfig>;
  return {
    ...DEFAULTS,
    ...raw,
    master: { ...DEFAULTS.master, ...raw.master },
    worker: { ...DEFAULTS.worker, ...raw.worker },
    workerModels: raw.workerModels?.length ? raw.workerModels : DEFAULTS.workerModels,
    mainRepos: raw.mainRepos?.length ? raw.mainRepos : DEFAULTS.mainRepos,
  };
}

/** Absolute folder of a main repo (a bare name resolves under masterCwd). */
export const mainRepoPath = (cfg: HubConfig, repo: string) => resolve(cfg.masterCwd, repo);
