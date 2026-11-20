import type { VideoApi, VideoModel } from '../../shared/video';

// A provider's video API as the hub drives it: list the models, ask the price, queue a job, ask for it until the
// video is there. One adapter per API (venice.ts); generate.ts runs any of them the same way.

/** Where an adapter's calls go. Its key is sent to `baseUrl` only; `signal` ends every call and download at once. */
export interface VideoContext {
  baseUrl: string;
  key: string;
  signal: AbortSignal;
  fetch: typeof fetch;
}

/** One video to make, its values already checked against the model. */
export interface VideoRequest {
  model: string;
  prompt: string;
  negativePrompt?: string;
  duration: string;
  aspectRatio?: string;
  resolution?: string;
  audio?: boolean;
  /** The image the video starts from: an http(s) address or a data: URL. */
  imageUrl?: string;
}

/** A job the provider took. */
export interface VideoJob {
  id: string;
  model: string;
  /** Where the finished video is fetched, when the provider gives an address rather than the file itself. */
  downloadUrl?: string;
}

export type VideoPoll =
  /** Still being made; how long it has run and usually runs, when the provider says. */
  | { state: 'pending'; elapsedMs?: number; expectedMs?: number }
  /** Made: the answer whose body is the video file, not read yet. */
  | { state: 'done'; media: Response };

/** What a provider answered instead of doing what was asked: its HTTP status and its own words. */
export class VideoApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'VideoApiError';
  }
}

export interface VideoAdapter {
  id: VideoApi;
  /** The video models the provider lists now. */
  models(ctx: VideoContext): Promise<VideoModel[]>;
  /** The price of a request in US dollars, null when the provider gives none. */
  quote(ctx: VideoContext, req: VideoRequest): Promise<number | null>;
  submit(ctx: VideoContext, req: VideoRequest): Promise<VideoJob>;
  poll(ctx: VideoContext, job: VideoJob): Promise<VideoPoll>;
  /** The provider's copy is no longer needed (the file is saved): it may delete it. Best effort. */
  release(ctx: VideoContext, job: VideoJob): Promise<void>;
}
