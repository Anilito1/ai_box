import { execFile, fork, type ChildProcess } from 'node:child_process';
import type { SearchModel } from './models';
import type { WorkerInit, WorkerReply, WorkerRequest } from './worker';

export type Device = 'auto' | 'gpu' | 'cpu';

export interface EngineOptions {
  /** The built worker script (`search-worker.mjs`). */
  script: string;
  /** Folder whose node_modules holds node-llama-cpp. */
  runtime: string;
  modelPath: string;
  model: SearchModel;
  device: () => Device;
  /** Milliseconds without a request after which the process is ended, which frees all its memory. Read at each use. */
  idleMs: () => number;
  /** Tokens one text may take. */
  slotTokens?: number;
  onState?: (state: EngineState) => void;
}

export interface EngineState { running: boolean; gpu: boolean; loadMs: number; dims: number }

type Answer = Extract<WorkerReply, { id: number }>;

const START_TIMEOUT_MS = 240_000;
const REQUEST_TIMEOUT_MS = 600_000;

/** Free video memory (MiB) and how busy the card is (%), or null where `nvidia-smi` does not answer (no NVIDIA card, no driver). */
export function gpuLoad(): Promise<{ freeMiB: number; util: number } | null> {
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=memory.free,utilization.gpu', '--format=csv,noheader,nounits'], { timeout: 4000, windowsHide: true }, (err, out) => {
      const [freeMiB, util] = String(out).trim().split('\n')[0].split(',').map((x) => Number.parseInt(x, 10));
      resolve(err || !Number.isFinite(freeMiB) || !Number.isFinite(util) ? null : { freeMiB, util });
    });
  });
}

/** What a model needs on the card: its weights plus the working buffers. */
export const vramNeed = (model: SearchModel): number => model.bytes / 1048576 + 700;

/**
 * Which of the machine's graphics devices runs the models: a laptop lists its integrated chip first, and a model
 * spread over both is twenty times slower than on the real card alone. -1 when nothing better than the first is known.
 */
export function pickDevice(names: string[]): number {
  const rank = (n: string) => (/nvidia|geforce|rtx|quadro/i.test(n) ? 3 : /radeon (rx|pro)|\barc\b/i.test(n) ? 2 : /amd|radeon/i.test(n) ? 1 : 0);
  let best = -1;
  names.forEach((n, i) => {
    if (rank(n) > (best < 0 ? 0 : rank(names[best]))) best = i;
  });
  return best;
}

function start(script: string, init: WorkerInit, device: number): ChildProcess {
  return fork(script, [], {
    env: { ...process.env, AIBOX_SEARCH_WORKER: JSON.stringify(init), ...(device >= 0 ? { GGML_VK_VISIBLE_DEVICES: String(device) } : {}) },
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
  });
}

let devices: Promise<number> | null = null;

/** Asked once per run of the app: the list of graphics devices does not change under it. */
function deviceIndex(script: string, runtime: string): Promise<number> {
  return (devices ??= new Promise<number>((resolve) => {
    const child = start(script, { runtime, modelPath: '', kind: 'devices', gpu: true, slotTokens: 0 }, -1);
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on('message', (m: WorkerReply) => {
      if ('devices' in m) resolve(pickDevice(m.devices));
    });
    child.once('error', () => resolve(-1));
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(-1);
    });
  }));
}

/**
 * One model, served by a process of our own that nothing outside can reach. Nothing runs until the first request;
 * the process is ended after `idleMs` without one. On the graphics card when it has room for the model, on the
 * processor otherwise or when the card refuses.
 */
export class Engine {
  private child: ChildProcess | null = null;
  private starting: Promise<ChildProcess> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly waiting = new Map<number, { resolve: (r: Answer) => void; reject: (e: Error) => void }>();
  private seq = 0;
  private info: EngineState = { running: false, gpu: false, loadMs: 0, dims: 0 };

  constructor(private readonly opts: EngineOptions) {}

  get state(): EngineState {
    return this.info;
  }

  /** A request is being answered right now. */
  get busy(): boolean {
    return this.waiting.size > 0;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const child = this.child;
    this.child = null;
    this.starting = null;
    this.info = { ...this.info, running: false };
    for (const w of this.waiting.values()) w.reject(new Error('The search engine stopped'));
    this.waiting.clear();
    if (child) {
      child.kill();
      this.opts.onState?.(this.info);
    }
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => (this.waiting.size > 0 ? this.arm() : this.stop()), Math.max(5000, this.opts.idleMs()));
    this.timer.unref();
  }

  private async wantsGpu(): Promise<boolean> {
    const device = this.opts.device();
    if (device !== 'auto') return device === 'gpu';
    const load = await gpuLoad();
    // Unknown card: tried, the worker falls back to the processor by itself.
    return load === null || load.freeMiB > vramNeed(this.opts.model);
  }

  private async launch(): Promise<ChildProcess> {
    const { script, runtime, modelPath, model } = this.opts;
    const gpu = await this.wantsGpu();
    const device = gpu ? await deviceIndex(script, runtime) : -1;
    return new Promise<ChildProcess>((resolve, reject) => {
      const child = start(script, { runtime, modelPath, kind: model.kind, gpu, slotTokens: this.opts.slotTokens ?? 2048 }, device);
      let ready = false;
      const fail = (reason: string) => {
        if (this.child === child) this.stop();
        child.kill();
        if (!ready) reject(new Error(reason));
      };
      const timer = setTimeout(() => fail('The search engine did not start in time'), START_TIMEOUT_MS);
      child.on('message', (m: WorkerReply) => {
        if ('ready' in m) {
          ready = true;
          clearTimeout(timer);
          this.child = child;
          this.info = { running: true, gpu: m.gpu, loadMs: m.loadMs, dims: m.dims };
          this.opts.onState?.(this.info);
          resolve(child);
        } else if ('fatal' in m) fail(m.fatal);
        else if ('id' in m) {
          const w = this.waiting.get(m.id);
          this.waiting.delete(m.id);
          if (m.error) w?.reject(new Error(m.error));
          else w?.resolve(m);
        }
      });
      child.once('error', (err) => fail(err.message));
      child.once('exit', (code) => {
        clearTimeout(timer);
        fail(`The search engine stopped (${code})`);
      });
    });
  }

  private async call(request: { op: 'embed'; texts: string[] } | { op: 'rerank'; query: string; documents: string[] }): Promise<Answer> {
    const id = ++this.seq;
    try {
      const child = this.child ?? (await (this.starting ??= this.launch().finally(() => (this.starting = null))));
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiting.delete(id);
          reject(new Error('The search engine took too long'));
        }, REQUEST_TIMEOUT_MS);
        this.waiting.set(id, { resolve: (r) => (clearTimeout(timer), resolve(r)), reject: (e) => (clearTimeout(timer), reject(e)) });
        child.send({ ...request, id } as WorkerRequest);
      });
    } finally {
      this.arm();
    }
  }

  /** One normalized vector per text. */
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!texts.length) return [];
    return (await this.call({ op: 'embed', texts })).vectors ?? [];
  }

  /** A relevance score per document for the question, higher is better. */
  async rerank(query: string, documents: string[]): Promise<number[]> {
    if (!documents.length) return [];
    return (await this.call({ op: 'rerank', query, documents })).scores ?? [];
  }
}
