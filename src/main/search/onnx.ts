import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * An embedding model run by ONNX Runtime (onnxruntime-node: every Windows binary signed by Microsoft) on DirectML, else
 * on the processor. The folder holds the graph, its weights and the tokenizer of a decoder exported with its key/value
 * cache (onnx-community): fed empty, the last token's state is the vector.
 *
 * DirectML is fast only on fixed shapes: a text of 400 tokens took 356 ms with free shapes and 59 ms in a session of
 * 512. So the card gets one session per length bucket, two at most (each holds its own copy of the weights); the
 * indexer sends its texts longest first, which changes bucket a handful of times per repo.
 */

interface Tensor { dims: readonly number[]; data: Float32Array }
interface Session {
  inputNames: readonly string[];
  run(feeds: Record<string, unknown>, fetches: string[]): Promise<Record<string, Tensor>>;
  release(): Promise<void>;
}
interface Ort {
  Tensor: new (type: string, data: unknown, dims: number[]) => unknown;
  InferenceSession: { create(path: string, options: Record<string, unknown>): Promise<Session> };
}
interface Tokenizer { encode(text: string): { ids: number[] } }

/** Lengths of the card's sessions; a longer text is cut to the last one. */
export const BUCKETS = [128, 256, 512, 1024, 2048];
export const bucketOf = (tokens: number): number => BUCKETS.find((b) => b >= tokens) ?? BUCKETS[BUCKETS.length - 1];

/** The ids a text goes in with: cut to `max` tokens, still closed by the end marker the vector is read on. */
export function clip(ids: number[], max: number, eos: number): number[] {
  if (ids.length <= max) return ids;
  return [...ids.slice(0, max - 1), eos];
}

/** The order to read texts in on the card: by bucket, longest first, so the session changes as rarely as possible. */
export function readingOrder(lengths: number[]): number[] {
  return lengths.map((n, i) => ({ i, b: bucketOf(n) })).sort((a, b) => b.b - a.b || a.i - b.i).map((x) => x.i);
}

export interface OnnxModel {
  gpu: boolean;
  device: string;
  dims: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

const ADAPTERS = 4;
/** Sessions kept open on the card at once. */
const SESSIONS = 2;

export async function openOnnx(o: { runtime: string; folder: string; gpu: boolean; maxTokens: number; threads?: number }): Promise<OnnxModel> {
  const require = createRequire(join(o.runtime, 'package.json'));
  const ort = require('onnxruntime-node') as Ort;
  const { Tokenizer } = (await import(pathToFileURL(join(o.runtime, 'node_modules', '@huggingface', 'tokenizers', 'dist', 'tokenizers.mjs')).href)) as {
    Tokenizer: new (json: unknown, config: unknown) => Tokenizer;
  };
  const read = (name: string): unknown => JSON.parse(readFileSync(join(o.folder, name), 'utf8'));
  const tokenizer = new Tokenizer(read('tokenizer.json'), read('tokenizer_config.json'));
  const cfg = read('config.json') as { hidden_size: number; num_key_value_heads: number; head_dim: number; eos_token_id: number };
  const graph = join(o.folder, 'onnx', 'model_fp16.onnx');
  const base = { graphOptimizationLevel: 'all', logSeverityLevel: 3 };
  const onCard = (adapter: number, length: number) =>
    ort.InferenceSession.create(graph, {
      ...base,
      executionProviders: [{ name: 'dml', deviceId: adapter }],
      enableMemPattern: false,
      executionMode: 'sequential',
      freeDimensionOverrides: { batch_size: 1, sequence_length: length, total_sequence_length: length, past_sequence_length: 0 },
    });

  const empty = (s: Session): Record<string, unknown> => {
    const feeds: Record<string, unknown> = {};
    for (const name of s.inputNames.filter((x) => x.startsWith('past_key_values'))) feeds[name] = new ort.Tensor('float16', new Uint16Array(0), [1, cfg.num_key_value_heads, 0, cfg.head_dim]);
    return feeds;
  };
  const longs = (length: number, at: (i: number) => number) => new ort.Tensor('int64', BigInt64Array.from({ length }, (_, i) => BigInt(at(i))), [1, length]);
  /** One text in a session of `length` tokens (its own length when the shapes are free): the normalized last state. */
  const vectorOf = async (s: Session, ids: number[], length: number): Promise<Float32Array> => {
    const n = ids.length;
    const out = await s.run(
      { ...empty(s), input_ids: longs(length, (i) => (i < n ? ids[i] : cfg.eos_token_id)), attention_mask: longs(length, () => 1), position_ids: longs(length, (i) => i) },
      ['last_hidden_state'],
    );
    // Causal attention: the tokens padded after the last one do not change its state.
    const d = out.last_hidden_state.dims[2];
    const v = Float32Array.from(out.last_hidden_state.data.subarray((n - 1) * d, n * d));
    let sum = 0;
    for (const x of v) sum += x * x;
    const norm = Math.sqrt(sum) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= norm;
    return v;
  };
  const idsOf = (text: string): number[] => clip(tokenizer.encode(text).ids, o.maxTokens, cfg.eos_token_id);

  const onCardModel = async (adapter: number): Promise<OnnxModel | null> => {
    // Most recently used last. Two at most: a batch of the index straddles two buckets (its texts are sorted by
    // characters, not tokens), and opening a session takes about two seconds.
    const sessions = new Map<number, Session>();
    const sessionFor = async (length: number): Promise<Session> => {
      const kept = sessions.get(length);
      if (kept) {
        sessions.delete(length);
        sessions.set(length, kept);
        return kept;
      }
      const drop = async (keep: number) => {
        for (const [l, s] of [...sessions]) {
          if (sessions.size <= keep) break;
          sessions.delete(l);
          await s.release();
        }
      };
      await drop(SESSIONS - 1);
      let s: Session;
      try {
        s = await onCard(adapter, length);
      } catch (err) {
        // No room for a second copy of the weights: the card keeps one session at a time.
        if (!sessions.size) throw err;
        await drop(0);
        s = await onCard(adapter, length);
      }
      sessions.set(length, s);
      return s;
    };
    try {
      await sessionFor(BUCKETS[0]);
    } catch {
      return null;
    }
    return {
      gpu: true,
      device: `DirectML ${adapter}`,
      dims: cfg.hidden_size,
      async embed(texts) {
        const ids = texts.map(idsOf);
        const out: Float32Array[] = new Array(texts.length);
        for (const i of readingOrder(ids.map((x) => x.length))) {
          const need = bucketOf(ids[i].length);
          // A lone question takes a session already open when one holds it.
          const open = texts.length === 1 ? [...sessions.keys()].filter((l) => l >= need).sort((a, b) => a - b)[0] : undefined;
          const length = open ?? need;
          out[i] = await vectorOf(await sessionFor(length), ids[i], length);
        }
        return out;
      },
    };
  };

  if (o.gpu) {
    const adapter = await pickAdapter(o.runtime, onCard, (s) => vectorOf(s, idsOf('warm up'), BUCKETS[0]));
    const model = adapter === null ? null : await onCardModel(adapter);
    if (model) return model;
    // The adapter kept is gone (another card, a driver removed): measured again next time, the processor now.
    if (adapter !== null) rmSync(join(o.runtime, 'dml-adapter.json'), { force: true });
  }
  const s = await ort.InferenceSession.create(graph, { ...base, executionProviders: ['cpu'], ...(o.threads ? { intraOpNumThreads: o.threads } : {}) });
  return {
    gpu: false,
    device: '',
    dims: cfg.hidden_size,
    async embed(texts) {
      const out: Float32Array[] = [];
      for (const text of texts) {
        const ids = idsOf(text);
        out.push(await vectorOf(s, ids, ids.length));
      }
      return out;
    },
  };
}

/**
 * Which DirectML adapter runs the model: a laptop lists its integrated chip first, and DirectML gives no name. The
 * fastest of them on a short text, measured once and kept beside the runtime. Null when none takes the model.
 */
async function pickAdapter(runtime: string, open: (adapter: number, length: number) => Promise<Session>, probe: (s: Session) => Promise<unknown>): Promise<number | null> {
  const file = join(runtime, 'dml-adapter.json');
  try {
    const kept = (JSON.parse(readFileSync(file, 'utf8')) as { adapter?: unknown }).adapter;
    if (typeof kept === 'number' && Number.isInteger(kept) && kept >= 0) return kept;
  } catch {
    // Never measured: measured now.
  }
  let best: { adapter: number; ms: number } | null = null;
  for (let adapter = 0; adapter < ADAPTERS; adapter++) {
    let s: Session;
    try {
      s = await open(adapter, BUCKETS[0]);
    } catch {
      break;
    }
    try {
      await probe(s);
      const t0 = performance.now();
      for (let i = 0; i < 3; i++) await probe(s);
      const ms = (performance.now() - t0) / 3;
      if (!best || ms < best.ms) best = { adapter, ms };
    } catch {
      // An adapter that refuses the model is not a choice.
    } finally {
      await s.release();
    }
  }
  if (best) writeFileSync(file, JSON.stringify(best));
  return best?.adapter ?? null;
}
