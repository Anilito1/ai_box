import type { ModelSpec } from '../shared/capabilities';
import type { NodeState } from '../shared/engine';
import { catalogOf, parseGraph, serializeGraph, type Graph } from '../shared/graph';
import type { AppState, ClientValue } from '../shared/protocol';

// What the page knows: the catalog, the graph being edited, and where the run in progress is.

/** A node during a run, as the events left it. */
export interface NodeRun {
  state: NodeState;
  progress?: string;
  outputs?: Record<string, ClientValue[]>;
  error?: string;
  costUsd?: number;
  ms?: number;
}

const SAVED = 'poc-model-graph:graph';

export class Store {
  state: AppState = { providers: [], models: [], examples: [] };
  catalog = new Map<string, ModelSpec>();
  graph: Graph = { version: 1, name: 'Sans nom', nodes: [], edges: [] };
  /** The nodes of the last run. */
  runs = new Map<string, NodeRun>();
  running = false;

  /** The graph's structure changed: everything that shows it is drawn again. */
  onGraph: (() => void)[] = [];
  /** Another graph took the place of the one that was there: a new chatbot, a new conversation. */
  onLoad: (() => void)[] = [];
  /** One node of the run moved on. */
  onRun: ((id: string) => void)[] = [];

  setState(state: AppState): void {
    this.state = state;
    this.catalog = catalogOf(state.models);
  }

  /** The graph the user left, or the first example. */
  restore(): void {
    try {
      const saved = localStorage.getItem(SAVED);
      if (saved) {
        this.graph = parseGraph(JSON.parse(saved));
        return;
      }
    } catch {
      // Unreadable: the example takes its place.
    }
    this.graph = structuredClone(this.state.examples[0] ?? this.graph);
  }

  /** Keeps the graph; `redraw` is false for a change the screen already shows (a text being typed, a node dragged). */
  changed(redraw = true): void {
    localStorage.setItem(SAVED, serializeGraph(this.graph));
    if (redraw) for (const f of this.onGraph) f();
  }

  setGraph(graph: Graph): void {
    this.graph = graph;
    this.runs.clear();
    this.changed();
    for (const f of this.onLoad) f();
  }

  setRun(id: string, run: NodeRun): void {
    this.runs.set(id, run);
    for (const f of this.onRun) f(id);
  }

  clearRuns(): void {
    const ids = [...this.runs.keys()];
    this.runs.clear();
    for (const id of ids) for (const f of this.onRun) f(id);
  }
}
