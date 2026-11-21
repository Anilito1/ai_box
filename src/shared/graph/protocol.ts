import type { ModelSpec } from '../modelCaps';
import type { NodeState, RunState, Turn } from './engine';
import type { Graph } from './format';
import type { Issue } from './validate';

// What the Graphs view and the main process say to each other. The view never holds a key nor a file path: a medium
// a run made is named by its run and its file name, and fetched when it is shown.

export interface GraphInfo {
  id: string;
  name: string;
  /** Last change, ms since the epoch. */
  updatedAt: number;
}

export interface GraphListing {
  graphs: GraphInfo[];
  /** The examples a new graph can start from. */
  examples: { id: string; name: string }[];
}

/** A graph's providers and models: the simulated one first, then the accounts whose API the hub can call. */
export interface GraphCatalogView {
  providers: { id: string; name: string }[];
  models: ModelSpec[];
}

/** What a run may cost: a cap that is always on, and whether a call of unknown price is refused. */
export interface GraphPrefs {
  maxUsd: number;
  refuseUnknownPrice: boolean;
}
export const GRAPH_PREFS_DEFAULT: GraphPrefs = { maxUsd: 1, refuseUnknownPrice: false };
export const GRAPH_MAX_USD_LIMIT = 100;

/** How a new graph starts: empty (the chat's two ends), from an example, or as a copy of another. */
export type GraphSeed = { blank: true } | { example: string } | { copy: string };

export interface GraphRunRequest {
  graph: Graph;
  text: string;
  images: { mime: string; data: Uint8Array }[];
  history: Turn[];
  maxUsd: number;
}

/** A value as the view gets it: a medium is a file of the run, fetched apart. */
export type ClientValue = { type: 'text'; text: string } | { type: 'image' | 'video' | 'audio'; mime: string; file: string; size: number; label?: string };

export type GraphRunEvent =
  | { type: 'run'; state: RunState; order?: string[]; error?: string; issues?: Issue[]; costUsd: number }
  | { type: 'node'; id: string; state: NodeState; progress?: string; outputs?: Record<string, ClientValue[]>; error?: string; costUsd?: number; ms?: number };

export interface GraphResult {
  ok: boolean;
  /** An error code (the view says it), empty when ok. */
  error: string;
  id?: string;
}
