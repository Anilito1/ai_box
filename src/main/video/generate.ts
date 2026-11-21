import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { VIDEO_REFERENCES_MAX, type VideoModel } from '../../shared/video';
import { t } from '../i18n';
import { VideoApiError, type VideoAdapter, type VideoContext, type VideoJob, type VideoRequest } from './types';

// One video, whatever the provider: the request checked against the model, the price asked, the job queued, then
// asked for until the video is there or the wait is over, and the file saved. Every wait ends with the caller's signal.

/** What a caller asks for, as it wrote it. */
export interface VideoAsk {
  prompt: string;
  negativePrompt?: string | null;
  duration?: string | null;
  aspectRatio?: string | null;
  resolution?: string | null;
  audio?: boolean | null;
  /** The image of the first frame: a file (absolute, or in `cwd`), an http(s) address or a data: URL. */
  image?: string | null;
  /** The reference images, in the order the prompt cites them (@Image1 first): files, addresses or data: URLs. */
  images?: readonly string[] | null;
  /** The video a video→video model reworks: a file, an http(s) address or a data: URL. */
  video?: string | null;
}

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const VIDEO_TYPES: Record<string, string> = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };
/** An image read from disk goes inside the request, a third larger once encoded. */
const IMAGE_MAX = 15 * 1024 * 1024;
/** What the images read from disk for one request weigh at most, together. */
const IMAGES_MAX = 40 * 1024 * 1024;
/** A video to rework read from disk goes inside the request as well. */
const SOURCE_VIDEO_MAX = 50 * 1024 * 1024;
const VIDEO_MAX = 4 * 1024 * 1024 * 1024;
/** A download that stays this long without a byte is given up. */
const STALL = 120_000;
/** Failures in a row a job's polling gets over (a cut connection, a busy provider) before it is given up. */
const POLL_RETRIES = 5;
const MEDIA_EXT: Record<string, string> = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov' };

/** The value among the ones a model takes, as the model spells it; anything when the model lists none. */
function among(what: string, value: string, allowed: string[], model: string): string {
  if (allowed.length === 0) return value;
  const hit = allowed.find((a) => a.toLowerCase() === value.toLowerCase());
  if (hit === undefined) throw new Error(t('video.badValue', { what, value, model, allowed: allowed.join(', ') }));
  return hit;
}

/**
 * The aspect ratio a model gets when none is asked: the one that follows its images ("auto", "adaptive") when it has
 * one, else the first it lists (Venice refuses a job without one on some models, though it prices it); none when it
 * lists none.
 */
const defaultAspect = (allowed: string[]) => allowed.find((a) => /^(auto|adaptive)$/i.test(a)) ?? allowed[0] ?? '';

/** "5", "5 s" and "5s" are the same duration. */
const durationOf = (text: string) => (/^\d+(\.\d+)?\s*s?$/i.test(text.trim()) ? `${parseFloat(text)}s` : text.trim());

/** What a request carries inline, by kind: the files it reads by extension, their weight, the data: URLs it takes as they are. */
const INLINE = {
  image: { types: IMAGE_TYPES, max: IMAGE_MAX, dataUrl: /^data:image\/[\w.+-]+;base64,/i, said: { type: 'video.imageType', missing: 'video.imageMissing', big: 'video.imageBig' } },
  video: { types: VIDEO_TYPES, max: SOURCE_VIDEO_MAX, dataUrl: /^data:video\/[\w.+-]+;base64,/i, said: { type: 'video.videoType', missing: 'video.videoMissing', big: 'video.videoBig' } },
} as const;

/** An image or a video as the request carries it: an address as it is, a file (absolute, or in `cwd`) as a data: URL. */
async function inline(value: string, cwd: string, kind: keyof typeof INLINE): Promise<string> {
  const { types, max, dataUrl, said } = INLINE[kind];
  const v = value.trim();
  if (/^https?:\/\//i.test(v) || dataUrl.test(v)) return v;
  const path = isAbsolute(v) ? v : resolve(cwd, v);
  const type = types[extname(path).toLowerCase()];
  if (!type) throw new Error(t(said.type, { path }));
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new Error(t(said.missing, { path }));
  if (info.size > max) throw new Error(t(said.big, { path, max: Math.round(max / 1024 / 1024) }));
  return `data:${type};base64,${(await readFile(path)).toString('base64')}`;
}

/** The image a video starts from, as the request carries it: an address as it is, a file as a data: URL. */
export const startImage = (image: string, cwd: string): Promise<string> => inline(image, cwd, 'image');

/** The bytes a data: URL holds; nothing for an address, which the provider fetches itself. */
const inlineBytes = (url: string) => (url.startsWith('data:') ? Math.floor(((url.length - url.indexOf(',') - 1) * 3) / 4) : 0);

/**
 * The images a model is given, checked against what it starts from: one first frame (image) for an image→video model,
 * reference images (images, in the order the prompt cites them) for a reference model, a video for a video→video
 * model, which may take images beside it. A model named by hand gets what was asked.
 */
function checkInputs(model: VideoModel, prompt: string, image: string, images: string[], video: string): void {
  if (images.length > VIDEO_REFERENCES_MAX) throw new Error(t('video.tooManyImages', { max: VIDEO_REFERENCES_MAX }));
  if (video && model.input !== 'video' && model.input !== '') throw new Error(t('video.noVideo', { model: model.id }));
  if (model.input === 'text' && (image || images.length > 0)) throw new Error(t('video.noImage', { model: model.id }));
  if (model.input === 'video' && !video) throw new Error(t('video.needsVideo', { model: model.id }));
  if (model.input === 'image') {
    if (images.length > 0) throw new Error(t('video.startNotReferences', { model: model.id }));
    if (!image) throw new Error(t('video.needsImage', { model: model.id }));
  }
  if (model.input === 'reference') {
    if (image) throw new Error(t('video.referencesNotStart', { model: model.id }));
    if (images.length === 0) throw new Error(t('video.needsReferences', { model: model.id }));
    // A citation without its image is refused here rather than paid for.
    const cited = Math.max(0, ...[...prompt.matchAll(/@image(\d+)\b/gi)].map((m) => Number(m[1])));
    if (cited > images.length) throw new Error(t('video.missingReference', { n: cited, count: images.length }));
  }
}

/** The request a model gets for what was asked: values it does not take are refused here, with the ones it takes. */
export async function videoRequest(model: VideoModel, ask: VideoAsk, cwd: string): Promise<VideoRequest> {
  const prompt = ask.prompt.trim();
  if (!prompt) throw new Error(t('video.noPrompt'));
  const asked = ask.duration ? durationOf(ask.duration) : '';
  const duration = asked ? among('duration', asked, model.durations, model.id) : (model.durations[0] ?? '5s');
  const image = ask.image?.trim() ?? '';
  const images = (ask.images ?? []).map((i) => i.trim()).filter(Boolean);
  const video = ask.video?.trim() ?? '';
  checkInputs(model, prompt, image, images, video);
  const aspectRatio = ask.aspectRatio?.trim() ? among('aspect_ratio', ask.aspectRatio.trim(), model.aspectRatios, model.id) : defaultAspect(model.aspectRatios);
  const resolution = ask.resolution?.trim() ? among('resolution', ask.resolution.trim(), model.resolutions, model.id) : '';
  // Read one after the other, in their order: a request too heavy stops at the image that tips it over.
  const urls: string[] = [];
  let weight = 0;
  for (const one of image ? [image, ...images] : images) {
    const url = await startImage(one, cwd);
    weight += inlineBytes(url);
    if (weight > IMAGES_MAX) throw new Error(t('video.imagesBig', { max: Math.round(IMAGES_MAX / 1024 / 1024) }));
    urls.push(url);
  }
  const imageUrl = image ? urls.shift() : undefined;
  return {
    model: model.id,
    prompt,
    ...(ask.negativePrompt?.trim() ? { negativePrompt: ask.negativePrompt.trim() } : {}),
    duration,
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(resolution ? { resolution } : {}),
    // Sound is only said to a model that lets it be chosen.
    ...(typeof ask.audio === 'boolean' && model.audioOption ? { audio: ask.audio } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    ...(urls.length > 0 ? { referenceImageUrls: urls } : {}),
    ...(video ? { videoUrl: await inline(video, cwd, 'video') } : {}),
  };
}

/** Why no video was saved. With `job`, the provider still holds it (a wait that ended, a cancelled call, a lost connection): a later call resumes it. */
export class VideoRunError extends Error {
  constructor(
    message: string,
    readonly job?: VideoJob,
  ) {
    super(message);
    this.name = 'VideoRunError';
  }
}

export interface RunOptions {
  adapter: VideoAdapter;
  baseUrl: string;
  key: string;
  /** The video to make; left out with `resume`. */
  request?: VideoRequest;
  /** A job queued earlier: only waited for and saved. */
  resume?: VideoJob;
  /** Only the price is asked: nothing is queued. */
  quoteOnly?: boolean;
  /** Above this price in US dollars, nothing is queued. */
  maxUsd?: number | null;
  outDir: string;
  /** How long the video is waited for once queued. */
  waitMs: number;
  signal: AbortSignal;
  /** The job as soon as the provider took it: what a later call resumes. */
  onJob?(job: VideoJob): void;
  fetch?: typeof fetch;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  now?(): number;
}

export type RunResult = { kind: 'quote'; usd: number | null } | { kind: 'saved'; path: string; bytes: number; job: VideoJob; usd: number | null; elapsedMs: number };

const sleepFor = (ms: number, signal: AbortSignal) =>
  new Promise<void>((done, fail) => {
    if (signal.aborted) return fail(signal.reason);
    const stop = () => {
      clearTimeout(timer);
      fail(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      done();
    }, ms);
    signal.addEventListener('abort', stop, { once: true });
  });

/** A failure worth asking again after: no answer, a busy or failing provider. A refusal is final. */
const passing = (err: unknown) => (err instanceof VideoApiError ? err.status === 429 || err.status >= 500 : err instanceof Error && (err.name === 'TimeoutError' || err instanceof TypeError));

/** What went wrong, for whoever asked: the provider's own words with what its status means. */
export function videoErrorText(err: unknown): string {
  if (err instanceof VideoApiError) {
    const key = err.status === 401 || err.status === 403 ? 'video.err.key' : err.status === 402 ? 'video.err.credit' : err.status === 429 ? 'video.err.busy' : 'video.err.refused';
    return t(key, { status: err.status, detail: err.message || '-' });
  }
  if (err instanceof Error && (err.name === 'TimeoutError' || err instanceof TypeError)) return t('video.err.network');
  return err instanceof Error ? err.message : String(err);
}

/** A file name no video has yet in this folder: when it was made and by which model. */
function freshPath(dir: string, model: string, ext: string, at: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}_${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
  const base = `${stamp}-${model.replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || 'video'}`;
  for (let n = 1; ; n++) {
    const path = join(dir, `${base}${n > 1 ? `-${n}` : ''}${ext}`);
    if (!existsSync(path) && !existsSync(`${path}.part`)) return path;
  }
}

/** The video written to the folder, whole or not at all: under a temporary name until its last byte. */
async function saveMedia(media: Response, dir: string, model: string, at: Date, stalled: () => void): Promise<{ path: string; bytes: number }> {
  const reader = media.body?.getReader();
  if (!reader) throw new Error(t('video.empty'));
  const type = (media.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  let path = '';
  let part = '';
  let file: FileHandle | null = null;
  let bytes = 0;
  let watchdog = setTimeout(stalled, STALL);
  try {
    await mkdir(dir, { recursive: true });
    // Two videos of one model ready in the same second: the name the other took meanwhile is left to it.
    while (!file) {
      path = freshPath(dir, model, MEDIA_EXT[type] ?? '.mp4', at);
      file = await open(`${path}.part`, 'wx').catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'EEXIST') throw err;
        return null;
      });
    }
    part = `${path}.part`;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      clearTimeout(watchdog);
      watchdog = setTimeout(stalled, STALL);
      bytes += value.length;
      if (bytes > VIDEO_MAX) throw new Error(t('video.tooBig'));
      await file.write(value);
    }
    if (bytes === 0) throw new Error(t('video.empty'));
    await file.close();
    await rename(part, path);
    return { path, bytes };
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    await file?.close().catch(() => undefined);
    if (part) await rm(part, { force: true }).catch(() => undefined);
    throw err;
  } finally {
    clearTimeout(watchdog);
  }
}

/**
 * Makes one video: price, queue, wait, save. A cancelled call stops at once and leaves no file; a wait that ends
 * first says the job's id (VideoRunError), which a later call resumes.
 */
export async function runVideo(o: RunOptions): Promise<RunResult> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? sleepFor;
  // One switch for every call and the download: the caller's signal, or a download that stalls.
  const run = new AbortController();
  const stop = () => run.abort(o.signal.reason);
  if (o.signal.aborted) stop();
  else o.signal.addEventListener('abort', stop, { once: true });
  const ctx: VideoContext = { baseUrl: o.baseUrl, key: o.key, signal: run.signal, fetch: o.fetch ?? fetch };
  let job = o.resume;
  try {
    let usd: number | null = null;
    if (!job) {
      const request = o.request;
      if (!request) throw new Error(t('video.noPrompt'));
      // A price that cannot be read never holds the video back, unless a ceiling was asked for.
      usd = await o.adapter.quote(ctx, request).catch((err: unknown) => {
        if (run.signal.aborted) throw err;
        return null;
      });
      if (o.quoteOnly) return { kind: 'quote', usd };
      if (typeof o.maxUsd === 'number') {
        if (usd === null) throw new Error(t('video.noQuote', { max: o.maxUsd }));
        if (usd > o.maxUsd) throw new Error(t('video.tooDear', { usd: String(usd), max: o.maxUsd }));
      }
      job = await o.adapter.submit(ctx, request);
      o.onJob?.(job);
    }
    const start = now();
    for (let failures = 0; ; ) {
      const waited = now() - start;
      // Asked often at first (a short clip is ready in seconds), then at a slower pace.
      const pause = waited < 60_000 ? 5_000 : 10_000;
      try {
        const r = await o.adapter.poll(ctx, job);
        failures = 0;
        if (r.state === 'done') {
          const done = job;
          const saved = await saveMedia(r.media, o.outDir, done.model, new Date(now()), () => run.abort(new DOMException('stalled download', 'TimeoutError'))).catch((err: unknown) => {
            if (o.signal.aborted) throw err;
            // Made, but not on this computer (a full disk, a download cut half-way): the provider still has it.
            throw new VideoRunError(`${t('video.notSaved', { reason: videoErrorText(err) })}\n${t('video.jobKept', { job: done.id, model: done.model })}`, done);
          });
          // Saved: the provider's copy may go. A failure here changes nothing for the user.
          await o.adapter.release(ctx, done).catch(() => undefined);
          return { kind: 'saved', ...saved, job: done, usd, elapsedMs: now() - start };
        }
      } catch (err) {
        if (o.signal.aborted || err instanceof VideoRunError || !passing(err) || ++failures > POLL_RETRIES) throw err;
      }
      if (now() - start + pause > o.waitMs) throw new VideoRunError(t('video.late', { minutes: Math.max(1, Math.round(o.waitMs / 60_000)), job: job.id, model: job.model }), job);
      await sleep(pause, run.signal);
    }
  } catch (err) {
    if (o.signal.aborted) throw new VideoRunError(job ? t('video.cancelledJob', { job: job.id, model: job.model }) : t('video.cancelled'), job);
    if (err instanceof VideoRunError) throw err;
    // Queued, then lost sight of: the provider may still finish it.
    if (job && passing(err)) throw new VideoRunError(`${videoErrorText(err)}\n${t('video.jobKept', { job: job.id, model: job.model })}`, job);
    throw new VideoRunError(videoErrorText(err));
  } finally {
    o.signal.removeEventListener('abort', stop);
  }
}
