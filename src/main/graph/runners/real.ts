import type { ModelSpec } from '../../../shared/modelCaps';
import type { DirectRunner, MediaValue, NodeCall, QueuedRunner, Runner, Value } from '../../../shared/graph/engine';
import { videoApiOf } from '../../../shared/video';
import { readCapped } from '../../accounts';
import { t } from '../../i18n';
import type { VideoContext, VideoJob, VideoRequest } from '../../video/types';
import { venice, veniceError } from '../../video/venice';

// The real calls of a graph, one runner per API. Chat, images and speech take the OpenAI shapes most providers
// take; Venice's own image endpoints are used on its address; a video goes through the hub's Venice adapter
// (video/venice.ts): the same quote, queue and retrieve calls as generate_video.

/** What a runner needs of a provider. The key is sent to `baseUrl` only. */
export interface Access {
  baseUrl: string;
  key: string;
  fetch: typeof fetch;
}

const root = (a: Access) => a.baseUrl.replace(/\/+$/, '');
export const texts = (values: Value[] | undefined): string =>
  (values ?? [])
    .flatMap((v) => (v.type === 'text' ? [v.text.trim()] : []))
    .filter(Boolean)
    .join('\n\n');
export const media = (values: Value[] | undefined): MediaValue[] => (values ?? []).filter((v): v is MediaValue => v.type !== 'text');
const base64 = (v: MediaValue) => Buffer.from(v.bytes).toString('base64');
const dataUrl = (v: MediaValue) => `data:${v.mime};base64,${base64(v)}`;
const isVenice = (a: Access) => videoApiOf(a.baseUrl) === 'venice';

/** The value asked for when the model takes it (or lists nothing), else the first the model lists; empty when neither. */
const pick = (asked: string | undefined, listed: string[] | undefined): string => (asked && (!listed?.length || listed.includes(asked)) ? asked : (listed?.[0] ?? ''));

/** How long a call that answers at once may take: an image or a long completion needs minutes, not more. */
const CALL_TIMEOUT = 5 * 60_000;
const MEDIA_MAX = 200 * 1024 * 1024;

async function send(a: Access, path: string, body: Record<string, unknown> | FormData, signal: AbortSignal): Promise<Response> {
  const form = body instanceof FormData;
  const res = await a.fetch(`${root(a)}${path}`, {
    method: 'POST',
    headers: { ...(form ? {} : { 'content-type': 'application/json' }), ...(a.key ? { authorization: `Bearer ${a.key}` } : {}) },
    body: form ? body : JSON.stringify(body),
    // The key goes to this address only: a redirect is refused, not followed.
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT)]),
  });
  if (!res.ok) throw new Error(t('graph.err.refused', { status: res.status, said: veniceError(await readCapped(res, 64 * 1024).catch(() => ''), a.key) || t('graph.err.noReason') }));
  return res;
}

/** An answer's JSON; an answer that is not JSON is said as such, never quoted (it could hold anything). */
async function json<T>(res: Response, max: number): Promise<T | null> {
  try {
    return JSON.parse(await readCapped(res, max)) as T | null;
  } catch {
    throw new Error(t('graph.err.unreadable'));
  }
}

async function bytesOf(res: Response): Promise<Uint8Array> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MEDIA_MAX) throw new Error(t('graph.err.tooBig'));
  return bytes;
}

/** The type of an image from its first bytes: only the plain picture types, never one that could hold a script. */
export function sniff(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return 'image/webp';
  return 'image/png';
}

/** An image the provider gave as a file: its type from the answer when it is a plain picture, else from its bytes. */
async function imageOf(res: Response): Promise<Value> {
  const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim();
  const bytes = await bytesOf(res);
  return { type: 'image', mime: /^image\/(png|jpeg|webp|gif)$/.test(mime) ? mime : sniff(bytes), bytes };
}

function fromBase64(text: unknown): Value {
  if (typeof text !== 'string' || !text) throw new Error(t('graph.err.noImage'));
  const bytes = new Uint8Array(Buffer.from(text.replace(/^data:[^,]*,/, ''), 'base64'));
  return { type: 'image', mime: sniff(bytes), bytes };
}

function chat(a: Access, spec: ModelSpec): DirectRunner {
  return {
    async estimate(call) {
      if (spec.price?.input === undefined) return null;
      // What is sent, at four characters a token and a thousand tokens an image; the answer is counted once it is there.
      const chars = (call.node.kind === 'model' ? (call.node.instruction ?? '').length : 0) + call.history.reduce((n, turn) => n + turn.text.length, 0) + texts(call.inputs.prompt).length;
      return ((chars / 4 + 1000 * media(call.inputs.images).length) * spec.price.input) / 1e6;
    },
    async run(call, ctx) {
      const asked = texts(call.inputs.prompt);
      const parts: Record<string, unknown>[] = [
        ...(asked ? [{ type: 'text', text: asked }] : []),
        ...media(call.inputs.images).map((v) => ({ type: 'image_url', image_url: { url: dataUrl(v) } })),
        ...media(call.inputs.video).map((v) => ({ type: 'video_url', video_url: { url: dataUrl(v) } })),
      ];
      if (parts.length === 0) throw new Error(t('graph.err.nothingToSend'));
      const instruction = call.node.kind === 'model' ? call.node.instruction : undefined;
      const messages = [
        ...(instruction ? [{ role: 'system', content: instruction }] : []),
        ...call.history.map((turn) => ({ role: turn.role, content: turn.text })),
        // A plain text stays a string: the oldest servers take nothing else.
        { role: 'user', content: parts.length === 1 && asked ? asked : parts },
      ];
      const res = await send(a, '/chat/completions', { model: spec.model, messages, stream: false }, ctx.signal);
      const o = await json<{ choices?: { message?: { content?: unknown } }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }>(res, 16 * 1024 * 1024);
      const content = o?.choices?.[0]?.message?.content;
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((p: { text?: unknown }) => (typeof p?.text === 'string' ? p.text : '')).join('') : '';
      if (!text.trim()) throw new Error(t('graph.err.noText'));
      const tokens = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      const priced = spec.price?.input !== undefined || spec.price?.output !== undefined;
      const costUsd = priced ? (tokens(o?.usage?.prompt_tokens) * (spec.price?.input ?? 0) + tokens(o?.usage?.completion_tokens) * (spec.price?.output ?? 0)) / 1e6 : undefined;
      return { outputs: { text: [{ type: 'text', text: text.trim() }] }, ...(costUsd !== undefined ? { costUsd } : {}) };
    },
  };
}

function image(a: Access, spec: ModelSpec): DirectRunner {
  return {
    estimate: async () => spec.price?.perCall ?? null,
    async run(call, ctx) {
      const asked = texts(call.inputs.prompt);
      if (isVenice(a)) {
        const res = await send(a, '/image/generate', { model: spec.model, prompt: asked, format: 'png' }, ctx.signal);
        const o = await json<{ images?: unknown[] }>(res, 64 * 1024 * 1024);
        return { outputs: { image: [fromBase64(o?.images?.[0])] } };
      }
      const res = await send(a, '/images/generations', { model: spec.model, prompt: asked, n: 1 }, ctx.signal);
      const first = (await json<{ data?: { b64_json?: unknown; url?: unknown }[] }>(res, 64 * 1024 * 1024))?.data?.[0];
      if (typeof first?.url === 'string' && /^https:\/\//i.test(first.url)) {
        // The provider's own short-lived address: fetched without the key.
        const file = await a.fetch(first.url, { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(CALL_TIMEOUT)]) });
        if (!file.ok) throw new Error(t('graph.err.download', { status: file.status }));
        return { outputs: { image: [await imageOf(file)] } };
      }
      return { outputs: { image: [fromBase64(first?.b64_json)] } };
    },
  };
}

function imageEdit(a: Access, spec: ModelSpec): DirectRunner {
  return {
    estimate: async () => spec.price?.perCall ?? null,
    async run(call, ctx) {
      const asked = texts(call.inputs.prompt);
      const sources = media(call.inputs.images);
      if (isVenice(a)) {
        // One source image is an edit; several are combined (the first is the base, the others the references).
        const res = sources.length === 1 ? await send(a, '/image/edit', { model: spec.model, prompt: asked, image: base64(sources[0]) }, ctx.signal) : await send(a, '/image/multi-edit', { modelId: spec.model, prompt: asked, images: sources.map(base64) }, ctx.signal);
        return { outputs: { image: [await imageOf(res)] } };
      }
      const form = new FormData();
      form.set('model', spec.model);
      form.set('prompt', asked);
      sources.forEach((v, i) => form.append(sources.length === 1 ? 'image' : 'image[]', new Blob([Buffer.from(v.bytes)], { type: v.mime }), `image-${i + 1}.${v.mime.split('/')[1] ?? 'png'}`));
      const res = await send(a, '/images/edits', form, ctx.signal);
      const first = (await json<{ data?: { b64_json?: unknown }[] }>(res, 64 * 1024 * 1024))?.data?.[0];
      return { outputs: { image: [fromBase64(first?.b64_json)] } };
    },
  };
}

function video(a: Access, spec: ModelSpec): QueuedRunner<VideoJob> {
  const context = (signal: AbortSignal): VideoContext => ({ baseUrl: a.baseUrl, key: a.key, signal, fetch: a.fetch });
  const request = (call: NodeCall): VideoRequest => {
    const o = call.node.options ?? {};
    const start = media(call.inputs.image)[0];
    return {
      model: spec.model,
      prompt: texts(call.inputs.prompt),
      // Venice refuses a value the model does not list: one kept from another model gives way to the first it lists.
      duration: pick(o.duration, spec.durations) || '5s',
      ...(pick(o.aspectRatio, spec.aspectRatios) ? { aspectRatio: pick(o.aspectRatio, spec.aspectRatios) } : {}),
      ...(pick(o.resolution, spec.resolutions) ? { resolution: pick(o.resolution, spec.resolutions) } : {}),
      ...(start ? { imageUrl: dataUrl(start) } : {}),
    };
  };
  return {
    pollEveryMs: 5000,
    estimate: (call, ctx) => venice.quote(context(ctx.signal), request(call)),
    submit: (call, ctx) => venice.submit(context(ctx.signal), request(call)),
    async poll(job, _call, ctx) {
      const polled = await venice.poll(context(ctx.signal), job);
      if (polled.state === 'pending') {
        const s = (ms: number) => Math.round(ms / 1000);
        const progress = polled.elapsedMs === undefined ? t('graph.progress.working') : polled.expectedMs ? t('graph.progress.expected', { elapsed: s(polled.elapsedMs), expected: s(polled.expectedMs) }) : t('graph.progress.elapsed', { elapsed: s(polled.elapsedMs) });
        return { state: 'pending', progress };
      }
      return { state: 'done', result: { outputs: { video: [{ type: 'video', mime: 'video/mp4', bytes: await bytesOf(polled.media) }] } } };
    },
    release: (job, ctx) => venice.release(context(ctx.signal), job),
  };
}

function speech(a: Access, spec: ModelSpec): DirectRunner {
  return {
    async run(call, ctx) {
      const res = await send(a, '/audio/speech', { model: spec.model, input: texts(call.inputs.text).slice(0, 4096), response_format: 'mp3' }, ctx.signal);
      return { outputs: { audio: [{ type: 'audio', mime: 'audio/mpeg', bytes: await bytesOf(res) }] } };
    },
  };
}

function transcription(a: Access, spec: ModelSpec): DirectRunner {
  return {
    async run(call, ctx) {
      const heard = media(call.inputs.audio)[0];
      const form = new FormData();
      form.set('model', spec.model);
      form.set('file', new Blob([Buffer.from(heard.bytes)], { type: heard.mime }), `audio.${heard.mime.split('/')[1] ?? 'mp3'}`);
      const res = await send(a, '/audio/transcriptions', form, ctx.signal);
      const text = (await json<{ text?: unknown }>(res, 8 * 1024 * 1024))?.text;
      if (typeof text !== 'string') throw new Error(t('graph.err.noText'));
      return { outputs: { text: [{ type: 'text', text }] } };
    },
  };
}

/** The runner of a provider's model; null when the hub has no adapter for it (a video model elsewhere than Venice). */
export function realRunner(a: Access, spec: ModelSpec): Runner | null {
  switch (spec.api) {
    case 'chat':
      return chat(a, spec);
    case 'image':
      return image(a, spec);
    case 'image-edit':
      return imageEdit(a, spec);
    case 'video':
      // The adapter sends a prompt and a first image, no video: a model that starts from one is not called for nothing.
      return isVenice(a) && !spec.inputs.some((p) => p.type === 'video') ? (video(a, spec) as Runner) : null;
    case 'speech':
      return speech(a, spec);
    case 'transcription':
      return transcription(a, spec);
  }
}
