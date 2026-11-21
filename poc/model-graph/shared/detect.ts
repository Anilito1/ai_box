import { specFromPreset, type ModelPrice, type ModelSpec, type PresetId } from './capabilities';

// From one entry of a provider's GET /models to a model's ports. Three sources, the surest first:
// 1. a typed list (Venice, Together): `type` says the API, `model_spec` says what the model reads;
// 2. modalities (OpenRouter): `architecture.input_modalities` / `output_modalities`;
// 3. nothing but an id (OpenAI, DeepSeek, a local server): a guess from the name, marked as one.
// What the user declares by hand always wins (see `applyManual`).

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '').slice(0, 60) : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const usd = (v: unknown): number | undefined => num(obj(v).usd);

/** A model the graph has no use for: embeddings, upscalers, anything that is not "media in, media out" yet. */
export type Detected = { spec: ModelSpec } | { skipped: string };

/** Venice's and Together's entries: `type` names what the model makes. */
function fromTyped(provider: string, id: string, type: string, entry: Record<string, unknown>): Detected | null {
  const spec = obj(entry.model_spec);
  const caps = obj(spec.capabilities);
  const constraints = obj(spec.constraints);
  const pricing = obj(spec.pricing);
  const name = str(spec.name) || str(entry.display_name) || id;
  const make = (preset: PresetId, more: { price?: ModelPrice; maxImages?: number; durations?: string[]; aspectRatios?: string[]; resolutions?: string[] } = {}): Detected => ({
    spec: specFromPreset(provider, id, preset, { name, source: 'listed', ...more }),
  });
  switch (type) {
    case 'text':
    case 'chat':
    case 'language': {
      const price: ModelPrice = { input: usd(pricing.input), output: usd(pricing.output) };
      // A list that says nothing of images leaves a text model, as the hub has it today.
      const preset: PresetId = caps.supportsVideoInput === true ? 'llm-video' : caps.supportsVision === true ? 'llm-vision' : 'llm';
      const maxImages = caps.supportsMultipleImages === false ? 1 : num(caps.maxImages);
      return make(preset, { price, maxImages });
    }
    case 'image':
      return make('text-to-image', { price: { perCall: usd(pricing.generation) } });
    case 'inpaint':
      // Venice's name for its instruction editors: one source image, more when the model combines them.
      return make('reference-to-image', { price: { perCall: usd(pricing.inpaint) }, maxImages: constraints.combineImages === true ? (num(constraints.maxInputImages) ?? 3) : 1 });
    case 'video': {
      const kind = str(constraints.model_type);
      const preset: PresetId = kind === 'image-to-video' ? 'image-to-video' : kind === 'video' ? 'video-to-video' : 'text-to-video';
      return make(preset, { durations: strings(constraints.durations), aspectRatios: strings(constraints.aspect_ratios), resolutions: strings(constraints.resolutions) });
    }
    case 'tts':
      return make('text-to-speech');
    case 'asr':
    case 'transcribe':
      return make('speech-to-text');
    case 'embedding':
    case 'upscale':
    case 'music':
    case 'decision':
    case 'rerank':
    case 'moderation':
      return { skipped: type };
    default:
      return null;
  }
}

/** OpenRouter's entries: the modalities themselves. */
function fromModalities(provider: string, id: string, entry: Record<string, unknown>): Detected | null {
  const arch = obj(entry.architecture);
  const input = strings(arch.input_modalities);
  const output = strings(arch.output_modalities);
  if (input.length === 0 || output.length === 0) return null;
  const pricing = obj(entry.pricing);
  // OpenRouter prices per token, as text.
  const perMillion = (v: unknown) => (typeof v === 'string' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v) * 1e12) / 1e6 : undefined);
  const more = { name: str(entry.name) || id, source: 'listed' as const, price: { input: perMillion(pricing.prompt), output: perMillion(pricing.completion) } };
  if (output.includes('text')) return { spec: specFromPreset(provider, id, input.includes('video') ? 'llm-video' : input.includes('image') ? 'llm-vision' : 'llm', more) };
  if (output.includes('image')) return { spec: specFromPreset(provider, id, input.includes('image') ? 'reference-to-image' : 'text-to-image', more) };
  return { skipped: output.join('+') };
}

// The order matters: "image-to-video" must not stop at "image".
const GUESSES: [RegExp, PresetId | null][] = [
  [/embed|rerank|moderation|guard/, null],
  [/whisper|transcri|parakeet|\bstt\b|\basr\b/, 'speech-to-text'],
  [/\btts\b|text-to-speech|speech/, 'text-to-speech'],
  [/image-to-video|img2vid|\bi2v\b/, 'image-to-video'],
  [/video-to-video|\bv2v\b/, 'video-to-video'],
  [/text-to-video|\bt2v\b|sora|veo|kling|seedance|\bwan-|video/, 'text-to-video'],
  [/image-edit|-edit\b|kontext|inpaint|reference-to-image|img2img/, 'reference-to-image'],
  [/dall-e|gpt-image|text-to-image|\bflux|stable-diffusion|sdxl|\bsd3|imagen|seedream|image/, 'text-to-image'],
  [/vision|gpt-4o|gpt-4\.1|gpt-5|claude|gemini|pixtral|llava|qwen.*vl|\bvl\b/, 'llm-vision'],
];

/** Nothing but a name: the usual words say enough to propose ports, and the user confirms or corrects. */
export function guessPreset(id: string): PresetId | null {
  const name = id.toLowerCase();
  for (const [pattern, preset] of GUESSES) if (pattern.test(name)) return preset;
  return 'llm';
}

/** One entry of a GET /models answer as a model of the catalog. */
export function detectModel(provider: string, entry: unknown): Detected {
  const e = obj(entry);
  const id = str(e.id);
  if (!id) return { skipped: 'no id' };
  const listed = fromTyped(provider, id, str(e.type).toLowerCase(), e) ?? fromModalities(provider, id, e);
  if (listed) return listed;
  const preset = guessPreset(id);
  return preset ? { spec: specFromPreset(provider, id, preset, { source: 'guessed' }) } : { skipped: 'not a generation model' };
}

/** A whole list, the models the graph can use sorted by id. */
export function detectModels(provider: string, list: unknown, max = 600): ModelSpec[] {
  const data = Array.isArray(list) ? list : Array.isArray(obj(list).data) ? (obj(list).data as unknown[]) : [];
  return data
    .filter((m) => obj(obj(m).model_spec).offline !== true)
    .map((m) => detectModel(provider, m))
    .flatMap((d) => ('spec' in d ? [d.spec] : []))
    .sort((a, b) => a.model.localeCompare(b.model))
    .slice(0, max);
}

/** What the user declared by hand for one provider: the model's id and the shape it has. */
export interface ManualModel {
  model: string;
  preset: PresetId;
  maxImages?: number;
}

/** The listed models with the user's declarations over them: a declared model replaces a listed one, or is added. */
export function applyManual(provider: string, listed: ModelSpec[], manual: ManualModel[]): ModelSpec[] {
  const byId = new Map(listed.map((m) => [m.model.toLowerCase(), m]));
  for (const m of manual) {
    const known = byId.get(m.model.toLowerCase());
    // The name, the price and the values a list gave stay: the declaration only says the ports.
    byId.set(m.model.toLowerCase(), { ...specFromPreset(provider, known?.model ?? m.model, m.preset, { maxImages: m.maxImages }), ...(known ? { name: known.name, price: known.price } : {}) });
  }
  return [...byId.values()].sort((a, b) => a.model.localeCompare(b.model));
}
