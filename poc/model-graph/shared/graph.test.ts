import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SIM_MODELS } from '../server/runners/sim';
import { catalogOf, GraphFormatError, parseGraph, type Graph } from './graph';
import { canConnect, equivalents, errorsOf, topoOrder, validateGraph } from './validate';

// The rules of the wires, on the example the POC ships: chat → LLM → text-to-image → image-to-video → LLM → chat.

const catalog = catalogOf(SIM_MODELS);
const example = (): Graph => parseGraph(JSON.parse(readFileSync('poc/model-graph/examples/1-texte-image-video-analyse.json', 'utf8')));
const refused = (graph: Graph, from: string, to: string) => {
  const verdict = canConnect(graph, catalog, from, to);
  assert.equal(verdict.ok, false, `${from} → ${to} should be refused`);
  return verdict as Exclude<typeof verdict, { ok: true }>;
};

test('a wire goes from an output to an input of the same type, and only there', () => {
  const graph = example();
  graph.edges = [];
  assert.deepEqual(canConnect(graph, catalog, 'in.text', 'writer.prompt'), { ok: true });
  assert.deepEqual(canConnect(graph, catalog, 'image.image', 'video.image'), { ok: true });

  const wrong = refused(graph, 'image.image', 'writer.prompt');
  assert.equal(wrong.code, 'type');
  assert.match(wrong.message, /sort image.*attend texte/);
  assert.equal(refused(graph, 'in.text', 'nowhere.prompt').code, 'unknown');
  assert.equal(refused(graph, 'writer.nothing', 'image.prompt').code, 'unknown');
});

test('a video towards an input that reads images: refused, with the conversion that makes it possible', () => {
  const graph = example();
  graph.nodes.push({ id: 'eyes', kind: 'model', model: 'sim/llm-vision', x: 0, y: 0 });
  const verdict = refused(graph, 'video.video', 'eyes.images');
  assert.equal(verdict.code, 'type');
  assert.deepEqual(verdict.bridges[0], { kind: 'convert', convert: 'frames', label: 'Extraire des images' });
  assert.match(verdict.message, /Extraire des images/);
  // Types no conversion joins: a model that reads one and gives the other is proposed instead.
  const toText = refused(graph, 'video.video', 'writer.prompt');
  assert.ok(toText.bridges.some((b) => b.kind === 'model' && b.model === 'sim/llm-video'));
});

test('an input takes as many wires as it says: one by default, several for reference images', () => {
  const graph = example();
  assert.equal(refused(graph, 'critic.text', 'image.prompt').code, 'full');
  assert.equal(refused(graph, 'in.text', 'writer.prompt').code, 'duplicate');
  graph.nodes.push({ id: 'edit', kind: 'model', model: 'sim/reference-to-image', x: 0, y: 0 });
  assert.deepEqual(canConnect(graph, catalog, 'in.images', 'edit.images'), { ok: true });
  graph.edges.push({ from: 'in.images', to: 'edit.images' });
  assert.deepEqual(canConnect(graph, catalog, 'image.image', 'edit.images'), { ok: true });
});

test('a wire that would close a loop is refused when it is drawn', () => {
  const graph = example();
  graph.edges = graph.edges.filter((e) => e.to !== 'writer.prompt');
  // critic reads the video, which comes from the image, which comes from writer.
  assert.equal(refused(graph, 'critic.text', 'writer.prompt').code, 'cycle');
  assert.equal(refused(graph, 'writer.text', 'writer.prompt').code, 'self');
});

test('the order of a run: every node after all it reads, the same from one run to the next', () => {
  const graph = example();
  const sorted = topoOrder(graph);
  assert.deepEqual(sorted, { ok: true, order: ['in', 'writer', 'image', 'video', 'critic', 'out'] });
  // The order the nodes are written in does not matter.
  graph.nodes.reverse();
  const again = topoOrder(graph);
  assert.ok(again.ok);
  for (const edge of graph.edges) {
    const [from, to] = [edge.from, edge.to].map((ref) => again.order.indexOf(ref.split('.')[0]));
    assert.ok(from < to, `${edge.from} runs before ${edge.to}`);
  }
});

test('a loop in a saved graph is found, and named', () => {
  const graph = example();
  graph.edges = graph.edges.filter((e) => e.to !== 'writer.prompt');
  graph.edges.push({ from: 'critic.text', to: 'writer.prompt' });
  const sorted = topoOrder(graph);
  assert.deepEqual(sorted, { ok: false, cycle: ['writer', 'image', 'video', 'critic'] });
  const issues = validateGraph(graph, catalog);
  const loop = issues.filter((i) => i.code === 'cycle');
  assert.equal(loop.length, 1);
  assert.match(loop[0].message, /boucle entre « Rédige le prompt »/);
});

test('the shipped examples are valid; a graph with what is missing says what', () => {
  for (const file of ['1-texte-image-video-analyse', '2-video-vers-llm-vision', '3-image-de-reference']) {
    const graph = parseGraph(JSON.parse(readFileSync(`poc/model-graph/examples/${file}.json`, 'utf8')));
    assert.deepEqual(validateGraph(graph, catalog), [], file);
  }
  const graph = example();
  // The image no longer goes to the video: the video lacks its input, and the image leads nowhere.
  graph.edges = graph.edges.filter((e) => e.to !== 'video.image');
  graph.nodes.find((n) => n.id === 'critic')!.model = 'venice/gone';
  graph.nodes.push({ id: 'spare', kind: 'model', model: 'sim/text-to-image', x: 0, y: 0 });
  const issues = validateGraph(graph, catalog);
  assert.deepEqual(errorsOf(issues).map((i) => [i.code, i.node]).sort(), [['model', 'critic'], ['required', 'spare'], ['required', 'video']]);
  assert.match(issues.find((i) => i.node === 'video')!.message, /l’entrée « image » \(image\) doit être reliée/);
  assert.deepEqual(issues.filter((i) => i.level === 'warning').map((i) => [i.code, i.node]), [['unused', 'image'], ['unused', 'spare']]);
});

test('a wire whose model changed under it is reported, not dropped', () => {
  const graph = example();
  // The image model becomes a plain LLM: it has no "image" output any more.
  graph.nodes.find((n) => n.id === 'image')!.model = 'sim/llm';
  const issues = errorsOf(validateGraph(graph, catalog));
  assert.ok(issues.some((i) => i.code === 'edge' && i.edge?.from === 'image.image'));
});

test('a model can stand in for another when it has the ports the graph wires', () => {
  const graph = example();
  const real = catalogOf([
    ...SIM_MODELS,
    { ...SIM_MODELS.find((m) => m.model === 'image-to-video')!, ref: 'venice/i2v-pro', provider: 'venice', model: 'i2v-pro', price: { perCall: 0.9 } },
    { ...SIM_MODELS.find((m) => m.model === 'image-to-video')!, ref: 'venice/i2v-fast', provider: 'venice', model: 'i2v-fast', price: { perCall: 0.1 } },
    // No image input: it cannot take the wire that brings the image.
    { ...SIM_MODELS.find((m) => m.model === 'text-to-video')!, ref: 'venice/t2v', provider: 'venice', model: 't2v' },
  ]);
  const video = graph.nodes.find((n) => n.id === 'video')!;
  assert.deepEqual(equivalents(graph, video, real, (m) => m.provider !== 'sim').map((m) => m.ref), ['venice/i2v-fast', 'venice/i2v-pro']);
});

test('a saved graph is read strictly: its version, its ids, its shape', () => {
  assert.throws(() => parseGraph({ version: 2, nodes: [], edges: [] }), GraphFormatError);
  assert.throws(() => parseGraph({ version: 1, nodes: [{ id: 'a', kind: 'model' }, { id: 'a', kind: 'model' }], edges: [] }), /deux nœuds/);
  assert.throws(() => parseGraph({ version: 1, nodes: [{ id: 'a.b', kind: 'model' }], edges: [] }), /id/);
  assert.throws(() => parseGraph({ version: 1, nodes: [], edges: [{ from: 'a.b' }] }), /lien 1/);
  // Nothing but `node.port` on a wire, and no conversion but the known ones (not a name every object has).
  assert.throws(() => parseGraph({ version: 1, nodes: [], edges: [{ from: 'a"]x.b', to: 'c.d' }] }), /lien 1/);
  assert.throws(() => parseGraph({ version: 1, nodes: [{ id: 'c', kind: 'convert', convert: 'constructor' }], edges: [] }), /conversion « constructor » inconnue/);
  const graph = parseGraph({ version: 1, name: 'x', nodes: [{ id: 'a', kind: 'model', model: 'sim/llm', junk: true }], edges: [] });
  assert.deepEqual(graph.nodes[0], { id: 'a', kind: 'model', model: 'sim/llm', x: 40, y: 80 });
});
