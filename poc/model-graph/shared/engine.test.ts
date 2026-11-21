import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SIM_MODELS, simRunner } from '../server/runners/sim';
import { runGraph, type NodeState, type RunEvent, type RunOptions, type Runner } from './engine';
import { catalogOf, parseGraph, type Graph } from './graph';

// The engine on the simulated provider: no network, and no waiting (the pauses end at once).

const catalog = catalogOf(SIM_MODELS);
const example = (): Graph => parseGraph(JSON.parse(readFileSync('poc/model-graph/examples/1-texte-image-video-analyse.json', 'utf8')));
/** A pause that lets the other nodes move on, then ends. */
const sleep = async (_ms: number, signal: AbortSignal) => {
  await new Promise((resolve) => setImmediate(resolve));
  if (signal.aborted) throw signal.reason;
};
const sim: RunOptions['runnerFor'] = (_node, spec) => (spec ? simRunner(spec, { sleep }) : null);

function record() {
  const events: RunEvent[] = [];
  const states = (id: string) => events.flatMap((e) => (e.type === 'node' && e.id === id ? [e.state] : [])).filter((s, i, all) => s !== all[i - 1]);
  return { events, states, onEvent: (e: RunEvent) => void events.push(e) };
}

test('LLM → image → video → LLM, simulated, from the chat’s message to its answer', async () => {
  const log = record();
  const result = await runGraph({ graph: example(), catalog, input: { text: 'Un renard dans la neige' }, runnerFor: sim, sleep, onEvent: log.onEvent });

  assert.equal(result.state, 'done');
  assert.equal(result.error, undefined);
  // What reached the chat: the video, and the last LLM's words about it.
  const [video] = result.outputs.video;
  assert.ok(video.type === 'video' && video.mime === 'video/mp4');
  assert.equal(Buffer.from(video.bytes.subarray(4, 8)).toString('latin1'), 'ftyp');
  const [text] = result.outputs.text;
  assert.ok(text.type === 'text');
  assert.match(text.text, /La vidéo \(192×112, 3 s\) montre un paysage/);
  // The request went through every step: the prompt writer's words are what the image, then the video, were made from.
  assert.match(text.text, /Un renard dans la neige, lumière dorée/);

  // Every node waited, ran, ended; none ran before what it reads had ended.
  for (const id of ['in', 'writer', 'image', 'video', 'critic', 'out']) assert.deepEqual(log.states(id), ['pending', 'running', 'done'], id);
  const done = log.events.flatMap((e) => (e.type === 'node' && e.state === 'done' ? [e.id] : []));
  assert.deepEqual(done, ['in', 'writer', 'image', 'video', 'critic', 'out']);
  const firstRunning = (id: string) => log.events.findIndex((e) => e.type === 'node' && e.id === id && e.state === 'running');
  const ended = (id: string) => log.events.findIndex((e) => e.type === 'node' && e.id === id && e.state === 'done');
  assert.ok(firstRunning('video') > ended('image') && firstRunning('critic') > ended('video'));

  // The video went through a queue: taken, asked for several times, then there.
  const progress = log.events.flatMap((e) => (e.type === 'node' && e.id === 'video' && e.progress ? [e.progress] : []));
  assert.deepEqual(progress.slice(0, 2), ['dans la file du fournisseur', 'dans la file du fournisseur']);
  assert.ok(progress.includes('génération 80 %'));

  // The intermediate results are in the events, for the editor to show on each node.
  const image = log.events.find((e) => e.type === 'node' && e.id === 'image' && e.state === 'done');
  assert.ok(image?.type === 'node' && image.outputs?.image[0].type === 'image' && image.outputs.image[0].mime === 'image/png');
  assert.equal(log.events[0].type === 'run' && log.events[0].state, 'running');
  const last = log.events.at(-1);
  assert.ok(last?.type === 'run' && last.state === 'done');
  // One image, one video, two completions.
  assert.ok(result.costUsd > 0.13 && result.costUsd < 0.14, String(result.costUsd));
});

test('the cap of a run: the step that would pass it is not started, the ones after it neither', async () => {
  const log = record();
  const result = await runGraph({ graph: example(), catalog, input: { text: 'Un renard' }, runnerFor: sim, sleep, onEvent: log.onEvent, maxCostUsd: 0.05 });
  assert.equal(result.state, 'error');
  assert.match(result.error ?? '', /« Anime l’image » : cette étape coûterait environ 0,12 \$, ce qui dépasse le plafond de 0,050 \$/);
  assert.deepEqual(result.outputs, {});
  assert.deepEqual(
    Object.fromEntries(['writer', 'image', 'video', 'critic', 'out'].map((id) => [id, result.states[id]])),
    { writer: 'done', image: 'done', video: 'error', critic: 'skipped', out: 'skipped' } satisfies Record<string, NodeState>,
  );
  assert.ok(result.costUsd < 0.05);
});

test('a provider’s refusal stops the run with its words, and nothing after it is called', async () => {
  const called: string[] = [];
  const runnerFor: RunOptions['runnerFor'] = (node, spec) => {
    if (node.id === 'image') {
      return {
        async run() {
          throw new Error('le fournisseur a répondu 402 : crédit épuisé');
        },
      };
    }
    const runner = sim(node, spec) as Runner;
    if (!('run' in runner)) return { ...runner, submit: (call, ctx) => (called.push(node.id), runner.submit(call, ctx)) };
    return { ...runner, run: (call, ctx) => (called.push(node.id), runner.run(call, ctx)) };
  };
  const result = await runGraph({ graph: example(), catalog, input: { text: 'x' }, runnerFor, sleep });
  assert.equal(result.state, 'error');
  assert.equal(result.error, '« Crée l’image » : le fournisseur a répondu 402 : crédit épuisé');
  assert.deepEqual(called, ['writer']);
  assert.equal(result.states.video, 'skipped');
});

test('two branches that do not depend on each other run at the same time', async () => {
  const graph: Graph = {
    version: 1,
    name: 'two',
    nodes: [
      { id: 'in', kind: 'chat-input', x: 0, y: 0 },
      { id: 'a', kind: 'model', model: 'sim/text-to-image', x: 0, y: 0 },
      { id: 'b', kind: 'model', model: 'sim/llm', x: 0, y: 0 },
      { id: 'unused', kind: 'model', model: 'sim/llm', x: 0, y: 0 },
      { id: 'out', kind: 'chat-output', x: 0, y: 0 },
    ],
    edges: [
      { from: 'in.text', to: 'a.prompt' },
      { from: 'in.text', to: 'b.prompt' },
      { from: 'in.text', to: 'unused.prompt' },
      { from: 'a.image', to: 'out.image' },
      { from: 'b.text', to: 'out.text' },
    ],
  };
  const log = record();
  const result = await runGraph({ graph, catalog, input: { text: 'x' }, runnerFor: sim, sleep, onEvent: log.onEvent });
  assert.equal(result.state, 'done');
  const at = (id: string, state: NodeState) => log.events.findIndex((e) => e.type === 'node' && e.id === id && e.state === state);
  assert.ok(at('a', 'running') < at('b', 'done') && at('b', 'running') < at('a', 'done'));
  assert.deepEqual(Object.keys(result.outputs).filter((port) => result.outputs[port].length), ['text', 'image']);
  // A node that does not lead to the answer costs nothing: it is not run.
  assert.deepEqual(log.states('unused'), ['skipped']);
});

test('stopping a run: the job in the queue is no longer asked for', async () => {
  const stop = new AbortController();
  const log = record();
  const result = await runGraph({
    graph: example(),
    catalog,
    input: { text: 'x' },
    runnerFor: sim,
    sleep,
    signal: stop.signal,
    onEvent(e) {
      log.onEvent(e);
      if (e.type === 'node' && e.id === 'video' && e.progress === 'génération 20 %') stop.abort(new Error('stopped'));
    },
  });
  assert.equal(result.state, 'cancelled');
  assert.deepEqual(result.outputs, {});
  assert.equal(result.states.video, 'skipped');
  assert.equal(result.states.critic, 'skipped');
  assert.ok(!log.events.some((e) => e.type === 'node' && e.progress === 'génération 60 %'));
});

test('a graph that cannot run is refused before anything is called', async () => {
  const graph = example();
  graph.edges = graph.edges.filter((e) => e.to !== 'video.image');
  let asked = 0;
  const result = await runGraph({ graph, catalog, input: { text: 'x' }, runnerFor: (n, s) => (asked++, sim(n, s)) });
  assert.equal(result.state, 'error');
  assert.match(result.error ?? '', /« Anime l’image » : l’entrée « image » \(image\) doit être reliée/);
  assert.equal(asked, 0);
});

test('the conversation goes to the nodes the chat’s text is wired to, and only to them', async () => {
  const seen: Record<string, number> = {};
  const runnerFor: RunOptions['runnerFor'] = (node, spec) => {
    const runner = sim(node, spec) as Runner;
    if (!('run' in runner)) return runner;
    return { ...runner, run: (call, ctx) => ((seen[node.id] = call.history.length), runner.run(call, ctx)) };
  };
  const history = [
    { role: 'user' as const, text: 'Un renard' },
    { role: 'assistant' as const, text: 'Voilà.' },
  ];
  await runGraph({ graph: example(), catalog, input: { text: 'Plus de neige' }, history, runnerFor, sleep });
  assert.deepEqual(seen, { writer: 2, image: 0, critic: 0 });
});
