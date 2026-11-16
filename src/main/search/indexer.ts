import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { chunkFile, importsOf, type Chunk } from './chunker';
import { listFiles, looksWritten, redact, skipReason } from './files';
import { embedText, hashOf, type SearchStore } from './store';

export interface FileStats { files: number; changed: number; removed: number; chunks: number; missing: number; ms: number }
export interface SyncProgress { done: number; total: number }

/** The model reads this much of a chunk: about 1 500 tokens of code. */
export const EMBED_CHARS = 6000;
const BATCH = 16;
/** Raised when the way files are chosen, cleaned or cut changes: an index made under other rules is built again. */
const RULES = '2';

/** Imported names the chunk really uses, by module: what the code leans on, without the whole import block. */
export function usesOf(fileText: string, chunkText: string): string {
  const used: string[] = [];
  for (const m of fileText.matchAll(/^\s*import\s+(?:type\s+)?([^'"\n;]+?)\s+from\s+['"]([^'"\n]+)['"]|^\s*from\s+([\w.]+)\s+import\s+([^\n#]+)|^\s*(?:const|let|var)\s+([^=\n]+?)\s*=\s*require\(\s*['"]([^'"\n]+)['"]/gm)) {
    const names = (m[1] ?? m[4] ?? m[5] ?? '').match(/[A-Za-z_$][\w$]*/g) ?? [];
    const source = m[2] ?? m[3] ?? m[6];
    if (names.some((n) => n !== 'as' && n !== 'type' && new RegExp(`\\b${n.replace(/\$/g, '\\$')}\\b`).test(chunkText))) used.push(source);
    if (used.length >= 8) break;
  }
  return used.join(', ');
}

/** What the model reads for a chunk of this file; the chunk carries its hash. */
function modelText(path: string, file: string, chunk: Pick<Chunk, 'symbol' | 'kind' | 'text'>): string {
  return embedText(path, chunk, chunk.kind !== 'outline' && importsOf(file).length > 0 ? usesOf(file, chunk.text) : '').slice(0, EMBED_CHARS);
}

async function cut(path: string, text: string): Promise<(Chunk & { hash: string })[]> {
  return (await chunkFile(path, text)).map((c) => ({ ...c, hash: hashOf(modelText(path, text, c)) }));
}

/**
 * Brings the files of a checkout up to date in its index: those git lists (so `.gitignore` is respected) whose size
 * or date changed are read and cut again, those gone are removed. Secrets are taken out of the text first; a file
 * whose name says it holds some (`.env`, `*.pem`, `credentials*`…) is recorded as skipped and never read.
 * `tree` names the checkout (its absolute path): worktrees of one repo share an index file and its vectors.
 */
export async function syncFiles(store: SearchStore, tree: string, root: string, model: string): Promise<FileStats> {
  const t0 = Date.now();
  const listed = await listFiles(root);
  if (store.meta(`rules:${tree}`) !== RULES) {
    store.dropTree(tree);
    store.setMeta(`rules:${tree}`, RULES);
  }
  const known = store.files(tree);
  const seen = new Set<string>();
  let changed = 0;
  for (const path of listed) {
    const info = await stat(join(root, path)).catch(() => null);
    if (!info?.isFile()) continue;
    seen.add(path);
    const before = known.get(path);
    const state = { size: info.size, mtime: Math.round(info.mtimeMs), skipped: '' as string };
    if (before && before.size === state.size && before.mtime === state.mtime) continue;
    changed++;
    state.skipped = skipReason(path, info.size);
    let chunks: (Chunk & { hash: string })[] = [];
    if (!state.skipped) {
      const raw = await readFile(join(root, path), 'utf8').catch(() => null);
      const text = raw === null ? '' : redact(raw).text;
      if (raw === null) state.skipped = 'unreadable';
      else if (!looksWritten(text)) state.skipped = 'minified';
      else chunks = await cut(path, text);
    }
    store.transaction(() => store.putFile(tree, path, state, chunks));
  }
  let removed = 0;
  for (const path of known.keys()) {
    if (seen.has(path)) continue;
    store.transaction(() => store.removeFile(tree, path));
    removed++;
  }
  if (changed || removed) store.prune();
  const stats = store.stats(tree, model);
  return { files: stats.files, changed, removed, chunks: stats.chunks, missing: model ? store.missing(tree, model).length : 0, ms: Date.now() - t0 };
}

export interface Doc { id: string; text: string }

/** The same for texts that are not files (the topics' memory, the posts' notes): each is a document named by its id. */
export async function syncDocs(store: SearchStore, tree: string, docs: Doc[]): Promise<void> {
  const known = store.files(tree);
  const seen = new Set<string>();
  for (const doc of docs) {
    seen.add(doc.id);
    const text = redact(doc.text).text;
    const state = { size: text.length, mtime: Number.parseInt(hashOf(text).slice(0, 12), 16), skipped: '' };
    const before = known.get(doc.id);
    if (before && before.size === state.size && before.mtime === state.mtime) continue;
    const chunks = (await chunkFile(`${doc.id}.md`, text)).map((c) => ({ ...c, hash: hashOf(embedText(doc.id, c).slice(0, EMBED_CHARS)) }));
    store.transaction(() => store.putFile(tree, doc.id, state, chunks));
  }
  for (const id of known.keys()) if (!seen.has(id)) store.transaction(() => store.removeFile(tree, id));
  store.prune();
}

/**
 * Computes the vectors a checkout lacks for this model, and only those: a chunk whose text did not change keeps its
 * vector, whatever moved around it. Stored batch by batch, so an interrupted run resumes where it stopped. `root`
 * is the checkout, read again for what a chunk imports; documents have none.
 */
export async function syncVectors(
  store: SearchStore,
  tree: string,
  model: string,
  embed: (texts: string[]) => Promise<Float32Array[]>,
  { root = '', passage = '', onProgress }: { root?: string; passage?: string; onProgress?: (p: SyncProgress) => void } = {},
): Promise<number> {
  const files = new Map<string, string>();
  const texts: { hash: string; text: string }[] = [];
  for (const m of store.missing(tree, model)) {
    const c = store.chunk(m.id);
    if (!c) continue;
    if (!root) {
      texts.push({ hash: m.hash, text: embedText(c.path, c).slice(0, EMBED_CHARS) });
      continue;
    }
    let file = files.get(c.path);
    if (file === undefined) files.set(c.path, (file = redact(await readFile(join(root, c.path), 'utf8').catch(() => '')).text));
    texts.push({ hash: m.hash, text: modelText(c.path, file, c) });
  }
  // Long texts first: the slow batches come while the count is still far from the end.
  texts.sort((a, b) => b.text.length - a.text.length);
  let done = 0;
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const vectors = await embed(batch.map((b) => passage + b.text));
    store.transaction(() => batch.forEach((b, n) => vectors[n] && store.putVector(b.hash, model, vectors[n])));
    done += batch.length;
    onProgress?.({ done, total: texts.length });
  }
  return done;
}
