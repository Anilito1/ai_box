/** Where the search models run: `auto` takes the graphics card when it has room for them, the processor otherwise. */
export type SearchDevice = 'auto' | 'gpu' | 'cpu';
export const SEARCH_DEVICES: SearchDevice[] = ['auto', 'gpu', 'cpu'];

export interface SearchSettings {
  /** Off by default: nothing is downloaded, read or computed until the user turns it on. */
  enabled: boolean;
  /** Minutes without a search after which the models leave memory. */
  idleMinutes: number;
  device: SearchDevice;
  /** Roots of the repos the user lets the hub index; their worktrees go with them. */
  repos: string[];
  /** Tokens a `search_code` answer may take unless the agent asks otherwise. */
  budget: number;
}

export const SEARCH_DEFAULTS: SearchSettings = { enabled: false, idleMinutes: 5, device: 'auto', repos: [], budget: 1500 };
export const SEARCH_IDLE_MIN = 1;
export const SEARCH_IDLE_MAX = 120;
export const SEARCH_BUDGET_MIN = 300;
export const SEARCH_BUDGET_MAX = 8000;
export const SEARCH_REPOS_MAX = 40;

export interface SearchRepoState {
  path: string;
  files: number;
  chunks: number;
  /** Chunks that have their vector: under `chunks` while the index is being built. */
  vectors: number;
  /** A build or an update is running. */
  indexing: boolean;
  error: string;
}

/** What the settings show: read from the index files and the running processes, never assumed. */
export interface SearchState {
  /** The engine and the models are on this machine. */
  installed: boolean;
  /** What is being fetched, with its progress in bytes; null when nothing is. */
  installing: { step: string; done: number; total: number } | null;
  error: string;
  /** The models in memory right now, and where. */
  loaded: { embed: boolean; rerank: boolean; gpu: boolean };
  /** Megabytes the install takes or will take on disk. */
  sizeMb: number;
  models: string[];
  repos: SearchRepoState[];
}
