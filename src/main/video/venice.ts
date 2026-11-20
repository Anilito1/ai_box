import type { VideoModel } from '../../shared/video';
import { readCapped } from '../accounts';
import { VideoApiError, type VideoAdapter, type VideoContext, type VideoJob, type VideoRequest } from './types';

// Venice's video API (docs.venice.ai): GET /models?type=video lists the models with what each takes, POST
// /video/quote prices a request, /video/queue takes it, /video/retrieve answers "PROCESSING" then the video itself
// (or "COMPLETED" when /video/queue gave an address to download it from), /video/complete deletes Venice's copy.

/** How long an answer's headers may take; a video's body then streams for as long as it needs. */
const ANSWER_TIMEOUT = 60_000;
const LIST_MAX = 500;

const root = (ctx: VideoContext) => ctx.baseUrl.replace(/\/+$/, '');
/** An answer whose body is a video file, not a page or a message that came in its place. */
const isMedia = (res: Response) => /^(video\/|application\/octet-stream)/i.test(res.headers.get('content-type') ?? '');
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '').slice(0, 60) : []);

/** A call that ends when the context does, or when no answer started in time. The body is left to read. */
async function call(ctx: VideoContext, url: string, init: RequestInit): Promise<Response> {
  const late = new AbortController();
  const timer = setTimeout(() => late.abort(new DOMException('no answer in time', 'TimeoutError')), ANSWER_TIMEOUT);
  try {
    return await ctx.fetch(url, { ...init, signal: AbortSignal.any([ctx.signal, late.signal]) });
  } finally {
    clearTimeout(timer);
  }
}

/** A POST to one of the video endpoints. The key goes to this address only: a redirect is refused, not followed. */
const post = (ctx: VideoContext, path: string, body: Record<string, unknown>) =>
  call(ctx, `${root(ctx)}/video/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(ctx.key ? { authorization: `Bearer ${ctx.key}` } : {}) },
    body: JSON.stringify(body),
    redirect: 'error',
  });

/** Venice's words behind a refusal ("error" a text or an object with a message, a prompt it suggests instead), the key masked. */
export function veniceError(text: string, key: string): string {
  let said = text;
  try {
    const o = JSON.parse(text) as { error?: unknown; details?: unknown; suggested_prompt?: unknown } | null;
    const error = o?.error;
    const message = typeof error === 'string' ? error : typeof (error as { message?: unknown } | null)?.message === 'string' ? (error as { message: string }).message : '';
    const details = o?.details && typeof o.details === 'object' ? JSON.stringify(o.details) : typeof o?.details === 'string' ? o.details : '';
    const suggested = typeof o?.suggested_prompt === 'string' ? `suggested prompt: ${o.suggested_prompt}` : '';
    said = [message, details, suggested].filter(Boolean).join(' · ') || text;
  } catch {
    // Not JSON: a proxy's page, said as it is.
  }
  return (key ? said.split(key).join('••••') : said).replace(/\s+/g, ' ').trim().slice(0, 600);
}

async function refused(ctx: VideoContext, res: Response): Promise<VideoApiError> {
  return new VideoApiError(res.status, veniceError(await readCapped(res, 64 * 1024).catch(() => ''), ctx.key));
}

async function json<T>(res: Response): Promise<T | null> {
  try {
    return JSON.parse(await readCapped(res, 8 * 1024 * 1024)) as T | null;
  } catch {
    return null;
  }
}

/** A request as /video/queue and /video/quote take it: only what was asked, Venice refuses a field it does not know. */
const body = (req: VideoRequest, priced: boolean): Record<string, unknown> => ({
  model: req.model,
  duration: req.duration,
  ...(req.aspectRatio ? { aspect_ratio: req.aspectRatio } : {}),
  ...(req.resolution ? { resolution: req.resolution } : {}),
  ...(req.audio !== undefined ? { audio: req.audio } : {}),
  // The price depends on neither the prompt nor the image.
  ...(priced ? {} : { prompt: req.prompt, ...(req.negativePrompt ? { negative_prompt: req.negativePrompt } : {}), ...(req.imageUrl ? { image_url: req.imageUrl } : {}) }),
});

interface VeniceModel {
  id?: unknown;
  type?: unknown;
  model_spec?: { name?: unknown; offline?: unknown; constraints?: { model_type?: unknown; durations?: unknown; aspect_ratios?: unknown; resolutions?: unknown; audio_configurable?: unknown } };
}

/** An entry of Venice's list as the hub keeps it; null for anything but a video model that is on. */
export function veniceModel(m: VeniceModel | null): VideoModel | null {
  if (!m || typeof m.id !== 'string' || !m.id || m.type !== 'video' || m.model_spec?.offline === true) return null;
  const c = m.model_spec?.constraints ?? {};
  const type = typeof c.model_type === 'string' ? c.model_type : '';
  return {
    id: m.id,
    name: typeof m.model_spec?.name === 'string' ? m.model_spec.name : '',
    input: type === 'text-to-video' ? 'text' : type === 'image-to-video' ? 'image' : type === 'video' ? 'video' : '',
    durations: strings(c.durations),
    aspectRatios: strings(c.aspect_ratios),
    resolutions: strings(c.resolutions),
    audioOption: c.audio_configurable === true,
    manual: false,
  };
}

export const venice: VideoAdapter = {
  id: 'venice',

  async models(ctx) {
    // The list is public: the key only spares the limits of an anonymous caller.
    const res = await call(ctx, `${root(ctx)}/models?type=video`, { headers: ctx.key ? { authorization: `Bearer ${ctx.key}` } : {}, redirect: 'error' });
    if (!res.ok) throw await refused(ctx, res);
    const list = (await json<{ data?: unknown }>(res))?.data;
    return (Array.isArray(list) ? list : [])
      .map((m) => veniceModel(m as VeniceModel | null))
      .filter((m): m is VideoModel => m !== null)
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, LIST_MAX);
  },

  async quote(ctx, req) {
    const res = await post(ctx, 'quote', body(req, true));
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    const quote = (await json<{ quote?: unknown }>(res))?.quote;
    return typeof quote === 'number' && Number.isFinite(quote) && quote >= 0 ? quote : null;
  },

  async submit(ctx, req) {
    const res = await post(ctx, 'queue', body(req, false));
    if (!res.ok) throw await refused(ctx, res);
    const o = await json<{ queue_id?: unknown; model?: unknown; download_url?: unknown }>(res);
    if (typeof o?.queue_id !== 'string' || !o.queue_id) throw new VideoApiError(res.status, 'no queue_id in the answer');
    return { id: o.queue_id, model: typeof o.model === 'string' ? o.model : req.model, ...(typeof o.download_url === 'string' && /^https:\/\//i.test(o.download_url) ? { downloadUrl: o.download_url } : {}) };
  },

  async poll(ctx, job) {
    const res = await post(ctx, 'retrieve', { model: job.model, queue_id: job.id });
    if (!res.ok) throw await refused(ctx, res);
    // The video itself: its body is the file.
    if (isMedia(res)) return { state: 'done', media: res };
    const o = await json<{ status?: unknown; average_execution_time?: unknown; execution_duration?: unknown }>(res);
    const status = typeof o?.status === 'string' ? o.status.toUpperCase() : '';
    const ms = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
    if (status === 'PROCESSING' || status === 'QUEUED' || status === 'PENDING') return { state: 'pending', elapsedMs: ms(o?.execution_duration), expectedMs: ms(o?.average_execution_time) };
    if (status !== 'COMPLETED') throw new VideoApiError(res.status, status ? `status ${status}` : 'unreadable answer');
    if (!job.downloadUrl) throw new VideoApiError(res.status, 'completed, but the address to download it from was only given when it was queued, and the hub no longer has it');
    // Venice's own short-lived address: fetched without the key.
    const media = await call(ctx, job.downloadUrl, {});
    if (!media.ok) throw await refused(ctx, media);
    if (!isMedia(media)) {
      await media.body?.cancel().catch(() => undefined);
      throw new VideoApiError(media.status, 'the download address answered without a video');
    }
    return { state: 'done', media };
  },

  async release(ctx, job: VideoJob) {
    const res = await post(ctx, 'complete', { model: job.model, queue_id: job.id });
    await res.body?.cancel().catch(() => undefined);
  },
};
