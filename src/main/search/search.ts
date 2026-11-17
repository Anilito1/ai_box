import { redact } from './files';
import { identifierParts, type SearchStore, type StoredChunk, type VectorIndex } from './store';

export interface Hit extends StoredChunk {
  /** How sure the search is, 0 to 1: the reranker's judgement when it ran, else the closeness of meaning; 1 for a definition. */
  score: number;
  /** What put it here. */
  by: 'definition' | 'path' | 'words' | 'meaning' | 'reranker';
}

export interface Stages {
  /** Exact words (BM25). */
  lexical: boolean;
  /** Meaning (vectors). */
  vectors: boolean;
  /** How many candidates the reranker reads; 0 leaves the fused order as it is. */
  rerank: number;
  /** What a rank in the exact-words list is worth next to the same rank by meaning (1 when absent). */
  lexicalWeight?: number;
  /** Candidates each search gives to the fusion (CANDIDATES when absent). */
  candidates?: number;
  /** What the reranker reads of a candidate (RERANK_CHARS when absent). */
  rerankChars?: number;
  /** The reranker only runs when the first and the fifth result by meaning are closer than this: an order already clear is kept. */
  rerankGap?: number;
  /** The fusion's constant: lower, the first ranks of each list count more (60 when absent). */
  rrfK?: number;
}

/** How many candidates each of the two searches gives to the fusion. */
export const CANDIDATES = 30;
/** What the reranker reads of a candidate. */
export const RERANK_CHARS = 2000;

const STOP = new Set(
  'a an and are as at be by do does for from how in is it of on or that the this to what when where which who why with le la les l un une des du de d et ou où est sont que qui quoi quel quelle quels quelles comment pourquoi dans sur pour par avec au aux ce cet cette ces se sa son ses on y en il elle ne pas plus fait faire gere geree gerer géré gérée gérer code fichier file'.split(' '),
);
const FILE_EXT = /\.(?:[cm]?[jt]sx?|py|cs|sql|md|json|ya?ml|toml|html|s?css|vue|go|rs|java|rb|php|sh|ps1)$/i;

export interface Route {
  /** `symbol`: the question is a name; `path`: a file; `concept`: a behaviour to find by its meaning. */
  kind: 'symbol' | 'path' | 'concept';
  /** Names of the code the question holds: looked up as definitions whatever the kind. */
  names: string[];
  paths: string[];
}

/**
 * What kind of question this is. A name of the code (`hubTools`, `list_repos`, `Orders.refund`, `stripe-webhook`)
 * or a path is answered from the index of names and files, with no model at all; only a described behaviour needs
 * the search by meaning.
 */
export function routeOf(query: string): Route {
  const names: string[] = [];
  const paths: string[] = [];
  let plain = 0;
  const alone = query.trim().split(/\s+/).length === 1;
  for (const raw of query.split(/\s+/)) {
    const quoted = alone || /^[`'"«(]+.*[`'"»)]+[?.,;:!]*$/.test(raw);
    // `hubTools()`, `"redact",`: what surrounds a name is not part of it.
    const token = raw.replace(/^[`'"«(]+|[`'"»()?.,;:!]+$/g, '');
    if (!token) continue;
    // A path has a file's ending or reads like folders (`src/main`); `read/write` or `and/or` are words.
    if (FILE_EXT.test(token) || /^\.?[\w.@-]+(?:\/[\w.@-]+)+\/?$/.test(token) && (token.split('/').length > 2 || /^(?:src|lib|app|apps|scripts|docs|tests?|packages|server|public|supabase|components|content|assets)\//i.test(token))) paths.push(token.replace(/\\/g, '/'));
    else if (/^[A-Za-z_$][\w$]*(?:(?:[.#-]|::?)[A-Za-z_$][\w$]*)*$/.test(token) && (token.split(/[.#:-]+/).pop()?.length ?? 0) >= 3 && (quoted || /[a-z0-9][A-Z]|_|[A-Za-z](?:[.#-]|::?)[A-Za-z]|^[A-Z]+[a-z]+[A-Z]/.test(token))) names.push(token.replace(/[#:]+/g, '.'));
    else if (!STOP.has(token.toLowerCase())) plain++;
  }
  return { kind: paths.length && plain <= 1 ? 'path' : names.length && plain <= 2 ? 'symbol' : 'concept', names, paths };
}

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
export function rrf(lists: number[][], weights: number[] = [], k = 60): number[] {
  const score = new Map<number, number>();
  lists.forEach((list, n) => list.forEach((id, rank) => score.set(id, (score.get(id) ?? 0) + (weights[n] ?? 1) / (k + rank + 1))));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/** The `limit` nearest vectors by cosine, best first, without sorting the whole index. */
export function nearest(index: VectorIndex, query: Float32Array, limit: number, keep?: (id: number) => boolean): { id: number; score: number }[] {
  const { ids, data, dims } = index;
  const n = Math.min(dims, query.length);
  const top: { id: number; score: number }[] = [];
  let floor = -Infinity;
  for (let i = 0; i < ids.length; i++) {
    if (keep && !keep(ids[i])) continue;
    let s = 0;
    const at = i * dims;
    for (let d = 0; d < n; d++) s += data[at + d] * query[d];
    if (top.length === limit && s <= floor) continue;
    let pos = top.length;
    while (pos > 0 && top[pos - 1].score < s) pos--;
    top.splice(pos, 0, { id: ids[i], score: s });
    if (top.length > limit) top.pop();
    floor = top[top.length - 1].score;
  }
  for (const t of top) t.score /= 127;
  return top;
}

/** Where the names of a question are defined, and the files asked for by path: answers that need no model. */
export function lookup(store: SearchStore, tree: string, route: Route, limit: number, under = ''): Hit[] {
  const hits: Hit[] = [];
  const seen = new Set<string>();
  const add = (chunk: StoredChunk | null, by: Hit['by']) => {
    const key = chunk ? `${chunk.path}:${chunk.start}` : '';
    if (!chunk || seen.has(key) || !chunk.path.startsWith(under) || hits.length >= limit) return;
    seen.add(key);
    hits.push({ ...chunk, score: 1, by });
  };
  for (const name of route.names) {
    for (const def of store.definitions(tree, name, limit)) {
      // The definition with its own extent, which may run past the piece that holds its first lines.
      const chunk = store.chunkAt(tree, def.path, def.start);
      if (chunk) add({ ...chunk, start: def.start, end: def.end, symbol: def.name, text: chunk.text.split('\n').slice(def.start - chunk.start, def.end - chunk.start + 1).join('\n') }, 'definition');
    }
  }
  for (const path of route.paths) for (const id of store.byPath(tree, path, limit)) add(store.chunk(id), 'path');
  return hits;
}

export interface Searcher {
  embedQuery?: (query: string) => Promise<Float32Array>;
  rerank?: (query: string, documents: string[]) => Promise<number[]>;
}

/**
 * The best chunks of a checkout for a described behaviour: exact words and meaning each give their candidates, the
 * fusion orders them, the reranker reads the top ones against the question when their order is not already clear.
 * A stage that is off or fails is skipped: the others still answer.
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
  vectorsOf: () => VectorIndex = () => store.vectors(tree, model),
): Promise<Hit[]> {
  const lists: number[][] = [];
  const weights: number[] = [];
  const candidates = stages.candidates ?? CANDIDATES;
  const cosine = new Map<number, number>();
  let near: { id: number; score: number }[] = [];
  if (stages.lexical) {
    lists.push(store.lexical(tree, ftsQuery(query), candidates, under));
    weights.push(stages.lexicalWeight ?? 1);
  }
  if (stages.vectors && engines.embedQuery) {
    const vector = await engines.embedQuery(query).catch(() => null);
    if (vector) {
      const paths = under ? store.paths(tree) : null;
      near = nearest(vectorsOf(), vector, candidates, paths ? (id) => paths.get(id)?.startsWith(under) === true : undefined);
      for (const x of near) cosine.set(x.id, x.score);
      lists.push(near.map((x) => x.id));
      weights.push(1);
    }
  }
  let ids = rrf(lists, weights, stages.rrfK);
  const judged = new Map<number, number>();
  // An order by meaning that is already clear is kept: the reranker is for the close calls.
  const clear = stages.rerankGap !== undefined && near.length >= 5 && near[0].score - near[4].score >= stages.rerankGap;
  if (stages.rerank > 0 && engines.rerank && ids.length > 1 && !clear) {
    const top = ids.slice(0, stages.rerank).flatMap((id) => store.chunk(id) ?? []);
    const scores = await engines.rerank(query, top.map((h) => `${h.path}${h.symbol ? ` › ${h.symbol}` : ''}\n${h.text}`.slice(0, stages.rerankChars ?? RERANK_CHARS))).catch(() => null);
    if (scores) {
      top.forEach((h, i) => judged.set(h.id, scores[i]));
      ids = [...top.map((h) => h.id).sort((a, b) => (judged.get(b) ?? 0) - (judged.get(a) ?? 0)), ...ids.slice(stages.rerank)];
    }
  }
  return ids.slice(0, limit).flatMap((id): Hit[] => {
    const c = store.chunk(id);
    if (!c) return [];
    const rel = judged.get(id);
    return [{ ...c, score: rel ?? cosine.get(id) ?? 0, by: rel !== undefined ? 'reranker' : cosine.has(id) ? 'meaning' : 'words' }];
  });
}

/**
 * How the stages are tuned, on the dev half of the questions of scripts/search-bench (docs/recherche-semantique.md);
 * the test half is read once, at the end, with nothing tuned after.
 */
export const TUNING = {
  /** A rank by exact words next to the same rank by meaning. */
  lexicalWeight: 0.5,
  /** The reranker reads this many candidates, this much of each. */
  rerank: 10,
  rerankChars: 800,
  /** …and only when the first and fifth results by meaning are closer than this. */
  rerankGap: 0.05,
  /** Under these, the search says it found nothing sure instead of showing code. 0 answers always. */
  minMeaning: 0,
  minReranker: 0,
  /** Definitions of the names a described behaviour holds, shown before what the search finds. */
  pinned: 2,
};
export type Tuning = typeof TUNING;

/** The stages of a search for a described behaviour, as tuned. */
export const stagesOf = (vectors: boolean, rerank: boolean, tuning: Tuning = TUNING): Stages => ({ lexical: true, vectors, rerank: rerank ? tuning.rerank : 0, rerankChars: tuning.rerankChars, rerankGap: tuning.rerankGap, lexicalWeight: tuning.lexicalWeight });

export interface Answer {
  hits: Hit[];
  /** A name or a path the index knows: no model was asked. */
  known: boolean;
  /** Nothing is close enough: the hits are leads only. */
  unsure: boolean;
  /** Files that import the names asked for. */
  users: string[];
}

/**
 * What `search_code` answers. A name that is defined or a file that exists comes from the index alone, with where
 * the name is used; a described behaviour from `find` (the search by words and meaning), within the file or folder
 * it names, after the definitions of the names it holds.
 */
export async function answer(store: SearchStore, tree: string, query: string, limit: number, under: string, find: (within: string) => Promise<Hit[]>, tuning: Tuning = TUNING): Promise<Answer> {
  const route = routeOf(query);
  const known = lookup(store, tree, route, limit, under);
  if (route.kind !== 'concept' && known.length) {
    const users = route.names.flatMap((n) => store.importers(tree, n)).filter((p, i, all) => all.indexOf(p) === i && !known.some((h) => h.path === p));
    // Then where the name is used: other pieces that hold it, outside the definitions already shown. A path asks for nothing more.
    const inside = (c: { path: string; start: number; end: number }) => known.some((h) => h.path === c.path && c.start >= h.start && c.end <= h.end);
    const more = route.kind === 'symbol' && known.length < limit ? store.lexical(tree, ftsQuery(route.names.join(' ')), limit * 2, under).flatMap((id) => store.chunk(id) ?? []).filter((c) => c.kind !== 'outline' && !inside(c)).map((c): Hit => ({ ...c, score: 0, by: 'words' })) : [];
    return { hits: [...known, ...more].slice(0, limit), known: true, unsure: false, users };
  }
  // In a described behaviour, a path says where to look and a name is a lead: neither takes the place of the search.
  const file = known.find((h) => h.by === 'path')?.path ?? '';
  const within = under || (file && route.paths.some((p) => file.endsWith(p)) ? file : (route.paths.find((p) => known.some((h) => h.by === 'path' && h.path.startsWith(p))) ?? ''));
  const pinned = known.filter((h) => h.by === 'definition').slice(0, tuning.pinned);
  const found = await find(within);
  const best = found[0];
  if (!pinned.length && best && ((best.by === 'meaning' && best.score < tuning.minMeaning) || (best.by === 'reranker' && best.score < tuning.minReranker))) return { hits: found, known: false, unsure: true, users: [] };
  return { hits: [...pinned, ...found.filter((h) => !pinned.some((p) => p.id === h.id))].slice(0, limit), known: false, unsure: false, users: [] };
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

/** `path:lines symbol (how sure)`: where to read, and how much to trust it. */
export function headOf(h: Hit): string {
  const sure = h.by === 'definition' ? 'definition' : h.by === 'path' ? 'file' : h.by === 'words' ? 'words' : h.score.toFixed(2);
  return `${h.path}:${h.start}-${h.end}${h.symbol ? ` ${h.symbol}` : ''}${h.kind === 'outline' ? ' (file outline)' : ''} (${sure})`;
}

/**
 * Results as an agent reads them: `path:lines symbol (score)`, then the fewest lines that show the hit. The budget
 * (in tokens) is shared by the results, the first ones first; `expand` gives each chunk whole instead.
 */
export function formatHits(hits: Hit[], query: string, budget: number, expand = false): string {
  if (!hits.length) return 'No result.';
  const words = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}_$]{3,}/gu) ?? []).filter((w) => !STOP.has(w)).flatMap((w) => [w, ...identifierParts(w).split(' ').filter(Boolean)]))];
  const out: string[] = [];
  let left = budget;
  const heads = hits.map(headOf);
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

/** The answer when nothing is close enough: said plainly, with the nearest places as leads only, and no excerpt to read. */
export function formatUnsure(hits: Hit[]): string {
  const leads = hits.slice(0, 3).map(headOf);
  return redact(`No confident match${leads.length ? `. Nearest, unverified:\n${leads.join('\n')}` : '.'}\nSearch an exact name with Grep, or ask with other words.`).text;
}
