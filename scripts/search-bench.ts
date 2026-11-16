// The measures behind docs/recherche-semantique.md. Everything it writes goes to the lab folder (AIBOX_SEARCH_LAB).
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Engine } from '../src/main/search/engine';
import { syncFiles, syncVectors } from '../src/main/search/indexer';
import { MODELS, modelOf, type SearchModel } from '../src/main/search/models';
import { CANDIDATES, formatHits, ftsQuery, nearest, rrf, search, type Hit } from '../src/main/search/search';
import { SearchStore } from '../src/main/search/store';

const LAB = resolve(process.env.AIBOX_SEARCH_LAB ?? '.aibox/scratch/hub-ai-box/lab');
const RUNTIME = resolve(process.env.AIBOX_SEARCH_RUNTIME ?? join(LAB, '..', 'rt-probe'));
const REPOS_DIR = resolve(process.env.AIBOX_BENCH_REPOS ?? join(LAB, '..', 'bench-repos'));
// The questions on this repo are versioned; those on private repos stay in the lab folder.
const QUESTION_DIRS = [resolve('scripts/search-bench'), join(LAB, 'questions')];
const SCRIPT = process.env.AIBOX_SEARCH_WORKER_SCRIPT ?? '';
const REPOS = ['claude-hub', 'CRM-extension', 'marketing-factory'];

interface Question { repo: string; type: string; q: string; expect: { path: string; start: number; end: number; symbol?: string }[] }

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
const need = (id: string): SearchModel => {
  const m = modelOf(id);
  if (!m) throw new Error(`Unknown model ${id}: ${MODELS.map((x) => x.id).join(', ')}`);
  return m;
};
const questions = (): Question[] =>
  REPOS.flatMap((r) => {
    const file = QUESTION_DIRS.map((d) => join(d, `questions-${r}.json`)).find((p) => existsSync(p));
    return file ? (JSON.parse(readFileSync(file, 'utf8')) as Question[]) : [];
  });
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

/** Rank (1-based) of the first hit that is the expected code: same file, overlapping lines. An outline is not an answer. */
function rankOf(hits: Hit[], q: Question, fileOnly = false): number {
  const at = hits.findIndex((h) => q.expect.some((e) => e.path === h.path && (fileOnly || (h.kind !== 'outline' && h.start <= e.end && h.end >= e.start))));
  return at < 0 ? 0 : at + 1;
}

async function index(modelId: string, repos: string[]): Promise<void> {
  const model = modelId === 'none' ? null : need(modelId);
  const engine = model ? engineOf(model) : null;
  for (const repo of repos) {
    const store = storeOf(repo);
    const root = join(REPOS_DIR, repo);
    let peak = vramUsed();
    const sampler = setInterval(() => (peak = Math.max(peak, vramUsed())), 3000);
    const t0 = Date.now();
    const files = await syncFiles(store, root, root, model?.id ?? '');
    const embedded = model ? await syncVectors(store, root, model.id, (texts) => engine!.embed(texts), { root, passage: model.passage }) : 0;
    clearInterval(sampler);
    const row = { op: 'index', model: modelId, repo, ...files, filesMs: files.ms, embedded, seconds: Math.round((Date.now() - t0) / 1000), gpu: engine?.state.gpu, loadMs: engine?.state.loadMs, dims: engine?.state.dims, vramPeakMiB: peak, skipped: store.stats(root, model?.id ?? '').skipped };
    record(row);
    console.log(JSON.stringify(row));
    store.close();
  }
  engine?.stop();
}

function truncated(index: { ids: Int32Array; data: Float32Array; dims: number }, dims: number): { ids: Int32Array; data: Float32Array; dims: number } {
  if (!dims || dims >= index.dims) return index;
  const data = new Float32Array(index.ids.length * dims);
  for (let i = 0; i < index.ids.length; i++) {
    let sum = 0;
    for (let d = 0; d < dims; d++) sum += index.data[i * index.dims + d] ** 2;
    const norm = Math.sqrt(sum) || 1;
    for (let d = 0; d < dims; d++) data[i * dims + d] = index.data[i * index.dims + d] / norm;
  }
  return { ids: index.ids, data, dims };
}

/** Every stage and combination on the same questions: what each one adds is read off the table. */
async function evaluate(embedIds: string[], rerankIds: string[], dimsList: number[]): Promise<void> {
  const qs = questions();
  const stores = new Map(REPOS.map((r) => [r, storeOf(r)]));
  const rows: Record<string, unknown>[] = [];
  const score = (name: string, ranks: number[], fileRanks: number[], ms: number[], extra: Record<string, unknown> = {}) => {
    const hit = (k: number, rs: number[]) => Math.round((100 * rs.filter((r) => r > 0 && r <= k).length) / rs.length);
    const mrr = ranks.reduce((s, r) => s + (r > 0 && r <= 10 ? 1 / r : 0), 0) / ranks.length;
    const row = { op: 'eval', config: name, n: ranks.length, 'hit@1': hit(1, ranks), 'hit@5': hit(5, ranks), 'file@5': hit(5, fileRanks), 'mrr@10': Number(mrr.toFixed(3)), msMedian: Math.round(median(ms)), ...extra };
    rows.push(row);
    record({ ...row, ranks });
    console.log(JSON.stringify(row));
  };
  const run = async (name: string, fn: (q: Question, store: SearchStore, tree: string) => Promise<Hit[]>, extra?: Record<string, unknown>) => {
    const ranks: number[] = [];
    const fileRanks: number[] = [];
    const ms: number[] = [];
    for (const q of qs) {
      const t = performance.now();
      const hits = await fn(q, stores.get(q.repo)!, join(REPOS_DIR, q.repo));
      ms.push(performance.now() - t);
      ranks.push(rankOf(hits, q));
      fileRanks.push(rankOf(hits, q, true));
    }
    score(name, ranks, fileRanks, ms, extra);
  };
  const off = { lexical: false, vectors: false, rerank: 0 };
  await run('bm25', (q, s, tree) => search(s, tree, '', q.q, 10, { ...off, lexical: true }, {}));
  for (const id of embedIds) {
    const model = need(id);
    const engine = engineOf(model);
    const queryVectors = new Map<string, Float32Array>();
    for (const q of qs) queryVectors.set(q.q, (await engine.embed([(model.query ?? '') + q.q]))[0]);
    engine.stop();
    const cache = new Map<string, ReturnType<SearchStore['vectors']>>();
    for (const dims of dimsList) {
      const vectorsOf = (s: SearchStore, tree: string) => {
        const key = `${tree}:${dims}`;
        if (!cache.has(key)) cache.set(key, truncated(s.vectors(tree, id), dims));
        return cache.get(key)!;
      };
      const cut = (v: Float32Array) => (dims && dims < v.length ? truncated({ ids: new Int32Array(1), data: v, dims: v.length }, dims).data : v);
      const embedQuery = async (q: string) => cut(queryVectors.get(q)!);
      const tag = dims ? `${id}@${dims}` : id;
      await run(`vec ${tag}`, (q, s, tree) => search(s, tree, id, q.q, 10, { ...off, vectors: true }, { embedQuery }, '', () => vectorsOf(s, tree)));
      await run(`bm25+vec ${tag}`, (q, s, tree) => search(s, tree, id, q.q, 10, { lexical: true, vectors: true, rerank: 0 }, { embedQuery }, '', () => vectorsOf(s, tree)));
      for (const rid of dims ? [] : rerankIds) {
        const reranker = engineOf(need(rid));
        const rerank = (query: string, documents: string[]) => reranker.rerank(query, documents);
        await reranker.rerank('warm', ['up']);
        await run(`bm25+vec ${tag} +rerank ${rid}`, (q, s, tree) => search(s, tree, id, q.q, 10, { lexical: true, vectors: true, rerank: CANDIDATES }, { embedQuery, rerank }, '', () => vectorsOf(s, tree)), { vramMiB: vramUsed() });
        reranker.stop();
      }
    }
  }
  for (const s of stores.values()) s.close();
  console.table(rows.map(({ op: _op, n: _n, ...r }) => r));
}

/** What one model costs: time to the first answer from nothing, a question once loaded, memory loaded and released. */
async function resources(embedId: string, rerankId: string, device: 'auto' | 'gpu' | 'cpu'): Promise<void> {
  const model = need(embedId);
  const repo = 'claude-hub';
  const tree = join(REPOS_DIR, repo);
  const store = storeOf(repo);
  const before = vramUsed();
  const embedder = engineOf(model, device);
  const reranker = rerankId ? engineOf(need(rerankId), device) : null;
  const engines = { embedQuery: async (q: string) => (await embedder.embed([(model.query ?? '') + q]))[0], ...(reranker ? { rerank: (q: string, d: string[]) => reranker.rerank(q, d) } : {}) };
  const stages = { lexical: true, vectors: true, rerank: reranker ? CANDIDATES : 0 };
  const ask = async (q: string) => {
    const t = performance.now();
    const hits = await search(store, tree, model.id, q, 8, stages, engines);
    return { ms: Math.round(performance.now() - t), hits };
  };
  const cold = await ask('où est géré le délai avant de décharger un modèle ?');
  const loaded = vramUsed();
  const warm: number[] = [];
  for (const q of questions().filter((x) => x.repo === repo)) warm.push((await ask(q.q)).ms);
  const sample = formatHits(cold.hits, 'où est géré le délai avant de décharger un modèle ?', 1500);
  embedder.stop();
  reranker?.stop();
  await new Promise((r) => setTimeout(r, 2500));
  const row = { op: 'resources', embed: embedId, rerank: rerankId, device, gpu: embedder.state.gpu, coldMs: cold.ms, embedLoadMs: embedder.state.loadMs, rerankLoadMs: reranker?.state.loadMs, warmMedianMs: median(warm), warmMaxMs: Math.max(...warm), vramBeforeMiB: before, vramLoadedMiB: loaded, vramAfterStopMiB: vramUsed(), answerTokens: Math.ceil(sample.length / 3.6) };
  record(row);
  console.log(JSON.stringify(row));
  store.close();
}

async function ask(repo: string, embedId: string, rerankId: string, query: string): Promise<void> {
  const model = need(embedId);
  const tree = join(REPOS_DIR, repo);
  const store = storeOf(repo);
  const embedder = engineOf(model);
  const reranker = rerankId ? engineOf(need(rerankId)) : null;
  const hits = await search(store, tree, model.id, query, 8, { lexical: true, vectors: true, rerank: reranker ? CANDIDATES : 0 }, { embedQuery: async (q) => (await embedder.embed([(model.query ?? '') + q]))[0], ...(reranker ? { rerank: (q: string, d: string[]) => reranker.rerank(q, d) } : {}) });
  console.log(formatHits(hits, query, 1500));
  embedder.stop();
  reranker?.stop();
  store.close();
}

function checkQuestions(): void {
  let bad = 0;
  for (const q of questions()) {
    for (const e of q.expect) {
      const file = join(REPOS_DIR, q.repo, e.path);
      const lines = existsSync(file) && statSync(file).isFile() ? readFileSync(file, 'utf8').split('\n') : null;
      const name = (e.symbol ?? '').split(/[.\s(]/).filter(Boolean).pop() ?? '';
      const ok = lines !== null && e.end <= lines.length + 1 && (!name || lines.slice(e.start - 1, e.end).join('\n').includes(name));
      if (!ok) {
        bad++;
        console.log(`BAD ${q.repo} ${e.path}:${e.start}-${e.end} ${e.symbol ?? ''} | ${q.q.slice(0, 60)}`);
      }
    }
  }
  const all = questions();
  console.log(`${all.length} questions, ${bad} bad targets; fts sample: ${ftsQuery(all[0].q)}; rrf ${rrf([[1, 2], [2, 3]]).join(',')}; nearest ${nearest({ ids: Int32Array.of(7), data: Float32Array.of(1, 0), dims: 2 }, Float32Array.of(1, 0), 1)}`);
}

const [command = 'help', ...args] = process.argv.slice(2);
const list = (s?: string): string[] => (s ? s.split(',').filter(Boolean) : []);
if (command === 'index') await index(args[0] ?? 'none', args.length > 1 ? args.slice(1) : REPOS);
else if (command === 'eval') await evaluate(list(args[0]), list(args[1]), [0, ...list(args[2]).map(Number)]);
else if (command === 'resources') await resources(args[0], args[1] ?? '', (args[2] as 'auto' | 'gpu' | 'cpu') ?? 'auto');
else if (command === 'ask') await ask(args[0], args[1], args[2] === '-' ? '' : (args[2] ?? ''), args.slice(3).join(' '));
else if (command === 'questions') checkQuestions();
else console.log('index <model|none> [repo…] | eval <embed,…> [rerank,…] [dims,…] | resources <embed> [rerank] [auto|gpu|cpu] | ask <repo> <embed> <rerank|-> <question> | questions');
process.exit(0);
