import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from '../git';
import { cutFile, type Chunk, type SymbolDef } from './chunker';
import { listFiles, looksWritten, redact, skipReason } from './files';
import { embedText, hashOf, type FileEntry, type FileState, type ImportRef, type SearchStore } from './store';

export interface FileStats { files: number; changed: number; removed: number; chunks: number; missing: number; ms: number; full: boolean }
export interface SyncProgress { done: number; total: number }

/** The model reads this much of a chunk: about 1 500 tokens of code. */
export const EMBED_CHARS = 6000;
const BATCH = 16;
/** Raised when the way files are chosen, cleaned or cut changes: an index made under other rules is built again. */
const RULES = '4';
/**
 * A writer that gives no news for this long is stuck: its claim is taken over (one whose process ended, at once).
 * Longer than the git calls of a pass, which may take a minute each.
 */
const CLAIM_MS = 300_000;
/** How long a writer waits for another one, which is doing the same work meanwhile. */
const WAIT_MS = 10 * 60_000;
const writing = new WeakMap<SearchStore, Promise<unknown>>();

/**
 * `work` as the only writer of an index's files: one after the other in this process, and across processes through
 * the claim the index holds (the app, a bench and the MCP bridge may open the same file). Two passes at once would
 * each remove what the other just put; one prune would take the vectors of files the other had not put back yet.
 * `renew` keeps the claim through a long pass, and stops it if another writer took the index over meanwhile.
 */
async function exclusive<T>(store: SearchStore, work: (renew: () => void) => Promise<T>): Promise<T> {
  const run = (writing.get(store) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const owner = `${process.pid}:${randomUUID()}`;
    const deadline = Date.now() + WAIT_MS;
    // A file locked by a long write elsewhere is one more reason to wait, not a failure.
    const take = () => {
      try {
        return store.claim(owner, CLAIM_MS);
      } catch (err) {
        if (/locked|busy/i.test(String(err))) return false;
        throw err;
      }
    };
    while (!take()) {
      if (Date.now() > deadline) throw new Error('Another process has been updating this index for too long');
      await new Promise((r) => setTimeout(r, 200));
    }
    let renewed = Date.now();
    const renew = () => {
      if (Date.now() - renewed < CLAIM_MS / 4) return;
      if (!store.claim(owner, CLAIM_MS)) throw new Error('Another process took over this index');
      renewed = Date.now();
    };
    try {
      return await work(renew);
    } finally {
      store.release(owner);
    }
  });
  writing.set(store, run);
  return run;
}

/** What a file imports, module by module, with the names it takes from each. */
export function importRefs(text: string): ImportRef[] {
  const refs: ImportRef[] = [];
  // The list of an `import { … }` may run over several lines.
  for (const m of text.matchAll(/^\s*import\s+(?:type\s+)?([^'";]+?)\s+from\s+['"]([^'"\n]+)['"]|^\s*from\s+([\w.]+)\s+import\s+([^\n#]+)|^\s*(?:const|let|var)\s+([^=\n]+?)\s*=\s*require\(\s*['"]([^'"\n]+)['"]/gm)) {
    const names = ((m[1] ?? m[4] ?? m[5] ?? '').match(/[A-Za-z_$][\w$]*/g) ?? []).filter((n) => n !== 'as' && n !== 'type');
    refs.push({ source: m[2] ?? m[3] ?? m[6], names });
  }
  return refs;
}

/** Imported modules the chunk really uses: what the code leans on, without the whole import block. */
export function usesOf(imports: ImportRef[], chunkText: string): string {
  const used: string[] = [];
  for (const ref of imports) {
    if (ref.names.some((n) => new RegExp(`\\b${n.replace(/\$/g, '\\$')}\\b`).test(chunkText))) used.push(ref.source);
    if (used.length >= 8) break;
  }
  return used.join(', ');
}

/**
 * What a file sets up beyond its code, for the catalogue `where_is` reads: a Supabase edge function (its folder
 * names it) and the jobs an SQL file schedules. Tables, functions and policies are already the names SQL defines.
 */
export function infraOf(path: string, text: string): SymbolDef[] {
  const found: SymbolDef[] = [];
  const edge = /(?:^|\/)supabase\/functions\/([^/_.][^/]*)\/index\.(?:ts|tsx|js|mjs)$/.exec(path);
  if (edge) found.push({ name: edge[1], kind: 'edge', start: 1, end: text.split('\n').length });
  if (path.endsWith('.sql')) {
    for (const m of text.matchAll(/cron\.schedule\(\s*'([^']+)'/g)) {
      const line = text.slice(0, m.index).split('\n').length;
      found.push({ name: m[1], kind: 'cron', start: line, end: line });
    }
  }
  return found;
}

/** What the model reads for a chunk; the chunk carries its hash. */
function modelText(path: string, imports: ImportRef[], chunk: Pick<Chunk, 'symbol' | 'kind' | 'text'>): string {
  return embedText(path, chunk, chunk.kind !== 'outline' && imports.length > 0 ? usesOf(imports, chunk.text) : '').slice(0, EMBED_CHARS);
}

async function entryOf(path: string, text: string): Promise<FileEntry> {
  const { chunks, symbols } = await cutFile(path, text);
  const imports = importRefs(text);
  return { chunks: chunks.map((c) => ({ ...c, hash: hashOf(modelText(path, imports, c)) })), symbols: [...symbols, ...infraOf(path, text)], imports };
}

/** Paths `git status --porcelain -z` names: changed, new, deleted, and both ends of a rename. */
export function statusPaths(out: string): string[] {
  const paths: string[] = [];
  const entries = out.split('\u0000');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2)) && entries[i + 1]) paths.push(entries[++i]);
  }
  return paths;
}

/**
 * The files that may differ from the index, asked of git instead of looking at every file: what the commits since
 * the last look changed, what is modified or new now, and what was modified then (it may have been put back).
 * Null when there is no last look to start from: every file is looked at.
 */
async function candidates(store: SearchStore, tree: string, root: string): Promise<{ paths: string[] | null; head: string; dirty: string[] }> {
  const head = (await git(root, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '')).trim();
  const dirty = statusPaths(await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { timeout: 60_000 }));
  const before = store.meta(`head:${tree}`);
  // Nothing known of this checkout (a first look, or an index that was emptied): there is no last look to start from.
  if (!before || !head || store.meta(`rules:${tree}`) !== RULES || store.files(tree).size === 0) return { paths: null, head, dirty };
  const paths = new Set<string>([...dirty, ...(JSON.parse(store.meta(`dirty:${tree}`) || '[]') as string[])]);
  if (before !== head) {
    const moved = await git(root, ['diff', '--name-only', '--no-renames', '-z', before, head], { timeout: 60_000 }).catch(() => null);
    if (moved === null) return { paths: null, head, dirty };
    for (const p of moved.split('\u0000')) if (p) paths.add(p);
  }
  return { paths: [...paths], head, dirty };
}

/**
 * Brings the files of a checkout up to date in its index. Git says which ones may have changed (and what it
 * ignores is never listed); those whose size or date differ are read and cut again, those gone are removed.
 * Secrets are taken out of the text first; a file whose name says it holds some (`.env`, `*.pem`, `credentials*`…)
 * is recorded as skipped and never read. `tree` names the checkout: worktrees of one repo share an index file.
 * Another process updating the same index is waited for.
 */
export async function syncFiles(store: SearchStore, tree: string, root: string, model: string): Promise<FileStats> {
  return exclusive(store, async (renew) => {
    const t0 = Date.now();
    const { paths, head, dirty } = await candidates(store, tree, root);
    renew();
    const full = paths === null;
    // Under other rules every file is cut again in place: the index never has a hole, and the vectors of a text that
    // did not change are kept. Until the pass ends, the next one starts over.
    const rebuild = full && store.meta(`rules:${tree}`) !== RULES;
    if (rebuild) store.setMeta(`head:${tree}`, '');
    const known = store.files(tree);
    const listed = full ? await listFiles(root) : paths;
    const seen = new Set<string>();
    let changed = 0;
    let removed = 0;
    for (const path of listed) {
      renew();
      const info = await stat(join(root, path)).catch(() => null);
      if (!info?.isFile()) continue;
      seen.add(path);
      const before = known.get(path);
      const state = { size: info.size, mtime: Math.round(info.mtimeMs), skipped: '' as string };
      if (!rebuild && before && before.size === state.size && before.mtime === state.mtime) continue;
      changed++;
      state.skipped = skipReason(path, info.size);
      let entry: FileEntry | undefined;
      if (!state.skipped) {
        const raw = await readFile(join(root, path), 'utf8').catch(() => null);
        const text = raw === null ? '' : redact(raw).text;
        if (raw === null) state.skipped = 'unreadable';
        else if (!looksWritten(text)) state.skipped = 'minified';
        else entry = await entryOf(path, text);
      }
      store.transaction(() => store.putFile(tree, path, state, entry));
    }
    // Gone: every known file no longer listed (a full look), or the candidates that are not there any more.
    for (const path of full ? known.keys() : listed) {
      if (seen.has(path) || !known.has(path)) continue;
      store.transaction(() => store.removeFile(tree, path));
      removed++;
    }
    if (changed || removed) store.prune();
    if (rebuild) store.setMeta(`rules:${tree}`, RULES);
    store.setMeta(`head:${tree}`, head);
    store.setMeta(`dirty:${tree}`, JSON.stringify(dirty));
    if (changed || removed) store.checkpoint();
    const stats = store.stats(tree, model);
    return { files: stats.files, changed, removed, chunks: stats.chunks, missing: model ? store.missing(tree, model).length : 0, ms: Date.now() - t0, full };
  });
}

export interface Doc { id: string; text: string }

/** The same for texts that are not files (the topics' memory, the posts' notes): each is a document named by its id. */
export async function syncDocs(store: SearchStore, tree: string, docs: Doc[]): Promise<void> {
  const states = docs.map((doc) => {
    const text = redact(doc.text).text;
    return { id: doc.id, text, state: { size: text.length, mtime: Number.parseInt(hashOf(text).slice(0, 12), 16), skipped: '' } };
  });
  const same = (known: Map<string, FileState>, s: (typeof states)[number]) => known.get(s.id)?.size === s.state.size && known.get(s.id)?.mtime === s.state.mtime;
  // Nothing changed, as for most searches: nothing to write, no claim to take.
  const before = store.files(tree);
  if (before.size === states.length && states.every((s) => same(before, s))) return;
  await exclusive(store, async () => {
    const known = store.files(tree);
    for (const s of states) {
      if (same(known, s)) continue;
      const { chunks } = await cutFile(`${s.id}.md`, s.text);
      store.transaction(() => store.putFile(tree, s.id, s.state, { chunks: chunks.map((c) => ({ ...c, hash: hashOf(embedText(s.id, c).slice(0, EMBED_CHARS)) })), symbols: [], imports: [] }));
    }
    const seen = new Set(states.map((s) => s.id));
    for (const id of known.keys()) if (!seen.has(id)) store.transaction(() => store.removeFile(tree, id));
  });
}

/**
 * Computes the vectors a checkout lacks for this model, and only those: a chunk whose text did not change keeps its
 * vector, whatever moved around it. Stored batch by batch, so an interrupted run resumes where it stopped. `root`
 * is the checkout, read again for what a chunk imports.
 */
export async function syncVectors(
  store: SearchStore,
  tree: string,
  model: string,
  embed: (texts: string[]) => Promise<Float32Array[]>,
  { root, passage = '', onProgress, bare = false }: { root: string; passage?: string; onProgress?: (p: SyncProgress) => void; /** Only the code, without its path, its name or what it uses: to measure what that context is worth. */ bare?: boolean },
): Promise<number> {
  const files = new Map<string, ImportRef[]>();
  const texts: { hash: string; text: string }[] = [];
  for (const m of store.missing(tree, model)) {
    const c = store.chunk(m.id);
    if (!c) continue;
    let imports = files.get(c.path);
    if (imports === undefined) files.set(c.path, (imports = importRefs(redact(await readFile(join(root, c.path), 'utf8').catch(() => '')).text)));
    texts.push({ hash: m.hash, text: bare ? c.text.slice(0, EMBED_CHARS) : modelText(c.path, imports, c) });
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
  if (done) store.checkpoint();
  return done;
}
