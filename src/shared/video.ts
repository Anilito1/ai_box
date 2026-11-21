// Video generation through a provider's API: what the settings screen and the main process share. No Node and no DOM.

/** What a model of a server's list makes. Only text models run sessions; the others are never offered for one. */
export type ModelKind = 'text' | 'image' | 'video';

const KINDS = new Map<string, ModelKind>([
  ['video', 'video'],
  ['text-to-video', 'video'],
  ['image-to-video', 'video'],
  ['image', 'image'],
  ['text-to-image', 'image'],
  ['inpaint', 'image'],
  ['upscale', 'image'],
]);

/**
 * The kind a server's list gives a model (the `type` of Venice's or Together's entries). Only the names that say a
 * model makes videos or images count: anything else, or nothing, leaves it a text model as before.
 */
export const modelKind = (type: unknown): ModelKind => (typeof type === 'string' ? (KINDS.get(type.toLowerCase()) ?? 'text') : 'text');

/** The video APIs the hub speaks, one adapter each (main/video). */
export type VideoApi = 'venice';

/** The video API behind a provider's address, null when the hub has no adapter for it. */
export function videoApiOf(baseUrl: string): VideoApi | null {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'api.venice.ai' ? 'venice' : null;
  } catch {
    return null;
  }
}

/** A video model of a provider, as its list describes it; one named by hand has only its id. */
export interface VideoModel {
  id: string;
  /** Its name at the provider, empty when unknown. */
  name: string;
  /**
   * What it starts from: a prompt alone, the image of its first frame, reference images the prompt cites in order
   * (@Image1, @Image2…), a video it reworks; empty when unknown.
   */
  input: VideoInput;
  /** The values it takes ("5s", "16:9", "720p"); empty when unknown: anything is sent as asked. */
  durations: string[];
  aspectRatios: string[];
  resolutions: string[];
  /** Its sound can be switched on or off. */
  audioOption: boolean;
  /** What the provider says it keeps of a request: nothing ('private'), or what it keeps anonymized; empty when unknown. */
  privacy: 'private' | 'anonymized' | '';
  /** The provider says it does not filter what the model makes. */
  uncensored: boolean;
  /** Named by hand in the settings, not listed by the provider. */
  manual: boolean;
}

export type VideoInput = 'text' | 'image' | 'reference' | 'video' | '';

/** Reference images one request carries at most (Venice's limit). */
export const VIDEO_REFERENCES_MAX = 30;

/** Video models a user may name by hand for one provider. */
export const VIDEO_MODELS_MAX = 50;

/** A video model the user named, with nothing known about it. */
export const manualVideoModel = (id: string): VideoModel => ({
  id,
  name: '',
  input: '',
  durations: [],
  aspectRatios: [],
  resolutions: [],
  audioOption: true,
  privacy: '',
  uncensored: false,
  manual: true,
});

/** The provider's video models, then the ones named by hand that it does not list. */
export function mergeVideoModels(listed: VideoModel[], manual: string[]): VideoModel[] {
  const known = new Set(listed.map((m) => m.id.toLowerCase()));
  return [...listed, ...manual.filter((id) => !known.has(id.toLowerCase())).map(manualVideoModel)];
}

/** The models that may run a session: the list without any known video model, whatever its case. */
export function textModels(models: string[], video: Iterable<string>): string[] {
  const out = new Set([...video].map((id) => id.toLowerCase()));
  return out.size === 0 ? models : models.filter((m) => !out.has(m.toLowerCase()));
}

/** The names of a list that are video models: what a provider's form refuses among its session models. */
export function videoAmong(models: string[], video: Iterable<string>): string[] {
  const kept = new Set(textModels(models, video));
  return models.filter((m) => !kept.has(m));
}
