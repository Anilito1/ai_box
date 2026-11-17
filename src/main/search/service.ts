import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { SearchRepoState, SearchSettings, SearchState } from '../../shared/search';
import { git } from '../git';
import { userNpm } from '../providers/tools';
import { Engine, gpuLoad, vramNeed } from './engine';
import { syncDocs, syncFiles, syncVectors, type Doc } from './indexer';
import { EMBED_MODEL, modelOf, RERANK_MODEL, type SearchModel } from './models';
import { answer, formatHits, formatUnsure, ftsQuery, search, stagesOf, TUNING, type Hit } from './search';
import { leafOf, SearchStore, type StoredSymbol, type VectorIndex } from './store';

/** Pinned: the engine's binaries are the same files for everyone, and a new version is a change to test. */
const RUNTIME_VERSION = '3.22.3';
/** ONNX Runtime (every Windows binary signed by Microsoft, DirectML included) and a tokenizer without native code. */
const ONNX_RUNTIME = { 'onnxruntime-node': '1.31.1', '@huggingface/tokenizers': '0.2.0' };
/** A search waits for the vectors of this many changed chunks; past it they are computed behind it. */
const INLINE_CHUNKS = 96;
/** Two searches this close share one look at the files. */
const FRESH_MS = 8000;
/** `where_is` reads every listed repo: each is looked at again no more often than this. */
const CATALOGUE_FRESH_MS = 60_000;
/** The page that shows the state hears of changes this often at most. */
const NOTIFY_MS = 1000;
/** Vectors are kept at this many dimensions (the models are trained so their first dimensions stand alone). */
export const VECTOR_DIMS = 1024;
/** With the card taken, up to this many pieces are computed on the processor instead of waiting for it. */
const CPU_CHUNKS = 200;
/** Question vectors kept in memory, the most recent ones. */
const QUERY_CACHE = 256;
/** A build that waits for the card looks again this often. */
const RETRY_MS = 120_000;
/** A card busier than this (%) is someone else's for now: a render, a game, another model. */
const GPU_BUSY = 40;
/** Past this size, a model is alone in memory: no second one beside it. */
const BIG_MODEL = 1_500_000_000;


export interface SearchQuery { query: string; k?: number; expand?: boolean; budget?: number; under?: string }
interface Checkout { tree: string; family: string }

/** The folder is in no repo of the user's list: the search does not read it. */
class NotListed extends Error {}

/** Kinds `where_is` shows first: what a project runs on, before what its code merely names. */
const INFRA = ['edge', 'table', 'view', 'function', 'procedure', 'cron', 'policy', 'trigger', 'index', 'type', 'schema', 'extension', 'sequence'];

function runtimePackages(engine: SearchModel['engine'], platform = process.platform, arch = process.arch): string[] | null {
  if (engine === 'onnx') return Object.entries(ONNX_RUNTIME).map(([name, version]) => `${name}@${version}`);
  const own = platform === 'win32' && arch === 'x64' ? ['win-x64', 'win-x64-vulkan'] : platform === 'darwin' && arch === 'arm64' ? ['mac-arm64-metal'] : platform === 'linux' && arch === 'x64' ? ['linux-x64', 'linux-x64-vulkan'] : null;
  return own && [`node-llama-cpp@${RUNTIME_VERSION}`, ...own.map((p) => `@node-llama-cpp/${p}@${RUNTIME_VERSION}`)];
}

const same = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const env = (): Record<string, string> => process.env as Record<string, string>;

/**
 * Which process answers a question by meaning: the model building an index when it is loaded on the card or idle
 * (`indexer`), else the questions' own process when it runs (`asker`), else that process is to be started.
 */
export function queryEngine(indexer: { gpu: boolean; busy: boolean } | null, askerRunning: boolean): 'indexer' | 'asker' | 'start' {
  if (indexer && (indexer.gpu || !indexer.busy)) return 'indexer';
  return askerRunning ? 'asker' : 'start';
}

/**
 * The loaded models that should leave their place, to start again elsewhere at the next question: on the card while
 * something else works there (a render, a game: `util` is then not ours, nothing of ours being busy); the questions'
 * process on the processor while the card is free again with `room` for it.
 */
export function misplaced(util: number, room: boolean, asker: 'card' | 'processor' | null, reranker: 'card' | 'processor' | null): ('asker' | 'reranker')[] {
  if (util >= GPU_BUSY) return [...(asker === 'card' ? ['asker' as const] : []), ...(reranker === 'card' ? ['reranker' as const] : [])];
  return asker === 'processor' && room ? ['asker'] : [];
}

/** The first `dims` dimensions of a vector, at length 1 again. */
export function shorten(vector: Float32Array, dims: number): Float32Array {
  if (vector.length <= dims) return vector;
  const out = vector.slice(0, dims);
  let sum = 0;
  for (const x of out) sum += x * x;
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < dims; i++) out[i] /= norm;
  return out;
}

/**
 * An SQL object defined several times (a function replaced by later migrations) is the last one: files of a
 * migrations folder sort by their date. Other names keep every definition.
 */
export function lastDefinitions(defs: StoredSymbol[]): { def: StoredSymbol; earlier: number }[] {
  const out: { def: StoredSymbol; earlier: number }[] = [];
  const sql = new Map<string, { def: StoredSymbol; earlier: number }>();
  for (const def of defs) {
    if (!def.path.endsWith('.sql')) {
      out.push({ def, earlier: 0 });
      continue;
    }
    const key = `${def.kind} ${def.name.toLowerCase()}`;
    const held = sql.get(key);
    if (!held) sql.set(key, { def, earlier: 0 });
    else if (def.path > held.def.path || (def.path === held.def.path && def.start > held.def.start)) sql.set(key, { def, earlier: held.earlier + 1 });
    else held.earlier++;
  }
  const rank = (kind: string) => (INFRA.indexOf(kind) + 1 || INFRA.length + 1);
  return [...sql.values(), ...out].sort((a, b) => rank(a.def.kind) - rank(b.def.kind));
}

/**
 * Local search over the repos the user chose and over the hub's own memory. Everything stays on this machine: the
 * models are files run by a process of ours, the indexes live in the app's data folder, and no question or code is
 * sent anywhere. The only network use is the one-time download of the engine (npm) and of the models (Hugging Face).
 *
 * A question never needs the graphics card. Names and paths are answered from the index alone; a described
 * behaviour gets its vector from the processor when the card is cold or taken. The card serves to build an index
 * and to rerank close calls, one model at a time, and only when nobody else is using it.
 */
export class SearchService {
  private readonly root: string;
  private readonly embedModel: SearchModel;
  private readonly rerankModel: SearchModel | null;
  /** Builds the vectors of an index: on the card when it is free. */
  private indexer: Engine | null = null;
  /** Turns a question into its vector: on the card when it was free at the start, on the processor otherwise. */
  private asker: Engine | null = null;
  private askOn: SearchSettings['device'] = 'cpu';
  private reranker: Engine | null = null;
  private readonly stores = new Map<string, SearchStore>();
  private readonly checkouts = new Map<string, Checkout>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly looked = new Map<string, number>();
  private readonly errors = new Map<string, string>();
  /** Checkouts whose vectors wait for the card to be free. */
  private readonly deferred = new Set<string>();
  /** A checkout's vectors as last read, and the count of its index's changes when they were. */
  private readonly vectors = new Map<string, { generation: number; index: VectorIndex }>();
  private readonly generations = new Map<string, number>();
  /** Model work goes one request at a time, whoever asks: eight agents do not make eight loads. */
  private line: Promise<unknown> = Promise.resolve();
  private memoryLine: Promise<unknown> = Promise.resolve();
  /** The vectors of the last questions: an agent often asks the same one again (more results, whole pieces). */
  private readonly queryVectors = new Map<string, Float32Array>();
  private forget: NodeJS.Timeout | null = null;
  private notify: NodeJS.Timeout | null = null;
  private installing: SearchState['installing'] = null;
  private error = '';

  constructor(
    private readonly opts: {
      dataDir: string;
      /** The built `search-worker.mjs`. */
      workerScript: string;
      settings: () => SearchSettings;
      onState?: () => void;
    },
  ) {
    this.root = join(opts.dataDir, 'search');
    // The measures (scripts/search-bench) run this same service with other models: they name them here.
    this.embedModel = modelOf(process.env.AIBOX_SEARCH_EMBED ?? '') ?? modelOf(EMBED_MODEL)!;
    this.rerankModel = process.env.AIBOX_SEARCH_RERANK === 'none' ? null : (modelOf(process.env.AIBOX_SEARCH_RERANK ?? '') ?? (RERANK_MODEL ? modelOf(RERANK_MODEL)! : null));
  }

  /** Where the engine lives: llama.cpp and ONNX Runtime each in a folder of their own. */
  private get runtime(): string {
    return join(this.root, this.embedModel.engine === 'onnx' ? 'runtime-onnx' : 'runtime');
  }
  private modelPath(m: SearchModel): string {
    return join(this.root, 'models', m.file);
  }
  private get models(): SearchModel[] {
    return this.rerankModel ? [this.embedModel, this.rerankModel] : [this.embedModel];
  }
  private hasModel(m: SearchModel): boolean {
    try {
      if (m.files) return m.files.every((f) => statSync(join(this.modelPath(m), f.name)).size === f.bytes);
      return statSync(this.modelPath(m)).size === m.bytes;
    } catch {
      return false;
    }
  }
  private hasRuntime(): boolean {
    try {
      const version = (name: string) => (JSON.parse(readFileSync(join(this.runtime, 'node_modules', name, 'package.json'), 'utf8')) as { version?: string }).version;
      if (this.embedModel.engine === 'onnx') return Object.entries(ONNX_RUNTIME).every(([name, v]) => version(name) === v);
      return version('node-llama-cpp') === RUNTIME_VERSION;
    } catch {
      return false;
    }
  }
  /** The engine and the embedding model are there: meaning can be searched. The reranker is a plus. */
  get installed(): boolean {
    return this.hasRuntime() && this.hasModel(this.embedModel);
  }

  /** Tells the page something moved, once for a burst of changes (a download, an index being built). */
  private changed(): void {
    this.notify ??= setTimeout(() => {
      this.notify = null;
      this.opts.onState?.();
    }, NOTIFY_MS);
  }

  private bump(tree: string): void {
    this.generations.set(tree, (this.generations.get(tree) ?? 0) + 1);
  }

  private queued<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.line.then(fn, fn);
    this.line = run.catch(() => undefined);
    return run;
  }

  /** Fetches what is missing: the engine with the user's npm, then each model, checked against its known hash. */
  async install(): Promise<string> {
    if (this.installing) return 'busy';
    this.error = '';
    try {
      const packages = runtimePackages(this.embedModel.engine);
      if (!packages) throw new Error('unsupported');
      if (!this.hasRuntime()) {
        this.installing = { step: 'engine', done: 0, total: 0 };
        this.changed();
        const npm = await userNpm(env());
        if (!npm) throw new Error('no-node');
        mkdirSync(this.runtime, { recursive: true });
        // No install script runs and no optional package comes: only the engine and this platform's binaries.
        await new Promise<void>((done, fail) =>
          execFile(npm.node, [npm.cli, 'install', '--prefix', this.runtime, '--no-audit', '--no-fund', '--loglevel=error', '--omit=optional', '--ignore-scripts', ...packages], { cwd: this.runtime, windowsHide: true, timeout: 600_000 }, (err) =>
            err || !this.hasRuntime() ? fail(new Error('install-failed')) : done(),
          ),
        );
      }
      for (const m of this.models) if (!this.hasModel(m)) await this.download(m);
      return '';
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      return this.error;
    } finally {
      this.installing = null;
      this.changed();
    }
  }

  private async download(m: SearchModel): Promise<void> {
    if (!m.files) return this.fetchFile(m.label, this.modelPath(m), m, 0, m.bytes);
    // A model in several files (ONNX): each one checked, the progress over all of them.
    let before = 0;
    for (const f of m.files) {
      const path = join(this.modelPath(m), f.name);
      let there = false;
      try {
        there = statSync(path).size === f.bytes;
      } catch {
        // Missing: fetched below.
      }
      if (!there) await this.fetchFile(m.label, path, f, before, m.bytes);
      before += f.bytes;
    }
  }

  private async fetchFile(label: string, path: string, f: { url: string; bytes: number; sha256?: string }, before: number, total: number): Promise<void> {
    const part = `${path}.part`;
    mkdirSync(dirname(path), { recursive: true });
    this.installing = { step: label, done: before, total };
    this.changed();
    const res = await fetch(f.url, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error('download-failed');
    const hash = createHash('sha256');
    const file = createWriteStream(part);
    let done = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done: ended, value: piece } = await reader.read();
        if (ended) break;
        hash.update(piece);
        if (!file.write(piece)) await new Promise<void>((r) => file.once('drain', () => r()));
        done += piece.byteLength;
        this.installing = { step: label, done: before + done, total };
        this.changed();
      }
    } finally {
      await new Promise<void>((r) => file.end(() => r()));
    }
    // A file that is not the one this version was measured with is not loaded.
    if (done !== f.bytes || (f.sha256 && hash.digest('hex') !== f.sha256)) {
      rmSync(part, { force: true });
      throw new Error('download-failed');
    }
    renameSync(part, path);
  }

  /** `priority`: `above` for the answers an agent waits for, `below` for building an index (see WorkerInit.priority). */
  private engine(model: SearchModel, device: () => SearchSettings['device'], priority: 'above' | 'below'): Engine {
    const settings = this.opts.settings;
    return new Engine({ script: this.opts.workerScript, runtime: this.runtime, modelPath: this.modelPath(model), model, device, priority, idleMs: () => settings().idleMinutes * 60_000, onState: () => this.changed() });
  }

  /** The card is ours to use: the user did not rule it out, and nothing else is working on it or filling it. */
  private async cardFree(model: SearchModel): Promise<boolean> {
    if (this.opts.settings().device === 'cpu') return false;
    if (this.opts.settings().device === 'gpu') return true;
    const ours = [this.indexer, this.asker, this.reranker].some((e) => e?.state.running && e.state.gpu);
    if (ours) return true;
    const load = await gpuLoad();
    return load === null || (load.util < GPU_BUSY && load.freeMiB > vramNeed(model));
  }

  /**
   * What answers a question by meaning. The model that builds an index when it is on the card (a question waits for
   * one batch at most there) or idle; else the questions' own process, started on the card when it is free: a
   * question takes milliseconds there, and up to seconds on a busy processor. A large reranker keeps the card to itself.
   */
  private async asking(): Promise<Engine> {
    const indexer = this.indexer?.state.running ? { gpu: this.indexer.state.gpu, busy: this.indexer.busy } : null;
    const pick = queryEngine(indexer, this.asker?.state.running === true);
    if (pick === 'indexer') return this.indexer!;
    if (pick === 'start') this.askOn = (this.rerankModel?.bytes ?? 0) <= BIG_MODEL && this.embedModel.bytes <= BIG_MODEL && (await this.cardFree(this.embedModel)) ? 'gpu' : 'cpu';
    return (this.asker ??= this.engine(this.embedModel, () => this.askOn, 'above'));
  }

  /** Models kept warm turn after turn would never move: see `misplaced`. Only between questions. */
  private async rebalance(): Promise<void> {
    const engines = [this.indexer, this.asker, this.reranker];
    if (this.opts.settings().device !== 'auto' || engines.some((e) => e?.busy)) return;
    const load = await gpuLoad();
    if (!load) return;
    const where = (e: Engine | null) => (e?.state.running ? (e.state.gpu ? 'card' : 'processor') : null);
    const room = this.embedModel.bytes <= BIG_MODEL && load.freeMiB > vramNeed(this.embedModel);
    const out = misplaced(load.util, room, where(this.asker), where(this.reranker));
    if (out.includes('asker')) this.asker?.stop();
    if (out.includes('reranker')) this.reranker?.stop();
  }

  /** The vector of a question. */
  private async embedQuery(query: string): Promise<Float32Array> {
    const known = this.queryVectors.get(query);
    if (known) {
      // Most recently used last: the first entry is the one to drop.
      this.queryVectors.delete(query);
      this.queryVectors.set(query, known);
      return known;
    }
    const text = (this.embedModel.query ?? '') + query;
    const vector = shorten((await (await this.asking()).embed([text]))[0], VECTOR_DIMS);
    this.queryVectors.set(query, vector);
    if (this.queryVectors.size > QUERY_CACHE) this.queryVectors.delete(this.queryVectors.keys().next().value!);
    return vector;
  }

  private async embedOnProcessor(texts: string[]): Promise<Float32Array[]> {
    // The card is taken: a questions' process already on it may still answer, else one starts on the processor.
    if (!this.asker?.state.running) this.askOn = 'cpu';
    this.asker ??= this.engine(this.embedModel, () => this.askOn, 'above');
    return (await this.asker.embed(texts)).map((v) => shorten(v, VECTOR_DIMS));
  }

  private async embedDocs(texts: string[]): Promise<Float32Array[]> {
    // One model on the card at a time; the questions' process already there reads the code too (its batches give way).
    this.reranker?.stop();
    const engine = this.asker?.state.running && this.asker.state.gpu ? this.asker : (this.indexer ??= this.engine(this.embedModel, () => this.opts.settings().device, 'below'));
    return (await engine.embed(texts)).map((v) => shorten(v, VECTOR_DIMS));
  }

  /** The reranker, when it may run: tuned in, installed, the card free, and no index being built on it. Null otherwise. */
  private async judge(): Promise<((query: string, documents: string[]) => Promise<number[]>) | null> {
    const model = this.rerankModel;
    if (!model || TUNING.rerank === 0 || !this.hasModel(model) || this.indexer?.busy || !(await this.cardFree(model))) return null;
    return (query, documents) => {
      // Two small models share the card; a large one is there alone, and never beside a large embedder.
      if (model.bytes > BIG_MODEL || this.embedModel.bytes > BIG_MODEL) {
        if (this.indexer?.state.running && !this.indexer.busy) this.indexer.stop();
        if (this.asker?.state.gpu || (model.bytes > BIG_MODEL && this.embedModel.bytes > BIG_MODEL)) this.asker?.stop();
      }
      this.reranker ??= this.engine(model, () => this.opts.settings().device, 'above');
      return this.reranker.rerank(query, documents);
    };
  }

  private store(name: string): SearchStore {
    let s = this.stores.get(name);
    if (!s) this.stores.set(name, (s = new SearchStore(join(this.root, 'index', `${name}.sqlite`))));
    return s;
  }

  /**
   * The checkout a folder belongs to, and the repo it is a worktree of: one index file per repo, whose vectors its
   * worktrees share. Only a repo of the user's list is ever read.
   */
  private async checkout(folder: string): Promise<Checkout & { store: SearchStore }> {
    const key = resolve(folder).toLowerCase();
    let found = this.checkouts.get(key);
    if (!found) {
      const tree = resolve((await git(folder, ['rev-parse', '--show-toplevel'])).trim());
      const common = resolve((await git(folder, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
      found = { tree, family: basename(common) === '.git' ? dirname(common) : tree };
      this.checkouts.set(key, found);
    }
    const { tree, family } = found;
    if (!this.opts.settings().repos.some((r) => same(resolve(r), family))) throw new NotListed(`${basename(family)} is not in the list of repos the user lets the hub index (Settings › Repos). Use Grep here.`);
    return { tree, family, store: this.store(`${basename(family).replace(/[^\w.-]/g, '_')}-${createHash('sha1').update(family.toLowerCase()).digest('hex').slice(0, 8)}`) };
  }

  /**
   * One update at a time per checkout; whoever asks while one runs gets that one. `files` waits until the files
   * are cut (names and exact words then find everything), `all` until every vector is computed too. The vectors
   * wait when the card is taken by something else: the next update tries again.
   */
  private update(tree: string, store: SearchStore, wait: 'files' | 'all'): Promise<void> {
    const pending = this.running.get(tree);
    if (pending) return wait === 'all' ? pending : Promise.resolve();
    let filesDone: () => void = () => undefined;
    const files = new Promise<void>((r) => (filesDone = r));
    const model = this.embedModel;
    const task = (async () => {
      try {
        const stats = await syncFiles(store, tree, tree, model.id).finally(filesDone);
        this.looked.set(tree, Date.now());
        if (stats.changed || stats.removed) this.bump(tree);
        // A worktree that was removed leaves nothing behind.
        for (const other of store.trees()) if (other !== tree && !other.startsWith('memory:') && !existsSync(other)) store.dropTree(other);
        this.deferred.delete(tree);
        if (stats.missing > 0 && this.installed) {
          const device = this.opts.settings().device;
          if (device !== 'cpu' && !(await this.cardFree(model))) {
            // The card is taken. A few changed pieces go to the processor; a whole index waits and tries again.
            if (stats.missing <= CPU_CHUNKS) {
              await syncVectors(store, tree, model.id, (texts) => this.embedOnProcessor(texts), { root: tree, passage: model.passage, onProgress: () => this.changed() });
              this.bump(tree);
            } else {
              this.deferred.add(tree);
              const again = setTimeout(() => void this.update(tree, store, 'all'), RETRY_MS);
              again.unref();
            }
          } else {
            await syncVectors(store, tree, model.id, (texts) => this.embedDocs(texts), { root: tree, passage: model.passage, onProgress: () => this.changed() });
            this.bump(tree);
          }
        }
        this.errors.delete(tree);
      } catch (err) {
        this.errors.set(tree, err instanceof Error ? err.message : String(err));
      } finally {
        this.running.delete(tree);
        this.changed();
      }
    })();
    this.running.set(tree, task);
    this.changed();
    return wait === 'all' ? task : files;
  }

  private ready(): void {
    if (!this.opts.settings().enabled) throw new Error('Local search is off (Settings › Repos). Use Grep.');
  }

  /**
   * `search_code`: the best pieces of a checkout for a question. The index follows the files first. A name or a
   * path is answered from the index of definitions, with no model; a described behaviour by exact words and by
   * meaning. While vectors are missing (a first build, a card that is taken, models not installed), exact words
   * still answer, and the answer says what it lacks.
   */
  async searchCode(folder: string, q: SearchQuery): Promise<string> {
    this.ready();
    const { tree, store } = await this.checkout(folder);
    const model = this.embedModel;
    if (!this.running.has(tree) && Date.now() - (this.looked.get(tree) ?? 0) > FRESH_MS) {
      await this.update(tree, store, 'files');
      const missing = store.missing(tree, model.id).length;
      if (missing > 0 && missing <= INLINE_CHUNKS) await this.running.get(tree);
    }
    const stats = store.stats(tree, model.id);
    const failure = this.errors.get(tree);
    if (stats.chunks === 0) return failure ? `The index of ${basename(tree)} could not be built (${failure}). Use Grep.` : `The index of ${basename(tree)} is being built. Use Grep meanwhile and call search_code again in a minute.`;
    const limit = Math.min(20, Math.max(1, q.k ?? (q.expand ? 3 : 5)));
    const budget = q.budget ?? this.opts.settings().budget;
    const under = (q.under ?? '').replace(/\\/g, '/').replace(/^\.?\//, '');
    const found = await answer(store, tree, q.query, limit, under, (within) => this.queued(() => this.find(store, tree, q.query, limit, within, this.installed && stats.vectors > 0)));
    // A name that is defined, a file that exists: the answer is known, no model was asked.
    if (found.known) return formatHits(found.hits, q.query, budget, q.expand === true) + (found.users.length ? `\n\nimported by: ${found.users.slice(0, 6).join(', ')}${found.users.length > 6 ? ` (+${found.users.length - 6})` : ''}` : '');
    const left = stats.chunks - stats.vectors;
    const note = !this.installed
      ? '\n\n(The models are not installed: these results come from exact words only.)'
      : failure
        ? `\n\n(The model could not read the code: ${failure}. These results come from exact words only.)`
        : left > 0
          ? `\n\n(${left} of ${stats.chunks} pieces ${this.deferred.has(tree) ? 'wait for the graphics card to be free' : 'are still being read by the model'}: for them, only exact words count for now.)`
          : '';
    return (found.unsure ? formatUnsure(found.hits) : formatHits(found.hits, q.query, budget, q.expand === true)) + note;
  }

  private async find(store: SearchStore, tree: string, query: string, limit: number, under: string, vectors: boolean): Promise<Hit[]> {
    const model = this.embedModel;
    // The vectors read for a search stay in memory as long as the models do, no longer.
    if (this.forget) clearTimeout(this.forget);
    this.forget = setTimeout(() => this.vectors.clear(), this.opts.settings().idleMinutes * 60_000);
    this.forget.unref();
    const vectorsOf = () => {
      const generation = this.generations.get(tree) ?? 0;
      const cached = this.vectors.get(tree);
      if (cached?.generation === generation) return cached.index;
      const index = store.vectors(tree, model.id);
      this.vectors.set(tree, { generation, index });
      return index;
    };
    const rerank = vectors ? await this.judge() : null;
    return search(store, tree, model.id, query, limit, stagesOf(vectors, rerank !== null), { embedQuery: (text) => this.embedQuery(text), ...(rerank ? { rerank } : {}) }, under, vectorsOf);
  }

  /**
   * `where_is`: what a name is across every listed repo (an edge function, a table, an SQL function, a scheduled
   * job, a policy, a function of the code), where its current definition stands and who uses it. Read from the
   * indexes of names: no model, and one answer for all the repos.
   */
  async whereIs(folder: string, name: string): Promise<string> {
    this.ready();
    const asked = name.trim().replace(/^[`'"]+|[`'"()]+$/g, '');
    if (!asked) return 'Give a name: an edge function, a table, an SQL function, a job, a function of the code.';
    const from = await this.checkout(folder).catch(() => null);
    const places: (Checkout & { store: SearchStore })[] = [];
    for (const repo of this.opts.settings().repos) {
      const main = await this.checkout(repo).catch(() => null);
      if (main) places.push(from && same(from.family, main.family) ? from : main);
    }
    const lines: string[] = [];
    const users: { where: string; doc: boolean }[] = [];
    const partial: string[] = [];
    for (const { tree, store } of places) {
      if (!this.running.has(tree) && Date.now() - (this.looked.get(tree) ?? 0) > CATALOGUE_FRESH_MS) await this.update(tree, store, 'files');
      // An index that has never been read to its end cannot say that a name does not exist.
      if (!this.looked.has(tree) || this.errors.has(tree)) partial.push(basename(tree));
      const defs = lastDefinitions(store.definitions(tree, asked, 40)).slice(0, 6);
      const repo = basename(tree);
      for (const { def, earlier } of defs) lines.push(`${def.kind} ${def.name} — ${repo} ${def.path}:${def.start}-${def.end}${earlier ? ` (current; ${earlier} earlier definition${earlier > 1 ? 's' : ''})` : ''}`);
      const own = new Set(defs.map((d) => d.def.path));
      for (const id of store.phrase(tree, leafOf(asked).replace(/[^\p{L}\p{N}]+/gu, ' '), 24)) {
        const c = store.chunk(id);
        if (c && !own.has(c.path) && c.kind !== 'outline') users.push({ where: `${repo} ${c.path}:${c.start}-${c.end}`, doc: c.kind === 'doc' });
      }
    }
    const caveat = partial.length ? `\n(The index of ${partial.join(', ')} is not complete yet: a name may be missing from it. Ask again in a minute, or use Grep.)` : '';
    if (!lines.length && !users.length) return `Nothing is named ${asked} in ${places.map((p) => basename(p.tree)).join(', ') || 'the indexed repos'}.${caveat}`;
    // Code that uses the name before the notes that mention it.
    const shown = [...users.filter((u) => !u.doc), ...users.filter((u) => u.doc)].slice(0, 8);
    return `${lines.length ? lines.join('\n') : `No definition of ${asked}.`}${shown.length ? `\nused in:\n${shown.map((u) => `  ${u.where}`).join('\n')}${users.length > shown.length ? `\n  (+${users.length - shown.length})` : ''}` : ''}${caveat}`;
  }

  /**
   * `search_memory`: exact words over short texts the hub already holds (topic memory, decisions, notes). No model:
   * these texts and the questions about them are written in the same words.
   */
  async searchMemory(scope: string, docs: Doc[], q: SearchQuery): Promise<string> {
    this.ready();
    if (!docs.length) return 'No memory to search yet.';
    const store = this.store('memory');
    const tree = `memory:${scope}`;
    // Two sessions asking at once would read and write the same texts twice: one sync after the other.
    const sync = this.memoryLine.then(() => syncDocs(store, tree, docs));
    this.memoryLine = sync.catch(() => undefined);
    await sync;
    const limit = Math.min(20, Math.max(1, q.k ?? 5));
    const hits = store.lexical(tree, ftsQuery(q.query), limit).flatMap((id) => store.chunk(id) ?? []).map((c): Hit => ({ ...c, score: 0, by: 'words' }));
    return formatHits(hits, q.query, q.budget ?? this.opts.settings().budget, q.expand === true);
  }

  /** Builds a checkout's index again from nothing; the vectors of unchanged text are kept. */
  async reindex(repo: string): Promise<string> {
    try {
      this.ready();
      const { tree, store } = await this.checkout(repo);
      await this.running.get(tree);
      // Under other rules, the next pass reads every file again and replaces each one whole: the index is never empty meanwhile.
      store.setMeta(`rules:${tree}`, '');
      this.bump(tree);
      void this.update(tree, store, 'all');
      return '';
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Loads what a question by meaning needs before it comes (an agent starts working in `folder`): the first question
   * then takes milliseconds instead of the seconds a model takes to load, many more on a busy machine. Nothing for a
   * repo outside the list, or whose index has no vectors yet. False when the folder is not one the search reads.
   */
  async warm(folder: string): Promise<boolean> {
    if (!this.opts.settings().enabled || !this.installed) return true;
    const found = await this.checkout(folder).catch((err: unknown) => err);
    if (found instanceof NotListed) return false;
    if (found instanceof Error) throw found;
    const { tree, store } = found as Checkout & { store: SearchStore };
    if (store.stats(tree, this.embedModel.id).vectors === 0) return true;
    await this.rebalance();
    // One after the other, as a search does: the reranker may need the card to itself.
    await (await this.asking()).embed(['warm']);
    await (await this.judge())?.('warm', ['up']);
    return true;
  }

  /** The repos of the list whose index is missing or incomplete get it now, so the first question does not wait. */
  prepare(): void {
    if (!this.opts.settings().enabled) return;
    for (const repo of this.opts.settings().repos) {
      void this.checkout(repo)
        .then(({ tree, store }) => {
          const s = store.stats(tree, this.embedModel.id);
          return s.chunks === 0 || s.vectors < s.chunks ? this.update(tree, store, 'all') : undefined;
        })
        .catch(() => undefined);
    }
  }

  async state(): Promise<SearchState> {
    const repos: SearchRepoState[] = [];
    for (const path of this.opts.settings().repos) {
      try {
        const { tree, store } = await this.checkout(path);
        const s = store.stats(tree, this.embedModel.id);
        repos.push({ path, files: s.files, chunks: s.chunks, vectors: s.vectors, indexing: this.running.has(tree), waiting: this.deferred.has(tree), error: this.errors.get(tree) ?? '' });
      } catch {
        repos.push({ path, files: 0, chunks: 0, vectors: 0, indexing: false, waiting: false, error: 'not-a-repo' });
      }
    }
    const engines = [this.indexer, this.asker, this.reranker].filter((e): e is Engine => e?.state.running === true);
    return {
      installed: this.installed && this.models.every((m) => this.hasModel(m)),
      installing: this.installing,
      error: this.error,
      loaded: { embed: this.indexer?.state.running === true || this.asker?.state.running === true, rerank: this.reranker?.state.running === true, gpu: engines.some((e) => e.state.gpu) },
      sizeMb: Math.round(this.models.reduce((n, m) => n + m.bytes, 0) / 1048576) + 160,
      models: this.models.map((m) => m.label),
      repos,
    };
  }

  /** Nothing loaded, nothing being built: the process that hosts this can end. */
  get idle(): boolean {
    return !this.installing && this.running.size === 0 && ![this.indexer, this.asker, this.reranker].some((e) => e?.state.running);
  }

  /** Ends the model processes now and closes the index files (app closing, feature switched off). */
  stop(): void {
    for (const e of [this.indexer, this.asker, this.reranker]) e?.stop();
    this.indexer = this.asker = this.reranker = null;
    for (const s of this.stores.values()) s.close();
    this.stores.clear();
    this.vectors.clear();
  }
}
