import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Chunk, SymbolDef } from './chunker';

export interface StoredChunk extends Chunk {
  id: number;
  path: string;
  /** Of the text given to the embedding model: two checkouts of a repo share the vectors of what they have in common. */
  hash: string;
}

export interface FileState { size: number; mtime: number; skipped: string }
/** What a file imports from one module. */
export interface ImportRef { source: string; names: string[] }
export interface StoredSymbol extends SymbolDef { path: string }
/** What goes into the index for one file. */
export interface FileEntry { chunks: (Chunk & { hash: string })[]; symbols: SymbolDef[]; imports: ImportRef[] }
/** Every vector of a checkout, in one block: `ids[i]` owns `data[i*dims …]`, each value a cosine part times 127. */
export interface VectorIndex { ids: Int32Array; data: Int8Array; dims: number }

const SCHEMA = 2;
const NOTHING: FileEntry = { chunks: [], symbols: [], imports: [] };

/** Identifiers cut at their capitals, so `hub tools` finds `hubTools`. Only the parts: the word itself is in the text. */
export function identifierParts(text: string): string {
  const parts = new Set<string>();
  for (const word of text.match(/[A-Za-z_$][A-Za-z0-9_$]{3,}/g) ?? []) {
    const cut = word.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/[\s_$]+/);
    if (cut.length > 1) for (const p of cut) if (p.length > 1) parts.add(p.toLowerCase());
  }
  return [...parts].join(' ');
}

/** The text a model reads for a chunk: where it is and what it is called, then the code. */
export function embedText(path: string, chunk: Pick<Chunk, 'symbol' | 'kind' | 'text'>, uses = ''): string {
  const title = chunk.kind === 'outline' ? `${path} (file outline)` : `${path}${chunk.symbol ? ` › ${chunk.symbol}` : ''}`;
  return `${title}\n${uses ? `uses: ${uses}\n` : ''}${chunk.text}`;
}

export const hashOf = (text: string): string => createHash('sha1').update(text).digest('hex');

/** The last part of a name, the one people ask for: `refund` of `Orders.refund`, `orders` of `public.orders`. */
export const leafOf = (name: string): string => name.split('.').pop() ?? name;

/** A unit vector on one byte per dimension: a quarter of the size, the same order of neighbours. */
export function quantize(vector: Float32Array): Int8Array {
  const out = new Int8Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = Math.max(-127, Math.min(127, Math.round(vector[i] * 127)));
  return out;
}

/**
 * The index of one repo and of its worktrees: files, chunks, defined names and imports per checkout (`tree`), a
 * full-text index for exact words, and the vectors, kept by text so a checkout only computes what it does not share
 * with the others.
 */
export class SearchStore {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();

  constructor(path: string, load: () => typeof import('node:sqlite') = () => createRequire(import.meta.url)('node:sqlite')) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new (load().DatabaseSync)(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=4000;');
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
    // An index is only a copy of the repo: another layout is built again, not migrated.
    if (version !== SCHEMA) {
      this.db.exec(`DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS fts; DROP TABLE IF EXISTS vectors; DROP TABLE IF EXISTS symbols; DROP TABLE IF EXISTS imports; DROP TABLE IF EXISTS meta;
        CREATE TABLE files(tree TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL, skipped TEXT NOT NULL, PRIMARY KEY(tree, path)) WITHOUT ROWID;
        CREATE TABLE chunks(id INTEGER PRIMARY KEY, tree TEXT NOT NULL, path TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, symbol TEXT NOT NULL, kind TEXT NOT NULL, hash TEXT NOT NULL);
        CREATE INDEX chunks_file ON chunks(tree, path);
        CREATE INDEX chunks_hash ON chunks(hash);
        CREATE VIRTUAL TABLE fts USING fts5(symbol, path, body, parts, tokenize="unicode61 remove_diacritics 2");
        CREATE TABLE vectors(hash TEXT NOT NULL, model TEXT NOT NULL, vec BLOB NOT NULL, PRIMARY KEY(hash, model)) WITHOUT ROWID;
        CREATE TABLE symbols(tree TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL, leaf TEXT NOT NULL COLLATE NOCASE, kind TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL);
        CREATE INDEX symbols_leaf ON symbols(tree, leaf);
        CREATE INDEX symbols_file ON symbols(tree, path);
        CREATE TABLE imports(tree TEXT NOT NULL, path TEXT NOT NULL, source TEXT NOT NULL, names TEXT NOT NULL);
        CREATE INDEX imports_file ON imports(tree, path);
        CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
        PRAGMA user_version=${SCHEMA};`);
    }
  }

  close(): void {
    this.statements.clear();
    this.db.close();
  }

  private sql(text: string): StatementSync {
    let s = this.statements.get(text);
    if (!s) this.statements.set(text, (s = this.db.prepare(text)));
    return s;
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Folds the write-ahead log back into the file: after an update, the index is one file of its real size. */
  checkpoint(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  meta(key: string): string {
    return String(this.sql('SELECT value FROM meta WHERE key=?').get(key)?.value ?? '');
  }

  setMeta(key: string, value: string): void {
    this.sql('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }

  files(tree: string): Map<string, FileState> {
    const out = new Map<string, FileState>();
    for (const r of this.sql('SELECT path, size, mtime, skipped FROM files WHERE tree=?').all(tree)) out.set(String(r.path), { size: Number(r.size), mtime: Number(r.mtime), skipped: String(r.skipped) });
    return out;
  }

  removeFile(tree: string, path: string): void {
    this.sql('DELETE FROM fts WHERE rowid IN (SELECT id FROM chunks WHERE tree=? AND path=?)').run(tree, path);
    for (const table of ['chunks', 'symbols', 'imports', 'files']) this.sql(`DELETE FROM ${table} WHERE tree=? AND path=?`).run(tree, path);
  }

  /** A file as it is now: what the index held of it goes, this takes its place. `skipped` says why it has nothing. */
  putFile(tree: string, path: string, state: FileState, entry: FileEntry = NOTHING): void {
    this.removeFile(tree, path);
    this.sql('INSERT INTO files(tree, path, size, mtime, skipped) VALUES(?, ?, ?, ?, ?)').run(tree, path, state.size, Math.round(state.mtime), state.skipped);
    for (const c of entry.chunks) {
      const { lastInsertRowid } = this.sql('INSERT INTO chunks(tree, path, start, end, symbol, kind, hash) VALUES(?, ?, ?, ?, ?, ?, ?)').run(tree, path, c.start, c.end, c.symbol, c.kind, c.hash);
      this.sql('INSERT INTO fts(rowid, symbol, path, body, parts) VALUES(?, ?, ?, ?, ?)').run(lastInsertRowid, c.symbol, path, c.text, identifierParts(`${c.symbol} ${c.text}`));
    }
    for (const s of entry.symbols) this.sql('INSERT INTO symbols(tree, path, name, leaf, kind, start, end) VALUES(?, ?, ?, ?, ?, ?, ?)').run(tree, path, s.name, leafOf(s.name), s.kind, s.start, s.end);
    for (const i of entry.imports) this.sql('INSERT INTO imports(tree, path, source, names) VALUES(?, ?, ?, ?)').run(tree, path, i.source, ` ${i.names.join(' ')} `);
  }

  /** Chunks of a checkout that have no vector for this model yet: the text to compute, once per distinct text. */
  missing(tree: string, model: string): { hash: string; id: number }[] {
    return this.sql('SELECT c.hash AS hash, MIN(c.id) AS id FROM chunks c WHERE c.tree=? AND NOT EXISTS (SELECT 1 FROM vectors v WHERE v.hash=c.hash AND v.model=?) GROUP BY c.hash')
      .all(tree, model)
      .map((r) => ({ hash: String(r.hash), id: Number(r.id) }));
  }

  putVector(hash: string, model: string, vector: Float32Array): void {
    const bytes = quantize(vector);
    this.sql('INSERT OR REPLACE INTO vectors(hash, model, vec) VALUES(?, ?, ?)').run(hash, model, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  }

  /** Vectors no chunk of any checkout uses any more. */
  prune(): void {
    this.db.exec('DELETE FROM vectors WHERE hash NOT IN (SELECT hash FROM chunks)');
  }

  chunk(id: number): StoredChunk | null {
    const r = this.sql('SELECT c.id, c.path, c.start, c.end, c.symbol, c.kind, c.hash, f.body FROM chunks c JOIN fts f ON f.rowid=c.id WHERE c.id=?').get(id);
    return r ? { id: Number(r.id), path: String(r.path), start: Number(r.start), end: Number(r.end), symbol: String(r.symbol), kind: r.kind as Chunk['kind'], hash: String(r.hash), text: String(r.body) } : null;
  }

  /** The piece that holds a line of a file: the smallest one, never the outline. */
  chunkAt(tree: string, path: string, line: number): StoredChunk | null {
    const r = this.sql("SELECT id FROM chunks WHERE tree=? AND path=? AND start<=? AND end>=? AND kind<>'outline' ORDER BY end-start LIMIT 1").get(tree, path, line, line);
    return r ? this.chunk(Number(r.id)) : null;
  }

  vectors(tree: string, model: string): VectorIndex {
    const rows = this.sql('SELECT c.id AS id, v.vec AS vec FROM chunks c JOIN vectors v ON v.hash=c.hash AND v.model=? WHERE c.tree=?').all(model, tree);
    const dims = rows.length ? (rows[0].vec as Uint8Array).byteLength : 0;
    const ids = new Int32Array(rows.length);
    const data = new Int8Array(rows.length * dims);
    rows.forEach((r, i) => {
      ids[i] = Number(r.id);
      const blob = r.vec as Uint8Array;
      data.set(new Int8Array(blob.buffer, blob.byteOffset, blob.byteLength), i * dims);
    });
    return { ids, data, dims };
  }

  private match(tree: string, match: string, limit: number, under: string): number[] {
    if (!match) return [];
    try {
      return this.sql(`SELECT c.id AS id FROM fts JOIN chunks c ON c.id=fts.rowid WHERE fts MATCH ? AND c.tree=? AND c.path LIKE ? ESCAPE '\\' ORDER BY bm25(fts, 6.0, 3.0, 1.0, 0.6) LIMIT ?`)
        .all(match, tree, `${under.replace(/[\\%_]/g, '\\$&')}%`, limit)
        .map((r) => Number(r.id));
    } catch {
      return []; // a query FTS5 cannot read finds nothing by words; the other searches still answer
    }
  }

  /** Best chunks for exact words, by BM25: a symbol counts more than a path, a path more than the body. */
  lexical(tree: string, match: string, limit: number, under = ''): number[] {
    return this.match(tree, match, limit, under);
  }

  /** Chunks where these words stand together, in this order: where a name is used. */
  phrase(tree: string, words: string, limit: number): number[] {
    const clean = words.replace(/["*^:(){}]/g, ' ').trim();
    return clean ? this.match(tree, `body: "${clean}"`, limit, '') : [];
  }

  /**
   * Where a name is defined. `refund` finds every `….refund`; a qualified name (`Orders.refund`, `public.orders`)
   * only what ends with it, so a namesake in another class or schema is not given for it.
   */
  definitions(tree: string, name: string, limit = 20): StoredSymbol[] {
    const leaf = leafOf(name);
    const wanted = name.toLowerCase();
    return this.sql('SELECT path, name, kind, start, end FROM symbols WHERE tree=? AND leaf=? ORDER BY (name=?) DESC, path DESC LIMIT ?')
      .all(tree, leaf, name, limit * 4)
      .map((r) => ({ path: String(r.path), name: String(r.name), kind: String(r.kind), start: Number(r.start), end: Number(r.end) }))
      .filter((s) => !name.includes('.') || s.name.toLowerCase() === wanted || s.name.toLowerCase().endsWith(`.${wanted}`))
      .slice(0, limit);
  }

  /** Files that import this name, by the name itself: one hop from a definition to its users. */
  importers(tree: string, name: string, limit = 8): string[] {
    // `instr`, not LIKE: a name is the same name only in the same case.
    return this.sql('SELECT DISTINCT path FROM imports WHERE tree=? AND instr(names, ?) > 0 LIMIT ?')
      .all(tree, ` ${leafOf(name)} `, limit)
      .map((r) => String(r.path));
  }

  /** Chunks of the files whose path holds this fragment: the shortest path first, its outline, then the file from its top. */
  byPath(tree: string, fragment: string, limit: number): number[] {
    return this.sql("SELECT id FROM chunks WHERE tree=? AND path LIKE ? ESCAPE '\\' ORDER BY length(path), (kind='outline') DESC, start LIMIT ?")
      .all(tree, `%${fragment.replace(/[\\%_]/g, '\\$&')}%`, limit)
      .map((r) => Number(r.id));
  }

  /** Every chunk's file, in one read. */
  paths(tree: string): Map<number, string> {
    const out = new Map<number, string>();
    for (const r of this.sql('SELECT id, path FROM chunks WHERE tree=?').all(tree)) out.set(Number(r.id), String(r.path));
    return out;
  }

  stats(tree: string, model: string): { files: number; skipped: number; chunks: number; vectors: number } {
    const n = (text: string, ...args: string[]) => Number(Object.values(this.sql(text).get(...args) ?? { n: 0 })[0]);
    return {
      files: n("SELECT COUNT(*) FROM files WHERE tree=? AND skipped=''", tree),
      skipped: n("SELECT COUNT(*) FROM files WHERE tree=? AND skipped<>''", tree),
      chunks: n('SELECT COUNT(*) FROM chunks WHERE tree=?', tree),
      vectors: n('SELECT COUNT(*) FROM chunks c WHERE c.tree=? AND EXISTS (SELECT 1 FROM vectors v WHERE v.hash=c.hash AND v.model=?)', tree, model),
    };
  }

  /** The checkouts this index knows. */
  trees(): string[] {
    return this.sql('SELECT DISTINCT tree FROM files').all().map((r) => String(r.tree));
  }

  dropTree(tree: string): void {
    this.transaction(() => {
      this.sql('DELETE FROM fts WHERE rowid IN (SELECT id FROM chunks WHERE tree=?)').run(tree);
      for (const table of ['chunks', 'symbols', 'imports', 'files']) this.sql(`DELETE FROM ${table} WHERE tree=?`).run(tree);
      // With it goes what was remembered of its last look: a checkout that comes back at the same place starts anew.
      for (const key of ['head', 'dirty', 'rules']) this.sql('DELETE FROM meta WHERE key=?').run(`${key}:${tree}`);
    });
  }
}
