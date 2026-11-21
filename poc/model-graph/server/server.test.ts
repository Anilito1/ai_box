import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { get } from 'node:http';
import { after, test } from 'node:test';
import { specFromPreset } from '../shared/capabilities';
import { runGraph, type RunEvent } from '../shared/engine';
import { catalogOf, parseGraph, type Graph } from '../shared/graph';
import type { AppState, ClientEvent } from '../shared/protocol';
import { mp4 } from './media/mp4';
import { paint } from './media/paint';
import { png } from './media/png';
import { wav } from './media/wav';
import { providersFromEnv, readEnv } from './providers';
import { realRunner } from './runners/real';
import { startServer, type RunningServer } from './server';

// The POC's server and its real calls, with the providers answered here: no call leaves this computer, and the
// key is a made-up one.

const KEY = 'fake-graph-key-0123456789';
const VENICE = 'https://api.venice.ai/api/v1';
const example = (): Graph => parseGraph(JSON.parse(readFileSync('poc/model-graph/examples/1-texte-image-video-analyse.json', 'utf8')));
const sleep = async (_ms: number, signal: AbortSignal) => {
  await new Promise((resolve) => setImmediate(resolve));
  if (signal.aborted) throw signal.reason;
};

test('the simulated media are real files: a PNG, an MP4 a player can index, a WAV', () => {
  const image = png(paint(7, 32, 16), 32, 16);
  assert.deepEqual([...image.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const header = new DataView(image.buffer, image.byteOffset);
  assert.deepEqual([header.getUint32(16), header.getUint32(20)], [32, 16]);
  // The same seed draws the same picture; time moves it.
  assert.deepEqual(paint(7, 32, 16), paint(7, 32, 16));
  assert.notDeepEqual(paint(7, 32, 16, 0), paint(7, 32, 16, 1));

  const frames = [0, 0.5, 1].map((t) => paint(7, 32, 16, t));
  const video = Buffer.from(mp4(frames, 32, 16, 8));
  assert.equal(video.subarray(4, 8).toString('latin1'), 'ftyp');
  for (const box of ['moov', 'avcC', 'stsz', 'stco', 'mdat']) assert.ok(video.includes(box), box);
  // The index gives the address of the first picture: its length, then a key frame (NAL type 5).
  const stco = video.indexOf('stco');
  const first = video.readUInt32BE(stco + 12);
  assert.equal(video.subarray(first - 4, first).toString('latin1'), 'mdat');
  assert.equal(video[first + 4] & 0x1f, 5);
  // Two macroblocks of raw samples (384 bytes each) and a few bytes of header per picture.
  const size = video.readUInt32BE(first);
  assert.ok(size > 2 * 384 && size < 2 * 384 + 16, String(size));
  assert.throws(() => mp4(frames, 30, 16, 8), /multiples of 16/);

  const sound = Buffer.from(wav(7));
  assert.equal(sound.subarray(0, 4).toString('latin1') + sound.subarray(8, 12).toString('latin1'), 'RIFFWAVE');
  assert.equal(sound.readUInt32LE(4), sound.length - 8);
});

test('the .env file: providers by number, a key never required', () => {
  const env = readEnv('# comment\nPOC_PROVIDER_1_NAME=Venice\nPOC_PROVIDER_1_URL = https://api.venice.ai/api/v1 \nPOC_PROVIDER_1_KEY="k-1"\n\nPOC_PROVIDER_3_URL=http://localhost:1234/v1\nnot a line');
  assert.deepEqual(providersFromEnv(env), [
    { name: 'Venice', baseUrl: VENICE, key: 'k-1' },
    { name: 'Fournisseur 3', baseUrl: 'http://localhost:1234/v1', key: '' },
  ]);
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
    const path = url.replace(/^https:\/\/[^/]+(\/api)?\/v1/, '');
    if (path === '/chat/completions') return json({ choices: [{ message: { content: `seen ${JSON.stringify(body.messages).length} chars` } }], usage: { prompt_tokens: 1000, completion_tokens: 500 } });
    if (path === '/image/generate') return json({ images: [Buffer.from(png(paint(1, 16, 16), 16, 16)).toString('base64')] });
    if (path === '/image/edit' || path === '/image/multi-edit') return new Response(Buffer.from(png(paint(2, 16, 16), 16, 16)), { headers: { 'content-type': 'image/png' } });
    if (path === '/video/quote') return json({ quote: 0.4 });
    if (path === '/video/queue') return json({ model: body.model, queue_id: 'q-1' });
    if (path === '/video/retrieve') return ++polls < 3 ? json({ status: 'PROCESSING', average_execution_time: 60000, execution_duration: polls * 5000 }) : new Response(Buffer.from('made-up video'), { headers: { 'content-type': 'video/mp4' } });
    if (path === '/video/complete') return json({ success: true });
    if (path === '/models?type=all') return json({ data: [{ id: 'flux-3', type: 'image', model_spec: { name: 'Flux 3', pricing: { generation: { usd: 0.03 } } } }, { id: 'bge', type: 'embedding' }] });
    return json({ error: { message: `no such thing, said to ${KEY}` } }, 404);
  }) as typeof fetch;
  return { calls, fetch: fake };
}

test('real mode: the same graph on a chat model, Venice’s images and its video queue', async () => {
  const p = provider();
  const access = { baseUrl: VENICE, key: KEY, fetch: p.fetch };
  const models = [
    specFromPreset('v', 'deepseek', 'llm', { price: { input: 1, output: 2 } }),
    specFromPreset('v', 'flux-3', 'text-to-image', { price: { perCall: 0.03 } }),
    specFromPreset('v', 'wan-i2v', 'image-to-video', { durations: ['5s', '10s'], resolutions: ['720p'] }),
    specFromPreset('v', 'gemini', 'llm-video', { price: { input: 2, output: 8 } }),
  ];
  const graph = example();
  const swap: Record<string, string> = { writer: 'v/deepseek', image: 'v/flux-3', video: 'v/wan-i2v', critic: 'v/gemini' };
  for (const node of graph.nodes) if (swap[node.id]) node.model = swap[node.id];
  delete graph.nodes.find((n) => n.id === 'video')!.options;

  const events: RunEvent[] = [];
  const result = await runGraph({ graph, catalog: catalogOf(models), input: { text: 'Un renard' }, history: [{ role: 'user', text: 'avant' }], runnerFor: (_n, spec) => (spec ? realRunner(access, spec) : null), sleep, onEvent: (e) => void events.push(e) });
  assert.equal(result.error, undefined);
  assert.equal(result.state, 'done');
  assert.deepEqual(p.calls.map((c) => c.url.replace(VENICE, '')), ['/chat/completions', '/image/generate', '/video/quote', '/video/queue', '/video/retrieve', '/video/retrieve', '/video/retrieve', '/video/complete', '/chat/completions']);
  // The key goes to the provider's address, on every call.
  assert.ok(p.calls.every((c) => c.auth === `Bearer ${KEY}`));

  const [writer, image, , queue, , , , , critic] = p.calls.map((c) => c.body);
  assert.deepEqual(writer, {
    model: 'deepseek',
    stream: false,
    messages: [
      { role: 'system', content: graph.nodes[1].instruction },
      { role: 'user', content: 'avant' },
      { role: 'user', content: 'Un renard' },
    ],
  });
  const prompt = (result.outputs.text[0] as { text: string }).text;
  assert.deepEqual(image, { model: 'flux-3', prompt: `seen ${JSON.stringify(writer.messages).length} chars`, format: 'png' });
  // The image made by the step before starts the video; the model's first values stand for the ones not chosen.
  assert.deepEqual({ ...queue, image_url: String(queue.image_url).slice(0, 22) }, { model: 'wan-i2v', duration: '5s', resolution: '720p', prompt: image.prompt, image_url: 'data:image/png;base64,' });
  // The last model gets the video itself, and no history: the chat is not wired to it.
  const parts = (critic.messages as { role: string; content: { type: string; video_url?: { url: string } }[] }[]).at(-1)!.content;
  assert.deepEqual(parts.map((x) => x.type), ['video_url']);
  assert.equal(parts[0].video_url?.url, `data:video/mp4;base64,${Buffer.from('made-up video').toString('base64')}`);
  assert.equal((critic.messages as unknown[]).length, 2);
  assert.match(prompt, /^seen \d+ chars$/);

  // The costs: tokens at the list's price, the image's price, the video's quote.
  assert.equal(result.costUsd.toFixed(4), (0.002 + 0.03 + 0.4 + 0.006).toFixed(4));
  const waits = events.flatMap((e) => (e.type === 'node' && e.id === 'video' && e.progress ? [e.progress] : []));
  assert.deepEqual(waits.slice(-1), ['génération : 10 s sur 60 s en moyenne']);
});

test('real mode: one reference image is an edit, several are combined; a refusal never shows the key', async () => {
  const p = provider();
  const access = { baseUrl: VENICE, key: KEY, fetch: p.fetch };
  const edit = specFromPreset('v', 'qwen-edit', 'reference-to-image');
  const picture = { type: 'image' as const, mime: 'image/png', bytes: png(paint(3, 16, 16), 16, 16) };
  const node = { id: 'edit', kind: 'model' as const, model: edit.ref, x: 0, y: 0 };
  const ctx = { signal: new AbortController().signal, progress: () => undefined };
  const runner = realRunner(access, edit) as { run: (call: unknown, c: typeof ctx) => Promise<{ outputs: Record<string, { type: string; mime?: string }[]> }> };
  const call = (images: (typeof picture)[]) => ({ node, spec: edit, history: [], inputs: { prompt: [{ type: 'text' as const, text: 'en hiver' }], images } });

  const one = await runner.run(call([picture]), ctx);
  assert.deepEqual([one.outputs.image[0].type, one.outputs.image[0].mime], ['image', 'image/png']);
  await runner.run(call([picture, picture]), ctx);
  assert.deepEqual(p.calls.map((c) => [c.url.replace(VENICE, ''), Object.keys(c.body).sort().join()]), [
    ['/image/edit', 'image,model,prompt'],
    ['/image/multi-edit', 'images,modelId,prompt'],
  ]);

  const speech = realRunner(access, specFromPreset('v', 'tts', 'text-to-speech')) as typeof runner;
  await assert.rejects(speech.run({ node, spec: edit, history: [], inputs: { text: [{ type: 'text', text: 'bonjour' }] } }, ctx), (err: Error) => {
    assert.match(err.message, /le fournisseur a répondu 404 : no such thing, said to ••••/);
    assert.ok(!err.message.includes(KEY));
    return true;
  });
  // A video model elsewhere than Venice: no adapter, said before anything is called.
  assert.equal(realRunner({ ...access, baseUrl: 'https://api.example.com/v1' }, specFromPreset('x', 'sora', 'text-to-video')), null);
  // A model that starts from a video: the adapter cannot send one, so it is not called with the prompt alone.
  assert.equal(realRunner(access, specFromPreset('v', 'wan-edit', 'video-to-video')), null);
});

test('real mode: a priced chat call is estimated before it is made, and held to the cap', async () => {
  const p = provider();
  const llm = specFromPreset('v', 'deepseek', 'llm', { price: { input: 1, output: 2 } });
  const graph: Graph = {
    version: 1,
    name: 'one',
    nodes: [
      { id: 'in', kind: 'chat-input', x: 0, y: 0 },
      { id: 'a', kind: 'model', model: llm.ref, instruction: 'x'.repeat(4000), x: 0, y: 0 },
      { id: 'out', kind: 'chat-output', x: 0, y: 0 },
    ],
    edges: [
      { from: 'in.text', to: 'a.prompt' },
      { from: 'a.text', to: 'out.text' },
    ],
  };
  const run = (maxCostUsd: number) => runGraph({ graph, catalog: catalogOf([llm]), input: { text: 'bonjour' }, runnerFor: (_n, spec) => (spec ? realRunner({ baseUrl: VENICE, key: KEY, fetch: p.fetch }, spec) : null), sleep, maxCostUsd });
  // About a thousand tokens to send, at one dollar the million.
  const refused = await run(0.0005);
  assert.equal(refused.state, 'error');
  assert.match(refused.error ?? '', /dépasse le plafond/);
  assert.deepEqual(p.calls, []);
  assert.equal((await run(0.01)).state, 'done');
});

let server: RunningServer | undefined;
after(() => server?.close());

test('the server: the page’s token, a run streamed event by event, what it made served as files', async () => {
  const p = provider();
  server = await startServer({ root: 'poc/model-graph', assets: 'poc/model-graph/client', port: 0, simSpeed: 1000, fetch: p.fetch });
  const page = await (await fetch(server.url)).text();
  const token = /name="poc-token" content="([0-9a-f]{48})"/.exec(page)?.[1] ?? '';
  assert.ok(token);
  const headers = { 'x-poc-token': token, 'content-type': 'application/json' };

  // Without the page's token, or from a name that is not this computer's, nothing answers.
  assert.equal((await fetch(`${server.url}/api/state`)).status, 403);
  const elsewhere = await new Promise<number>((resolve, reject) => {
    get(`${server?.url}/api/state`, { headers: { ...headers, host: 'evil.example' } }, (answer) => resolve(answer.resume().statusCode ?? 0)).on('error', reject);
  });
  assert.equal(elsewhere, 403);

  const state = (await (await fetch(`${server.url}/api/state`, { headers })).json()) as AppState;
  assert.equal(state.examples.length, 3);
  assert.deepEqual(state.providers, []);
  assert.ok(state.models.every((m) => m.provider === 'sim'));

  // A provider typed in the page: its list is read at once, its key never comes back.
  const added = await fetch(`${server.url}/api/providers`, { method: 'POST', headers, body: JSON.stringify({ name: 'Venice', baseUrl: VENICE, key: KEY }) });
  const text = await added.text();
  assert.ok(!text.includes(KEY));
  const withVenice = JSON.parse(text) as AppState;
  assert.deepEqual(withVenice.providers, [{ id: 'venice', name: 'Venice', baseUrl: VENICE, hasKey: true, error: '', models: 1, manual: [], fromEnv: false }]);
  assert.deepEqual(withVenice.models.filter((m) => m.provider === 'venice').map((m) => [m.ref, m.name, m.api]), [['venice/flux-3', 'Flux 3', 'image']]);
  const declared = (await (await fetch(`${server.url}/api/providers/venice/declare`, { method: 'POST', headers, body: JSON.stringify({ model: 'ref-to-image', preset: 'reference-to-image', maxImages: 2 }) })).json()) as AppState;
  assert.deepEqual(declared.models.filter((m) => m.provider === 'venice').map((m) => [m.model, m.source]), [['flux-3', 'listed'], ['ref-to-image', 'manual']]);

  const res = await fetch(`${server.url}/api/run`, { method: 'POST', headers, body: JSON.stringify({ graph: example(), text: 'Un renard', images: [], history: [] }) });
  assert.equal(res.status, 200);
  const events = (await res.text()).trim().split('\n').map((line) => JSON.parse(line) as ClientEvent);
  const last = events.at(-1);
  assert.ok(last?.type === 'run' && last.state === 'done', JSON.stringify(last));
  const out = events.find((e) => e.type === 'node' && e.id === 'out' && e.state === 'done');
  assert.ok(out?.type === 'node' && out.outputs);
  const video = out.outputs.video[0];
  assert.ok(video.type === 'video' && /^\/artifact\/[0-9a-f]{24}$/.test(video.url));
  // The same file is shown on the node that made it and in the answer: one address.
  const made = events.find((e) => e.type === 'node' && e.id === 'video' && e.state === 'done');
  assert.ok(made?.type === 'node' && made.outputs?.video[0].type === 'video' && made.outputs.video[0].url === video.url);

  const file = await fetch(`${server.url}${video.url}`);
  // Opened in a tab of its own, a file made by a provider runs nothing.
  assert.deepEqual([file.status, file.headers.get('content-type'), file.headers.get('content-security-policy'), (await file.arrayBuffer()).byteLength], [200, 'video/mp4', 'sandbox', video.size]);
  const part = await fetch(`${server.url}${video.url}`, { headers: { range: 'bytes=4-7' } });
  assert.deepEqual([part.status, part.headers.get('content-range'), await part.text()], [206, `bytes 4-7/${video.size}`, 'ftyp']);
  assert.equal((await fetch(`${server.url}/artifact/${'0'.repeat(24)}`)).status, 404);

  const uncapped = await fetch(`${server.url}/api/run`, { method: 'POST', headers, body: JSON.stringify({ graph: example(), text: 'x', maxCostUsd: -1 }) });
  assert.deepEqual([uncapped.status, ((await uncapped.json()) as { error: string }).error], [400, 'Plafond invalide : un nombre positif, en dollars.']);
  const bad = await fetch(`${server.url}/api/run`, { method: 'POST', headers, body: JSON.stringify({ graph: { version: 9 }, text: 'x' }) });
  assert.deepEqual([bad.status, ((await bad.json()) as { error: string }).error], [400, 'Graphe illisible : version 9 inconnue (attendue : 1)']);
});
