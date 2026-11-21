import type { ModelSpec, PresetId } from './capabilities';
import type { ManualModel } from './detect';
import type { NodeState, Turn } from './engine';
import type { Graph } from './graph';

// What the POC's page and its local server say to each other. In the hub this is the IPC between the renderer
// and the main process: the page never holds a key or a file, only addresses of what the engine made.

/** A value as the page gets it: a media is an address on the local server, not its bytes. */
export type ClientValue = { type: 'text'; text: string } | { type: 'image' | 'video' | 'audio'; mime: string; url: string; size: number; label?: string };

export type ClientEvent =
  | { type: 'run'; state: 'running' | 'done' | 'error' | 'cancelled'; order?: string[]; error?: string; costUsd: number }
  | { type: 'node'; id: string; state: NodeState; progress?: string; outputs?: Record<string, ClientValue[]>; error?: string; costUsd?: number; ms?: number };

export interface ProviderInfo {
  id: string;
  name: string;
  baseUrl: string;
  hasKey: boolean;
  /** Why its list could not be read; empty when it was. */
  error: string;
  models: number;
  manual: ManualModel[];
  /** Read from the .env file at start. */
  fromEnv: boolean;
}

export interface AppState {
  providers: ProviderInfo[];
  /** The catalog: the simulated models, then every provider's. */
  models: ModelSpec[];
  examples: Graph[];
}

export interface RunRequest {
  graph: Graph;
  text: string;
  images: { mime: string; base64: string }[];
  history: Turn[];
  maxCostUsd?: number;
}

export interface AddProviderRequest {
  name: string;
  baseUrl: string;
  key: string;
}

export interface DeclareRequest {
  model: string;
  preset: PresetId;
  maxImages?: number;
}
