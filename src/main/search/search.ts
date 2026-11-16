import { redact } from './files';
import { identifierParts, type SearchStore, type StoredChunk } from './store';

export interface Hit extends StoredChunk { score: number }

export interface Stages {
  /** Exact words (BM25). */
  lexical: boolean;
  /** Meaning (vectors). */
  vectors: boolean;
  /** How many candidates the reranker reads; 0 leaves the fused order as it is. */
  rerank: number;
}

/** How many candidates each of the two searches gives to the fusion. */
export const CANDIDATES = 30;
/** What the reranker reads of a candidate. */
export const RERANK_CHARS = 2000;

const STOP = new Set(
  'a an and are as at be by do does for from how in is it of on or that the this to what when where which who why with le la les l un une des du de d et ou où est sont que qui quoi quel quelle quels quelles comment pourquoi dans sur pour par avec au aux ce cet cette ces se sa son ses on y en il elle ne pas plus fait faire gere geree gerer géré gérée gérer code fichier file'.split(' '),
);

/**
 * The question as an FTS5 query: its words, and the parts of its identifiers, any of them. Each is quoted, so no
 * character of the question is read as FTS5 syntax.
 */
export function ftsQuery(query: string): string {
  const words = new Set<string>();
  for (const raw of query.match(/[\p{L}\p{N}_$]{2,}/gu) ?? []) {
    const w = raw.toLowerCase();
    if (!STOP.has(w)) words.add(w);
    for (const p of identifierParts(raw).split(' ')) if (p && !STOP.has(p)) words.add(p);
  }
  return [...words].slice(0, 24).map((w) => `"${w.replace(/"/g, '')}"`).join(' OR ');
}

/** Reciprocal rank fusion: a chunk high in several lists beats one that tops a single list. */
export function rrf(lists: number[][], k = 60): number[] {
  const score = new Map<number, number>();
  for (const list of lists) list.forEach((id, rank) => score.set(id, (score.get(id) ?? 0) + 1 / (k + rank + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/** The `limit` nearest vectors by cosine (vectors are normalized, a dot product is enough). */
export function nearest(index: { ids: Int32Array; data: Float32Array; dims: number }, query: Float32Array, limit: number, keep?: (id: number) => boolean): number[] {
  const { ids, data, dims } = index;
  const n = Math.min(dims, query.length);
  const scored: { id: number; s: number }[] = [];
  for (let i = 0; i < ids.length; i++) {
    if (keep && !keep(ids[i])) continue;
    let s = 0;
    const at = i * dims;
    for (let d = 0; d < n; d++) s += data[at + d] * query[d];
    scored.push({ id: ids[i], s });
  }
  return scored.sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.id);
}

export interface Searcher {
  embedQuery?: (query: string) => Promise<Float32Array>;
  rerank?: (query: string, documents: string[]) => Promise<number[]>;
}

/**
 * The best chunks of a checkout for a question: exact words and meaning each give their candidates, the fusion
 * orders them, the reranker reads the top ones against the question. A stage that is off or fails is skipped: the
 * others still answer.
 */
export async function search(
  store: SearchStore,
  tree: string,
  model: string,
  query: string,
  limit: number,
  stages: Stages,
  engines: Searcher,
  under = '',
  vectorsOf: () => { ids: Int32Array; data: Float32Array; dims: number } = () => store.vectors(tree, model),
): Promise<Hit[]> {
  const lists: number[][] = [];
  if (stages.lexical) lists.push(store.lexical(tree, ftsQuery(query), CANDIDATES, under));
  if (stages.vectors && engines.embedQuery) {
    const vector = await engines.embedQuery(query).catch(() => null);
    if (vector) {
      const index = vectorsOf();
      const paths = under ? store.paths(tree, index.ids) : null;
      lists.push(nearest(index, vector, CANDIDATES, paths ? (id) => paths.get(id)?.startsWith(under) === true : undefined));
    }
  }
  let ids = rrf(lists);
  const hits = (list: number[]): Hit[] => list.flatMap((id, rank) => {
    const c = store.chunk(id);
    return c ? [{ ...c, score: 1 / (rank + 1) }] : [];
  });
  if (stages.rerank > 0 && engines.rerank && ids.length > 1) {
    const top = hits(ids.slice(0, stages.rerank));
    const scores = await engines.rerank(query, top.map((h) => `${h.path}${h.symbol ? ` › ${h.symbol}` : ''}\n${h.text}`.slice(0, RERANK_CHARS))).catch(() => null);
    if (scores) {
      const order = top.map((h, i) => ({ id: h.id, s: scores[i] })).sort((a, b) => b.s - a.s).map((x) => x.id);
      ids = [...order, ...ids.slice(stages.rerank)];
    }
  }
  return hits(ids.slice(0, limit));
}

const tokens = (text: string): number => Math.ceil(text.length / 3.6);

/** The lines of a chunk that carry the most words of the question, with its first line (the signature). */
function excerpt(hit: Hit, words: string[], maxLines: number): string {
  const lines = hit.text.split('\n');
  const cut = (l: string) => (l.length > 160 ? `${l.slice(0, 159)}…` : l);
  if (lines.length <= maxLines) return lines.map(cut).join('\n');
  const weight = lines.map((l) => {
    const low = l.toLowerCase();
    return words.reduce((n, w) => n + (low.includes(w) ? 1 : 0), 0);
  });
  const span = maxLines - 1;
  let best = 1;
  let bestSum = -1;
  let sum = 0;
  for (let i = 1; i < lines.length; i++) {
    sum += weight[i];
    if (i - span >= 1) sum -= weight[i - span];
    if (i >= span && sum > bestSum) {
      bestSum = sum;
      best = i - span + 1;
    }
  }
  const body = lines.slice(best, best + span).map(cut);
  return [cut(lines[0]), ...(best > 1 ? ['  …'] : []), ...body, ...(best + span < lines.length ? ['  …'] : [])].join('\n');
}

/**
 * Results as an agent reads them: `path:lines symbol`, then the fewest lines that show the hit. The budget (in
 * tokens) is shared by the results, the first ones first; `expand` gives each chunk whole instead.
 */
export function formatHits(hits: Hit[], query: string, budget: number, expand = false): string {
  if (!hits.length) return 'No result.';
  const words = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}_$]{3,}/gu) ?? []).filter((w) => !STOP.has(w)).flatMap((w) => [w, ...identifierParts(w).split(' ').filter(Boolean)]))];
  const out: string[] = [];
  let left = budget;
  const heads = hits.map((h) => `${h.path}:${h.start}-${h.end}${h.symbol ? ` ${h.symbol}` : ''}${h.kind === 'outline' ? ' (file outline)' : ''}`);
  // Every result keeps at least its location: an agent can read the lines itself.
  left -= heads.reduce((n, h) => n + tokens(h) + 2, 0);
  hits.forEach((h, i) => {
    const share = Math.max(0, Math.floor(left / (hits.length - i)));
    const lines = expand ? Number.MAX_SAFE_INTEGER : Math.min(24, Math.max(0, Math.floor(share / 14)));
    let body = lines >= 2 ? excerpt(h, words, lines) : '';
    while (body && tokens(body) > share && !expand) body = body.split('\n').slice(0, -2).join('\n');
    if (expand && tokens(body) > left) body = `${body.slice(0, Math.max(0, Math.floor(left * 3.6)))}\n  … (cut: read ${h.path} from line ${h.start})`;
    left -= tokens(body);
    out.push(body ? `${heads[i]}\n${body}` : heads[i]);
  });
  // The index holds no secret already; an answer goes to a model outside this machine, so it is checked again.
  return redact(out.join('\n\n')).text;
}
