import { PRESET_IDS, PRESETS, specOf, type ModelSpec, type PresetId } from '../../../shared/modelCaps';
import type { DirectRunner, MediaValue, NodeCall, QueuedRunner, Runner, Value } from '../../../shared/graph/engine';
import { t, type Key } from '../../i18n';
import { mp4 } from '../media/mp4';
import { paint, seedOf, skyOf } from '../media/paint';
import { png } from '../media/png';
import { wav } from '../media/wav';
import { media, texts } from './real';

// The simulated provider: one model per shape, no key, no network. Its answers are made here (a landscape drawn
// from the prompt, the same landscape moving, a few notes) and say what they were made from, so a run shows the
// data going through the graph: the image comes from the prompt, the video from the image, the analysis from the
// video. Its calls have made-up prices, so that a run's cap can be tried for nothing.

export const SIM = 'sim';

const PRICES: Partial<Record<PresetId, number>> = { 'text-to-image': 0.01, 'reference-to-image': 0.04, 'text-to-video': 0.15, 'image-to-video': 0.12, 'video-to-video': 0.2, 'text-to-speech': 0.002, 'speech-to-text': 0.001 };

/** The simulated models, named in the user's language. */
export const simModels = (): ModelSpec[] =>
  PRESET_IDS.map((preset) =>
    specOf(SIM, {
      model: preset,
      name: t(`graph.sim.name.${preset}`),
      preset,
      source: 'listed',
      price: PRICES[preset] !== undefined ? { perCall: PRICES[preset] } : { input: 0.3, output: 1.2 },
      ...(PRESETS[preset].api === 'video' ? { durations: ['2s', '3s', '5s'] } : {}),
    }),
  );

export const IMAGE = { width: 384, height: 224 };
export const VIDEO = { width: 192, height: 112, fps: 8 };

export interface SimOptions {
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** 1 is the pace of a demo; larger is faster. */
  speed?: number;
}

const short = (text: string, max = 90) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const kb = (bytes: Uint8Array) => Math.max(1, Math.round(bytes.length / 1024));

/** What a simulated reader says of something it was given. */
function seen(value: MediaValue): string {
  const what = t(`graph.sim.what.${value.type}`);
  if (!value.sim) return t('graph.sim.received', { what, mime: value.mime, kb: kb(value.bytes) });
  if (value.type === 'audio') return t('graph.sim.heard', { what });
  const scene = t('graph.sim.scene', { sky: t(`graph.sim.sky.${skyOf(value.sim.seed)}` as Key) });
  return t(value.type === 'video' ? 'graph.sim.sawVideo' : 'graph.sim.saw', { what, label: value.label ?? `${kb(value.bytes)} kB`, scene });
}

/** The simulated LLM's words: a prompt when it is asked for one, a description of what it was given, an answer. */
export function simText(call: NodeCall): string {
  const asked = texts(call.inputs.prompt);
  const given = [...media(call.inputs.video), ...media(call.inputs.images), ...media(call.inputs.audio)];
  if (given.length) {
    const about = given.find((v) => v.sim)?.sim?.about;
    const lines = given.map((v) => seen(v).replace(/^./, (c) => c.toUpperCase()));
    return [...lines, ...(about ? [t('graph.sim.fits', { about: short(about) })] : [])].join(' ');
  }
  const instruction = call.node.kind === 'model' ? (call.node.instruction ?? '') : '';
  if (/prompt/i.test(instruction)) return `${short(asked.replace(/[.!?\s]+$/, ''), 300)}${t('graph.sim.promptTail')}`;
  const turn = call.history.filter((x) => x.role === 'user').length + 1;
  return t(turn > 1 ? 'graph.sim.replyTurn' : 'graph.sim.reply', { asked: short(asked, 200), turn });
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
  const estimate = async () => spec.price?.perCall ?? 0;
  const tokens = (s: string) => Math.ceil(s.length / 4);
  switch (spec.api) {
    case 'chat':
      return {
        estimate: async (call) => (tokens(texts(call.inputs.prompt)) * (spec.price?.input ?? 0)) / 1e6,
        async run(call, ctx) {
          await wait(900, ctx.signal);
          const text = simText(call);
          // Priced like a real one, on rough token counts.
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
          if (job.polls < 6) return { state: 'pending', progress: job.polls === 1 ? t('graph.progress.working') : t('graph.progress.percent', { percent: (job.polls - 1) * 20 }) };
          return { state: 'done', result: { outputs: { video: [simVideo(call)] } } };
        },
      } satisfies QueuedRunner<{ polls: number }> as Runner;
    case 'speech':
      return {
        estimate,
        async run(call, ctx) {
          await wait(700, ctx.signal);
          const said = texts(call.inputs.text);
          return { outputs: { audio: [{ type: 'audio', mime: 'audio/wav', bytes: wav(seedOf(said)), label: '2.4 s', sim: { seed: seedOf(said), about: said } }] } };
        },
      } satisfies DirectRunner;
    case 'transcription':
      return {
        estimate,
        async run(call, ctx) {
          await wait(700, ctx.signal);
          const heard = media(call.inputs.audio)[0];
          return { outputs: { text: [{ type: 'text', text: heard?.sim?.about ? t('graph.sim.transcript', { about: heard.sim.about }) : t('graph.sim.transcriptOf', { kb: heard ? kb(heard.bytes) : 0 }) }] } };
        },
      } satisfies DirectRunner;
  }
}
