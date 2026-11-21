import type { NodeState } from '../../shared/graph/engine';
import { catalogOf, GRAPH_VERSION, type Catalog, type Graph } from '../../shared/graph/format';
import type { ClientValue, GraphCatalogView } from '../../shared/graph/protocol';
import type { ModelSpec } from '../../shared/modelCaps';

// What the Graphs view knows: the catalog, the graph being edited, and where its last test run is.

/** A node during a run, as the events left it. */
export interface NodeRun {
  state: NodeState;
  progress?: string;
  outputs?: Record<string, ClientValue[]>;
  error?: string;
  costUsd?: number;
  ms?: number;
}

export class GraphStore {
  view: GraphCatalogView = { providers: [], models: [] };
  catalog: Catalog = new Map<string, ModelSpec>();
  /** The graph open in the editor, and its id; empty when none is. */
  id = '';
  graph: Graph = { version: GRAPH_VERSION, name: '', nodes: [], edges: [] };
  /** The nodes of the last run, and the run their files belong to. */
  runs = new Map<string, NodeRun>();
  runId = '';

  /** The graph's structure changed: everything that shows it is drawn again. */
  onGraph: (() => void)[] = [];
  /** Another graph took the place of the one that was there: a new chatbot, a new conversation. */
  onLoad: (() => void)[] = [];
  /** One node of the run moved on. */
  onRun: ((id: string) => void)[] = [];
  /** The graph is to be saved (its owner waits a moment and writes it). */
  onChange: (() => void)[] = [];

  setCatalog(view: GraphCatalogView): void {
    this.view = view;
    this.catalog = catalogOf(view.models);
  }

  providerName(id: string): string {
    return this.view.providers.find((p) => p.id === id)?.name ?? id;
  }

  /** Keeps the graph; `redraw` is false for a change the screen already shows (a text being typed, a node dragged). */
  changed(redraw = true): void {
    for (const f of this.onChange) f();
    if (redraw) for (const f of this.onGraph) f();
  }

  load(id: string, graph: Graph): void {
    this.id = id;
    this.graph = graph;
    this.runs.clear();
    this.runId = '';
    for (const f of this.onLoad) f();
    for (const f of this.onGraph) f();
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
