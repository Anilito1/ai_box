import type { ModelSpec, Port } from '../modelCaps';

// A graph as it is saved: a short JSON a person can read and fix by hand. No Node, no DOM, no text.
//
//   { "version": 1, "name": "…",
//     "nodes": [ { "id": "image", "kind": "model", "model": "a-1b2c3d4e/flux-3", "x": 300, "y": 80 } ],
//     "edges": [ { "from": "writer.text", "to": "image.prompt" } ] }
//
// A node's ports are not saved: they come from its model (the catalog) when the graph is read, so a model whose
// capabilities changed shows as a wire in error rather than as stale data.
//
// Each sort of node is one entry of NODE_KINDS (its ports, how many a graph may hold, its own saved fields): a new
// sort (a worker with its own conversation, say) is a new entry and a new member of the GraphNode union.

export const GRAPH_VERSION = 1;
export const GRAPH_LIMITS = { nodes: 60, edges: 200, name: 80, title: 80, instruction: 8000 } as const;

/** Conversions the hub makes itself, without any model. */
export type ConverterId = 'frames';
export const CONVERTER_IDS: ConverterId[] = ['frames'];

interface NodeBase {
  id: string;
  /** What the node is for, in the user's words ("Writes the prompt"). */
  title?: string;
  /** Per-node values: a video's "duration", "aspectRatio", "resolution"; a conversion's "count". */
  options?: Record<string, string>;
  x: number;
  y: number;
}

export type GraphNode =
  | (NodeBase & { kind: 'chat-input' })
  | (NodeBase & { kind: 'chat-output' })
  /** `model`: the catalog's ref (`account/model`), empty until one is picked. `instruction`: a chat model's system prompt. */
  | (NodeBase & { kind: 'model'; model: string; instruction?: string })
  | (NodeBase & { kind: 'convert'; convert: ConverterId });

export type NodeKind = GraphNode['kind'];
export type NodeOf<K extends NodeKind> = Extract<GraphNode, { kind: K }>;

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

export interface NodePorts {
  inputs: Port[];
  outputs: Port[];
}

export const CONVERTERS: Record<ConverterId, NodePorts> = {
  // A few pictures spread over a video, for a model that reads images but no video.
  frames: { inputs: [{ id: 'video', type: 'video', required: true }], outputs: [{ id: 'images', type: 'image', max: 8 }] },
};

/** What the user typed and attached, and what the conversation shows back. */
const CHAT_INPUT: NodePorts = {
  inputs: [],
  outputs: [
    { id: 'text', type: 'text' },
    { id: 'images', type: 'image', max: 8 },
  ],
};
const CHAT_OUTPUT: NodePorts = {
  inputs: [
    { id: 'text', type: 'text', max: 4 },
    { id: 'image', type: 'image', max: 8 },
    { id: 'video', type: 'video', max: 2 },
    { id: 'audio', type: 'audio', max: 2 },
  ],
  outputs: [],
};

export class GraphFormatError extends Error {
  constructor(
    readonly code: 'not-object' | 'version' | 'lists' | 'too-big' | 'node-id' | 'node-twice' | 'node-kind' | 'convert' | 'edge',
    readonly params: Record<string, string | number> = {},
  ) {
    super(`${code} ${JSON.stringify(params)}`);
    this.name = 'GraphFormatError';
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const text = (v: unknown, max: number) => str(v).trim().slice(0, max);

/** One sort of node. */
export interface NodeKindDef<K extends NodeKind = NodeKind> {
  /** Its ports; null when it cannot have any now (a model the catalog no longer has, none picked). */
  ports(node: NodeOf<K>, catalog: Catalog): NodePorts | null;
  /** A graph holds exactly one such node (the chat's two ends), or any number. */
  count: 'one' | 'any';
  /** Its own saved fields, read from JSON; throws a GraphFormatError. */
  read(raw: Record<string, unknown>, id: string): Omit<NodeOf<K>, keyof NodeBase | 'kind'>;
}

type Registry = { [K in NodeKind]: NodeKindDef<K> };

export const NODE_KINDS: Registry = {
  'chat-input': { count: 'one', ports: () => CHAT_INPUT, read: () => ({}) },
  'chat-output': { count: 'one', ports: () => CHAT_OUTPUT, read: () => ({}) },
  model: {
    count: 'any',
    ports: (node, catalog) => {
      const spec = node.model ? catalog.get(node.model) : undefined;
      return spec ? { inputs: spec.inputs, outputs: spec.outputs } : null;
    },
    read: (raw) => ({ model: text(raw.model, 320), ...(text(raw.instruction, GRAPH_LIMITS.instruction) ? { instruction: str(raw.instruction).slice(0, GRAPH_LIMITS.instruction) } : {}) }),
  },
  convert: {
    count: 'any',
    ports: (node) => (Object.hasOwn(CONVERTERS, node.convert) ? CONVERTERS[node.convert] : null),
    read: (raw, id) => {
      const convert = str(raw.convert);
      if (!(CONVERTER_IDS as string[]).includes(convert)) throw new GraphFormatError('convert', { node: id, convert: convert.slice(0, 40) });
      return { convert: convert as ConverterId };
    },
  },
};

export const NODE_KIND_IDS = Object.keys(NODE_KINDS) as NodeKind[];
const isKind = (v: unknown): v is NodeKind => typeof v === 'string' && Object.hasOwn(NODE_KINDS, v);

/** A node's ports; null for one that cannot have any now. */
export const nodePorts = (node: GraphNode, catalog: Catalog): NodePorts | null => (NODE_KINDS[node.kind] as NodeKindDef).ports(node, catalog);

/** The model of a model node, when the catalog has it. */
export const nodeSpec = (node: GraphNode, catalog: Catalog): ModelSpec | null => (node.kind === 'model' && node.model ? (catalog.get(node.model) ?? null) : null);

/** What a node is called: the user's title, else its model's name, else what `fallback` says of its sort. */
export function nodeName(node: GraphNode, catalog: Catalog, fallback: (node: GraphNode) => string): string {
  if (node.title) return node.title;
  const spec = nodeSpec(node, catalog);
  return spec ? spec.name || spec.model : fallback(node);
}

export interface Endpoint {
  node: string;
  port: string;
}

/** `node.port` taken apart; neither a node's id nor a port's has a dot. */
export function endpoint(ref: string): Endpoint {
  const dot = ref.indexOf('.');
  return dot < 0 ? { node: ref, port: '' } : { node: ref.slice(0, dot), port: ref.slice(dot + 1) };
}

export const NODE_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
/** A wire's end: `node.port`, nothing that could be read as anything else. */
const REF = /^[a-z0-9][a-z0-9_-]{0,39}\.[a-z0-9_-]{1,40}$/i;

/** A saved graph read back: its shape checked, nothing more (the wires are checked by validate.ts). */
export function parseGraph(json: unknown): Graph {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new GraphFormatError('not-object');
  const g = json as Record<string, unknown>;
  if (g.version !== GRAPH_VERSION) throw new GraphFormatError('version', { version: JSON.stringify(g.version ?? null).slice(0, 20), expected: GRAPH_VERSION });
  if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) throw new GraphFormatError('lists');
  if (g.nodes.length > GRAPH_LIMITS.nodes || g.edges.length > GRAPH_LIMITS.edges) throw new GraphFormatError('too-big', { nodes: GRAPH_LIMITS.nodes, edges: GRAPH_LIMITS.edges });
  const seen = new Set<string>();
  const nodes = g.nodes.map((raw: unknown, i): GraphNode => {
    const n = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const id = str(n.id);
    if (!NODE_ID.test(id)) throw new GraphFormatError('node-id', { index: i + 1 });
    if (seen.has(id)) throw new GraphFormatError('node-twice', { node: id });
    seen.add(id);
    if (!isKind(n.kind)) throw new GraphFormatError('node-kind', { node: id });
    const options = n.options && typeof n.options === 'object' ? Object.entries(n.options as Record<string, unknown>).filter((e): e is [string, string] => /^[a-z][a-zA-Z0-9]{0,30}$/.test(e[0]) && typeof e[1] === 'string' && e[1].length <= 40).slice(0, 12) : [];
    const title = text(n.title, GRAPH_LIMITS.title);
    return {
      id,
      kind: n.kind,
      ...(title ? { title } : {}),
      ...(options.length > 0 ? { options: Object.fromEntries(options) } : {}),
      x: typeof n.x === 'number' && Number.isFinite(n.x) ? Math.max(0, Math.min(20_000, Math.round(n.x))) : 40 + i * 240,
      y: typeof n.y === 'number' && Number.isFinite(n.y) ? Math.max(0, Math.min(20_000, Math.round(n.y))) : 80,
      ...(NODE_KINDS[n.kind] as NodeKindDef).read(n, id),
    } as GraphNode;
  });
  const edges = g.edges.map((raw: unknown, i): GraphEdge => {
    const e = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (typeof e.from !== 'string' || typeof e.to !== 'string' || !REF.test(e.from) || !REF.test(e.to)) throw new GraphFormatError('edge', { index: i + 1 });
    return { from: e.from, to: e.to };
  });
  return { version: GRAPH_VERSION, name: text(g.name, GRAPH_LIMITS.name), nodes, edges };
}

/** The graph as it is written to a file: two spaces, a final newline. */
export const serializeGraph = (graph: Graph): string => `${JSON.stringify(graph, null, 2)}\n`;

/** An id no node has yet, from a readable base ("image", "image-2"). */
export function freshId(graph: Graph, base: string): string {
  const clean =
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'node';
  const taken = new Set(graph.nodes.map((n) => n.id));
  if (!taken.has(clean)) return clean;
  for (let i = 2; ; i++) if (!taken.has(`${clean}-${i}`)) return `${clean}-${i}`;
}
