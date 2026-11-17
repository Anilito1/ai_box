import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * One model in a process of its own (llama.cpp through node-llama-cpp). The hub starts it for a first request and
 * ends it after a while without one: every byte the model took, on the graphics card or not, goes with the process.
 */
export interface WorkerInit {
  /** Folder whose node_modules holds node-llama-cpp. */
  runtime: string;
  modelPath: string;
  kind: 'embed' | 'rerank' | 'devices';
  gpu: boolean;
  /** Tokens one text may take. */
  slotTokens: number;
  /** Processor threads one request may use; llama.cpp's own choice when absent. */
  threads?: number;
}
export type WorkerRequest = { id: number; op: 'embed'; texts: string[] } | { id: number; op: 'rerank'; query: string; documents: string[] };
export type WorkerReply =
  | { ready: true; gpu: boolean; loadMs: number; dims: number; /** The graphics device the runtime found, '' without one. */ device: string }
  | { devices: string[] }
  | { fatal: string }
  | { id: number; vectors?: Float32Array[]; scores?: number[]; error?: string };

interface LlamaModel {
  embeddingVectorSize: number;
  tokenize(text: string): number[];
  createEmbeddingContext(o: { contextSize: number; batchSize: number; threads?: number }): Promise<{ getEmbeddingFor(input: number[]): Promise<{ vector: readonly number[] }> }>;
  createRankingContext(o: { contextSize: number; batchSize: number; threads?: number }): Promise<{ rankAll(query: string, documents: string[]): Promise<number[]> }>;
}
interface Llama {
  gpu: string | false;
  getGpuDeviceNames(): Promise<string[]>;
  loadModel(o: { modelPath: string; gpuLayers: 'max' | 0 }): Promise<LlamaModel>;
  dispose(): Promise<void>;
}
type GetLlama = (o: { gpu: 'auto' | false; build: 'never'; skipDownload: true; logLevel: string }) => Promise<Llama>;

const send = (reply: WorkerReply): void => void process.send?.(reply);

function normalized(vector: readonly number[]): Float32Array {
  const out = Float32Array.from(vector);
  let sum = 0;
  for (const x of out) sum += x * x;
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

async function main(): Promise<void> {
  const init = JSON.parse(process.env.AIBOX_SEARCH_WORKER ?? '{}') as WorkerInit;
  // The hub gone without a word (crash, kill): nothing must keep the model in memory.
  process.on('disconnect', () => process.exit(0));
  const lib = (await import(pathToFileURL(join(init.runtime, 'node_modules', 'node-llama-cpp', 'dist', 'index.js')).href)) as { getLlama: GetLlama };
  const open = (gpu: boolean) => lib.getLlama({ gpu: gpu ? 'auto' : false, build: 'never', skipDownload: true, logLevel: 'error' });
  if (init.kind === 'devices') {
    const llama = await open(true);
    send({ devices: llama.gpu ? await llama.getGpuDeviceNames() : [] });
    await llama.dispose();
    // The channel to the hub would keep this process alive: it has said what it had to say.
    process.exit(0);
  }
  const t0 = Date.now();
  let llama = await open(init.gpu);
  const device = llama.gpu ? ((await llama.getGpuDeviceNames())[0] ?? '') : '';
  let model: LlamaModel;
  try {
    model = await llama.loadModel({ modelPath: init.modelPath, gpuLayers: llama.gpu ? 'max' : 0 });
  } catch (err) {
    if (!llama.gpu) throw err;
    // No room on the card, or a card that refuses the model: the processor takes over.
    await llama.dispose();
    llama = await open(false);
    model = await llama.loadModel({ modelPath: init.modelPath, gpuLayers: 0 });
  }
  const size = { contextSize: init.slotTokens, batchSize: init.slotTokens, ...(init.threads ? { threads: init.threads } : {}) };
  const embedder = init.kind === 'embed' ? await model.createEmbeddingContext(size) : null;
  const ranker = init.kind === 'rerank' ? await model.createRankingContext(size) : null;
  send({ ready: true, gpu: llama.gpu !== false, loadMs: Date.now() - t0, dims: model.embeddingVectorSize, device });

  let queue: Promise<void> = Promise.resolve();
  process.on('message', (req: WorkerRequest) => {
    queue = queue.then(async () => {
      try {
        if (req.op === 'embed' && embedder) {
          const vectors: Float32Array[] = [];
          // A text longer than the model's room is cut at the token, not refused. Two are kept for the model's own markers.
          for (const text of req.texts) vectors.push(normalized((await embedder.getEmbeddingFor(model.tokenize(text).slice(0, init.slotTokens - 2))).vector));
          send({ id: req.id, vectors });
        } else if (req.op === 'rerank' && ranker) send({ id: req.id, scores: await ranker.rankAll(req.query, req.documents) });
        else send({ id: req.id, error: 'Unsupported request' });
      } catch (err) {
        send({ id: req.id, error: err instanceof Error ? err.message : String(err) });
      }
    });
  });
}

main().catch((err) => {
  send({ fatal: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
