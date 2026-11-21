import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { Account } from '../../shared/types';
import { manualVideoModel, type VideoModel } from '../../shared/video';
import { runVideo, videoRequest, VideoRunError } from './generate';
import { videoSpending, VideoService, type VideoSpend } from './service';
import { venice, veniceError, veniceModel } from './venice';

// Venice's video API, answered here: no call leaves this computer, and the key is a made-up one.

const KEY = 'fake-video-key-0123456789';
const BASE = 'https://api.venice.ai/api/v1';
const MP4 = Buffer.from('\u0000\u0000\u0000\u0018ftypmp42 a made-up video');
const root = mkdtempSync(join(tmpdir(), 'hub-video-'));
after(() => rmSync(root, { recursive: true, force: true }));
let folders = 0;
const folder = () => join(root, `out-${++folders}`);

interface Call {
  method: string;
  path: string;
  auth: string;
  body: Record<string, unknown>;
}
type Answer = (call: Call, n: number) => Response;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const mp4 = () => new Response(MP4, { status: 200, headers: { 'content-type': 'video/mp4' } });

/** A fetch answered by `answers`, by path; every call is kept. */
function server(answers: Record<string, Answer>) {
  const calls: Call[] = [];
  const count: Record<string, number> = {};
  const fake = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    init.signal?.throwIfAborted();
    const url = new URL(String(input));
    const path = url.origin === new URL(BASE).origin ? url.pathname.replace('/api/v1', '') + url.search : String(input);
    const call: Call = { method: init.method ?? 'GET', path, auth: String((init.headers as Record<string, string> | undefined)?.authorization ?? ''), body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} };
    calls.push(call);
    const answer = answers[path];
    if (!answer) return json({ error: `no route ${path}` }, 404);
    count[path] = (count[path] ?? 0) + 1;
    return answer(call, count[path]);
  };
  return { calls, fetch: fake as typeof fetch, paths: () => calls.map((c) => c.path) };
}

/** A clock that only moves when the code waits. */
function clock() {
  let at = 1_800_000_000_000;
  return { now: () => at, sleep: async (ms: number, signal: AbortSignal) => { signal.throwIfAborted(); at += ms; } };
}

const LISTED = {
  data: [
    { id: 'wan-2.5-preview-text-to-video', type: 'video', model_spec: { name: 'Wan 2.5', offline: false, constraints: { model_type: 'text-to-video', aspect_ratios: ['16:9', '9:16'], resolutions: ['480p', '720p'], durations: ['5s', '10s'], audio: true, audio_configurable: true } } },
    { id: 'wan-2.5-preview-image-to-video', type: 'video', model_spec: { name: 'Wan 2.5', constraints: { model_type: 'image-to-video', aspect_ratios: [], resolutions: ['720p'], durations: ['5s'], audio: false, audio_configurable: false } } },
    { id: 'gone-video', type: 'video', model_spec: { name: 'Gone', offline: true } },
    { id: 'venice-uncensored', type: 'text', model_spec: { name: 'Venice Uncensored' } },
    { type: 'video' },
    null,
  ],
};
const T2V = veniceModel(LISTED.data[0] as never) as VideoModel;
const I2V = veniceModel(LISTED.data[1] as never) as VideoModel;
const ctx = (fetch: typeof globalThis.fetch) => ({ baseUrl: BASE, key: KEY, signal: new AbortController().signal, fetch });
const REQUEST = { model: T2V.id, prompt: 'a fox running in the snow', duration: '5s' };

test('Venice’s list: only its video models that are on, with what each takes', async () => {
  const s = server({ '/models?type=video': () => json(LISTED) });
  const models = await venice.models(ctx(s.fetch));
  assert.deepEqual(models.map((m) => m.id), ['wan-2.5-preview-image-to-video', 'wan-2.5-preview-text-to-video']);
  assert.deepEqual(T2V, { id: 'wan-2.5-preview-text-to-video', name: 'Wan 2.5', input: 'text', durations: ['5s', '10s'], aspectRatios: ['16:9', '9:16'], resolutions: ['480p', '720p'], audioOption: true, manual: false });
  assert.equal(I2V.input, 'image');
  assert.deepEqual(s.calls[0], { method: 'GET', path: '/models?type=video', auth: `Bearer ${KEY}`, body: {} });
  const refused = server({ '/models?type=video': () => json({ error: 'nope' }, 500) });
  await assert.rejects(venice.models(ctx(refused.fetch)), /nope/);
});

test('a request is checked against the model before anything is sent', async () => {
  const dir = folder();
  const ask = (more: object, model = T2V) => videoRequest(model, { prompt: ' a fox ', ...more }, dir);
  assert.deepEqual(await ask({}), { model: T2V.id, prompt: 'a fox', duration: '5s' }, 'nothing said: the model’s first duration, the provider’s defaults');
  assert.deepEqual(await ask({ duration: '10', aspectRatio: '9:16', resolution: '720P', audio: false, negativePrompt: ' blur ' }), {
    model: T2V.id, prompt: 'a fox', negativePrompt: 'blur', duration: '10s', aspectRatio: '9:16', resolution: '720p', audio: false,
  });
  await assert.rejects(ask({ duration: '8s' }), /duration "8s" is not taken by wan-2\.5-preview-text-to-video\. It takes: 5s, 10s/);
  await assert.rejects(ask({ resolution: '4k' }), /It takes: 480p, 720p/);
  await assert.rejects(videoRequest(T2V, { prompt: '  ' }, dir), /Give a prompt/);
  await assert.rejects(ask({ image: 'https://example.com/a.png' }), /starts from the prompt alone/);
  await assert.rejects(ask({}, I2V), /starts from an image/);
  await assert.rejects(ask({}, { ...T2V, input: 'video' }), /reworks a video it is given/);
  // A model that does not let sound be chosen is not told about it.
  assert.equal('audio' in (await ask({ image: 'https://example.com/a.png', audio: true }, I2V)), false);

  // A file becomes a data: URL; an address goes as it is. A model named by hand takes whatever is asked.
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'start.png'), 'png bytes');
  assert.equal((await ask({ image: 'start.png' }, I2V)).imageUrl, `data:image/png;base64,${Buffer.from('png bytes').toString('base64')}`);
  assert.equal((await ask({ image: 'https://example.com/a.png' }, I2V)).imageUrl, 'https://example.com/a.png');
  await assert.rejects(ask({ image: 'missing.png' }, I2V), /Image not found/);
  await assert.rejects(ask({ image: 'notes.txt' }, I2V), /Not an image/);
  assert.deepEqual(await videoRequest(manualVideoModel('my-video'), { prompt: 'x', duration: '7s', resolution: 'odd' }, dir), { model: 'my-video', prompt: 'x', duration: '7s', resolution: 'odd' });
});

test('one video: priced, queued, asked for until it is there, saved, then released at the provider', async () => {
  const s = server({
    '/video/quote': () => json({ quote: 0.085 }),
    '/video/queue': () => json({ model: T2V.id, queue_id: 'q-1' }),
    '/video/retrieve': (_c, n) => (n < 3 ? json({ status: 'PROCESSING', average_execution_time: 145_000, execution_duration: 5000 * n }) : mp4()),
    '/video/complete': () => json({ success: true }),
  });
  const outDir = folder();
  const seen: string[] = [];
  const r = await runVideo({ adapter: venice, baseUrl: BASE, key: KEY, request: { ...REQUEST, aspectRatio: '16:9', imageUrl: undefined }, outDir, waitMs: 600_000, signal: new AbortController().signal, onJob: (j) => seen.push(j.id), fetch: s.fetch, ...clock() });
  assert.equal(r.kind, 'saved');
  if (r.kind !== 'saved') return;
  assert.deepEqual(s.paths(), ['/video/quote', '/video/queue', '/video/retrieve', '/video/retrieve', '/video/retrieve', '/video/complete']);
  assert.ok(s.calls.every((c) => c.method === 'POST' && c.auth === `Bearer ${KEY}`));
  // The price is asked on what sets it; the prompt only goes with the job.
  assert.deepEqual(s.calls[0].body, { model: T2V.id, duration: '5s', aspect_ratio: '16:9' });
  assert.deepEqual(s.calls[1].body, { model: T2V.id, duration: '5s', aspect_ratio: '16:9', prompt: 'a fox running in the snow' });
  assert.deepEqual(s.calls[2].body, { model: T2V.id, queue_id: 'q-1' });
  assert.deepEqual([r.usd, r.job.id, r.bytes, r.elapsedMs, seen], [0.085, 'q-1', MP4.length, 10_000, ['q-1']]);
  assert.deepEqual(readFileSync(r.path), MP4);
  assert.match(r.path, /\d{4}-\d\d-\d\d_\d{6}-wan-2\.5-preview-text-to-video\.mp4$/);
  assert.deepEqual(readdirSync(outDir).length, 1, 'no temporary file left');
});

test('a provider that gives an address for the video: fetched there without the key', async () => {
  const s = server({
    '/video/quote': () => json({ error: 'no price for this model' }, 400),
    '/video/queue': () => json({ model: T2V.id, queue_id: 'q-2', download_url: 'https://media.example.com/v/q-2.webm' }),
    '/video/retrieve': (_c, n) => json({ status: n < 2 ? 'PROCESSING' : 'COMPLETED', average_execution_time: 1, execution_duration: 1 }),
    'https://media.example.com/v/q-2.webm': () => new Response(MP4, { headers: { 'content-type': 'video/webm' } }),
    '/video/complete': () => json({ error: 'gone' }, 500),
  });
  const r = await runVideo({ adapter: venice, baseUrl: BASE, key: KEY, request: REQUEST, outDir: folder(), waitMs: 600_000, signal: new AbortController().signal, fetch: s.fetch, ...clock() });
  assert.equal(r.kind, 'saved');
  if (r.kind !== 'saved') return;
  assert.equal(r.usd, null, 'no price: the video is made all the same');
  assert.match(r.path, /\.webm$/);
  const download = s.calls.find((c) => c.path.startsWith('https://media.example.com')) as Call;
  assert.deepEqual([download.method, download.auth], ['GET', ''], 'the key stays with the provider’s own address');
});

test('the price alone, and a ceiling on it: nothing is queued', async () => {
  const s = server({ '/video/quote': () => json({ quote: 1.5 }), '/video/queue': () => json({ model: T2V.id, queue_id: 'never' }) });
  const base = { adapter: venice, baseUrl: BASE, key: KEY, request: REQUEST, outDir: folder(), waitMs: 60_000, signal: new AbortController().signal, fetch: s.fetch, ...clock() };
  assert.deepEqual(await runVideo({ ...base, quoteOnly: true }), { kind: 'quote', usd: 1.5 });
  await assert.rejects(runVideo({ ...base, maxUsd: 1 }), /Price quoted: \$1\.5, above the ceiling of \$1: nothing was queued/);
  const mute = server({ '/video/quote': () => json({}, 500) });
  await assert.rejects(runVideo({ ...base, fetch: mute.fetch, maxUsd: 1 }), /gave no price: nothing was queued/);
  assert.ok(![...s.paths(), ...mute.paths()].includes('/video/queue'));
});

test('a refusal says the provider’s own words, never the key', async () => {
  const run = (answers: Record<string, Answer>) => {
    const s = server({ '/video/quote': () => json({ quote: 0.1 }), ...answers });
    return runVideo({ adapter: venice, baseUrl: BASE, key: KEY, request: REQUEST, outDir: folder(), waitMs: 60_000, signal: new AbortController().signal, fetch: s.fetch, ...clock() });
  };
  await assert.rejects(run({ '/video/queue': () => json({ error: 'Insufficient balance' }, 402) }), /lack of credit \(402\).*Insufficient balance/);
  await assert.rejects(run({ '/video/queue': () => json({ error: `Invalid key ${KEY}` }, 401) }), (err: Error) => /refused the key \(401\)/.test(err.message) && !err.message.includes(KEY) && err.message.includes('••••'));
  await assert.rejects(run({ '/video/queue': () => json({ error: 'Prompt refused', suggested_prompt: 'a calm fox' }, 422) }), /refused \(422\): Prompt refused · suggested prompt: a calm fox/);
  await assert.rejects(run({ '/video/queue': () => json({ model: T2V.id }) }), /no queue_id/);
  // A refusal while the video is asked for ends the job: it would never come.
  const policy = run({ '/video/queue': () => json({ model: T2V.id, queue_id: 'q-3' }), '/video/retrieve': () => json({ error: { message: 'Blocked by the content policy', type: 'provider_content_policy' } }, 422) });
  await assert.rejects(policy, (err: Error) => err instanceof VideoRunError && err.job === undefined && /Blocked by the content policy/.test(err.message));
  // A page where the video should be is not saved as one.
  await assert.rejects(run({ '/video/queue': () => json({ model: T2V.id, queue_id: 'q-3' }), '/video/retrieve': () => new Response('<html>Sign in</html>', { headers: { 'content-type': 'text/html' } }) }), /unreadable answer/);
  assert.equal(veniceError('<html>Bad gateway</html>', KEY), '<html>Bad gateway</html>');
});

test('a busy provider or a cut connection while waiting is asked again; too many in a row end the wait, the job kept', async () => {
  let n = 0;
  const flaky = server({
    '/video/quote': () => json({ quote: 0.1 }),
    '/video/queue': () => json({ model: T2V.id, queue_id: 'q-4' }),
    '/video/retrieve': () => {
      n++;
      if (n === 1) return json({ error: 'Model at capacity' }, 503);
      if (n === 2) throw new TypeError('fetch failed');
      return mp4();
    },
    '/video/complete': () => json({ success: true }),
  });
  const base = { adapter: venice, baseUrl: BASE, key: KEY, request: REQUEST, waitMs: 600_000, signal: new AbortController().signal };
  assert.equal((await runVideo({ ...base, outDir: folder(), fetch: flaky.fetch, ...clock() })).kind, 'saved');
  const down = server({ '/video/quote': () => json({ quote: 0.1 }), '/video/queue': () => json({ model: T2V.id, queue_id: 'q-5' }), '/video/retrieve': () => json({ error: 'down' }, 500) });
  const outDir = folder();
  await assert.rejects(runVideo({ ...base, outDir, fetch: down.fetch, ...clock() }), (err: Error) => err instanceof VideoRunError && err.job?.id === 'q-5' && /job_id "q-5"/.test(err.message));
  assert.equal(down.paths().filter((p) => p === '/video/retrieve').length, 6);
});

test('a wait that ends first keeps the job: a later call resumes it without queueing anything', async () => {
  let ready = false;
  const s = server({
    '/video/quote': () => json({ quote: 0.2 }),
    '/video/queue': () => json({ model: T2V.id, queue_id: 'q-6' }),
    '/video/retrieve': () => (ready ? mp4() : json({ status: 'PROCESSING', average_execution_time: 900_000, execution_duration: 1000 })),
    '/video/complete': () => json({ success: true }),
  });
  const outDir = folder();
  const base = { adapter: venice, baseUrl: BASE, key: KEY, outDir, waitMs: 60_000, signal: new AbortController().signal, fetch: s.fetch };
  let late: VideoRunError | undefined;
  await assert.rejects(runVideo({ ...base, request: REQUEST, ...clock() }), (err: Error) => {
    late = err as VideoRunError;
    return err instanceof VideoRunError && /not ready after 1 min.*job_id "q-6" and model "wan-2\.5-preview-text-to-video"/.test(err.message);
  });
  assert.deepEqual(late?.job, { id: 'q-6', model: T2V.id });
  // Asked for the whole minute, and no longer.
  assert.equal(s.paths().filter((p) => p === '/video/retrieve').length, 13);
  ready = true;
  // Made, but the folder cannot be written (here a file stands where it should be): the job is kept all the same.
  writeFileSync(join(root, 'not-a-folder'), '');
  await assert.rejects(runVideo({ ...base, outDir: join(root, 'not-a-folder', 'videos'), resume: late?.job, ...clock() }), (err: Error) => err instanceof VideoRunError && err.job?.id === 'q-6' && /could not be saved on this computer.*\n.*job_id "q-6"/.test(err.message));
  s.calls.length = 0;
  const r = await runVideo({ ...base, resume: late?.job, ...clock() });
  assert.deepEqual([r.kind, s.paths()], ['saved', ['/video/retrieve', '/video/complete']]);
});

test('a cancelled call stops at once: no file, and the job’s id for whoever picks it up', async () => {
  const stop = new AbortController();
  const s = server({
    '/video/quote': () => json({ quote: 0.2 }),
    '/video/queue': () => json({ model: T2V.id, queue_id: 'q-7' }),
    '/video/retrieve': () => json({ status: 'PROCESSING', average_execution_time: 1, execution_duration: 1 }),
  });
  const outDir = folder();
  const sleep = async (_ms: number, signal: AbortSignal) => {
    stop.abort();
    signal.throwIfAborted();
  };
  await assert.rejects(runVideo({ adapter: venice, baseUrl: BASE, key: KEY, request: REQUEST, outDir, waitMs: 600_000, signal: stop.signal, fetch: s.fetch, sleep }), (err: Error) => err instanceof VideoRunError && err.job?.id === 'q-7' && /Stopped waiting/.test(err.message));
  assert.deepEqual(s.paths(), ['/video/quote', '/video/queue', '/video/retrieve'], 'nothing is asked after the cancellation');
  assert.throws(() => readdirSync(outDir), /ENOENT/, 'nothing was written');
  // Cancelled before anything was sent: nothing is queued.
  const none = server({});
  await assert.rejects(runVideo({ adapter: venice, baseUrl: BASE, key: KEY, request: REQUEST, outDir, waitMs: 1000, signal: stop.signal, fetch: none.fetch }), /Cancelled before anything was queued/);
  assert.deepEqual(none.paths(), []);

  // A download cut half-way leaves no file either.
  const cut = new AbortController();
  let pulls = 0;
  const half = new ReadableStream<Uint8Array>({
    pull(c) {
      if (++pulls === 1) return c.enqueue(MP4);
      cut.abort();
      c.error(cut.signal.reason);
    },
  });
  const broken = server({ '/video/quote': () => json({ quote: 0.2 }), '/video/queue': () => json({ model: T2V.id, queue_id: 'q-8' }), '/video/retrieve': () => new Response(half, { headers: { 'content-type': 'video/mp4' } }) });
  const partial = folder();
  await assert.rejects(runVideo({ adapter: venice, baseUrl: BASE, key: KEY, request: REQUEST, outDir: partial, waitMs: 600_000, signal: cut.signal, fetch: broken.fetch, ...clock() }), /Stopped waiting/);
  assert.deepEqual(readdirSync(partial), []);
});

const account = (more: Partial<Account> = {}): Account => ({ id: 'a-ven00001', kind: 'openai', name: 'Venice', baseUrl: BASE, model: 'venice-uncensored', smallModel: '', slug: 'venice', models: ['venice-uncensored'], isolated: false, ...more });

test('the hub’s video service: the models of each provider, a video made by its id, a job remembered until it is saved', async () => {
  let ready = false;
  const s = server({
    '/models?type=video': () => json(LISTED),
    '/video/quote': () => json({ quote: 0.085 }),
    '/video/queue': () => json({ model: T2V.id, queue_id: 'q-9' }),
    '/video/retrieve': () => (ready ? mp4() : json({ status: 'PROCESSING', average_execution_time: 1, execution_duration: 1 })),
    '/video/complete': () => json({ success: true }),
  });
  const accounts = [account({ videoModels: ['my-video'] }), account({ id: 'a-dsk00001', name: 'DeepSeek', slug: 'deepseek-2', baseUrl: 'https://api.deepseek.com' })];
  const outDir = folder();
  const cwd = folder();
  const video = new VideoService({ accounts: () => accounts, key: (id) => (id === 'a-ven00001' ? KEY : ''), outDir: () => outDir, fetch: s.fetch, ...clock() });
  const signal = new AbortController().signal;

  // Nothing read yet: only what was named by hand. Then the provider's list, and both.
  assert.deepEqual(video.ids(accounts[0]), ['my-video']);
  await video.refresh(accounts[0]);
  assert.deepEqual(video.view(accounts[0]), { listed: ['wan-2.5-preview-image-to-video', 'wan-2.5-preview-text-to-video'], manual: ['my-video'] });
  assert.deepEqual(video.view(accounts[1]), { listed: [], manual: [] }, 'no video API the hub speaks at that address');

  const list = await video.list({}, signal);
  assert.deepEqual(list.split('\n'), [
    'venice (Venice) · 3 video models',
    'wan-2.5-preview-image-to-video · Wan 2.5 · image→video · 5s · 720p',
    'wan-2.5-preview-text-to-video · Wan 2.5 · text→video · 5s 10s · 16:9 9:16 · 480p 720p',
    'my-video · named by hand',
  ]);
  assert.match(await video.list({ search: 'TEXT→video 720p' }, signal), /^venice \(Venice\) · 1 of 3 video models\nwan-2\.5-preview-text-to-video/);
  await assert.rejects(video.list({ provider: 'deepseek-2' }, signal), /No provider "deepseek-2" with video models\. Providers: venice/);

  await assert.rejects(video.generate({ prompt: 'a fox' }, { cwd, signal }), /Name a model: there are 3 video models/);
  await assert.rejects(video.generate({ prompt: 'a fox', model: 'wan-2.5' }, { cwd, signal }), /Unknown video model "wan-2\.5".*Close ones: wan-2\.5-preview-image-to-video, wan-2\.5-preview-text-to-video/);
  await assert.rejects(video.generate({ prompt: 'a fox', model: T2V.id, output_dir: '../elsewhere' }, { cwd, signal }), /output_dir must be inside your folder/);
  assert.equal(await video.generate({ prompt: 'a fox', model: T2V.id.toUpperCase(), duration: '10s', quote_only: true }, { cwd, signal }), 'venice · wan-2.5-preview-text-to-video · 10s. Price quoted by the provider: $0.085 (US dollars). Nothing was queued.');

  // The wait ends first: the job is listed, and its id alone resumes it.
  await assert.rejects(video.generate({ prompt: 'a fox', model: T2V.id, wait_minutes: 1 }, { cwd, signal }), /job_id "q-9"/);
  assert.match(await video.list({ search: 'none-of-them' }, signal), /Still being made \(generate_video job_id\):\nq-9 · wan-2\.5-preview-text-to-video · /);
  ready = true;
  s.calls.length = 0;
  const text = await video.generate({ job_id: 'q-9', output_dir: 'media' }, { cwd, signal });
  assert.deepEqual(s.paths(), ['/video/retrieve', '/video/complete'], 'nothing new is queued');
  const [file] = readdirSync(join(cwd, 'media'));
  const path = join(cwd, 'media', file);
  assert.deepEqual(text.split('\n'), [
    `Video saved: ${path} (1 kB)`,
    'Made by venice · wan-2.5-preview-text-to-video · -',
    'Ready in 0 s. Job q-9.',
    `Show it to the user with this link, which opens the file from the conversation: [${file}](<${path.replace(/\\/g, '/')}>)`,
  ]);
  assert.doesNotMatch(await video.list({}, signal), /Still being made/);

  // A whole call, with the price in the answer. A model named by hand is taken as asked.
  const whole = await video.generate({ prompt: 'a fox', model: 'my-video', duration: '8' }, { cwd, signal });
  assert.ok(whole.startsWith(`Video saved: ${outDir}`), whole);
  assert.match(whole, /Price quoted by the provider: \$0\.085 \(US dollars\)\./);
  assert.deepEqual(s.calls.find((c) => c.path === '/video/queue')?.body, { model: 'my-video', duration: '8s', prompt: 'a fox' });

  // No key for it, no provider at all: said for the user to fix.
  const keyless = new VideoService({ accounts: () => accounts, key: () => '', outDir: () => outDir, fetch: s.fetch });
  await assert.rejects(keyless.generate({ prompt: 'a fox', model: T2V.id }, { cwd, signal }), /No key is stored for venice/);
  const none = new VideoService({ accounts: () => [accounts[1]], key: () => KEY, outDir: () => outDir, fetch: s.fetch });
  await assert.rejects(none.list({}, signal), /No provider with a video API is connected/);
});

test('a video queued is a spending of its provider, at the price it quoted; a quote alone or a resumed job is none', async () => {
  let quote: unknown = 0.085;
  let ready = false;
  const s = server({
    '/models?type=video': () => json(LISTED),
    '/video/quote': () => (quote === 'down' ? json({ error: 'busy' }, 500) : json({ quote })),
    '/video/queue': (_c, n) => json({ model: T2V.id, queue_id: `q-s${n}` }),
    '/video/retrieve': () => (ready ? mp4() : json({ status: 'PROCESSING', average_execution_time: 1, execution_duration: 1 })),
    '/video/complete': () => json({ success: true }),
  });
  const accounts = [account()];
  const video = new VideoService({ accounts: () => accounts, key: () => KEY, outDir: folder, fetch: s.fetch, ...clock() });
  const spent: VideoSpend[] = [];
  const ctx = { cwd: folder(), signal: new AbortController().signal };
  // The session that calls sets who pays around its call, as sessions.ts does.
  const call = (args: Parameters<VideoService['generate']>[0]) => videoSpending.run((v) => spent.push(v), () => video.generate(args, ctx));

  await call({ prompt: 'a fox', model: T2V.id, quote_only: true });
  assert.deepEqual(spent, [], 'a quote alone spends nothing');
  // Queued, then not waited for: paid all the same.
  await assert.rejects(call({ prompt: 'a fox', model: T2V.id, wait_minutes: 1 }), /job_id "q-s1"/);
  assert.deepEqual(spent, [{ provider: 'venice', model: T2V.id, usd: 0.085 }]);
  ready = true;
  await call({ job_id: 'q-s1' });
  assert.equal(spent.length, 1, 'a resumed job is not paid twice');
  // A price the provider could not give: the video is made, its price said unknown.
  quote = 'down';
  await call({ prompt: 'a fox', model: T2V.id });
  assert.deepEqual(spent.at(-1), { provider: 'venice', model: T2V.id, usd: null });
  // Outside a session's call (no one to charge): made all the same, nothing logged.
  await video.generate({ prompt: 'a fox', model: T2V.id }, ctx);
  assert.equal(spent.length, 2);
});
