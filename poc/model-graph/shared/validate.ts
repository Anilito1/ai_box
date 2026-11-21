import { typeName, type ModelSpec, type Port } from './capabilities';
import { CONVERTERS, CONVERTER_IDS, endpoint, nodePorts, nodeTitle, type Catalog, type ConverterId, type Graph, type GraphEdge, type GraphNode } from './graph';

// What may be wired to what, and whether a whole graph can run. No Node and no DOM: the editor asks the same
// questions while a wire is dragged as the engine does before a run.

/** Something to put between two ports whose types differ. */
export type Bridge = { kind: 'convert'; convert: ConverterId; label: string } | { kind: 'model'; model: string; label: string };

export type Verdict = { ok: true } | { ok: false; code: 'unknown' | 'self' | 'type' | 'full' | 'duplicate' | 'cycle'; message: string; bridges: Bridge[] };

const no = (code: Exclude<Verdict, { ok: true }>['code'], message: string, bridges: Bridge[] = []): Verdict => ({ ok: false, code, message, bridges });

function findPort(graph: Graph, catalog: Catalog, ref: string, side: 'inputs' | 'outputs'): { node: GraphNode; port: Port } | null {
  const { node: id, port: portId } = endpoint(ref);
  const node = graph.nodes.find((n) => n.id === id);
  const port = node ? nodePorts(node, catalog)?.[side].find((p) => p.id === portId) : undefined;
  return node && port ? { node, port } : null;
}

/**
 * What turns one type into another: the engine's own conversions first (free, local), then up to `max` models of
 * the catalog that read the first type and give the second.
 */
export function bridges(catalog: Catalog, from: Port['type'], to: Port['type'], max = 3): Bridge[] {
  const out: Bridge[] = [];
  for (const id of CONVERTER_IDS) {
    const c = CONVERTERS[id];
    if (c.inputs.some((p) => p.type === from) && c.outputs.some((p) => p.type === to)) out.push({ kind: 'convert', convert: id, label: c.label });
  }
  const models = [...catalog.values()].filter((m) => m.inputs.some((p) => p.type === from) && m.outputs.some((p) => p.type === to));
  for (const m of models.slice(0, max)) out.push({ kind: 'model', model: m.ref, label: m.name });
  return out;
}

/** The nodes reached from `start` by following the wires. */
function downstream(graph: Graph, start: string): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length) {
    const id = queue.pop() as string;
    for (const e of graph.edges) {
      if (endpoint(e.from).node !== id) continue;
      const next = endpoint(e.to).node;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/** Whether a wire may go from an output (`node.port`) to an input, and if not, why and what would make it possible. */
export function canConnect(graph: Graph, catalog: Catalog, from: string, to: string): Verdict {
  const a = findPort(graph, catalog, from, 'outputs');
  const b = findPort(graph, catalog, to, 'inputs');
  if (!a) return no('unknown', `La sortie « ${from} » n’existe pas.`);
  if (!b) return no('unknown', `L’entrée « ${to} » n’existe pas.`);
  if (a.node.id === b.node.id) return no('self', 'Un nœud ne peut pas se relier à lui-même.');
  if (a.port.type !== b.port.type) {
    const found = bridges(catalog, a.port.type, b.port.type);
    const hint = found.length ? ` Ajoute entre les deux : ${found.map((x) => `« ${x.label} »`).join(' ou ')}.` : ` Il faut entre les deux un modèle qui lit ${typeName(a.port.type)} et donne ${typeName(b.port.type)}.`;
    return no('type', `« ${nodeTitle(a.node, catalog)} » sort ${typeName(a.port.type)}, mais l’entrée « ${b.port.id} » de « ${nodeTitle(b.node, catalog)} » attend ${typeName(b.port.type)}.${hint}`, found);
  }
  if (graph.edges.some((e) => e.from === from && e.to === to)) return no('duplicate', 'Ce lien existe déjà.');
  const taken = graph.edges.filter((e) => e.to === to).length;
  const max = b.port.max ?? 1;
  if (taken >= max) return no('full', max === 1 ? `L’entrée « ${b.port.id} » de « ${nodeTitle(b.node, catalog)} » ne prend qu’une valeur : retire d’abord le lien en place.` : `L’entrée « ${b.port.id} » de « ${nodeTitle(b.node, catalog)} » prend ${max} valeurs au plus.`);
  if (downstream(graph, b.node.id).has(a.node.id)) return no('cycle', 'Ce lien ferait une boucle : le graphe doit aller de l’entrée du chat à la réponse, sans retour.');
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
    if (known.has(from) && known.has(to) && from !== to) waiting.get(to)?.add(from);
    if (from === to && known.has(from)) return { ok: false, cycle: [from] };
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
  return left.size === 0 ? { ok: true, order } : { ok: false, cycle: ids.filter((id) => left.has(id) && downstream(graph, id).has(id)) };
}

/** The nodes a node reads, directly or not. */
export function ancestors(graph: Graph, id: string): Set<string> {
  const seen = new Set<string>();
  const queue = [id];
  while (queue.length) {
    const at = queue.pop() as string;
    for (const e of graph.edges) {
      if (endpoint(e.to).node !== at) continue;
      const prev = endpoint(e.from).node;
      if (!seen.has(prev)) {
        seen.add(prev);
        queue.push(prev);
      }
    }
  }
  return seen;
}

export interface Issue {
  code: 'no-input' | 'no-output' | 'model' | 'edge' | 'required' | 'cycle' | 'unused' | 'nothing-shown';
  /** A warning does not stop a run. */
  level: 'error' | 'warning';
  node?: string;
  edge?: GraphEdge;
  message: string;
}

/** Everything that keeps a graph from running (errors) or is probably a mistake (warnings). Empty: it can run. */
export function validateGraph(graph: Graph, catalog: Catalog): Issue[] {
  const issues: Issue[] = [];
  const err = (code: Issue['code'], message: string, more: Partial<Issue> = {}) => issues.push({ code, level: 'error', message, ...more });
  const inputs = graph.nodes.filter((n) => n.kind === 'chat-input');
  const outputs = graph.nodes.filter((n) => n.kind === 'chat-output');
  if (inputs.length !== 1) err('no-input', inputs.length === 0 ? 'Il manque le nœud « Entrée chat ».' : 'Un seul nœud « Entrée chat » par graphe.');
  if (outputs.length !== 1) err('no-output', outputs.length === 0 ? 'Il manque le nœud « Réponse chat ».' : 'Un seul nœud « Réponse chat » par graphe.');

  for (const node of graph.nodes) {
    if (nodePorts(node, catalog)) continue;
    err('model', node.kind === 'model' ? (node.model ? `« ${nodeTitle(node, catalog)} » : le modèle ${node.model} n’est plus dans la liste des fournisseurs.` : `« ${nodeTitle(node, catalog)} » : aucun modèle choisi.`) : `« ${node.id} » : conversion inconnue.`, { node: node.id });
  }

  // Each wire on its own, as if it were being drawn now on the graph without it.
  graph.edges.forEach((edge, i) => {
    const others: Graph = { ...graph, edges: graph.edges.filter((_, j) => j !== i) };
    const fromNode = graph.nodes.find((n) => n.id === endpoint(edge.from).node);
    const toNode = graph.nodes.find((n) => n.id === endpoint(edge.to).node);
    // A node without a model already said so: its wires are not reported once more.
    if (fromNode && toNode && (!nodePorts(fromNode, catalog) || !nodePorts(toNode, catalog))) return;
    const verdict = canConnect(others, catalog, edge.from, edge.to);
    // Loops are reported once, below, with the nodes they hold.
    if (!verdict.ok && verdict.code !== 'cycle') err('edge', `Lien ${edge.from} → ${edge.to} : ${verdict.message}`, { edge, node: endpoint(edge.to).node });
  });

  const order = topoOrder(graph);
  if (!order.ok) {
    const names = order.cycle.map((id) => `« ${nodeTitle(graph.nodes.find((n) => n.id === id) as GraphNode, catalog)} »`);
    err('cycle', `Le graphe fait une boucle entre ${names.join(', ')} : il doit aller de l’entrée à la réponse sans retour.`, { node: order.cycle[0] });
  }

  for (const node of graph.nodes) {
    const inputs = nodePorts(node, catalog)?.inputs ?? [];
    // Optional inputs only (a model that reads images or a video): one of them at least must bring something.
    if (node.kind !== 'chat-output' && inputs.length > 0 && !inputs.some((p) => p.required) && !graph.edges.some((e) => endpoint(e.to).node === node.id)) {
      err('required', `« ${nodeTitle(node, catalog)} » : aucune entrée n’est reliée.`, { node: node.id });
    }
    for (const port of inputs) {
      if (port.required && !graph.edges.some((e) => e.to === `${node.id}.${port.id}`)) err('required', `« ${nodeTitle(node, catalog)} » : l’entrée « ${port.id} » (${typeName(port.type)}) doit être reliée.`, { node: node.id });
    }
  }

  const out = outputs[0];
  if (out && outputs.length === 1) {
    if (!graph.edges.some((e) => endpoint(e.to).node === out.id)) err('nothing-shown', 'Rien n’est relié à « Réponse chat » : le chat n’aurait rien à afficher.', { node: out.id });
    const used = ancestors(graph, out.id);
    for (const node of graph.nodes) {
      if (node.id !== out.id && !used.has(node.id) && node.kind !== 'chat-input') issues.push({ code: 'unused', level: 'warning', node: node.id, message: `« ${nodeTitle(node, catalog)} » ne mène pas à la réponse : il ne sera pas exécuté.` });
    }
  }
  return issues;
}

export const errorsOf = (issues: Issue[]): Issue[] => issues.filter((i) => i.level === 'error');

/** The models that can stand in for one in a graph: same API, and every port the graph wires on this node. */
export function equivalents(graph: Graph, node: GraphNode, catalog: Catalog, among: (spec: ModelSpec) => boolean): ModelSpec[] {
  const current = node.model ? catalog.get(node.model) : undefined;
  if (!current) return [];
  const wired = (side: 'from' | 'to') => graph.edges.map((e) => endpoint(e[side])).filter((p) => p.node === node.id).map((p) => p.port);
  const type = (ports: Port[], id: string) => ports.find((p) => p.id === id)?.type;
  const cost = (m: ModelSpec) => m.price?.perCall ?? m.price?.output ?? Number.POSITIVE_INFINITY;
  return [...catalog.values()]
    .filter((m) => m.ref !== current.ref && among(m) && m.api === current.api)
    .filter((m) => wired('to').every((id) => type(m.inputs, id) !== undefined && type(m.inputs, id) === type(current.inputs, id)))
    .filter((m) => wired('from').every((id) => type(m.outputs, id) !== undefined && type(m.outputs, id) === type(current.outputs, id)))
    // No required input may be left without a wire.
    .filter((m) => m.inputs.every((p) => !p.required || wired('to').includes(p.id)))
    // The cheapest known first: a stand-in picked for the user must not be the dearest of the list.
    .sort((a, b) => cost(a) - cost(b) || a.model.localeCompare(b.model));
}
