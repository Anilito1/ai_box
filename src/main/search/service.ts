import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { SearchRepoState, SearchSettings, SearchState } from '../../shared/search';
import { git } from '../git';
import { userNpm } from '../providers/tools';
import { Engine } from './engine';
import { syncDocs, syncFiles, syncVectors, type Doc } from './indexer';
import { EMBED_MODEL, modelOf, RERANK_MODEL, type SearchModel } from './models';
import { CANDIDATES, formatHits, search, type Hit } from './search';
import { SearchStore } from './store';

/** Pinned: the engine's binaries are the same files for everyone, and a new version is a change to test. */
const RUNTIME_VERSION = '3.22.3';
/** A search waits for the vectors of this many changed chunks; past it they are computed behind it. */
const INLINE_CHUNKS = 96;
/** Two searches this close share one look at the files. */
const FRESH_MS = 8000;
/** The page that shows the state hears of changes this often at most. */
const NOTIFY_MS = 1000;
/** Vectors are kept at this many dimensions (the models are trained so their first dimensions stand alone). */
export const VECTOR_DIMS = 1024;

export interface SearchQuery { query: string; k?: number; expand?: boolean; budget?: number; under?: string }
interface Checkout { tree: string; family: string }

function runtimePackages(platform = process.platform, arch = process.arch): string[] | null {
  const own = platform === 'win32' && arch === 'x64' ? ['win-x64', 'win-x64-vulkan'] : platform === 'darwin' && arch === 'arm64' ? ['mac-arm64-metal'] : platform === 'linux' && arch === 'x64' ? ['linux-x64', 'linux-x64-vulkan'] : null;
  return own && [`node-llama-cpp@${RUNTIME_VERSION}`, ...own.map((p) => `@node-llama-cpp/${p}@${RUNTIME_VERSION}`)];
}

const same = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const env = (): Record<string, string> => process.env as Record<string, string>;

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
 * Local search over the repos the user chose and over the hub's own memory. Everything stays on this machine: the
 * models are files run by a process of ours, the indexes live in the app's data folder, and no question or code is
 * sent anywhere. The only network use is the one-time download of the engine (npm) and of the models (Hugging Face).
 */
export class SearchService {
  private readonly root: string;
  private readonly embedModel: SearchModel;
  private readonly rerankModel: SearchModel | null;
  private embedder: Engine | null = null;
  private reranker: Engine | null = null;
  private readonly stores = new Map<string, SearchStore>();
  private readonly checkouts = new Map<string, Checkout>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly looked = new Map<string, number>();
  private readonly errors = new Map<string, string>();
  /** A checkout's vectors as last read, and the count of its index's changes when they were. */
  private readonly vectors = new Map<string, { generation: number; index: ReturnType<SearchStore['vectors']> }>();
  private readonly generations = new Map<string, number>();
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
    this.embedModel = modelOf(EMBED_MODEL)!;
    this.rerankModel = RERANK_MODEL ? modelOf(RERANK_MODEL)! : null;
  }

  private get runtime(): string {
    return join(this.root, 'runtime');
  }
  private modelPath(m: SearchModel): string {
    return join(this.root, 'models', m.file);
  }
  private get models(): SearchModel[] {
    return this.rerankModel ? [this.embedModel, this.rerankModel] : [this.embedModel];
  }
  private hasModel(m: SearchModel): boolean {
    try {
      return statSync(this.modelPath(m)).size === m.bytes;
    } catch {
      return false;
    }
  }
  private hasRuntime(): boolean {
    try {
      return (JSON.parse(readFileSync(join(this.runtime, 'node_modules', 'node-llama-cpp', 'package.json'), 'utf8')) as { version?: string }).version === RUNTIME_VERSION;
    } catch {
      return false;
    }
  }
  get installed(): boolean {
    return this.hasRuntime() && this.models.every((m) => this.hasModel(m));
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

  /** Fetches what is missing: the engine with the user's npm, then each model, checked against its known hash. */
  async install(): Promise<string> {
    if (this.installing) return 'busy';
    this.error = '';
    try {
      const packages = runtimePackages();
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
    const path = this.modelPath(m);
    const part = `${path}.part`;
    mkdirSync(dirname(path), { recursive: true });
    this.installing = { step: m.label, done: 0, total: m.bytes };
    this.changed();
    const res = await fetch(m.url, { redirect: 'follow' });
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
        this.installing = { step: m.label, done, total: m.bytes };
        this.changed();
      }
    } finally {
      await new Promise<void>((r) => file.end(() => r()));
    }
    // A file that is not the one this version was measured with is not loaded.
    if (done !== m.bytes || (m.sha256 && hash.digest('hex') !== m.sha256)) {
      rmSync(part, { force: true });
      throw new Error('download-failed');
    }
    renameSync(part, path);
  }

  private engine(model: SearchModel): Engine {
    const settings = this.opts.settings;
    return new Engine({ script: this.opts.workerScript, runtime: this.runtime, modelPath: this.modelPath(model), model, device: () => settings().device, idleMs: () => settings().idleMinutes * 60_000, onState: () => this.changed() });
  }

  private async embedQuery(query: string): Promise<Float32Array> {
    this.embedder ??= this.engine(this.embedModel);
    return shorten((await this.embedder.embed([(this.embedModel.query ?? '') + query]))[0], VECTOR_DIMS);
  }

  private async embedDocs(texts: string[]): Promise<Float32Array[]> {
    this.embedder ??= this.engine(this.embedModel);
    return (await this.embedder.embed(texts)).map((v) => shorten(v, VECTOR_DIMS));
  }

  private rerank(query: string, documents: string[]): Promise<number[]> {
    this.reranker ??= this.engine(this.rerankModel!);
    return this.reranker.rerank(query, documents);
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
    if (!this.opts.settings().repos.some((r) => same(resolve(r), family))) throw new Error(`${basename(family)} is not in the list of repos the user lets the hub index (Settings › Repos). Use Grep here.`);
    return { tree, family, store: this.store(`${basename(family).replace(/[^\w.-]/g, '_')}-${createHash('sha1').update(family.toLowerCase()).digest('hex').slice(0, 8)}`) };
  }

  /**
   * One update at a time per checkout; whoever asks while one runs gets that one. `files` waits until the files
   * are cut (exact words then find everything), `all` until every vector is computed too.
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
        if (stats.missing > 0) {
          await syncVectors(store, tree, model.id, (texts) => this.embedDocs(texts), { root: tree, passage: model.passage, onProgress: () => this.changed() });
          this.bump(tree);
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
    if (!this.installed) throw new Error('Local search is not installed yet (Settings › Repos). Use Grep.');
  }

  /**
   * `search_code`: the best pieces of a checkout for a question. The index follows the files first: what changed
   * since the last search is cut again, and its vectors are computed before answering when there is little of it.
   * While vectors are missing (a first build, a large change, a model that does not start), exact words still
   * answer, and the answer says what it lacks.
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
    const left = stats.chunks - stats.vectors;
    const note = failure
      ? `\n\n(The model could not read the code: ${failure}. These results come from exact words only.)`
      : left > 0
        ? `\n\n(${left} of ${stats.chunks} pieces are still being read by the model: for them, only exact words count for now.)`
        : '';
    const hits = await this.find(store, tree, q, stats.vectors > 0);
    return formatHits(hits, q.query, q.budget ?? this.opts.settings().budget, q.expand === true) + note;
  }

  private async find(store: SearchStore, tree: string, q: SearchQuery, vectors: boolean, cache = true): Promise<Hit[]> {
    const model = this.embedModel;
    // The vectors read for a search stay in memory as long as the models do, no longer.
    if (this.forget) clearTimeout(this.forget);
    this.forget = setTimeout(() => this.vectors.clear(), this.opts.settings().idleMinutes * 60_000);
    this.forget.unref();
    const vectorsOf = () => {
      const generation = this.generations.get(tree) ?? 0;
      const cached = this.vectors.get(tree);
      if (cache && cached?.generation === generation) return cached.index;
      const index = store.vectors(tree, model.id);
      if (cache) this.vectors.set(tree, { generation, index });
      return index;
    };
    const limit = Math.min(20, Math.max(1, q.k ?? (q.expand ? 3 : 8)));
    const engines = { embedQuery: (text: string) => this.embedQuery(text), ...(this.rerankModel ? { rerank: (text: string, docs: string[]) => this.rerank(text, docs) } : {}) };
    return search(store, tree, model.id, q.query, limit, { lexical: true, vectors, rerank: this.rerankModel ? CANDIDATES : 0 }, engines, (q.under ?? '').replace(/\\/g, '/').replace(/^\.?\//, ''), vectorsOf);
  }

  /** `search_memory`: the same search over short texts the hub already holds (topic memory, decisions, notes). */
  async searchMemory(scope: string, docs: Doc[], q: SearchQuery): Promise<string> {
    this.ready();
    if (!docs.length) return 'No memory to search yet.';
    const store = this.store('memory');
    const tree = `memory:${scope}`;
    const model = this.embedModel;
    await syncDocs(store, tree, docs);
    await syncVectors(store, tree, model.id, (texts) => this.embedDocs(texts), { passage: model.passage });
    return formatHits(await this.find(store, tree, q, true, false), q.query, q.budget ?? this.opts.settings().budget, q.expand === true);
  }

  /** Builds a checkout's index again from nothing; the vectors of unchanged text are kept. */
  async reindex(repo: string): Promise<string> {
    try {
      this.ready();
      const { tree, store } = await this.checkout(repo);
      await this.running.get(tree);
      store.dropTree(tree);
      this.bump(tree);
      void this.update(tree, store, 'all');
      return '';
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  /** The repos of the list not indexed yet get their index now, so the first question does not wait for it. */
  prepare(): void {
    if (!this.opts.settings().enabled || !this.installed) return;
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
        repos.push({ path, files: s.files, chunks: s.chunks, vectors: s.vectors, indexing: this.running.has(tree), error: this.errors.get(tree) ?? '' });
      } catch {
        repos.push({ path, files: 0, chunks: 0, vectors: 0, indexing: false, error: 'not-a-repo' });
      }
    }
    const embed = this.embedder?.state;
    const rerank = this.reranker?.state;
    return {
      installed: this.installed,
      installing: this.installing,
      error: this.error,
      loaded: { embed: embed?.running === true, rerank: rerank?.running === true, gpu: (embed?.running && embed.gpu) || (rerank?.running && rerank.gpu) || false },
      sizeMb: Math.round(this.models.reduce((n, m) => n + m.bytes, 0) / 1048576) + 160,
      models: this.models.map((m) => m.label),
      repos,
    };
  }

  /** Nothing loaded, nothing being built: the process that hosts this can end. */
  get idle(): boolean {
    return !this.installing && this.running.size === 0 && !this.embedder?.state.running && !this.reranker?.state.running;
  }

  /** Ends the model processes now and closes the index files (app closing, feature switched off). */
  stop(): void {
    this.embedder?.stop();
    this.reranker?.stop();
    this.embedder = this.reranker = null;
    for (const s of this.stores.values()) s.close();
    this.stores.clear();
    this.vectors.clear();
  }
}
