import { PRESETS, specFromPreset, type ModelSpec, type PresetId } from '../../shared/capabilities';
import type { DirectRunner, NodeCall, QueuedRunner, Runner, Value } from '../../shared/engine';
import { mp4 } from '../media/mp4';
import { describe, paint, seedOf } from '../media/paint';
import { png } from '../media/png';
import { wav } from '../media/wav';

// The simulated provider: one model per shape, no key, no network. Its answers are made here (a drawn landscape,
// the same landscape animated, a few notes) and say what they were made from, so a run shows the data going
// through the graph: the image comes from the prompt, the video from the image, the analysis from the video.

export const SIM = 'sim';

const NAMES: Record<PresetId, string> = {
  llm: 'LLM simulé',
  'llm-vision': 'LLM vision simulé',
  'llm-video': 'LLM vidéo simulé',
  'text-to-image': 'Texte → image simulé',
  'reference-to-image': 'Référence → image simulé',
  'text-to-video': 'Texte → vidéo simulé',
  'image-to-video': 'Image → vidéo simulé',
  'video-to-video': 'Vidéo → vidéo simulé',
  'text-to-speech': 'Voix simulée',
  'speech-to-text': 'Transcription simulée',
};

/** What the simulated calls "cost", so the cap of a run can be tried without spending anything. */
const PRICES: Partial<Record<PresetId, number>> = { 'text-to-image': 0.01, 'reference-to-image': 0.04, 'text-to-video': 0.15, 'image-to-video': 0.12, 'video-to-video': 0.2, 'text-to-speech': 0.002, 'speech-to-text': 0.001 };

export const SIM_MODELS: ModelSpec[] = (Object.keys(PRESETS) as PresetId[]).map((preset) => ({
  ...specFromPreset(SIM, preset, preset, { name: NAMES[preset], source: 'listed' }),
  ...(PRICES[preset] !== undefined ? { price: { perCall: PRICES[preset] } } : { price: { input: 0.3, output: 1.2 } }),
  ...(PRESETS[preset].api === 'video' ? { durations: ['2s', '3s', '5s'] } : {}),
}));

export const IMAGE = { width: 384, height: 224 };
export const VIDEO = { width: 192, height: 112, fps: 8 };

export interface SimOptions {
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** 1 is the pace of the demo; larger is faster. */
  speed?: number;
}

const texts = (values: Value[] | undefined): string =>
  (values ?? [])
    .flatMap((v) => (v.type === 'text' ? [v.text.trim()] : []))
    .filter(Boolean)
    .join('\n\n');
const media = (values: Value[] | undefined) => (values ?? []).filter((v): v is Exclude<Value, { type: 'text' }> => v.type !== 'text');
const kb = (bytes: Uint8Array) => `${Math.max(1, Math.round(bytes.length / 1024))} Ko`;
const short = (text: string, max = 90) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** What a simulated reader says of something it was given. */
function seen(value: Exclude<Value, { type: 'text' }>): string {
  const what = value.type === 'video' ? 'la vidéo' : value.type === 'image' ? 'l’image' : 'l’audio';
  if (!value.sim) return `${what} reçue (${value.mime}, ${kb(value.bytes)})`;
  if (value.type === 'audio') return `${what} (${value.label ?? 'quelques notes'})`;
  const moves = value.type === 'video' ? ' ; le soleil traverse le ciel et les collines glissent doucement' : '';
  return `${what} (${value.label ?? kb(value.bytes)}) montre ${describe(value.sim.seed)}${moves}`;
}

/** The simulated LLM's words: a prompt when it is asked for one, a description of what it was given, an answer. */
export function simText(call: NodeCall): string {
  const asked = texts(call.inputs.prompt);
  const given = [...media(call.inputs.video), ...media(call.inputs.images), ...media(call.inputs.audio)];
  if (given.length) {
    const about = given.find((v) => v.sim)?.sim?.about;
    const fits = about ? ` Cela correspond à la demande de départ : « ${short(about)} ».` : '';
    return `${given.map((v) => seen(v).replace(/^./, (c) => c.toUpperCase())).join('. ')}.${fits}`;
  }
  if (/prompt/i.test(call.node.instruction ?? '')) return `${short(asked.replace(/[.!?\s]+$/, ''), 300)}, lumière dorée de fin de journée, plan large cinématographique, détails fins, 35 mm`;
  const turn = call.history.filter((t) => t.role === 'user').length + 1;
  return `Réponse simulée à « ${short(asked, 200)} »${turn > 1 ? ` (${turn}ᵉ message de la conversation)` : ''}.`;
}

/** The seed of a picture: its prompt and the pictures it starts from. */
function seedFor(call: NodeCall): { seed: number; about: string } {
  const asked = texts(call.inputs.prompt) || texts(call.inputs.text);
  const from = [...media(call.inputs.image), ...media(call.inputs.images), ...media(call.inputs.video)];
  // A video made from an image keeps the image's seed: it is that picture, moving.
  const first = from.find((v) => v.sim)?.sim;
  if (call.spec?.api === 'video' && first) return { seed: first.seed, about: first.about };
  const mixed = from.reduce((s, v) => Math.imul(s ^ (v.sim?.seed ?? v.bytes.length), 16777619) >>> 0, seedOf(asked));
  return { seed: mixed, about: asked || first?.about || '' };
}

function simVideo(call: NodeCall): Value {
  const { seed, about } = seedFor(call);
  const seconds = Math.min(6, Math.max(1, Number.parseInt(call.node.options?.duration ?? '3', 10) || 3));
  const count = seconds * VIDEO.fps;
  const frames = Array.from({ length: count }, (_, i) => paint(seed, VIDEO.width, VIDEO.height, i / (count - 1)));
  return { type: 'video', mime: 'video/mp4', bytes: mp4(frames, VIDEO.width, VIDEO.height, VIDEO.fps), label: `${VIDEO.width}×${VIDEO.height}, ${seconds} s`, sim: { seed, about } };
}

/** The runner of a simulated model. */
export function simRunner(spec: ModelSpec, o: SimOptions): Runner {
  const wait = (ms: number, signal: AbortSignal) => o.sleep(ms / (o.speed ?? 1), signal);
  const estimate = async () => spec.price?.perCall ?? null;
  switch (spec.api) {
    case 'chat':
      return {
        async run(call, ctx) {
          await wait(900, ctx.signal);
          const text = simText(call);
          // Priced like a real one, on rough token counts.
          const tokens = (s: string) => Math.ceil(s.length / 4);
          const costUsd = (tokens(texts(call.inputs.prompt)) * (spec.price?.input ?? 0) + tokens(text) * (spec.price?.output ?? 0)) / 1e6;
          return { outputs: { text: [{ type: 'text', text }] }, costUsd };
        },
      } satisfies DirectRunner;
    case 'image':
    case 'image-edit':
      return {
        estimate,
        async run(call, ctx) {
          await wait(1400, ctx.signal);
          const { seed, about } = seedFor(call);
          const bytes = png(paint(seed, IMAGE.width, IMAGE.height), IMAGE.width, IMAGE.height);
          return { outputs: { image: [{ type: 'image', mime: 'image/png', bytes, label: `${IMAGE.width}×${IMAGE.height}`, sim: { seed, about } }] } };
        },
      } satisfies DirectRunner;
    case 'video':
      // Queued like a real one: taken at once, then asked for until it is made.
      return {
        estimate,
        pollEveryMs: 700 / (o.speed ?? 1),
        async submit(_call, ctx) {
          await wait(300, ctx.signal);
          return { polls: 0 };
        },
        async poll(job, call) {
          job.polls++;
          if (job.polls < 6) return { state: 'pending', progress: job.polls === 1 ? 'dans la file du fournisseur' : `génération ${(job.polls - 1) * 20} %` };
          return { state: 'done', result: { outputs: { video: [simVideo(call)] } } };
        },
      } satisfies QueuedRunner<{ polls: number }> as Runner;
    case 'speech':
      return {
        estimate,
        async run(call, ctx) {
          await wait(700, ctx.signal);
          const said = texts(call.inputs.text);
          return { outputs: { audio: [{ type: 'audio', mime: 'audio/wav', bytes: wav(seedOf(said)), label: '2,4 s', sim: { seed: seedOf(said), about: said } }] } };
        },
      } satisfies DirectRunner;
    case 'transcription':
      return {
        estimate,
        async run(call, ctx) {
          await wait(700, ctx.signal);
          const heard = media(call.inputs.audio)[0];
          return { outputs: { text: [{ type: 'text', text: heard?.sim?.about ? `Transcription simulée : « ${heard.sim.about} »` : `Transcription simulée de l’audio reçu (${heard ? kb(heard.bytes) : 'vide'}).` }] } };
        },
      } satisfies DirectRunner;
  }
}
