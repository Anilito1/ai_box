// What a provider's model takes and gives, as the graphs and the settings need it. No Node and no DOM, no text.
//
// Two things the hub long held as one are kept apart:
// - the ports: typed inputs and outputs, what may be wired to what in a graph;
// - the API: which call runs the model (a chat completion, an image call, a queued video job...).
// Every model has one of a few shapes (`PresetId`): a provider's list says which (`detectModel`), else its name
// suggests one, and what the user declares by hand (`ModelCap`, saved on the account) always wins.

export type MediaType = 'text' | 'image' | 'video' | 'audio';
export const MEDIA_TYPES: readonly MediaType[] = ['text', 'image', 'video', 'audio'];

/** One typed input or output of a graph's node. */
export interface Port {
  id: string;
  type: MediaType;
  /** Inputs only: the node cannot run without a value here. */
  required?: boolean;
  /** Inputs: how many values it takes (reference images); outputs: how many it may give (frames). 1 when absent. */
  max?: number;
}

/** The call that runs a model: the runner a graph hands it to. */
export type ModelApi = 'chat' | 'image' | 'image-edit' | 'video' | 'speech' | 'transcription';

/** What a call costs in US dollars, when the provider's list says. */
export interface ModelPrice {
  perCall?: number;
  /** Per million tokens. */
  input?: number;
  output?: number;
}

export type PresetId = 'llm' | 'llm-vision' | 'llm-video' | 'text-to-image' | 'reference-to-image' | 'text-to-video' | 'image-to-video' | 'video-to-video' | 'text-to-speech' | 'speech-to-text';

interface Preset {
  api: ModelApi;
  inputs: Port[];
  outputs: Port[];
}

const prompt = (required = true): Port => ({ id: 'prompt', type: 'text', required });

// The port ids are the same across the models of one API: putting another model on a node keeps its wires.
export const PRESETS: Record<PresetId, Preset> = {
  llm: { api: 'chat', inputs: [prompt()], outputs: [{ id: 'text', type: 'text' }] },
  // A model that reads media can do with its instruction alone ("describe this video"): its prompt is optional.
  'llm-vision': { api: 'chat', inputs: [prompt(false), { id: 'images', type: 'image', max: 8 }], outputs: [{ id: 'text', type: 'text' }] },
  'llm-video': { api: 'chat', inputs: [prompt(false), { id: 'images', type: 'image', max: 8 }, { id: 'video', type: 'video' }], outputs: [{ id: 'text', type: 'text' }] },
  'text-to-image': { api: 'image', inputs: [prompt()], outputs: [{ id: 'image', type: 'image' }] },
  'reference-to-image': { api: 'image-edit', inputs: [prompt(), { id: 'images', type: 'image', required: true, max: 4 }], outputs: [{ id: 'image', type: 'image' }] },
  'text-to-video': { api: 'video', inputs: [prompt()], outputs: [{ id: 'video', type: 'video' }] },
  'image-to-video': { api: 'video', inputs: [prompt(false), { id: 'image', type: 'image', required: true }], outputs: [{ id: 'video', type: 'video' }] },
  'video-to-video': { api: 'video', inputs: [prompt(false), { id: 'video', type: 'video', required: true }], outputs: [{ id: 'video', type: 'video' }] },
  'text-to-speech': { api: 'speech', inputs: [{ id: 'text', type: 'text', required: true }], outputs: [{ id: 'audio', type: 'audio' }] },
  'speech-to-text': { api: 'transcription', inputs: [{ id: 'audio', type: 'audio', required: true }], outputs: [{ id: 'text', type: 'text' }] },
};

export const PRESET_IDS = Object.keys(PRESETS) as PresetId[];
export const isPresetId = (v: unknown): v is PresetId => typeof v === 'string' && Object.hasOwn(PRESETS, v);
/** The shapes of the models that may run a session: they answer a conversation with text. */
export const isChatPreset = (preset: PresetId) => PRESETS[preset].api === 'chat';

/** Reference images a model may be declared to take, at most. */
export const MAX_IMAGES_LIMIT = 30;

/** A model as its provider's list (or the user) describes it: one shape, and what the list adds. */
export interface ModelShape {
  model: string;
  /** Its name at the provider, empty when unknown. */
  name: string;
  preset: PresetId;
  /** How many images its `images` input takes, when the list says (or the user). */
  maxImages?: number;
  /** Where its shape comes from: the provider's list, a guess from its name, the user. */
  source: 'listed' | 'guessed' | 'manual';
  price?: ModelPrice;
  /** The values a video model takes ("5s", "16:9", "720p"), when its list gives them. */
  durations?: string[];
  aspectRatios?: string[];
  resolutions?: string[];
}

/** A model of the graphs' catalog: its shape, its ports, and where it is. */
export interface ModelSpec extends ModelShape {
  /** `account/model`: unique in the catalog, what a graph's node names. */
  ref: string;
  /** The account it runs on (or "sim", the simulated provider). */
  provider: string;
  api: ModelApi;
  inputs: Port[];
  outputs: Port[];
  /** Answers through a queue: submitted, then asked for until it is made. */
  queued: boolean;
}

/** The ref of a model: its account, then its id (which may itself hold slashes). */
export const modelRef = (provider: string, model: string) => `${provider}/${model}`;
/** A ref taken apart at its first slash. */
export function splitRef(ref: string): { provider: string; model: string } {
  const at = ref.indexOf('/');
  return at < 0 ? { provider: '', model: ref } : { provider: ref.slice(0, at), model: ref.slice(at + 1) };
}

/** A model of the catalog, its ports made from its shape. */
export function specOf(provider: string, shape: ModelShape): ModelSpec {
  const p = PRESETS[shape.preset];
  const max = shape.maxImages !== undefined && shape.maxImages >= 1 ? Math.min(Math.floor(shape.maxImages), MAX_IMAGES_LIMIT) : undefined;
  return {
    ...shape,
    ref: modelRef(provider, shape.model),
    provider,
    api: p.api,
    inputs: p.inputs.map((port) => (port.id === 'images' && max !== undefined ? { ...port, max } : { ...port })),
    outputs: p.outputs.map((port) => ({ ...port })),
    queued: p.api === 'video',
  };
}

// ── From a provider's list ───────────────────────────────────────────────────────────────────────────────────────
// Three sources, the surest first:
// 1. a typed list (Venice, Together): `type` says the API, `model_spec` says what the model reads;
// 2. modalities (OpenRouter): `architecture.input_modalities` / `output_modalities`;
// 3. nothing but an id (OpenAI, DeepSeek, a local server): a guess from the name, marked as one.

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '' && x.length <= 40).slice(0, 60) : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const usd = (v: unknown): number | undefined => num(obj(v).usd);
/** Only what is known: an empty price or list is left out. */
const known = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0))) as Partial<T>;

/** A model the graphs have no use for (embeddings, upscalers, music...), and why. */
export type Detected = { shape: ModelShape } | { skipped: string };

type More = Pick<ModelShape, 'maxImages' | 'price' | 'durations' | 'aspectRatios' | 'resolutions'>;

/** Venice's and Together's entries: `type` names what the model makes. */
function fromTyped(id: string, type: string, entry: Record<string, unknown>): Detected | null {
  const spec = obj(entry.model_spec);
  const caps = obj(spec.capabilities);
  const constraints = obj(spec.constraints);
  const pricing = obj(spec.pricing);
  const name = str(spec.name) || str(entry.display_name);
  const make = (preset: PresetId, more: More = {}): Detected => {
    const price = more.price ? known(more.price) : undefined;
    return { shape: { model: id, name, preset, source: 'listed', ...known({ ...more, price: price && Object.keys(price).length > 0 ? price : undefined }) } };
  };
  switch (type) {
    case 'text':
    case 'chat':
    case 'language': {
      // A list that says nothing of images leaves a text model, as the hub has it.
      const preset: PresetId = caps.supportsVideoInput === true ? 'llm-video' : caps.supportsVision === true ? 'llm-vision' : 'llm';
      const maxImages = preset === 'llm' ? undefined : caps.supportsMultipleImages === false ? 1 : num(caps.maxImages);
      return make(preset, { price: { input: usd(pricing.input), output: usd(pricing.output) }, maxImages });
    }
    case 'image':
      return make('text-to-image', { price: { perCall: usd(pricing.generation) } });
    case 'inpaint':
      // Venice's name for its instruction editors, the "reference to image" models: one source image, more when the
      // model combines them.
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
function fromModalities(id: string, entry: Record<string, unknown>): Detected | null {
  const arch = obj(entry.architecture);
  const input = strings(arch.input_modalities);
  const output = strings(arch.output_modalities);
  if (input.length === 0 || output.length === 0) return null;
  const pricing = obj(entry.pricing);
  // OpenRouter prices a token, as text.
  const perMillion = (v: unknown) => (typeof v === 'string' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v) * 1e12) / 1e6 : undefined);
  const price = known({ input: perMillion(pricing.prompt), output: perMillion(pricing.completion) });
  const shape = (preset: PresetId): Detected => ({ shape: { model: id, name: str(entry.name), preset, source: 'listed', ...(Object.keys(price).length > 0 ? { price } : {}) } });
  if (output.includes('text')) return shape(input.includes('video') ? 'llm-video' : input.includes('image') ? 'llm-vision' : 'llm');
  if (output.includes('image')) return shape(input.includes('image') ? 'reference-to-image' : 'text-to-image');
  return { skipped: output.join('+') };
}

// The order matters: "image-to-video" must not stop at "image".
const GUESSES: [RegExp, PresetId | null][] = [
  [/embed|rerank|moderation|llama-?guard|prompt-?guard|shieldgemma|granite-guardian/, null],
  [/whisper|transcri|parakeet|\bstt\b|\basr\b/, 'speech-to-text'],
  [/\btts\b|text-to-speech|speech/, 'text-to-speech'],
  [/image-to-video|img2vid|\bi2v\b/, 'image-to-video'],
  [/video-to-video|\bv2v\b/, 'video-to-video'],
  [/text-to-video|\bt2v\b|sora|\bveo|kling|seedance|\bwan-|hunyuan-?video|ltx-?video|cogvideo|video-?gen/, 'text-to-video'],
  [/image-edit|-edit\b|kontext|inpaint|reference.to.image|ref2img|img2img/, 'reference-to-image'],
  [/dall-e|gpt-image|text-to-image|\bflux|stable-diffusion|sdxl|\bsd3|imagen|seedream|picture|image/, 'text-to-image'],
  [/vision|gpt-4o|gpt-4\.1|gpt-5|claude|gemini|pixtral|llava|qwen.*vl|\bvl\b/, 'llm-vision'],
];

/** Nothing but a name: the usual words say enough to propose a shape, which the user confirms or corrects. Null: not a generation model. */
export function guessPreset(id: string): PresetId | null {
  const name = id.toLowerCase();
  for (const [pattern, preset] of GUESSES) if (pattern.test(name)) return preset;
  return 'llm';
}

/** One entry of a GET /models answer. */
export function detectModel(entry: unknown): Detected {
  const e = obj(entry);
  const id = str(e.id);
  if (!id || id.length > 200) return { skipped: 'no id' };
  const listed = fromTyped(id, str(e.type).toLowerCase(), e) ?? fromModalities(id, e);
  if (listed) return listed;
  const preset = guessPreset(id);
  return preset ? { shape: { model: id, name: '', preset, source: 'guessed' } } : { skipped: 'not a generation model' };
}

/** A whole GET /models answer (`{ data: [...] }` or a bare list): the models the hub can call, by id. Models that are off are left out. */
export function detectModels(list: unknown, max = 600): ModelShape[] {
  const data = Array.isArray(list) ? list : Array.isArray(obj(list).data) ? (obj(list).data as unknown[]) : [];
  return data
    .filter((m) => obj(obj(m).model_spec).offline !== true)
    .map((m) => detectModel(m))
    .flatMap((d) => ('shape' in d ? [d.shape] : []))
    .sort((a, b) => a.model.localeCompare(b.model))
    .slice(0, max);
}

// ── What the user declares ───────────────────────────────────────────────────────────────────────────────────────

/** A shape the user declared for one model of a provider: saved on its account, it wins over the list. */
export interface ModelCap {
  preset: PresetId;
  maxImages?: number;
}

/** Models a provider may have declared by hand. */
export const MODEL_CAPS_MAX = 100;

/** Declarations as the settings sent them or the config held them: the valid ones, at most MODEL_CAPS_MAX. */
export function normalizeCaps(raw: unknown, validId: (id: string) => boolean): Record<string, ModelCap> {
  const out: Record<string, ModelCap> = {};
  for (const [model, v] of Object.entries(obj(raw))) {
    const cap = obj(v);
    if (!validId(model) || !isPresetId(cap.preset) || Object.keys(out).length >= MODEL_CAPS_MAX) continue;
    const max = typeof cap.maxImages === 'number' && Number.isInteger(cap.maxImages) && cap.maxImages >= 1 && cap.maxImages <= MAX_IMAGES_LIMIT ? cap.maxImages : undefined;
    out[model] = { preset: cap.preset, ...(max !== undefined ? { maxImages: max } : {}) };
  }
  return out;
}

/** The shape of a model the list does not describe: what its name suggests, an LLM when nothing does. */
export const guessedShape = (model: string, fallback: PresetId = 'llm'): ModelShape => ({ model, name: '', preset: guessPreset(model) ?? fallback, source: 'guessed' });

/**
 * A provider's models with the user's declarations over them: a declared model takes the declared shape (its name,
 * price and values from the list stay), or is added when the list lacks it. Sorted by id.
 */
export function applyCaps(listed: ModelShape[], caps: Record<string, ModelCap>): ModelShape[] {
  const byId = new Map(listed.map((m) => [m.model.toLowerCase(), m]));
  for (const [model, cap] of Object.entries(caps)) {
    const was = byId.get(model.toLowerCase());
    byId.set(model.toLowerCase(), {
      model: was?.model ?? model,
      name: was?.name ?? '',
      preset: cap.preset,
      source: 'manual',
      ...(cap.maxImages !== undefined ? { maxImages: cap.maxImages } : {}),
      ...(was?.price ? { price: was.price } : {}),
      ...(was?.durations ? { durations: was.durations, aspectRatios: was.aspectRatios, resolutions: was.resolutions } : {}),
    });
  }
  return [...byId.values()].sort((a, b) => a.model.localeCompare(b.model));
}

/** The shape of one model of a provider: declared, else listed, else guessed from its name. */
export function shapeOf(model: string, listed: ModelShape[], caps: Record<string, ModelCap>): ModelShape {
  const lower = model.toLowerCase();
  const declared = Object.entries(caps).find(([id]) => id.toLowerCase() === lower);
  if (declared) return applyCaps(listed.filter((m) => m.model.toLowerCase() === lower), { [declared[0]]: declared[1] })[0];
  return listed.find((m) => m.model.toLowerCase() === lower) ?? guessedShape(model);
}

/** The models of a list that may run a session: the ones whose shape answers with text, as declared or detected. */
export function chatShapes(shapes: ModelShape[]): string[] {
  return shapes.filter((m) => isChatPreset(m.preset)).map((m) => m.model);
}
