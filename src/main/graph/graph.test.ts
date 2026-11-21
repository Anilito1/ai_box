import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { plainSay, runGraph, type NodeState, type RunEvent, type RunOptions, type Runner } from '../../shared/graph/engine';
import { catalogOf, type Graph } from '../../shared/graph/format';
import type { GraphRunEvent } from '../../shared/graph/protocol';
import { specOf } from '../../shared/modelCaps';
import type { Account } from '../../shared/types';
import { checkOpenAI } from '../accounts';
import { EXAMPLES } from './examples';
import { mp4 } from './media/mp4';
import { paint } from './media/paint';
import { png } from './media/png';
import { realRunner } from './runners/real';
import { simModels, simRunner } from './runners/sim';
import { GraphService } from './service';

// The graphs in the main process: the engine on the simulated provider, the real calls against a provider answered
// here (no call leaves this computer, the key is a made-up one), the graphs' files and the run_graph tool.

const KEY = 'fake-graph-key-0123456789';
const VENICE = 'https://api.venice.ai/api/v1';
const root = mkdtempSync(join(tmpdir(), 'hub-graphs-'));
after(() => rmSync(root, { recursive: true, force: true }));
let folders = 0;
const folder = () => join(root, `f-${++folders}`);

/** A pause that lets the other nodes move on, then ends. */
const sleep = async (_ms: number, signal: AbortSignal) => {
  await new Promise((resolve) => setImmediate(resolve));
  if (signal.aborted) throw signal.reason;
};
const catalog = catalogOf(simModels());
const chain = (): Graph => EXAMPLES[0].graph();
const sim: RunOptions['runnerFor'] = (_node, spec) => (spec ? simRunner(spec, { sleep }) : null);

function record() {
  const events: RunEvent[] = [];
  const states = (id: string) => events.flatMap((e) => (e.type === 'node' && e.id === id ? [e.state] : [])).filter((s, i, all) => s !== all[i - 1]);
  return { events, states, onEvent: (e: RunEvent) => void events.push(e) };
}

test('LLM → image → video → LLM, simulated, from the chat’s message to its answer', async () => {
  const log = record();
  const result = await runGraph({ graph: chain(), catalog, input: { text: 'A fox in the snow' }, runnerFor: sim, sleep, onEvent: log.onEvent });
  assert.equal(result.state, 'done', result.error);
  // What reached the chat: a real MP4, and the last LLM's words about it.
  const [video] = result.outputs.video;
  assert.ok(video.type === 'video' && video.mime === 'video/mp4');
  assert.equal(Buffer.from(video.bytes.subarray(4, 8)).toString('latin1'), 'ftyp');
  const [text] = result.outputs.text;
  assert.ok(text.type === 'text');
  assert.match(text.text, /^The video \(192×112, 3 s\) shows a landscape of hills/);
  // The request went through every step: the prompt writer's words are what the image, then the video, came from.
  assert.match(text.text, /“A fox in the snow, golden evening light/);

  // Every node waited, ran, ended; none ran before what it reads had ended.
  for (const id of ['in', 'writer', 'image', 'video', 'critic', 'out']) assert.deepEqual(log.states(id), ['pending', 'running', 'done'], id);
  const at = (id: string, state: NodeState) => log.events.findIndex((e) => e.type === 'node' && e.id === id && e.state === state);
  assert.ok(at('video', 'running') > at('image', 'done') && at('critic', 'running') > at('video', 'done'));
  // The video went through a queue: taken, asked for again and again, then there.
  const progress = log.events.flatMap((e) => (e.type === 'node' && e.id === 'video' && e.progress ? [e.progress] : []));
  assert.deepEqual(progress.slice(0, 2), ['run.queued', 'being made']);
  assert.ok(progress.includes('being made: 80 %'));
  // One image, one video, two completions.
  assert.ok(result.costUsd > 0.13 && result.costUsd < 0.14, String(result.costUsd));
});

test('the cap of a run: the step that would pass it is not started, nor the ones after it', async () => {
  const result = await runGraph({ graph: chain(), catalog, input: { text: 'x' }, runnerFor: sim, sleep, maxCostUsd: 0.05, say: plainSay });
  assert.equal(result.state, 'error');
  assert.match(result.error ?? '', /^run\.failed node=Animates the image error=run\.over-cap estimate=0\.12 cap=0\.050 spent=0\.010/);
  assert.deepEqual(['writer', 'image', 'video', 'critic', 'out'].map((id) => result.states[id]), ['done', 'done', 'error', 'skipped', 'skipped']);
  assert.deepEqual(result.outputs, {});
});

test('a call of unknown price is refused when the settings say so; a free one is not', async () => {
  const runnerFor: RunOptions['runnerFor'] = (node, spec) => {
    const runner = sim(node, spec) as Runner;
    // The image model gives no estimate.
    return node.id === 'image' ? { ...runner, estimate: undefined } : runner;
  };
  const result = await runGraph({ graph: chain(), catalog, input: { text: 'x' }, runnerFor, sleep, refuseUnknownPrice: true, say: plainSay });
  assert.equal(result.error, 'run.failed node=Makes the image error=run.unknown-price');
  assert.equal(result.states.writer, 'done');
});

test('a provider’s refusal stops the run with its words, and nothing after it is called', async () => {
  const called: string[] = [];
  const runnerFor: RunOptions['runnerFor'] = (node, spec) => {
    if (node.id === 'image') return { run: async () => Promise.reject(new Error('the provider answered 402: no credit')) };
    const runner = sim(node, spec) as Runner;
    if (!('run' in runner)) return { ...runner, submit: (call, ctx) => (called.push(node.id), runner.submit(call, ctx)) };
    return { ...runner, run: (call, ctx) => (called.push(node.id), runner.run(call, ctx)) };
  };
  const result = await runGraph({ graph: chain(), catalog, input: { text: 'x' }, runnerFor, sleep });
  assert.equal(result.error, 'run.failed node=Makes the image error=the provider answered 402: no credit');
  assert.deepEqual(called, ['writer']);
  assert.equal(result.states.video, 'skipped');
});

test('stopping a run: the job in the queue is no longer asked for', async () => {
  const stop = new AbortController();
  const log = record();
  const result = await runGraph({
    graph: chain(),
    catalog,
    input: { text: 'x' },
    runnerFor: sim,
    sleep,
    signal: stop.signal,
    onEvent(e) {
      log.onEvent(e);
      if (e.type === 'node' && e.id === 'video' && e.progress === 'being made: 20 %') stop.abort(new Error('stopped'));
    },
  });
  assert.equal(result.state, 'cancelled');
  assert.deepEqual([result.states.video, result.states.critic], ['skipped', 'skipped']);
  assert.ok(!log.events.some((e) => e.type === 'node' && e.progress === 'being made: 60 %'));
});

test('a graph that cannot run is refused before anything is called; the conversation goes only where the chat’s text goes', async () => {
  const graph = chain();
  graph.edges = graph.edges.filter((e) => e.to !== 'video.image');
  let asked = 0;
  const refused = await runGraph({ graph, catalog, input: { text: 'x' }, runnerFor: (n, s) => (asked++, sim(n, s)) });
  assert.deepEqual([refused.state, refused.issues?.map((i) => i.code), asked], ['error', ['required'], 0]);

  const seen: Record<string, number> = {};
  const runnerFor: RunOptions['runnerFor'] = (node, spec) => {
    const runner = sim(node, spec) as Runner;
    return 'run' in runner ? { ...runner, run: (call, ctx) => ((seen[node.id] = call.history.length), runner.run(call, ctx)) } : runner;
  };
  const history = [
    { role: 'user' as const, text: 'A fox' },
    { role: 'assistant' as const, text: 'There.' },
  ];
  await runGraph({ graph: chain(), catalog, input: { text: 'More snow' }, history, runnerFor, sleep });
  assert.deepEqual(seen, { writer: 2, image: 0, critic: 0 });
});

/** A provider that answers what Venice's and OpenAI's documents describe, and keeps what it was sent. */
function provider() {
  const calls: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  let polls = 0;
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ url, auth: new Headers(init?.headers).get('authorization'), body });
    const path = url.replace(VENICE, '');
    if (path === '/chat/completions') return json({ choices: [{ message: { content: `seen ${JSON.stringify(body.messages).length} chars` } }], usage: { prompt_tokens: 1000, completion_tokens: 500 } });
    if (path === '/image/generate') return json({ images: [Buffer.from(png(paint(1, 16, 16), 16, 16)).toString('base64')] });
    if (path === '/image/edit' || path === '/image/multi-edit') return new Response(Buffer.from(png(paint(2, 16, 16), 16, 16)), { headers: { 'content-type': 'image/svg+xml' } });
    if (path === '/video/quote') return json({ quote: 0.4 });
    if (path === '/video/queue') return json({ model: body.model, queue_id: 'q-1' });
    if (path === '/video/retrieve') return ++polls < 3 ? json({ status: 'PROCESSING', average_execution_time: 60000, execution_duration: polls * 5000 }) : new Response(Buffer.from(mp4([paint(3, 16, 16)], 16, 16, 8)), { headers: { 'content-type': 'video/mp4' } });
    if (path === '/video/complete') return json({ success: true });
    if (path === '/models?type=all') return json({ data: [{ id: 'deepseek', type: 'text', model_spec: { pricing: { input: { usd: 1 }, output: { usd: 2 } } } }, { id: 'flux-3', type: 'image', model_spec: { name: 'Flux 3', pricing: { generation: { usd: 0.03 } } } }, { id: 'qwen-edit', type: 'inpaint', model_spec: {} }, { id: 'bge', type: 'embedding' }] });
    return json({ error: { message: `no such thing, said to ${KEY}` } }, 404);
  }) as typeof fetch;
  return { calls, fetch: fake };
}

test('real mode: the same chain on a chat model, Venice’s images and its video queue (the hub’s adapter)', async () => {
  const p = provider();
  const access = { baseUrl: VENICE, key: KEY, fetch: p.fetch };
  const models = [
    specOf('v', { model: 'deepseek', name: '', preset: 'llm', source: 'listed', price: { input: 1, output: 2 } }),
    specOf('v', { model: 'flux-3', name: '', preset: 'text-to-image', source: 'listed', price: { perCall: 0.03 } }),
    specOf('v', { model: 'wan-i2v', name: '', preset: 'image-to-video', source: 'listed', durations: ['5s', '10s'], resolutions: ['720p'] }),
    specOf('v', { model: 'gemini', name: '', preset: 'llm-video', source: 'listed', price: { input: 2, output: 8 } }),
  ];
  const graph = chain();
  const swap: Record<string, string> = { writer: 'v/deepseek', image: 'v/flux-3', video: 'v/wan-i2v', critic: 'v/gemini' };
  for (const node of graph.nodes) if (node.kind === 'model') node.model = swap[node.id];
  const result = await runGraph({ graph, catalog: catalogOf(models), input: { text: 'A fox' }, history: [{ role: 'user', text: 'before' }], runnerFor: (_n, spec) => (spec ? realRunner(access, spec) : null), sleep });
  assert.equal(result.state, 'done', result.error);
  assert.deepEqual(p.calls.map((c) => c.url.replace(VENICE, '')), ['/chat/completions', '/image/generate', '/video/quote', '/video/queue', '/video/retrieve', '/video/retrieve', '/video/retrieve', '/video/complete', '/chat/completions']);
  assert.ok(p.calls.every((c) => c.auth === `Bearer ${KEY}`));
  const [writer, image, , queue, , , , , critic] = p.calls.map((c) => c.body);
  assert.equal((writer.messages as { role: string }[]).map((m) => m.role).join(), 'system,user,user');
  // The image made by the step before starts the video; the model's first values stand for the ones not chosen
  // (the "3s" kept from the simulated model is not one Venice's model takes).
  assert.deepEqual({ ...queue, image_url: String(queue.image_url).slice(0, 22) }, { model: 'wan-i2v', duration: '5s', resolution: '720p', prompt: image.prompt, image_url: 'data:image/png;base64,' });
  // The last model gets the video itself, and no history: the chat is not wired to it.
  const parts = (critic.messages as { content: { type: string }[] }[]).at(-1)?.content ?? [];
  assert.deepEqual(parts.map((x) => x.type), ['video_url']);
  assert.equal((result.costUsd).toFixed(4), (0.002 + 0.03 + 0.4 + 0.006).toFixed(4));
});

test('real mode: one reference image is an edit, several are combined; a type that could hold a script is not trusted; a refusal hides the key', async () => {
  const p = provider();
  const access = { baseUrl: VENICE, key: KEY, fetch: p.fetch };
  const edit = specOf('v', { model: 'qwen-edit', name: '', preset: 'reference-to-image', source: 'listed' });
  const picture = { type: 'image' as const, mime: 'image/png', bytes: png(paint(3, 16, 16), 16, 16) };
  const ctx = { signal: new AbortController().signal, progress: () => undefined };
  const runner = realRunner(access, edit) as Extract<Runner, { run: unknown }>;
  const call = (images: (typeof picture)[]) => ({ node: { id: 'edit', kind: 'model' as const, model: edit.ref, x: 0, y: 0 }, spec: edit, history: [], inputs: { prompt: [{ type: 'text' as const, text: 'in winter' }], images } });
  const one = await runner.run(call([picture]), ctx);
  // The provider said SVG: the bytes say PNG.
  assert.equal((one.outputs.image[0] as { mime: string }).mime, 'image/png');
  await runner.run(call([picture, picture]), ctx);
  assert.deepEqual(p.calls.map((c) => [c.url.replace(VENICE, ''), Object.keys(c.body).sort().join()]), [['/image/edit', 'image,model,prompt'], ['/image/multi-edit', 'images,modelId,prompt']]);
  const speech = realRunner(access, specOf('v', { model: 'tts', name: '', preset: 'text-to-speech', source: 'listed' })) as typeof runner;
  await assert.rejects(speech.run({ ...call([]), inputs: { text: [{ type: 'text', text: 'hello' }] } }, ctx), (err: Error) => /answered 404: no such thing, said to ••••/.test(err.message) && !err.message.includes(KEY));
  // A video model the adapter cannot feed (it starts from a video), or elsewhere than Venice: none.
  assert.equal(realRunner(access, specOf('v', { model: 'v2v', name: '', preset: 'video-to-video', source: 'listed' })), null);
  assert.equal(realRunner({ ...access, baseUrl: 'https://api.example.com/v1' }, specOf('x', { model: 'sora', name: '', preset: 'text-to-video', source: 'listed' })), null);
});

test('a provider’s list read for its check: every type asked of Venice, the shapes kept, only chat models for sessions', async () => {
  const p = provider();
  const real = globalThis.fetch;
  globalThis.fetch = p.fetch;
  try {
    const st = await checkOpenAI(VENICE, KEY);
    assert.equal(p.calls[0].url, `${VENICE}/models?type=all`);
    assert.deepEqual(st.models, ['deepseek']);
    assert.deepEqual(st.shapes?.map((s) => [s.model, s.preset]), [['deepseek', 'llm'], ['flux-3', 'text-to-image'], ['qwen-edit', 'reference-to-image']]);
  } finally {
    globalThis.fetch = real;
  }
});

const account = (o: Partial<Account> = {}): Account => ({ id: 'a-ven00001', kind: 'openai', name: 'Venice', baseUrl: VENICE, model: 'deepseek', smallModel: '', slug: 'venice', models: ['deepseek', 'typed-model'], isolated: false, ...o });

function service(accounts: Account[] = [account()]) {
  const p = provider();
  const out = folder();
  const graphs = new GraphService({ dir: folder(), runsDir: folder(), outDir: () => out, accounts: () => accounts, key: () => KEY, fetch: p.fetch, sleep });
  return { graphs, p, out };
}

test('the catalog: the simulated models, then each account’s, its declarations winning', () => {
  const { graphs } = service([account({ modelCaps: { 'flux-3': { preset: 'reference-to-image', maxImages: 2 } }, videoModels: ['my-video'] })]);
  // Nothing listed yet: only what the account holds.
  const first = graphs.catalogView();
  assert.deepEqual(first.providers.map((p) => p.id), ['sim', 'a-ven00001']);
  assert.deepEqual(first.models.filter((m) => m.provider !== 'sim').map((m) => [m.model, m.preset, m.source]), [['deepseek', 'llm', 'guessed'], ['flux-3', 'reference-to-image', 'manual'], ['my-video', 'text-to-video', 'guessed'], ['typed-model', 'llm', 'guessed']]);
  graphs.noteListed('a-ven00001', [{ model: 'deepseek', name: 'DeepSeek', preset: 'llm', source: 'listed', price: { input: 1 } }]);
  const listed = graphs.catalogView().models.find((m) => m.ref === 'a-ven00001/deepseek');
  assert.deepEqual([listed?.name, listed?.source], ['DeepSeek', 'listed']);
  assert.deepEqual(graphs.shapesView(account()), { listed: [{ model: 'deepseek', preset: 'llm', source: 'listed' }], manual: {} });
  // An account a graph cannot call (a Claude sign-in) brings nothing.
  const { graphs: none } = service([account({ id: 'a-cla00001', kind: 'claude', slug: '', baseUrl: '' })]);
  assert.deepEqual(none.catalogView().providers.map((p) => p.id), ['sim']);
});

test('graphs are files: created from an example, saved, copied, listed, deleted; a bad one is refused', () => {
  const { graphs } = service();
  const made = graphs.create({ example: 'image-video-review' });
  assert.ok(made.ok && made.id && /^g-[a-z0-9]{8}$/.test(made.id));
  const id = made.id as string;
  const graph = graphs.get(id) as Graph;
  assert.equal(graph.name, 'Text → image → video → review');
  assert.deepEqual(graphs.save(id, { ...graph, name: 'Mine' }), { ok: true, error: '', id });
  assert.deepEqual(graphs.save(id, { version: 7 }), { ok: false, error: 'format:version' });
  assert.deepEqual(graphs.save('../../etc', graph), { ok: false, error: 'not-found' });
  const copy = graphs.create({ copy: id });
  assert.deepEqual(graphs.list().graphs.map((g) => g.name), ['Mine', 'Mine (copy)']);
  assert.deepEqual(graphs.list().examples.map((e) => e.id), ['image-video-review', 'video-frames', 'reference-image']);
  assert.deepEqual(graphs.create({ example: 'nope' }), { ok: false, error: 'not-found' });
  graphs.delete(copy.id as string);
  assert.deepEqual(graphs.list().graphs.map((g) => g.id), [id]);
  // The costs' settings: a cap always on, within bounds.
  assert.deepEqual(graphs.prefs(), { maxUsd: 1, refuseUnknownPrice: false });
  assert.deepEqual(graphs.prefs({ maxUsd: 1e9, refuseUnknownPrice: true }), { maxUsd: 100, refuseUnknownPrice: true });
  assert.deepEqual(graphs.prefs({ maxUsd: -1 }), { maxUsd: 1, refuseUnknownPrice: false });
});

test('run_graph refuses an image, a video or a voice of unknown price, which the cap would count as free', async () => {
  const { graphs } = service();
  graphs.noteListed('a-ven00001', [{ model: 'flux-3', name: 'Flux 3', preset: 'text-to-image', source: 'listed' }]);
  const id = graphs.create({ blank: true }).id as string;
  const graph = graphs.get(id) as Graph;
  graph.nodes.push({ id: 'image', kind: 'model', model: 'a-ven00001/flux-3', x: 0, y: 0 });
  graph.edges.push({ from: 'in.text', to: 'image.prompt' }, { from: 'image.image', to: 'out.image' });
  assert.equal(graphs.save(id, graph).ok, true);
  await assert.rejects(graphs.toolRun({ graph: id, message: 'a fox' }, { cwd: root, signal: new AbortController().signal }), /its price is not known beforehand/);
});

test('a test run of the view: its events, its files fetched by name, nothing else readable', async () => {
  const { graphs } = service();
  const events: GraphRunEvent[] = [];
  await graphs.run('r-test-0001', { graph: chain(), text: 'A fox', images: [], history: [], maxUsd: 5 }, (e) => events.push(e));
  const last = events.at(-1);
  assert.ok(last?.type === 'run' && last.state === 'done', JSON.stringify(last));
  const out = events.find((e) => e.type === 'node' && e.id === 'out' && e.state === 'done');
  const video = out?.type === 'node' ? out.outputs?.video[0] : undefined;
  assert.ok(video?.type === 'video' && /^video-video-\d+\.mp4$/.test(video.file), JSON.stringify(video));
  // The same file is shown on the node that made it and in the answer.
  const made = events.find((e) => e.type === 'node' && e.id === 'video' && e.state === 'done');
  assert.ok(made?.type === 'node' && made.outputs?.video[0].type === 'video' && made.outputs.video[0].file === video.file);
  const file = graphs.media('r-test-0001', video.file);
  assert.deepEqual([file?.mime, file?.data.length], ['video/mp4', video.size]);
  assert.equal(graphs.media('r-test-0001', '../../secrets.json'), null);
  assert.equal(graphs.media('..', video.file), null);
  // The queued job never reaches the view.
  assert.ok(!JSON.stringify(events).includes('"job"'));
});

test('run_graph: a saved graph by its name, under the user’s cap, its files saved for the user', async () => {
  const { graphs, out } = service();
  const id = graphs.create({ example: 'image-video-review' }).id as string;
  assert.match(graphs.toolList(), /^1 graphs \(each run is capped at 1\.00 \$/);
  assert.match(graphs.toolList(), new RegExp(`${id} · Text → image → video → review · takes: text · gives: text, video · 4 models`));
  const said = await graphs.toolRun({ graph: 'text → image → video → review', message: 'A fox' }, { cwd: root, signal: new AbortController().signal });
  assert.match(said, /^Graph “Text → image → video → review” ran: 6 steps, 0\.13\d \$\./);
  assert.match(said, /Answer:\nThe video \(192×112, 3 s\) shows/);
  const dir = join(out, 'graphs', readdirSync(join(out, 'graphs'))[0]);
  assert.deepEqual(readdirSync(dir), ['video-1.mp4']);
  assert.ok(said.includes(join(dir, 'video-1.mp4')));
  // max_usd may only lower the user's cap.
  await assert.rejects(graphs.toolRun({ graph: id, message: 'x', max_usd: 0.05 }, { cwd: root, signal: new AbortController().signal }), /past the cap of 0\.050 \$/);
  graphs.prefs({ maxUsd: 0.05 });
  await assert.rejects(graphs.toolRun({ graph: id, message: 'x', max_usd: 50 }, { cwd: root, signal: new AbortController().signal }), /past the cap of 0\.050 \$/);
  await assert.rejects(graphs.toolRun({ graph: 'nope', message: 'x' }, { cwd: root, signal: new AbortController().signal }), new RegExp(`No graph “nope”\\. The graphs: ${id}`));
  // An image attached by path, and one that is not there.
  const ref = graphs.create({ example: 'reference-image' }).id as string;
  graphs.prefs({ maxUsd: 1 });
  writeFileSync(join(root, 'ref.png'), png(paint(5, 16, 16), 16, 16));
  assert.match(await graphs.toolRun({ graph: ref, message: 'in winter', images: ['ref.png'] }, { cwd: root, signal: new AbortController().signal }), /Files made/);
  // Only picture files: one that is not there, one whose name lies, one that is no picture at all.
  writeFileSync(join(root, 'notes.png'), 'secret notes');
  writeFileSync(join(root, 'config.json'), '{}');
  for (const path of ['missing.png', 'notes.png', 'config.json']) await assert.rejects(graphs.toolRun({ graph: ref, message: 'x', images: [path] }, { cwd: root, signal: new AbortController().signal }), /Not a picture file/, path);
  // Two runs of one graph in the same second: each its own folder.
  const [a, b] = await Promise.all([1, 2].map(() => graphs.toolRun({ graph: ref, message: 'same', images: ['ref.png'] }, { cwd: root, signal: new AbortController().signal })));
  const file = (said: string) => /image: (.+)$/m.exec(said)?.[1];
  assert.ok(file(a) && file(b) && file(a) !== file(b));
  assert.ok(existsSync(dir) && readFileSync(join(dir, 'video-1.mp4')).subarray(4, 8).toString('latin1') === 'ftyp');
});
