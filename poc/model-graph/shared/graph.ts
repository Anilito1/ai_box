import type { ModelSpec, Port } from './capabilities';

// The graph as it is saved: a short JSON a person can read and fix by hand. No Node and no DOM.
//
//   { "version": 1, "name": "…",
//     "nodes": [ { "id": "image", "kind": "model", "model": "venice/flux-3", "x": 300, "y": 80 } ],
//     "edges": [ { "from": "writer.text", "to": "image.prompt" } ] }
//
// A node's ports are not saved: they come from its model (the catalog) at the time the graph is read, so a model
// whose capabilities change shows it as an error on the wire rather than as stale data.

export const GRAPH_VERSION = 1;

export type NodeKind = 'chat-input' | 'chat-output' | 'model' | 'convert';

/** Conversions the engine does itself, without any model. */
export type ConverterId = 'frames';

export interface GraphNode {
  id: string;
  kind: NodeKind;
  /** `model` nodes: the catalog's ref, `provider/model`. */
  model?: string;
  /** `convert` nodes. */
  convert?: ConverterId;
  /** What the node is for, in the user's words ("Rédige le prompt"). */
  title?: string;
  /** Chat models: the system prompt that gives the node its role in the chain. */
  instruction?: string;
  /** Per-node values: a video's "duration", "aspectRatio", "resolution"; a conversion's "count". */
  options?: Record<string, string>;
  x: number;
  y: number;
}

/** A wire from an output to an input, each written `node.port`. */
export interface GraphEdge {
  from: string;
  to: string;
}

export interface Graph {
  version: typeof GRAPH_VERSION;
  name: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type Catalog = ReadonlyMap<string, ModelSpec>;

export const catalogOf = (models: ModelSpec[]): Map<string, ModelSpec> => new Map(models.map((m) => [m.ref, m]));

interface ConverterSpec {
  label: string;
  hint: string;
  inputs: Port[];
  outputs: Port[];
}

export const CONVERTERS: Record<ConverterId, ConverterSpec> = {
  frames: {
    label: 'Extraire des images',
    hint: 'Quelques images réparties sur la vidéo, pour un modèle qui ne lit pas la vidéo.',
    inputs: [{ id: 'video', type: 'video', required: true }],
    outputs: [{ id: 'images', type: 'image', max: 8 }],
  },
};

export const CONVERTER_IDS = Object.keys(CONVERTERS) as ConverterId[];

/** What the user typed and attached, and what the conversation shows back. */
const CHAT_INPUT: Port[] = [
  { id: 'text', type: 'text' },
  { id: 'images', type: 'image', max: 8 },
];
const CHAT_OUTPUT: Port[] = [
  { id: 'text', type: 'text', max: 4 },
  { id: 'image', type: 'image', max: 8 },
  { id: 'video', type: 'video', max: 2 },
  { id: 'audio', type: 'audio', max: 2 },
];

export interface NodePorts {
  inputs: Port[];
  outputs: Port[];
}

/** A node's ports; null for a model node whose model the catalog does not have. */
export function nodePorts(node: GraphNode, catalog: Catalog): NodePorts | null {
  switch (node.kind) {
    case 'chat-input':
      return { inputs: [], outputs: CHAT_INPUT };
    case 'chat-output':
      return { inputs: CHAT_OUTPUT, outputs: [] };
    case 'convert': {
      const c = node.convert && Object.hasOwn(CONVERTERS, node.convert) ? CONVERTERS[node.convert] : undefined;
      return c ? { inputs: c.inputs, outputs: c.outputs } : null;
    }
    case 'model': {
      const spec = node.model ? catalog.get(node.model) : undefined;
      return spec ? { inputs: spec.inputs, outputs: spec.outputs } : null;
    }
  }
}

export interface Endpoint {
  node: string;
  port: string;
}

/** `node.port` taken apart; a node's id has no dot, a port's may not either. */
export function endpoint(ref: string): Endpoint {
  const dot = ref.indexOf('.');
  return dot < 0 ? { node: ref, port: '' } : { node: ref.slice(0, dot), port: ref.slice(dot + 1) };
}

/** What a node is called on screen. */
export function nodeTitle(node: GraphNode, catalog: Catalog): string {
  if (node.title) return node.title;
  if (node.kind === 'chat-input') return 'Entrée chat';
  if (node.kind === 'chat-output') return 'Réponse chat';
  if (node.kind === 'convert') return node.convert ? (CONVERTERS[node.convert]?.label ?? node.convert) : 'Conversion';
  return (node.model && catalog.get(node.model)?.name) || node.model || 'Modèle';
}

export class GraphFormatError extends Error {}

const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
/** A wire's end: `node.port`, nothing that could be read as anything else. */
const REF = /^[a-z0-9_-]+\.[a-z0-9_-]+$/i;

/** A saved graph read back: its shape checked, nothing more (the wires are checked by validate.ts). */
export function parseGraph(json: unknown): Graph {
  const fail = (why: string): never => {
    throw new GraphFormatError(`Graphe illisible : ${why}`);
  };
  if (!json || typeof json !== 'object') return fail('ce n’est pas un objet JSON');
  const g = json as Record<string, unknown>;
  if (g.version !== GRAPH_VERSION) return fail(`version ${JSON.stringify(g.version)} inconnue (attendue : ${GRAPH_VERSION})`);
  if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) return fail('« nodes » et « edges » doivent être des listes');
  const seen = new Set<string>();
  const nodes = g.nodes.map((raw: unknown, i): GraphNode => {
    const n = (raw ?? {}) as Record<string, unknown>;
    const id = typeof n.id === 'string' && ID.test(n.id) ? n.id : fail(`nœud ${i + 1} : « id » manquant ou invalide (lettres, chiffres, - et _)`);
    if (seen.has(id)) fail(`deux nœuds s’appellent « ${id} »`);
    seen.add(id);
    const kind = n.kind === 'chat-input' || n.kind === 'chat-output' || n.kind === 'model' || n.kind === 'convert' ? n.kind : fail(`nœud « ${id} » : « kind » inconnu`);
    const options = n.options && typeof n.options === 'object' ? Object.fromEntries(Object.entries(n.options as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string')) : undefined;
    return {
      id,
      kind,
      ...(typeof n.model === 'string' ? { model: n.model } : {}),
      ...(typeof n.convert === 'string' ? { convert: (CONVERTER_IDS as string[]).includes(n.convert) ? (n.convert as ConverterId) : fail(`nœud « ${id} » : conversion « ${n.convert.slice(0, 40)} » inconnue`) } : {}),
      ...(typeof n.title === 'string' && n.title ? { title: n.title.slice(0, 80) } : {}),
      ...(typeof n.instruction === 'string' && n.instruction ? { instruction: n.instruction.slice(0, 8000) } : {}),
      ...(options && Object.keys(options).length ? { options } : {}),
      x: typeof n.x === 'number' && Number.isFinite(n.x) ? Math.round(n.x) : 40 + i * 240,
      y: typeof n.y === 'number' && Number.isFinite(n.y) ? Math.round(n.y) : 80,
    };
  });
  const edges = g.edges.map((raw: unknown, i): GraphEdge => {
    const e = (raw ?? {}) as Record<string, unknown>;
    if (typeof e.from !== 'string' || typeof e.to !== 'string' || !REF.test(e.from) || !REF.test(e.to)) return fail(`lien ${i + 1} : « from » et « to » s’écrivent "nœud.port"`);
    return { from: e.from, to: e.to };
  });
  return { version: GRAPH_VERSION, name: typeof g.name === 'string' ? g.name.slice(0, 80) : 'Sans nom', nodes, edges };
}

/** The graph as it is written to a file: stable key order, two spaces. */
export const serializeGraph = (graph: Graph): string => JSON.stringify(graph, null, 2);

/** An id no node has yet, from a readable base ("image", "image-2"). */
export function freshId(graph: Graph, base: string): string {
  const clean = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'node';
  const taken = new Set(graph.nodes.map((n) => n.id));
  if (!taken.has(clean)) return clean;
  for (let i = 2; ; i++) if (!taken.has(`${clean}-${i}`)) return `${clean}-${i}`;
}
