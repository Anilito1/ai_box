// What a model takes and what it gives, as the graph editor and the engine need it. No Node and no DOM.
//
// Two things the hub's ModelKind ('text' | 'image' | 'video') holds as one are kept apart here:
// - the ports: typed inputs and outputs, what may be wired to what;
// - the API: which adapter runs the model (a chat completion, an image call, a queued video job...).

export type MediaType = 'text' | 'image' | 'video' | 'audio';
export const MEDIA_TYPES: readonly MediaType[] = ['text', 'image', 'video', 'audio'];

/** One typed input or output of a node. */
export interface Port {
  id: string;
  type: MediaType;
  /** Inputs only: the node cannot run without a value here. */
  required?: boolean;
  /** Inputs: how many values it takes (reference images); outputs: how many it may give (frames). 1 when absent. */
  max?: number;
}

/** The API that runs a model: the adapter the engine hands it to. */
export type ModelApi = 'chat' | 'image' | 'image-edit' | 'video' | 'speech' | 'transcription';

/** What a call costs in US dollars, when the provider's list says. */
export interface ModelPrice {
  perCall?: number;
  /** Per million tokens. */
  input?: number;
  output?: number;
}

export interface ModelSpec {
  /** `provider/model`: unique in the catalog, what a graph's node names. */
  ref: string;
  provider: string;
  model: string;
  name: string;
  api: ModelApi;
  inputs: Port[];
  outputs: Port[];
  /** Where its ports come from: the provider's list, a guess from its name, the user. */
  source: 'listed' | 'guessed' | 'manual';
  /** Answers through a queue: submitted, then asked for until it is made. */
  queued: boolean;
  price?: ModelPrice;
  /** The values a video model takes ("5s", "16:9", "720p"), when its list gives them. */
  durations?: string[];
  aspectRatios?: string[];
  resolutions?: string[];
}

/** The shapes a model is declared with by hand, and the ones detection lands on. */
export type PresetId = 'llm' | 'llm-vision' | 'llm-video' | 'text-to-image' | 'reference-to-image' | 'text-to-video' | 'image-to-video' | 'video-to-video' | 'text-to-speech' | 'speech-to-text';

interface Preset {
  label: string;
  api: ModelApi;
  inputs: Port[];
  outputs: Port[];
}

const prompt = (required = true): Port => ({ id: 'prompt', type: 'text', required });

// Port ids are the same across the models of one API: swapping a model for another keeps the wires.
export const PRESETS: Record<PresetId, Preset> = {
  llm: { label: 'LLM (texte)', api: 'chat', inputs: [prompt()], outputs: [{ id: 'text', type: 'text' }] },
  // A model that reads media can do with its instruction alone ("describe this video"): its prompt is optional.
  'llm-vision': { label: 'LLM qui lit les images', api: 'chat', inputs: [prompt(false), { id: 'images', type: 'image', max: 8 }], outputs: [{ id: 'text', type: 'text' }] },
  'llm-video': {
    label: 'LLM qui lit images et vidéos',
    api: 'chat',
    inputs: [prompt(false), { id: 'images', type: 'image', max: 8 }, { id: 'video', type: 'video' }],
    outputs: [{ id: 'text', type: 'text' }],
  },
  'text-to-image': { label: 'Texte → image', api: 'image', inputs: [prompt()], outputs: [{ id: 'image', type: 'image' }] },
  'reference-to-image': {
    label: 'Image(s) de référence → image',
    api: 'image-edit',
    inputs: [prompt(), { id: 'images', type: 'image', required: true, max: 4 }],
    outputs: [{ id: 'image', type: 'image' }],
  },
  'text-to-video': { label: 'Texte → vidéo', api: 'video', inputs: [prompt()], outputs: [{ id: 'video', type: 'video' }] },
  'image-to-video': {
    label: 'Image → vidéo',
    api: 'video',
    inputs: [prompt(false), { id: 'image', type: 'image', required: true }],
    outputs: [{ id: 'video', type: 'video' }],
  },
  'video-to-video': {
    label: 'Vidéo → vidéo',
    api: 'video',
    inputs: [prompt(false), { id: 'video', type: 'video', required: true }],
    outputs: [{ id: 'video', type: 'video' }],
  },
  'text-to-speech': { label: 'Texte → audio (voix)', api: 'speech', inputs: [{ id: 'text', type: 'text', required: true }], outputs: [{ id: 'audio', type: 'audio' }] },
  'speech-to-text': { label: 'Audio → texte (transcription)', api: 'transcription', inputs: [{ id: 'audio', type: 'audio', required: true }], outputs: [{ id: 'text', type: 'text' }] },
};

export const PRESET_IDS = Object.keys(PRESETS) as PresetId[];

/** A model with the ports of a preset; `maxImages` sets how many images its `images` input takes. */
export function specFromPreset(provider: string, model: string, preset: PresetId, more: Partial<Pick<ModelSpec, 'name' | 'source' | 'price' | 'durations' | 'aspectRatios' | 'resolutions'>> & { maxImages?: number } = {}): ModelSpec {
  const p = PRESETS[preset];
  const { maxImages, ...rest } = more;
  const inputs = p.inputs.map((port) => (port.id === 'images' && maxImages !== undefined && maxImages >= 1 ? { ...port, max: Math.min(Math.floor(maxImages), 30) } : { ...port }));
  return {
    ref: `${provider}/${model}`,
    provider,
    model,
    name: model,
    api: p.api,
    inputs,
    outputs: p.outputs.map((port) => ({ ...port })),
    source: 'manual',
    queued: p.api === 'video',
    ...rest,
  };
}

const NAMES: Record<MediaType, [one: string, many: string]> = { text: ['texte', 'textes'], image: ['image', 'images'], video: ['vidéo', 'vidéos'], audio: ['audio', 'audios'] };

/** A port's type as the editor writes it: "image", "images ×4". */
export const portLabel = (port: Port): string => ((port.max ?? 1) > 1 ? `${NAMES[port.type][1]} ×${port.max}` : NAMES[port.type][0]);

export const typeName = (type: MediaType): string => NAMES[type][0];

/** What a model does in a few words: "texte + images ×4 → image". */
export function signature(spec: Pick<ModelSpec, 'inputs' | 'outputs'>): string {
  const side = (ports: Port[]) => ports.map(portLabel).join(' + ') || '∅';
  return `${side(spec.inputs)} → ${side(spec.outputs)}`;
}
