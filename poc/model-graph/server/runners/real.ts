import { readCapped } from '../../../../src/main/accounts';
import type { VideoContext, VideoJob, VideoRequest } from '../../../../src/main/video/types';
import { venice, veniceError } from '../../../../src/main/video/venice';
import { videoApiOf } from '../../../../src/shared/video';
import type { ModelSpec } from '../../shared/capabilities';
import type { DirectRunner, NodeCall, QueuedRunner, Runner, Value } from '../../shared/engine';

// The real calls, one runner per API. Chat, images and speech follow the OpenAI shapes most providers take;
// Venice's own image endpoints are used on its address; video goes through the hub's existing Venice adapter
// (src/main/video/venice.ts): the same queue, quote and retrieve calls as the app's generate_video tool.

/** What a runner needs of a provider. The key is sent to `baseUrl` only. */
export interface Access {
  baseUrl: string;
  key: string;
  fetch: typeof fetch;
}

type Media = Exclude<Value, { type: 'text' }>;

const root = (a: Access) => a.baseUrl.replace(/\/+$/, '');
const texts = (values: Value[] | undefined): string =>
  (values ?? [])
    .flatMap((v) => (v.type === 'text' ? [v.text.trim()] : []))
    .filter(Boolean)
    .join('\n\n');
const media = (values: Value[] | undefined): Media[] => (values ?? []).filter((v): v is Media => v.type !== 'text');
const base64 = (v: Media) => Buffer.from(v.bytes).toString('base64');
const dataUrl = (v: Media) => `data:${v.mime};base64,${base64(v)}`;
const isVenice = (a: Access) => videoApiOf(a.baseUrl) === 'venice';

/** The value asked for when the model takes it (or lists nothing), else the first the model lists; empty when neither. */
const pick = (asked: string | undefined, listed: string[] | undefined): string => (asked && (!listed?.length || listed.includes(asked)) ? asked : (listed?.[0] ?? ''));

/** How long a call that answers at once may take: an image or a long completion needs minutes, not more. */
const CALL_TIMEOUT = 5 * 60_000;

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
  if (!res.ok) throw new Error(`le fournisseur a répondu ${res.status} : ${veniceError(await readCapped(res, 64 * 1024).catch(() => ''), a.key) || 'sans explication'}`);
  return res;
}

const MEDIA_MAX = 200 * 1024 * 1024;

async function bytesOf(res: Response): Promise<Uint8Array> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MEDIA_MAX) throw new Error('fichier reçu trop gros');
  return bytes;
}

/** An image the provider gave as a file: its type from the answer when it is a plain picture, else from its bytes. */
async function imageOf(res: Response): Promise<Value> {
  const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim();
  const bytes = await bytesOf(res);
  return { type: 'image', mime: /^image\/(png|jpeg|webp|gif)$/.test(mime) ? mime : sniff(bytes), bytes };
}

/** The type of an image given as base64, from its first bytes. */
function sniff(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return 'image/webp';
  return 'image/png';
}

function fromBase64(text: unknown): Value {
  if (typeof text !== 'string' || !text) throw new Error('la réponse du fournisseur ne contient pas d’image');
  const bytes = new Uint8Array(Buffer.from(text.replace(/^data:[^,]*,/, ''), 'base64'));
  return { type: 'image', mime: sniff(bytes), bytes };
}

function chat(a: Access, spec: ModelSpec): DirectRunner {
  return {
    async estimate(call) {
      if (spec.price?.input === undefined) return null;
      // What is sent, at four characters a token and a thousand tokens an image; the answer is counted once it is there.
      const chars = (call.node.instruction ?? '').length + call.history.reduce((n, t) => n + t.text.length, 0) + texts(call.inputs.prompt).length;
      return ((chars / 4 + 1000 * media(call.inputs.images).length) * spec.price.input) / 1e6;
    },
    async run(call, ctx) {
      const asked = texts(call.inputs.prompt);
      const parts: Record<string, unknown>[] = [
        ...(asked ? [{ type: 'text', text: asked }] : []),
        ...media(call.inputs.images).map((v) => ({ type: 'image_url', image_url: { url: dataUrl(v) } })),
        ...media(call.inputs.video).map((v) => ({ type: 'video_url', video_url: { url: dataUrl(v) } })),
      ];
      if (parts.length === 0) throw new Error('rien à envoyer au modèle');
      const messages = [
        ...(call.node.instruction ? [{ role: 'system', content: call.node.instruction }] : []),
        ...call.history.map((t) => ({ role: t.role, content: t.text })),
        // A plain text stays a string: the oldest servers take nothing else.
        { role: 'user', content: parts.length === 1 && asked ? asked : parts },
      ];
      const res = await send(a, '/chat/completions', { model: spec.model, messages, stream: false }, ctx.signal);
      const o = JSON.parse(await readCapped(res, 16 * 1024 * 1024)) as { choices?: { message?: { content?: unknown } }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } } | null;
      const content = o?.choices?.[0]?.message?.content;
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((p: { text?: unknown }) => (typeof p?.text === 'string' ? p.text : '')).join('') : '';
      if (!text.trim()) throw new Error('le modèle a répondu sans texte');
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
        const o = JSON.parse(await readCapped(res, 64 * 1024 * 1024)) as { images?: unknown[] } | null;
        return { outputs: { image: [fromBase64(o?.images?.[0])] } };
      }
      const res = await send(a, '/images/generations', { model: spec.model, prompt: asked, n: 1 }, ctx.signal);
      const first = (JSON.parse(await readCapped(res, 64 * 1024 * 1024)) as { data?: { b64_json?: unknown; url?: unknown }[] } | null)?.data?.[0];
      if (typeof first?.url === 'string' && /^https:\/\//i.test(first.url)) {
        // The provider's own short-lived address: fetched without the key.
        const file = await a.fetch(first.url, { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(CALL_TIMEOUT)]) });
        if (!file.ok) throw new Error(`l’image n’a pas pu être téléchargée (${file.status})`);
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
      const first = (JSON.parse(await readCapped(res, 64 * 1024 * 1024)) as { data?: { b64_json?: unknown }[] } | null)?.data?.[0];
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
        const seconds = (ms: number | undefined) => (ms === undefined ? '' : `${Math.round(ms / 1000)} s`);
        return { state: 'pending', progress: polled.elapsedMs === undefined ? 'génération en cours' : `génération : ${seconds(polled.elapsedMs)}${polled.expectedMs ? ` sur ${seconds(polled.expectedMs)} en moyenne` : ''}` };
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
      const text = (JSON.parse(await readCapped(res, 8 * 1024 * 1024)) as { text?: unknown } | null)?.text;
      if (typeof text !== 'string') throw new Error('la réponse du fournisseur ne contient pas de texte');
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
