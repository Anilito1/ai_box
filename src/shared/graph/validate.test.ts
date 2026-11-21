import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PRESET_IDS, specOf } from '../modelCaps';
import { catalogOf, GraphFormatError, parseGraph, serializeGraph, type Graph } from './format';
import { canConnect, equivalents, errorsOf, topoOrder, validateGraph } from './validate';

// The rules of the wires, on the chain the Graphs view starts with: chat → LLM → text-to-image → image-to-video →
// LLM that reads videos → chat.

const sim = PRESET_IDS.map((preset) => specOf('sim', { model: preset, name: preset, preset, source: 'listed' }));
const catalog = catalogOf(sim);

const chain = (): Graph => ({
  version: 1,
  name: 'chain',
  nodes: [
    { id: 'in', kind: 'chat-input', x: 0, y: 0 },
    { id: 'writer', kind: 'model', model: 'sim/llm', title: 'Writes the prompt', x: 0, y: 0 },
    { id: 'image', kind: 'model', model: 'sim/text-to-image', x: 0, y: 0 },
    { id: 'video', kind: 'model', model: 'sim/image-to-video', x: 0, y: 0 },
    { id: 'critic', kind: 'model', model: 'sim/llm-video', x: 0, y: 0 },
    { id: 'out', kind: 'chat-output', x: 0, y: 0 },
  ],
  edges: [
    { from: 'in.text', to: 'writer.prompt' },
    { from: 'writer.text', to: 'image.prompt' },
    { from: 'image.image', to: 'video.image' },
    { from: 'writer.text', to: 'video.prompt' },
    { from: 'video.video', to: 'critic.video' },
    { from: 'critic.text', to: 'out.text' },
    { from: 'video.video', to: 'out.video' },
  ],
});
const refused = (graph: Graph, from: string, to: string) => {
  const verdict = canConnect(graph, catalog, from, to);
  assert.equal(verdict.ok, false, `${from} → ${to} should be refused`);
  return verdict as Exclude<typeof verdict, { ok: true }>;
};

test('a wire goes from an output to an input of the same type, and only there', () => {
  const graph = chain();
  graph.edges = [];
  assert.deepEqual(canConnect(graph, catalog, 'in.text', 'writer.prompt'), { ok: true });
  assert.deepEqual(canConnect(graph, catalog, 'image.image', 'video.image'), { ok: true });
  const wrong = refused(graph, 'image.image', 'writer.prompt');
  assert.deepEqual([wrong.code, wrong.params], ['type', { from: 'image', to: 'writer', port: 'prompt', have: 'image', want: 'text' }]);
  assert.equal(refused(graph, 'in.text', 'nowhere.prompt').code, 'unknown-in');
  assert.equal(refused(graph, 'writer.nothing', 'image.prompt').code, 'unknown-out');
});

test('a video towards an input that reads images: refused, with the conversion that makes it possible', () => {
  const graph = chain();
  graph.nodes.push({ id: 'eyes', kind: 'model', model: 'sim/llm-vision', x: 0, y: 0 });
  const verdict = refused(graph, 'video.video', 'eyes.images');
  assert.equal(verdict.code, 'type');
  assert.deepEqual(verdict.bridges[0], { kind: 'convert', convert: 'frames' });
  // Types no conversion joins: a model that reads one and gives the other is proposed instead.
  assert.ok(refused(graph, 'video.video', 'writer.prompt').bridges.some((b) => b.kind === 'model' && b.model === 'sim/llm-video'));
});

test('an input takes as many wires as it says: one by default, several for reference images', () => {
  const graph = chain();
  assert.deepEqual([refused(graph, 'critic.text', 'image.prompt').code, refused(graph, 'in.text', 'writer.prompt').code], ['full', 'duplicate']);
  graph.nodes.push({ id: 'edit', kind: 'model', model: 'sim/reference-to-image', x: 0, y: 0 });
  graph.edges.push({ from: 'in.images', to: 'edit.images' });
  assert.deepEqual(canConnect(graph, catalog, 'image.image', 'edit.images'), { ok: true });
});

test('a loop is refused when it is drawn, and found and named in a saved graph', () => {
  const graph = chain();
  graph.edges = graph.edges.filter((e) => e.to !== 'writer.prompt');
  assert.equal(refused(graph, 'critic.text', 'writer.prompt').code, 'cycle');
  assert.equal(refused(graph, 'writer.text', 'writer.prompt').code, 'self');
  graph.edges.push({ from: 'critic.text', to: 'writer.prompt' });
  assert.deepEqual(topoOrder(graph), { ok: false, cycle: ['writer', 'image', 'video', 'critic'] });
  const loops = validateGraph(graph, catalog).filter((i) => i.code === 'cycle');
  assert.deepEqual(loops.map((i) => i.params), [{ nodes: 'writer,image,video,critic' }]);
});

test('the order of a run: every node after all it reads, whatever order the nodes are written in', () => {
  const graph = chain();
  assert.deepEqual(topoOrder(graph), { ok: true, order: ['in', 'writer', 'image', 'video', 'critic', 'out'] });
  graph.nodes.reverse();
  const again = topoOrder(graph);
  assert.ok(again.ok);
  for (const edge of graph.edges) assert.ok(again.order.indexOf(edge.from.split('.')[0]) < again.order.indexOf(edge.to.split('.')[0]), `${edge.from} before ${edge.to}`);
});

test('a graph says what keeps it from running, and what is probably a mistake', () => {
  assert.deepEqual(validateGraph(chain(), catalog), []);
  const graph = chain();
  // The image no longer goes to the video: the video lacks its input, and the image leads nowhere.
  graph.edges = graph.edges.filter((e) => e.to !== 'video.image');
  (graph.nodes[4] as { model: string }).model = 'a-gone0001/old-model';
  graph.nodes.push({ id: 'spare', kind: 'model', model: '', x: 0, y: 0 }, { id: 'out2', kind: 'chat-output', x: 0, y: 0 });
  const issues = validateGraph(graph, catalog);
  assert.deepEqual(errorsOf(issues).map((i) => [i.code, i.node]).sort(), [['count', 'out'], ['gone', 'critic'], ['no-model', 'spare'], ['required', 'video']]);
  assert.deepEqual(issues.find((i) => i.code === 'required')?.params, { node: 'video', port: 'image', type: 'image' });
  assert.deepEqual(issues.find((i) => i.code === 'count')?.params, { kind: 'chat-output', count: 2 });
});

test('a wire whose model changed under it is reported, not dropped', () => {
  const graph = chain();
  (graph.nodes[2] as { model: string }).model = 'sim/llm';
  const edge = errorsOf(validateGraph(graph, catalog)).find((i) => i.code === 'edge');
  assert.deepEqual([edge?.edge?.from, edge?.refusal], ['image.image', 'unknown-out']);
});

test('a model can stand in for another when it has the ports the graph wires: the cheapest known first', () => {
  const graph = chain();
  const real = catalogOf([
    ...sim,
    specOf('a-ven00001', { model: 'i2v-pro', name: '', preset: 'image-to-video', source: 'listed', price: { perCall: 0.9 } }),
    specOf('a-ven00001', { model: 'i2v-fast', name: '', preset: 'image-to-video', source: 'listed', price: { perCall: 0.1 } }),
    // No image input: it cannot take the wire that brings the image.
    specOf('a-ven00001', { model: 't2v', name: '', preset: 'text-to-video', source: 'listed' }),
  ]);
  assert.deepEqual(equivalents(graph, graph.nodes[3], real, (m) => m.provider !== 'sim').map((m) => m.ref), ['a-ven00001/i2v-fast', 'a-ven00001/i2v-pro']);
});

test('a saved graph is read strictly: its version, its ids, its wires, its conversions', () => {
  const code = (raw: unknown) => {
    try {
      parseGraph(raw);
      return 'ok';
    } catch (err) {
      assert.ok(err instanceof GraphFormatError);
      return err.code;
    }
  };
  assert.equal(code({ version: 2, nodes: [], edges: [] }), 'version');
  assert.equal(code({ version: 1, nodes: [{ id: 'a', kind: 'model' }, { id: 'a', kind: 'model' }], edges: [] }), 'node-twice');
  assert.equal(code({ version: 1, nodes: [{ id: 'a.b', kind: 'model' }], edges: [] }), 'node-id');
  assert.equal(code({ version: 1, nodes: [{ id: 'a', kind: 'worker' }], edges: [] }), 'node-kind');
  assert.equal(code({ version: 1, nodes: [{ id: 'c', kind: 'convert', convert: 'constructor' }], edges: [] }), 'convert');
  assert.equal(code({ version: 1, nodes: [], edges: [{ from: 'a"]x.b', to: 'c.d' }] }), 'edge');
  const graph = parseGraph({ version: 1, name: ' x ', nodes: [{ id: 'a', kind: 'model', model: 'sim/llm', junk: true, options: { duration: '5s', bad: 3 } }], edges: [] });
  assert.deepEqual(graph, { version: 1, name: 'x', nodes: [{ id: 'a', kind: 'model', model: 'sim/llm', options: { duration: '5s' }, x: 40, y: 80 }], edges: [] });
  // What is written reads back the same.
  assert.deepEqual(parseGraph(JSON.parse(serializeGraph(chain()))), chain());
});
