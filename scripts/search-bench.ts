// The measures behind docs/recherche-semantique.md. Everything it writes goes to the lab folder (AIBOX_SEARCH_LAB).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { Engine } from '../src/main/search/engine';
import { syncDocs, syncFiles, syncVectors, type Doc } from '../src/main/search/indexer';
import { MODELS, modelOf, type SearchModel } from '../src/main/search/models';
import { answer, formatHits, formatUnsure, ftsQuery, lookup, routeOf, search, stagesOf, TUNING, type Hit, type Stages, type Tuning } from '../src/main/search/search';
import { quantize, SearchStore, type VectorIndex } from '../src/main/search/store';

const LAB = resolve(process.env.AIBOX_SEARCH_LAB ?? '.aibox/scratch/hub-ai-box/lab');
const RUNTIME = resolve(process.env.AIBOX_SEARCH_RUNTIME ?? join(LAB, '..', 'rt-probe'));
const REPOS_DIR = resolve(process.env.AIBOX_BENCH_REPOS ?? join(LAB, '..', 'bench-repos'));
// The questions on this repo are versioned; those on private repos stay in the lab folder.
const QUESTION_DIRS = [resolve('scripts/search-bench'), join(LAB, 'questions')];
const SCRIPT = process.env.AIBOX_SEARCH_WORKER_SCRIPT ?? '';
const REPOS = (process.env.AIBOX_BENCH_REPO_NAMES ?? 'claude-hub,CRM-extension,marketing-factory').split(',');
/** Results asked of each search: enough to see whether the answer is among the candidates at all. */
const TOP = 30;

/**
 * A question and where its answer is. `expect` without lines is a file to find (questions drawn from commits and
 * missions); an empty `expect` is a question the repo has no answer to: the right result is to say so.
 */
interface Question { repo: string; type: string; q: string; expect: { path: string; start?: number; end?: number; symbol?: string }[]; set?: 'dev' | 'test'; source?: string; /** Why the question was taken out of the dev half (lab/questions/CORRECTIONS.md). */ drop?: string }

const vramUsed = (): number => {
  try {
    return Number.parseInt(execFileSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { windowsHide: true }).toString(), 10);
  } catch {
    return -1;
  }
};
const record = (row: Record<string, unknown>): void => {
  mkdirSync(LAB, { recursive: true });
  appendFileSync(join(LAB, 'results.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);
};
const storeOf = (repo: string): SearchStore => new SearchStore(join(LAB, 'index', `${repo}.sqlite`));
const engineOf = (model: SearchModel, device: 'auto' | 'gpu' | 'cpu' = 'auto'): Engine =>
  new Engine({ script: SCRIPT, runtime: RUNTIME, modelPath: join(LAB, 'models', model.file), model, device: () => device, idleMs: () => 600_000 });
/** `model#bare` is the same model on vectors computed without the context line (see `index … bare`). */
const need = (key: string): SearchModel => {
  const id = key.split('#')[0];
  const m = modelOf(id);
  if (!m) throw new Error(`Unknown model ${id}: ${MODELS.map((x) => x.id).join(', ')}`);
  return m;
};
/** Every `questions-<repo>*.json` of the two folders; `set` keeps the questions of one half. */
function questions(set = 'all'): Question[] {
  const all: Question[] = [];
  for (const dir of QUESTION_DIRS) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).sort()) {
      const repo = REPOS.find((r) => file.startsWith(`questions-${r}`) && file.endsWith('.json'));
      if (repo) all.push(...(JSON.parse(readFileSync(join(dir, file), 'utf8')) as Question[]));
    }
  }
  return all.filter((q) => !q.drop && (set === 'all' || (q.set ?? 'test') === set));
}
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

/**
 * Rank (1-based) of the first hit that is the expected code: same file and, when the question gives lines,
 * overlapping lines (an outline is then not an answer). 0 when it is not among the hits.
 */
function rankOf(hits: Hit[], q: Question, fileOnly = false): number {
  const at = hits.findIndex((h) => q.expect.some((e) => e.path === h.path && (fileOnly || e.start === undefined || (h.kind !== 'outline' && h.start <= (e.end ?? e.start) && h.end >= e.start))));
  return at < 0 ? 0 : at + 1;
}

async function index(modelId: string, repos: string[], bare = false): Promise<void> {
  const model = modelId === 'none' ? null : need(modelId);
  const key = model ? `${model.id}${bare ? '#bare' : ''}` : '';
  const engine = model ? engineOf(model) : null;
  for (const repo of repos) {
    const store = storeOf(repo);
    const root = join(REPOS_DIR, repo);
    let peak = vramUsed();
    const sampler = setInterval(() => (peak = Math.max(peak, vramUsed())), 3000);
    const t0 = Date.now();
    const files = await syncFiles(store, root, root, key);
    const embedded = model ? await syncVectors(store, root, key, (texts) => engine!.embed(texts), { root, passage: model.passage, bare }) : 0;
    clearInterval(sampler);
    const row = { op: 'index', model: key || 'none', repo, ...files, filesMs: files.ms, embedded, seconds: Math.round((Date.now() - t0) / 1000), gpu: engine?.state.gpu, loadMs: engine?.state.loadMs, dims: engine?.state.dims, vramPeakMiB: peak, skipped: store.stats(root, model?.id ?? '').skipped };
    record(row);
    console.log(JSON.stringify(row));
    store.close();
  }
  engine?.stop();
}

/** The first `dims` dimensions of every vector, at length 1 again. */
function truncated(index: VectorIndex, dims: number): VectorIndex {
  if (!dims || dims >= index.dims) return index;
  const data = new Int8Array(index.ids.length * dims);
  for (let i = 0; i < index.ids.length; i++) {
    const v = new Float32Array(dims);
    let sum = 0;
    for (let d = 0; d < dims; d++) sum += (v[d] = index.data[i * index.dims + d]) ** 2;
    const norm = Math.sqrt(sum) || 1;
    data.set(quantize(v.map((x) => x / norm)), i * dims);
  }
  return { ids: index.ids, data, dims };
}

/**
 * One row of the tables: how the app would answer (`answer`, the routing of search_code) with these stages and this
 * tuning. `vec` rows skip the routing: what the model alone is worth.
 */
interface Config { name: string; lexical: boolean; vectors: boolean; rerank: boolean; tuning: Tuning; candidates?: number; rrfK?: number; expand?: boolean; routed: boolean; /** Results that are a file's outline are dropped: what the outlines are worth. */ noOutline?: boolean }

const app = (name: string, tuning: Partial<Tuning> = {}, more: Partial<Config> = {}): Config => ({ name, lexical: (tuning.lexicalWeight ?? TUNING.lexicalWeight) > 0, vectors: true, rerank: false, tuning: { ...TUNING, ...tuning }, routed: true, ...more });

/**
 * What is compared, by grid. Each row differs from a neighbour by one thing, so the table says what that thing is
 * worth. `models`: one model against another; `fusion`: exact words next to meaning; `rerank`: when and how much the
 * reranker reads; `final`: the rows read on the test half.
 */
function configs(grid: string, tag: string, rerankId: string): Config[] {
  const r = rerankId ? ` +${rerankId}` : '';
  const rr = (name: string, tuning: Partial<Tuning>, more: Partial<Config> = {}) => (rerankId ? [app(`${name} ${tag}${r}`, tuning, { rerank: true, ...more })] : []);
  const vec: Config = { name: `vec ${tag}`, lexical: false, vectors: true, rerank: false, tuning: TUNING, routed: false };
  if (grid === 'models') return [vec, app(`app ${tag} w0.5`, { lexicalWeight: 0.5 }), app(`app ${tag} w0.25`, { lexicalWeight: 0.25 }), ...rr('app rerank10x800', { rerankGap: Infinity })];
  if (grid === 'fusion') {
    return [
      vec,
      { ...vec, name: `vec ${tag} no-outline`, noOutline: true },
      ...[0, 0.1, 0.25, 0.5, 1].map((w) => app(`app ${tag} w${w}`, { lexicalWeight: w })),
      ...[0.25, 0.5].flatMap((w) => [10, 120].map((k) => app(`app ${tag} w${w} k${k}`, { lexicalWeight: w }, { rrfK: k }))),
      ...[0.25, 0.5].map((w) => app(`app ${tag} w${w} c60`, { lexicalWeight: w }, { candidates: 60 })),
      ...[1, 2].map((n) => app(`app ${tag} w0.5 perFile${n}`, { lexicalWeight: 0.5, perFile: n })),
      app(`app ${tag} w0.5 no-expand`, { lexicalWeight: 0.5 }, { expand: false }),
    ];
  }
  if (grid === 'rerank') {
    return [
      ...rr('app rerank10x800', { rerankGap: Infinity }),
      ...rr('app rerank10x800 gap0.05', { rerankGap: 0.05 }),
      ...rr('app rerank10x800 gap0.1', { rerankGap: 0.1 }),
      ...rr('app rerank5x800', { rerank: 5, rerankGap: Infinity }),
      ...rr('app rerank20x800', { rerank: 20, rerankGap: Infinity }),
      ...rr('app rerank10x1600', { rerankChars: 1600, rerankGap: Infinity }),
      ...rr('app rerank30x2000', { rerank: 30, rerankChars: 2000, rerankGap: Infinity }),
      ...rr('app rerank10x800 w0', { lexicalWeight: 0, rerankGap: Infinity }),
    ];
  }
  if (grid === 'pick') return [app(`app ${tag} w0.5 perFile2 pinned0`, { lexicalWeight: 0.5, perFile: 2, pinned: 0 }), app(`app ${tag} w0.25 perFile2 pinned0`, { lexicalWeight: 0.25, perFile: 2, pinned: 0 }), app(`app ${tag} w0.1 perFile2 pinned0`, { lexicalWeight: 0.1, perFile: 2, pinned: 0 }), app(`app ${tag} w0.5 perFile1 pinned0`, { lexicalWeight: 0.5, perFile: 1, pinned: 0 })];
  if (grid === 'pin') return [0, 1, 2].flatMap((n) => [app(`app ${tag} w0.5 pinned${n}`, { lexicalWeight: 0.5, pinned: n }), app(`app ${tag} w0.5 perFile2 pinned${n}`, { lexicalWeight: 0.5, perFile: 2, pinned: n })]);
  if (grid === 'final') return [vec, app(`app ${tag}`), ...rr('app rerank', {})];
  throw new Error(`Unknown grid ${grid}: models, fusion, rerank, final`);
}

/** Computed once per text, kept in the lab: the grids read the same query vectors and the same judgements again. */
class Cache<T> {
  private readonly map = new Map<string, T>();
  constructor(private readonly file: string) {
    if (!existsSync(file)) return;
    for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      const { k, v } = JSON.parse(line) as { k: string; v: T };
      this.map.set(k, v);
    }
  }
  static key = (...parts: string[]): string => createHash('sha1').update(parts.join('\u0000')).digest('hex');
  get(key: string): T | undefined {
    return this.map.get(key);
  }
  set(key: string, value: T): void {
    this.map.set(key, value);
    appendFileSync(this.file, `${JSON.stringify({ k: key, v: value })}\n`);
  }
}

/** Every row of a grid on the same questions; each question's rank is kept for the paired statistics. */
async function evaluate(embedIds: string[], rerankIds: string[], set: string, dims: number, grid: string): Promise<void> {
  const qs = questions(set);
  const stores = new Map(REPOS.map((r) => [r, storeOf(r)]));
  // An index still being written, or left half done, would be measured as a worse model: it is refused. A few
  // pieces the model could not read (an empty text) are only reported.
  for (const id of embedIds) {
    for (const [repo, s] of stores) {
      const { chunks, vectors } = s.stats(join(REPOS_DIR, repo), id);
      if (!chunks || chunks - vectors > Math.max(5, chunks / 1000)) throw new Error(`${repo}: ${vectors} of ${chunks} pieces have a vector for ${id}; run index first`);
      if (vectors < chunks) console.warn(`${repo}: ${chunks - vectors} pieces without a vector for ${id}`);
    }
  }
  mkdirSync(LAB, { recursive: true });
  const queryCache = new Cache<string>(join(LAB, 'query-vectors.jsonl'));
  const judged = new Cache<number>(join(LAB, 'rerank-scores.jsonl'));
  const rows: Record<string, unknown>[] = [];
  const run = async (name: string, fn: (q: Question, store: SearchStore, tree: string) => Promise<Hit[]>) => {
    const ranks: number[] = [];
    const fileRanks: number[] = [];
    const ms: number[] = [];
    const top: number[] = [];
    const topBy: string[] = [];
    const shown: number[] = [];
    for (const q of qs) {
      const t = performance.now();
      const hits = await fn(q, stores.get(q.repo)!, join(REPOS_DIR, q.repo));
      ms.push(performance.now() - t);
      ranks.push(rankOf(hits, q));
      fileRanks.push(rankOf(hits, q, true));
      top.push(hits[0] ? Number(hits[0].score.toFixed(3)) : 0);
      topBy.push(hits[0]?.by ?? '');
      // What the agent would be given: five results in 800 tokens.
      shown.push(Math.ceil(formatHits(hits.slice(0, 5), q.q, 800).length / 3.6));
    }
    // Scored on the questions that have an answer; the others only matter for the abstention (see `calibrate`).
    const answerable = qs.map((q, i) => (q.expect.length ? i : -1)).filter((i) => i >= 0);
    const hit = (k: number, rs: number[]) => Math.round((1000 * answerable.filter((i) => rs[i] > 0 && rs[i] <= k).length) / Math.max(1, answerable.length)) / 10;
    const mrr = answerable.reduce((s, i) => s + (ranks[i] > 0 && ranks[i] <= 10 ? 1 / ranks[i] : 0), 0) / Math.max(1, answerable.length);
    const row = { op: 'eval', set, config: name, n: answerable.length, 'hit@1': hit(1, ranks), 'hit@3': hit(3, ranks), 'hit@5': hit(5, ranks), 'hit@10': hit(10, ranks), 'file@5': hit(5, fileRanks), 'mrr@10': Number(mrr.toFixed(3)), msMedian: Math.round(median(ms)), tokPerQuery: Math.round(shown.reduce((s, x) => s + x, 0) / qs.length) };
    rows.push(row);
    record({ ...row, ranks, fileRanks, top, topBy, sources: qs.map((q) => q.source ?? 'manual'), repos: qs.map((q) => q.repo), answerable: qs.map((q) => q.expect.length > 0) });
    console.log(JSON.stringify(row));
  };
  if (grid !== 'final' || !embedIds.length) {
    await run('bm25', (q, s, tree) => search(s, tree, '', q.q, TOP, { lexical: true, vectors: false, rerank: 0 }, {}));
    await run('bm25 no-expand', (q, s, tree) => search(s, tree, '', q.q, TOP, { lexical: true, vectors: false, rerank: 0, expand: false }, {}));
    await run('bm25 app', async (q, s, tree) => (await answer(s, tree, q.q, TOP, '', (within) => search(s, tree, '', q.q, TOP, { lexical: true, vectors: false, rerank: 0 }, {}, within))).hits);
  }
  for (const id of embedIds) {
    const model = need(id);
    let engine: Engine | null = null;
    const queryVectors = new Map<string, Float32Array>();
    for (const q of qs) {
      const key = Cache.key(id, (model.query ?? '') + q.q);
      let saved = queryCache.get(key);
      if (!saved) {
        engine ??= engineOf(model);
        const v = (await engine.embed([(model.query ?? '') + q.q]))[0];
        queryCache.set(key, (saved = Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64')));
      }
      const bytes = Buffer.from(saved, 'base64');
      queryVectors.set(q.q, new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
    }
    (engine as Engine | null)?.stop();
    const cache = new Map<string, VectorIndex>();
    const vectorsOf = (s: SearchStore, tree: string) => {
      if (!cache.has(tree)) cache.set(tree, truncated(s.vectors(tree, id), dims));
      return cache.get(tree)!;
    };
    const cut = (v: Float32Array) => {
      if (!dims || dims >= v.length) return v;
      const head = v.slice(0, dims);
      const norm = Math.hypot(...head) || 1;
      return head.map((x) => x / norm);
    };
    const embedQuery = async (q: string) => cut(queryVectors.get(q)!);
    const tag = dims ? `${id}@${dims}` : id;
    for (const rid of rerankIds.length ? rerankIds : ['']) {
      let reranker: Engine | null = null;
      // Judgements already made are read back; only new pairs wake the model.
      const rerank = async (query: string, documents: string[]) => {
        const keys = documents.map((d) => Cache.key(rid, query, d));
        const missing = documents.filter((_d, i) => judged.get(keys[i]) === undefined);
        if (missing.length) {
          reranker ??= engineOf(need(rid));
          const scores = await reranker.rerank(query, missing);
          missing.forEach((d, i) => judged.set(Cache.key(rid, query, d), scores[i]));
        }
        return keys.map((k) => judged.get(k)!);
      };
      for (const c of configs(grid, tag, rid)) {
        // The rows without a reranker are the same whatever the reranker: measured once.
        if (!c.rerank && rid !== (rerankIds[0] ?? '')) continue;
        const stages: Stages = { ...stagesOf(c.vectors, c.rerank, c.tuning), lexical: c.lexical, ...(c.candidates ? { candidates: c.candidates } : {}), ...(c.rrfK ? { rrfK: c.rrfK } : {}), ...(c.expand === false ? { expand: false } : {}) };
        const engines = { embedQuery, ...(c.rerank ? { rerank } : {}) };
        await run(c.name, async (q, s, tree) => {
          const find = async (within: string) => (await search(s, tree, id, q.q, c.noOutline ? TOP * 2 : TOP, stages, engines, within, () => vectorsOf(s, tree))).filter((h) => !c.noOutline || h.kind !== 'outline');
          return c.routed ? (await answer(s, tree, q.q, TOP, '', find, c.tuning)).hits : find('');
        });
      }
      (reranker as Engine | null)?.stop();
    }
  }
  for (const s of stores.values()) s.close();
  console.table(rows.map(({ op: _op, set: _set, ...r }) => r));
}

interface EvalRow { op: string; set: string; config: string; ranks: number[]; fileRanks: number[]; top: number[]; topBy?: string[]; answerable: boolean[]; sources: string[]; repos: string[]; msMedian: number; tokPerQuery: number; tokPerUseful: number }
const evalRows = (set: string): EvalRow[] => {
  const rows = readFileSync(join(LAB, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as EvalRow).filter((r) => r.op === 'eval' && r.set === set && r.sources);
  // The last run of each row.
  return [...new Map(rows.map((r) => [r.config, r])).values()];
};

/** The last evaluation of a set as one table: every row, overall and by where the questions come from. */
function report(set: string): void {
  const pct = (xs: boolean[]) => (xs.length ? Math.round((1000 * xs.filter(Boolean).length) / xs.length) / 10 : 0);
  console.table(
    evalRows(set).map((r) => {
      const idx = r.answerable.map((ok, i) => (ok ? i : -1)).filter((i) => i >= 0);
      const of = (source: string) => idx.filter((i) => r.sources[i] === source);
      const hit = (is: number[], k: number, ranks = r.ranks) => pct(is.map((i) => ranks[i] > 0 && ranks[i] <= k));
      return { config: r.config, n: idx.length, 'hit@1': hit(idx, 1), 'hit@3': hit(idx, 3), 'hit@5': hit(idx, 5), 'file@5': hit(idx, 5, r.fileRanks), mrr: Number((idx.reduce((s, i) => s + (r.ranks[i] > 0 && r.ranks[i] <= 10 ? 1 / r.ranks[i] : 0), 0) / Math.max(1, idx.length)).toFixed(3)), 'manual@5': hit(of('manual'), 5), 'commit@5': hit(of('commit'), 5), 'session@5': hit(of('session'), 5), ms: r.msMedian, tok: r.tokPerQuery };
    }),
  );
}

/**
 * Where to stop answering: for a row, each score under which the search would say "nothing sure", with what that
 * saves (questions without an answer, and answers that were wrong anyway) and what it loses (right answers).
 */
function calibrate(config: string, set: string): void {
  const r = evalRows(set).find((x) => x.config === config);
  if (!r) throw new Error('Row not found');
  const right = (i: number) => r.answerable[i] && r.ranks[i] > 0 && r.ranks[i] <= 5;
  const all = r.top.map((_t, i) => i);
  const none = all.filter((i) => !r.answerable[i]);
  const rows = [...new Set(r.top.map((t) => Math.round(t * 20) / 20))].sort((a, b) => a - b).map((t) => {
    // As answer() does: only a first result found by meaning or judged by the reranker can be too weak.
    const silent = all.filter((i) => r.top[i] < t && (!r.topBy || /meaning|reranker/.test(r.topBy[i])));
    const lost = silent.filter(right).length;
    const spared = silent.length - lost;
    return { under: t, silent: silent.length, noAnswerCaught: `${none.filter((i) => silent.includes(i)).length}/${none.length}`, wrongSpared: spared, rightLost: lost, precisionOfAnswers: Number((all.filter((i) => r.top[i] >= t && right(i)).length / Math.max(1, all.length - silent.length)).toFixed(3)) };
  });
  console.table(rows);
}

/** A paired comparison of two rows of the last evaluations: the gain of `b` over `a`, its interval and its chance. */
function stats(a: string, b: string, set: string, metric: string): void {
  const rows = readFileSync(join(LAB, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { op: string; set: string; config: string; ranks: number[]; fileRanks: number[]; answerable: boolean[] });
  const last = (name: string) => rows.filter((r) => r.op === 'eval' && r.set === set && r.config === name).pop();
  const ra = last(a);
  const rb = last(b);
  if (!ra || !rb || ra.ranks.length !== rb.ranks.length) throw new Error('Rows not found or not on the same questions');
  const idx = ra.answerable.map((ok, i) => (ok ? i : -1)).filter((i) => i >= 0);
  const k = Number(/\d+/.exec(metric)?.[0] ?? 5);
  const value = (r: typeof ra, i: number) => {
    const rank = (metric.startsWith('file') ? r.fileRanks : r.ranks)[i];
    return metric.startsWith('mrr') ? (rank > 0 && rank <= 10 ? 1 / rank : 0) : rank > 0 && rank <= k ? 1 : 0;
  };
  const diff = idx.map((i) => value(rb, i) - value(ra, i));
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  // Paired bootstrap: the same questions are drawn for both rows.
  let seed = 12345;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const boots: number[] = [];
  for (let n = 0; n < 5000; n++) boots.push(mean(Array.from({ length: diff.length }, () => diff[Math.floor(random() * diff.length)])));
  boots.sort((x, y) => x - y);
  // McNemar, exact: among the questions only one of the two gets right, is it a coin toss?
  const won = diff.filter((d) => d > 0).length;
  const lost = diff.filter((d) => d < 0).length;
  const choose = (n: number, r: number) => { let c = 1; for (let i = 0; i < r; i++) c = (c * (n - i)) / (i + 1); return c; };
  const tail = Array.from({ length: Math.min(won, lost) + 1 }, (_, i) => choose(won + lost, i)).reduce((s, x) => s + x, 0) / 2 ** (won + lost);
  console.log(JSON.stringify({ metric, set, n: idx.length, a: Number(mean(idx.map((i) => value(ra, i))).toFixed(3)), b: Number(mean(idx.map((i) => value(rb, i))).toFixed(3)), gain: Number(mean(diff).toFixed(3)), ci95: [Number(boots[125].toFixed(3)), Number(boots[4875].toFixed(3))], won, lost, mcnemarP: Number(Math.min(1, 2 * tail).toFixed(4)) }));
}

/** What one setup costs: time to the first answer from nothing, a question once loaded, memory loaded and released. */
async function resources(embedId: string, rerankId: string, device: 'auto' | 'gpu' | 'cpu'): Promise<void> {
  const model = need(embedId);
  const repo = REPOS[0];
  const tree = join(REPOS_DIR, repo);
  const store = storeOf(repo);
  const before = vramUsed();
  const embedder = engineOf(model, device);
  const reranker = rerankId ? engineOf(need(rerankId), 'auto') : null;
  const engines = { embedQuery: async (q: string) => (await embedder.embed([(model.query ?? '') + q]))[0], ...(reranker ? { rerank: (q: string, d: string[]) => reranker.rerank(q, d) } : {}) };
  const stages = { lexical: true, vectors: true, lexicalWeight: 0.5, rerank: reranker ? 10 : 0, rerankChars: 800 };
  const ask = async (q: string) => {
    const t = performance.now();
    const hits = await search(store, tree, model.id, q, 5, stages, engines);
    return { ms: Math.round(performance.now() - t), hits };
  };
  const first = 'où est géré le délai avant de décharger un modèle ?';
  const cold = await ask(first);
  const loaded = vramUsed();
  const warm: number[] = [];
  for (const q of questions().filter((x) => x.repo === repo).slice(0, 20)) warm.push((await ask(q.q)).ms);
  const sample = formatHits(cold.hits, first, 800);
  embedder.stop();
  reranker?.stop();
  await new Promise((r) => setTimeout(r, 2500));
  const row = { op: 'resources', embed: embedId, rerank: rerankId, device, gpu: embedder.state.gpu, coldMs: cold.ms, embedLoadMs: embedder.state.loadMs, rerankLoadMs: reranker?.state.loadMs, warmMedianMs: median(warm), warmMaxMs: Math.max(...warm), vramBeforeMiB: before, vramLoadedMiB: loaded, vramAfterStopMiB: vramUsed(), answerTokens: Math.ceil(sample.length / 3.6) };
  record(row);
  console.log(JSON.stringify(row));
  store.close();
}

/** How long the index takes to notice that nothing changed, and one changed file. */
async function freshness(): Promise<void> {
  for (const repo of REPOS) {
    const store = storeOf(repo);
    const root = join(REPOS_DIR, repo);
    const first = await syncFiles(store, root, root, '');
    const again = await syncFiles(store, root, root, '');
    store.setMeta(`head:${root}`, '');
    const full = await syncFiles(store, root, root, '');
    const row = { op: 'freshness', repo, files: again.files, firstMs: first.ms, firstChanged: first.changed, unchangedMs: again.ms, fullScanMs: full.ms };
    record(row);
    console.log(JSON.stringify(row));
    store.close();
  }
}

/**
 * Questions that are a name or a path, as agents ask them instead of Grep or Glob: drawn from what each index
 * defines (one name in `per`, by a hash of the name), asked bare, in a French sentence and in an English one, and
 * answered as the app does, with no model. Measures the routing and the lookup, not an understanding of the code.
 */
async function names(per: number): Promise<void> {
  const rows: Record<string, unknown>[] = [];
  const pick = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % per === 0;
  const results = new Map<string, { ranks: number[]; ms: number[]; kinds: string[] }>();
  for (const repo of REPOS) {
    const store = storeOf(repo);
    const tree = join(REPOS_DIR, repo);
    const db = new (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')).DatabaseSync(join(LAB, 'index', `${repo}.sqlite`), { readOnly: true });
    const defs = db.prepare("SELECT name, leaf, path, start, end FROM symbols WHERE tree=? AND kind IN ('function','method','class','type','edge','table','cron') AND length(leaf) >= 6").all(tree) as { name: string; leaf: string; path: string; start: number; end: number }[];
    const files = (db.prepare("SELECT path FROM files WHERE tree=? AND skipped=''").all(tree) as { path: string }[]).map((f) => f.path);
    db.close();
    const asks: { form: string; q: string; ok: (h: Hit) => boolean }[] = [];
    for (const leaf of [...new Set(defs.map((d) => d.leaf))].filter(pick)) {
      const at = defs.filter((d) => d.leaf === leaf);
      const ok = (h: Hit) => at.some((d) => d.path === h.path && h.start <= d.end && h.end >= d.start);
      asks.push({ form: 'name', q: leaf, ok }, { form: 'name fr', q: `où est défini ${leaf} ?`, ok }, { form: 'name en', q: `where is ${leaf} implemented`, ok });
    }
    for (const path of files.filter(pick)) {
      const ok = (h: Hit) => h.path === path;
      asks.push({ form: 'path', q: path, ok }, { form: 'file fr', q: `que fait ${path.split('/').pop()} ?`, ok });
    }
    for (const a of asks) {
      const t = performance.now();
      const found = await answer(store, tree, a.q, 5, '', async (within) => search(store, tree, '', a.q, 5, { lexical: true, vectors: false, rerank: 0 }, {}, within));
      const r = results.get(a.form) ?? { ranks: [], ms: [], kinds: [] };
      r.ms.push(performance.now() - t);
      const at = found.hits.findIndex(a.ok);
      r.ranks.push(at < 0 ? 0 : at + 1);
      r.kinds.push(found.known ? 'index' : 'search');
      results.set(a.form, r);
    }
    store.close();
  }
  for (const [form, r] of results) {
    const hit = (k: number) => Math.round((1000 * r.ranks.filter((x) => x > 0 && x <= k).length) / r.ranks.length) / 10;
    rows.push({ op: 'names', form, n: r.ranks.length, 'hit@1': hit(1), 'hit@5': hit(5), fromIndex: `${Math.round((100 * r.kinds.filter((k) => k === 'index').length) / r.kinds.length)}%`, msMedian: Number(median(r.ms).toFixed(1)), msMax: Number(Math.max(...r.ms).toFixed(1)) });
  }
  for (const row of rows) record(row);
  console.table(rows.map(({ op: _op, ...r }) => r));
}

/**
 * search_memory on notes like the ones the hub keeps (topic memory, decisions, handoff notes): exact words alone, as
 * the app answers, against meaning and both. The notes are read from AIBOX_BENCH_MEMORY_DIR (folders of `*.md`, one
 * per project), the questions from lab/questions/memory.json; a note whose name says it holds secrets is left out.
 */
async function memory(embedId: string): Promise<void> {
  const dir = process.env.AIBOX_BENCH_MEMORY_DIR;
  if (!dir) throw new Error('Set AIBOX_BENCH_MEMORY_DIR');
  const docs: Doc[] = [];
  for (const project of readdirSync(dir)) {
    const notes = join(dir, project, 'memory');
    if (!existsSync(notes)) continue;
    for (const file of readdirSync(notes).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md' && !/credential|secret|password|token/i.test(f))) docs.push({ id: `${project.replace(/^C--Users-[^-]+-/, '')}/${file.replace(/\.md$/, '')}`, text: readFileSync(join(notes, file), 'utf8') });
  }
  const qs = JSON.parse(readFileSync(join(LAB, 'questions', 'memory.json'), 'utf8')) as { q: string; expect: string[] }[];
  const store = new SearchStore(join(LAB, 'index', 'memory.sqlite'));
  const tree = 'memory:bench';
  await syncDocs(store, tree, docs);
  const model = need(embedId);
  const engine = engineOf(model);
  await syncVectors(store, tree, model.id, (texts) => engine.embed(texts), { root: LAB, passage: model.passage });
  const queries = new Map<string, Float32Array>();
  for (const q of qs) queries.set(q.q, (await engine.embed([(model.query ?? '') + q.q]))[0]);
  engine.stop();
  const embedQuery = async (q: string) => queries.get(q)!;
  const rows: Record<string, unknown>[] = [];
  const run = async (name: string, stages: Stages) => {
    const ranks: number[] = [];
    for (const q of qs) {
      // A note is the answer, whichever of its sections comes first.
      const notes = [...new Set((await search(store, tree, model.id, q.q, 20, stages, { embedQuery })).map((h) => h.path))];
      const at = notes.findIndex((n) => q.expect.includes(n));
      ranks.push(at < 0 ? 0 : at + 1);
    }
    const hit = (k: number) => Math.round((1000 * ranks.filter((r) => r > 0 && r <= k).length) / ranks.length) / 10;
    const row = { op: 'memory', config: name, docs: docs.length, n: qs.length, 'hit@1': hit(1), 'hit@3': hit(3), 'hit@5': hit(5), mrr: Number((ranks.reduce((s, r) => s + (r ? 1 / r : 0), 0) / ranks.length).toFixed(3)) };
    rows.push(row);
    record({ ...row, ranks });
  };
  const words = { lexical: true, vectors: false, rerank: 0 };
  await run('bm25 (app)', words);
  await run('bm25 no-expand', { ...words, expand: false });
  await run(`vec ${model.id}`, { ...words, lexical: false, vectors: true });
  for (const w of [1, 0.5, 0.25]) await run(`bm25+vec ${model.id} w${w}`, { ...words, vectors: true, lexicalWeight: w });
  store.close();
  console.table(rows.map(({ op: _op, ...r }) => r));
}

async function ask(repo: string, embedId: string, rerankId: string, query: string): Promise<void> {
  const model = need(embedId);
  const tree = join(REPOS_DIR, repo);
  const store = storeOf(repo);
  const route = routeOf(query);
  const pinned = lookup(store, tree, route, 5);
  console.log(`route: ${route.kind} names=${route.names.join(',')} paths=${route.paths.join(',')} fts=${ftsQuery(query)}`);
  if (route.kind !== 'concept' && pinned.length) console.log(formatHits(pinned, query, 800));
  else {
    const embedder = engineOf(model, 'cpu');
    const reranker = rerankId ? engineOf(need(rerankId)) : null;
    const hits = await search(store, tree, model.id, query, 5, { lexical: true, vectors: true, lexicalWeight: 0.5, rerank: reranker ? 10 : 0, rerankChars: 800 }, { embedQuery: async (q) => (await embedder.embed([(model.query ?? '') + q]))[0], ...(reranker ? { rerank: (q: string, d: string[]) => reranker.rerank(q, d) } : {}) });
    console.log(formatHits(hits, query, 800));
    console.log('---\n' + formatUnsure(hits));
    embedder.stop();
    reranker?.stop();
  }
  store.close();
}

function checkQuestions(): void {
  const all = questions();
  let bad = 0;
  for (const q of all) {
    for (const e of q.expect) {
      const file = join(REPOS_DIR, q.repo, e.path);
      if (!existsSync(file)) {
        bad++;
        console.log(`MISSING ${q.repo} ${e.path} | ${q.q.slice(0, 60)}`);
      }
    }
  }
  const by = (key: (q: Question) => string) => Object.fromEntries([...new Set(all.map(key))].map((k) => [k, all.filter((q) => key(q) === k).length]));
  console.log(JSON.stringify({ questions: all.length, missingTargets: bad, byRepo: by((q) => q.repo), bySet: by((q) => q.set ?? 'test'), bySource: by((q) => q.source ?? 'manual'), byRoute: by((q) => routeOf(q.q).kind), unanswerable: all.filter((q) => !q.expect.length).length }));
}

/** Writes each question file back with a `set`: one question in three to `dev` (tuning), the rest to `test`. */
function split(): void {
  for (const dir of QUESTION_DIRS) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => /^questions-.*\.json$/.test(f))) {
      const qs = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Question[];
      // Decided by the text of the question, so adding questions does not move the others.
      for (const q of qs) q.set ??= [...q.q].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 3 === 0 ? 'dev' : 'test';
      writeFileSync(join(dir, file), `${JSON.stringify(qs, null, 1)}\n`);
    }
  }
  checkQuestions();
}

const [command = 'help', ...args] = process.argv.slice(2);
const list = (s?: string): string[] => (s && s !== '-' ? s.split(',').filter(Boolean) : []);
if (command === 'index') await index(args[0] ?? 'none', args.filter((a, i) => i > 0 && a !== 'bare').length ? args.filter((a, i) => i > 0 && a !== 'bare') : REPOS, args.includes('bare'));
else if (command === 'eval') await evaluate(list(args[0]), list(args[1]), args[2] ?? 'dev', Number(args[3] ?? 0), args[4] ?? 'models');
else if (command === 'report') report(args[0] ?? 'all');
else if (command === 'calibrate') calibrate(args[0], args[1] ?? 'dev');
else if (command === 'stats') stats(args[0], args[1], args[2] ?? 'all', args[3] ?? 'hit@5');
else if (command === 'resources') await resources(args[0], args[1] === '-' ? '' : (args[1] ?? ''), (args[2] as 'auto' | 'gpu' | 'cpu') ?? 'auto');
else if (command === 'freshness') await freshness();
else if (command === 'ask') await ask(args[0], args[1], args[2] === '-' ? '' : (args[2] ?? ''), args.slice(3).join(' '));
else if (command === 'questions') checkQuestions();
else if (command === 'names') await names(Number(args[0] ?? 8));
else if (command === 'memory') await memory(args[0] ?? 'qwen3-embed-0.6b');
else if (command === 'split') split();
else console.log('index <model|none> [repo…] [bare] | eval <embed,…|-> [rerank,…|-] [dev|test|all] [dims] [models|fusion|rerank|final] | report [set] | calibrate <config> [set] | stats <config a> <config b> [set] [hit@5|hit@1|file@5|mrr] | resources <embed> [rerank|-] [auto|gpu|cpu] | freshness | ask <repo> <embed> <rerank|-> <question> | questions | split | memory <embed> | names [one in n]');
process.exit(0);
