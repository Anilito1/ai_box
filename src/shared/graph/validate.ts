import type { MediaType, ModelSpec, Port } from '../modelCaps';
import { CONVERTERS, CONVERTER_IDS, endpoint, NODE_KINDS, NODE_KIND_IDS, nodePorts, type Catalog, type ConverterId, type Graph, type GraphEdge, type GraphNode, type NodeKind } from './format';

// What may be wired to what, and whether a whole graph can run. No Node, no DOM, no text: a problem is a code and
// its values (node ids, port ids, types); the settings window and the main process each say it in words. The editor
// asks the same questions while a wire is dragged as the engine does before a run.

/** Something to put between two ports whose types differ: one of the hub's conversions, or a model of the catalog. */
export type Bridge = { kind: 'convert'; convert: ConverterId } | { kind: 'model'; model: string };

export type Params = Record<string, string | number>;

export type RefusalCode = 'unknown-out' | 'unknown-in' | 'self' | 'type' | 'full' | 'duplicate' | 'cycle';
export type Verdict = { ok: true } | { ok: false; code: RefusalCode; params: Params; bridges: Bridge[] };

const no = (code: RefusalCode, params: Params = {}, bridges: Bridge[] = []): Verdict => ({ ok: false, code, params, bridges });

function findPort(graph: Graph, catalog: Catalog, ref: string, side: 'inputs' | 'outputs'): { node: GraphNode; port: Port } | null {
  const { node: id, port: portId } = endpoint(ref);
  const node = graph.nodes.find((n) => n.id === id);
  const port = node ? nodePorts(node, catalog)?.[side].find((p) => p.id === portId) : undefined;
  return node && port ? { node, port } : null;
}

/**
 * What turns one type into another: the hub's own conversions first (free, local), then up to `max` models of the
 * catalog that read the first type and give the second, the cheapest known first.
 */
export function bridges(catalog: Catalog, from: MediaType, to: MediaType, max = 3): Bridge[] {
  const out: Bridge[] = [];
  for (const id of CONVERTER_IDS) {
    const c = CONVERTERS[id];
    if (c.inputs.some((p) => p.type === from) && c.outputs.some((p) => p.type === to)) out.push({ kind: 'convert', convert: id });
  }
  const models = [...catalog.values()].filter((m) => m.inputs.some((p) => p.type === from) && m.outputs.some((p) => p.type === to)).sort((a, b) => costOf(a) - costOf(b));
  for (const m of models.slice(0, max)) out.push({ kind: 'model', model: m.ref });
  return out;
}

/** A model's price as one number to sort by: unknown last. */
const costOf = (m: ModelSpec) => m.price?.perCall ?? m.price?.output ?? Number.POSITIVE_INFINITY;

function follow(graph: Graph, start: string, forward: boolean): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length) {
    const at = queue.pop() as string;
    for (const e of graph.edges) {
      const [a, b] = forward ? [endpoint(e.from).node, endpoint(e.to).node] : [endpoint(e.to).node, endpoint(e.from).node];
      if (a !== at || seen.has(b)) continue;
      seen.add(b);
      queue.push(b);
    }
  }
  return seen;
}

/** The nodes a node reads, directly or not. */
export const ancestors = (graph: Graph, id: string): Set<string> => follow(graph, id, false);

/** Whether a wire may go from an output (`node.port`) to an input, and if not, why and what would make it possible. */
export function canConnect(graph: Graph, catalog: Catalog, from: string, to: string): Verdict {
  const a = findPort(graph, catalog, from, 'outputs');
  const b = findPort(graph, catalog, to, 'inputs');
  if (!a) return no('unknown-out', { ref: from });
  if (!b) return no('unknown-in', { ref: to });
  if (a.node.id === b.node.id) return no('self', { node: a.node.id });
  if (a.port.type !== b.port.type) return no('type', { from: a.node.id, to: b.node.id, port: b.port.id, have: a.port.type, want: b.port.type }, bridges(catalog, a.port.type, b.port.type));
  if (graph.edges.some((e) => e.from === from && e.to === to)) return no('duplicate');
  const max = b.port.max ?? 1;
  if (graph.edges.filter((e) => e.to === to).length >= max) return no('full', { to: b.node.id, port: b.port.id, max });
  if (follow(graph, b.node.id, true).has(a.node.id)) return no('cycle');
  return { ok: true };
}

export type Order = { ok: true; order: string[] } | { ok: false; cycle: string[] };

/**
 * The nodes in an order that runs each one after everything it reads (Kahn). Among the nodes that are ready the
 * graph's own order is kept, so the result is the same from one run to the next. A loop leaves nodes that never
 * become ready: the ones on the loop are returned as `cycle`.
 */
export function topoOrder(graph: Graph): Order {
  const ids = graph.nodes.map((n) => n.id);
  const known = new Set(ids);
  const waiting = new Map(ids.map((id) => [id, new Set<string>()]));
  for (const e of graph.edges) {
    const from = endpoint(e.from).node;
    const to = endpoint(e.to).node;
    if (from === to && known.has(from)) return { ok: false, cycle: [from] };
    if (known.has(from) && known.has(to)) waiting.get(to)?.add(from);
  }
  const order: string[] = [];
  const left = new Set(ids);
  for (;;) {
    const ready = ids.filter((id) => left.has(id) && [...(waiting.get(id) ?? [])].every((dep) => !left.has(dep)));
    if (ready.length === 0) break;
    for (const id of ready) {
      order.push(id);
      left.delete(id);
    }
  }
  // What is left is the loop and everything after it: only the nodes that lead back to themselves are the loop.
  return left.size === 0 ? { ok: true, order } : { ok: false, cycle: ids.filter((id) => left.has(id) && follow(graph, id, true).has(id)) };
}

export type IssueCode = 'count' | 'no-model' | 'gone' | 'edge' | 'cycle' | 'required' | 'unwired' | 'nothing-shown' | 'unused';

export interface Issue {
  code: IssueCode;
  /** A warning does not stop a run. */
  level: 'error' | 'warning';
  node?: string;
  edge?: GraphEdge;
  /** `edge`: why the wire is refused. */
  refusal?: RefusalCode;
  params: Params;
}

/** Everything that keeps a graph from running (errors) or is probably a mistake (warnings). Empty: it can run. */
export function validateGraph(graph: Graph, catalog: Catalog): Issue[] {
  const issues: Issue[] = [];
  const err = (code: IssueCode, params: Params, more: Partial<Issue> = {}) => issues.push({ code, level: 'error', params, ...more });

  for (const kind of NODE_KIND_IDS) {
    const count = graph.nodes.filter((n) => n.kind === kind).length;
    if (NODE_KINDS[kind].count === 'one' && count !== 1) err('count', { kind, count }, { node: graph.nodes.find((n) => n.kind === kind)?.id });
  }

  for (const node of graph.nodes) {
    if (nodePorts(node, catalog)) continue;
    if (node.kind === 'model') err(node.model ? 'gone' : 'no-model', { node: node.id, model: node.model }, { node: node.id });
  }

  // Each wire on its own, as if it were being drawn now on the graph without it.
  graph.edges.forEach((edge, i) => {
    const fromNode = graph.nodes.find((n) => n.id === endpoint(edge.from).node);
    const toNode = graph.nodes.find((n) => n.id === endpoint(edge.to).node);
    // A node without a model already said so: its wires are not reported once more.
    if (fromNode && toNode && (!nodePorts(fromNode, catalog) || !nodePorts(toNode, catalog))) return;
    const verdict = canConnect({ ...graph, edges: graph.edges.filter((_, j) => j !== i) }, catalog, edge.from, edge.to);
    // Loops are reported once, below, with the nodes they hold.
    if (!verdict.ok && verdict.code !== 'cycle') err('edge', { ...verdict.params, from: edge.from, to: edge.to }, { edge, node: toNode?.id, refusal: verdict.code });
  });

  const order = topoOrder(graph);
  if (!order.ok) err('cycle', { nodes: order.cycle.join(',') }, { node: order.cycle[0] });

  for (const node of graph.nodes) {
    const inputs = nodePorts(node, catalog)?.inputs ?? [];
    const wired = (port: string) => graph.edges.some((e) => e.to === `${node.id}.${port}`);
    // Optional inputs only (a model that reads images or a video): one of them at least must bring something.
    if (node.kind !== 'chat-output' && inputs.length > 0 && !inputs.some((p) => p.required) && !inputs.some((p) => wired(p.id))) err('unwired', { node: node.id }, { node: node.id });
    for (const port of inputs) if (port.required && !wired(port.id)) err('required', { node: node.id, port: port.id, type: port.type }, { node: node.id });
  }

  const outputs = graph.nodes.filter((n) => n.kind === 'chat-output');
  if (outputs.length === 1) {
    const out = outputs[0];
    if (!graph.edges.some((e) => endpoint(e.to).node === out.id)) err('nothing-shown', { node: out.id }, { node: out.id });
    const used = ancestors(graph, out.id);
    for (const node of graph.nodes) {
      if (node.id !== out.id && !used.has(node.id) && node.kind !== 'chat-input') issues.push({ code: 'unused', level: 'warning', node: node.id, params: { node: node.id } });
    }
  }
  return issues;
}

export const errorsOf = (issues: Issue[]): Issue[] => issues.filter((i) => i.level === 'error');

/** The sort of node a `count` issue is about. */
export const issueKind = (issue: Issue): NodeKind | null => (issue.code === 'count' ? (issue.params.kind as NodeKind) : null);

/** The models that can stand in for a model node's: same API, and every port the graph wires on it. Cheapest known first. */
export function equivalents(graph: Graph, node: GraphNode, catalog: Catalog, among: (spec: ModelSpec) => boolean): ModelSpec[] {
  const current = node.kind === 'model' && node.model ? catalog.get(node.model) : undefined;
  if (!current) return [];
  const wired = (side: 'from' | 'to') =>
    graph.edges
      .map((e) => endpoint(e[side]))
      .filter((p) => p.node === node.id)
      .map((p) => p.port);
  const type = (ports: Port[], id: string) => ports.find((p) => p.id === id)?.type;
  return [...catalog.values()]
    .filter((m) => m.ref !== current.ref && among(m) && m.api === current.api)
    .filter((m) => wired('to').every((id) => type(m.inputs, id) !== undefined && type(m.inputs, id) === type(current.inputs, id)))
    .filter((m) => wired('from').every((id) => type(m.outputs, id) !== undefined && type(m.outputs, id) === type(current.outputs, id)))
    // No required input may be left without a wire.
    .filter((m) => m.inputs.every((p) => !p.required || wired('to').includes(p.id)))
    .sort((a, b) => costOf(a) - costOf(b) || a.model.localeCompare(b.model));
}
