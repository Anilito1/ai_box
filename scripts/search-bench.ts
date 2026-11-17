// The measures behind docs/recherche-semantique.md. Everything it writes goes to the lab folder (AIBOX_SEARCH_LAB).
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Engine } from '../src/main/search/engine';
import { syncFiles, syncVectors } from '../src/main/search/indexer';
import { MODELS, modelOf, type SearchModel } from '../src/main/search/models';
import { formatHits, formatUnsure, ftsQuery, lookup, routeOf, search, type Hit, type Stages } from '../src/main/search/search';
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
interface Question { repo: string; type: string; q: string; expect: { path: string; start?: number; end?: number; symbol?: string }[]; set?: 'dev' | 'test'; source?: string }

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
  return all.filter((q) => set === 'all' || (q.set ?? 'test') === set);
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

interface Config { name: string; stages: Stages; routed?: boolean; embed?: boolean; rerank?: boolean; /** Results that are a file's outline are dropped: what the outlines are worth. */ noOutline?: boolean }

/** What is compared. Each row differs from a neighbour by one thing, so the table says what that thing is worth. */
function configs(tag: string, rerankId: string): Config[] {
  const hybrid = { lexical: true, vectors: true, rerank: 0 };
  const out: Config[] = [
    { name: `vec ${tag}`, stages: { lexical: false, vectors: true, rerank: 0 }, embed: true },
    { name: `vec ${tag} no-outline`, stages: { lexical: false, vectors: true, rerank: 0 }, embed: true, noOutline: true },
    ...[1, 0.5, 0.25, 0.1].map((w) => ({ name: `bm25+vec ${tag} w${w}`, stages: { ...hybrid, lexicalWeight: w }, embed: true })),
    { name: `routed ${tag} w0.5`, stages: { ...hybrid, lexicalWeight: 0.5 }, embed: true, routed: true },
    { name: `routed ${tag} w0.25`, stages: { ...hybrid, lexicalWeight: 0.25 }, embed: true, routed: true },
  ];
  if (!rerankId) return out;
  const r = (name: string, stages: Partial<Stages>, routed = false): Config => ({ name: `${name} ${tag} +${rerankId}`, stages: { ...hybrid, lexicalWeight: 0.5, ...stages }, embed: true, rerank: true, routed });
  out.push(
    r('rerank30x2000', { rerank: 30 }),
    r('rerank10x800', { rerank: 10, rerankChars: 800 }),
    r('rerank10x2000', { rerank: 10 }),
    r('rerank10x800 gap0.05', { rerank: 10, rerankChars: 800, rerankGap: 0.05 }),
    r('rerank10x800 gap0.1', { rerank: 10, rerankChars: 800, rerankGap: 0.1 }),
    r('routed rerank10x800', { rerank: 10, rerankChars: 800 }, true),
    r('vec-only rerank10x800', { rerank: 10, rerankChars: 800, lexical: false }),
  );
  return out;
}

/** The rows that are kept for the final reading, on the questions nothing was tuned on. */
function finalConfigs(tag: string, rerankId: string): Config[] {
  const all = configs(tag, rerankId);
  const keep = [`vec ${tag}`, `bm25+vec ${tag} w1`, `bm25+vec ${tag} w0.25`, `routed ${tag} w0.25`, `rerank10x800 ${tag} +${rerankId}`, `rerank10x800 gap0.05 ${tag} +${rerankId}`, `routed rerank10x800 ${tag} +${rerankId}`, `rerank30x2000 ${tag} +${rerankId}`];
  return all.filter((c) => keep.includes(c.name));
}

/** Every stage and combination on the same questions; each question's rank is kept for the paired statistics. */
async function evaluate(embedIds: string[], rerankIds: string[], set: string, dims: number, grid: 'full' | 'final'): Promise<void> {
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
  const rows: Record<string, unknown>[] = [];
  const run = async (name: string, fn: (q: Question, store: SearchStore, tree: string) => Promise<{ hits: Hit[]; reranked?: boolean }>, extra: Record<string, unknown> = {}) => {
    const ranks: number[] = [];
    const fileRanks: number[] = [];
    const ms: number[] = [];
    const top: number[] = [];
    const shown: number[] = [];
    let reranked = 0;
    for (const q of qs) {
      const t = performance.now();
      const out = await fn(q, stores.get(q.repo)!, join(REPOS_DIR, q.repo));
      ms.push(performance.now() - t);
      ranks.push(rankOf(out.hits, q));
      fileRanks.push(rankOf(out.hits, q, true));
      top.push(out.hits[0] ? Number(out.hits[0].score.toFixed(3)) : 0);
      // What the agent would be given: five results in 800 tokens.
      shown.push(Math.ceil(formatHits(out.hits.slice(0, 5), q.q, 800).length / 3.6));
      if (out.hits[0]?.by === 'reranker') reranked++;
    }
    // Scored on the questions that have an answer; the others only matter for the abstention (see `stats`).
    const answerable = qs.map((q, i) => (q.expect.length ? i : -1)).filter((i) => i >= 0);
    const hit = (k: number, rs: number[]) => Math.round((1000 * answerable.filter((i) => rs[i] > 0 && rs[i] <= k).length) / Math.max(1, answerable.length)) / 10;
    const mrr = answerable.reduce((s, i) => s + (ranks[i] > 0 && ranks[i] <= 10 ? 1 / ranks[i] : 0), 0) / Math.max(1, answerable.length);
    const useful = answerable.filter((i) => ranks[i] > 0 && ranks[i] <= 5).length;
    const row = { op: 'eval', set, config: name, n: answerable.length, 'hit@1': hit(1, ranks), 'hit@3': hit(3, ranks), 'hit@5': hit(5, ranks), 'hit@30': hit(30, ranks), 'file@5': hit(5, fileRanks), 'mrr@10': Number(mrr.toFixed(3)), msMedian: Math.round(median(ms)), reranked, tokPerQuery: Math.round(shown.reduce((s, x) => s + x, 0) / qs.length), tokPerUseful: Math.round(answerable.reduce((s, i) => s + shown[i], 0) / Math.max(1, useful)), ...extra };
    rows.push(row);
    record({ ...row, ranks, fileRanks, top, sources: qs.map((q) => q.source ?? 'manual'), repos: qs.map((q) => q.repo), answerable: qs.map((q) => q.expect.length > 0) });
    console.log(JSON.stringify(row));
  };
  const off = { lexical: false, vectors: false, rerank: 0 };
  await run('bm25', async (q, s, tree) => ({ hits: await search(s, tree, '', q.q, TOP, { ...off, lexical: true }, {}) }));
  await run('names only', async (q, s, tree) => ({ hits: lookup(s, tree, routeOf(q.q), TOP) }));
  for (const id of embedIds) {
    const model = need(id);
    const engine = engineOf(model);
    const queryVectors = new Map<string, Float32Array>();
    for (const q of qs) queryVectors.set(q.q, (await engine.embed([(model.query ?? '') + q.q]))[0]);
    engine.stop();
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
      const reranker = rid ? engineOf(need(rid)) : null;
      if (reranker) await reranker.rerank('warm', ['up']);
      for (const c of grid === 'final' ? finalConfigs(tag, rid) : configs(tag, rid)) {
        // The rows without a reranker are the same whatever the reranker: measured once.
        if (!c.rerank && rid !== (rerankIds[0] ?? '')) continue;
        const engines = { embedQuery, ...(c.rerank && reranker ? { rerank: (query: string, documents: string[]) => reranker.rerank(query, documents) } : {}) };
        await run(c.name, async (q, s, tree) => {
          const found = async () => (await search(s, tree, id, q.q, c.noOutline ? TOP * 2 : TOP, c.stages, engines, '', () => vectorsOf(s, tree))).filter((h) => !c.noOutline || h.kind !== 'outline');
          if (!c.routed) return { hits: await found() };
          // As the app answers: a name or a path from the index alone, a behaviour by the hybrid search, definitions first.
          const route = routeOf(q.q);
          const pinned = lookup(s, tree, route, TOP);
          if (route.kind !== 'concept' && pinned.length) return { hits: pinned };
          const rest = await found();
          return { hits: [...pinned, ...rest.filter((h) => !pinned.some((p) => p.id === h.id))] };
        }, c.rerank ? { vramMiB: vramUsed() } : {});
      }
      reranker?.stop();
    }
  }
  for (const s of stores.values()) s.close();
  console.table(rows.map(({ op: _op, set: _set, ...r }) => r));
}

interface EvalRow { op: string; set: string; config: string; ranks: number[]; fileRanks: number[]; top: number[]; answerable: boolean[]; sources: string[]; repos: string[]; msMedian: number; tokPerQuery: number; tokPerUseful: number }
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
      return { config: r.config, n: idx.length, 'hit@1': hit(idx, 1), 'hit@3': hit(idx, 3), 'hit@5': hit(idx, 5), 'file@5': hit(idx, 5, r.fileRanks), mrr: Number((idx.reduce((s, i) => s + (r.ranks[i] > 0 && r.ranks[i] <= 10 ? 1 / r.ranks[i] : 0), 0) / Math.max(1, idx.length)).toFixed(3)), 'manual@5': hit(of('manual'), 5), 'commit@5': hit(of('commit'), 5), 'session@5': hit(of('session'), 5), ms: r.msMedian, tok: r.tokPerQuery, 'tok/useful': r.tokPerUseful };
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
    const silent = all.filter((i) => r.top[i] < t);
    const lost = silent.filter(right).length;
    const spared = silent.length - lost;
    return { under: t, silent: silent.length, noAnswerCaught: `${none.filter((i) => r.top[i] < t).length}/${none.length}`, wrongSpared: spared, rightLost: lost, precisionOfAnswers: Number((all.filter((i) => r.top[i] >= t && right(i)).length / Math.max(1, all.length - silent.length)).toFixed(3)) };
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
else if (command === 'eval') await evaluate(list(args[0]), list(args[1]), args[2] ?? 'all', Number(args[3] ?? 0), args[4] === 'final' ? 'final' : 'full');
else if (command === 'report') report(args[0] ?? 'all');
else if (command === 'calibrate') calibrate(args[0], args[1] ?? 'dev');
else if (command === 'stats') stats(args[0], args[1], args[2] ?? 'all', args[3] ?? 'hit@5');
else if (command === 'resources') await resources(args[0], args[1] === '-' ? '' : (args[1] ?? ''), (args[2] as 'auto' | 'gpu' | 'cpu') ?? 'auto');
else if (command === 'freshness') await freshness();
else if (command === 'ask') await ask(args[0], args[1], args[2] === '-' ? '' : (args[2] ?? ''), args.slice(3).join(' '));
else if (command === 'questions') checkQuestions();
else if (command === 'split') split();
else console.log('index <model|none> [repo…] [bare] | eval <embed,…> [rerank,…|-] [dev|test|all] [dims] [full|final] | report [set] | calibrate <config> [set] | stats <config a> <config b> [set] [hit@5|hit@1|file@5|mrr] | resources <embed> [rerank|-] [auto|gpu|cpu] | freshness | ask <repo> <embed> <rerank|-> <question> | questions | split');
process.exit(0);
