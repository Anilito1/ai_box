import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Chunk } from './chunker';

export interface StoredChunk extends Chunk {
  id: number;
  path: string;
  /** Of the text given to the embedding model: two checkouts of a repo share the vectors of what they have in common. */
  hash: string;
}

export interface FileState { size: number; mtime: number; skipped: string }

const SCHEMA = 1;

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

/**
 * The index of one repo and of its worktrees: files and chunks per checkout (`tree`), a full-text index for exact
 * names, and the vectors, kept by text so a checkout only computes what it does not share with the others.
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
      this.db.exec(`DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS fts; DROP TABLE IF EXISTS vectors; DROP TABLE IF EXISTS meta;
        CREATE TABLE files(tree TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL, skipped TEXT NOT NULL, PRIMARY KEY(tree, path)) WITHOUT ROWID;
        CREATE TABLE chunks(id INTEGER PRIMARY KEY, tree TEXT NOT NULL, path TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, symbol TEXT NOT NULL, kind TEXT NOT NULL, hash TEXT NOT NULL);
        CREATE INDEX chunks_file ON chunks(tree, path);
        CREATE INDEX chunks_hash ON chunks(hash);
        CREATE VIRTUAL TABLE fts USING fts5(symbol, path, body, parts, tokenize="unicode61 remove_diacritics 2");
        CREATE TABLE vectors(hash TEXT NOT NULL, model TEXT NOT NULL, vec BLOB NOT NULL, PRIMARY KEY(hash, model)) WITHOUT ROWID;
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
    this.sql('DELETE FROM chunks WHERE tree=? AND path=?').run(tree, path);
    this.sql('DELETE FROM files WHERE tree=? AND path=?').run(tree, path);
  }

  /** A file as it is now: its former chunks go, these take their place. `skipped` says why it has none. */
  putFile(tree: string, path: string, state: FileState, chunks: (Chunk & { hash: string })[]): void {
    this.removeFile(tree, path);
    this.sql('INSERT INTO files(tree, path, size, mtime, skipped) VALUES(?, ?, ?, ?, ?)').run(tree, path, state.size, Math.round(state.mtime), state.skipped);
    for (const c of chunks) {
      const { lastInsertRowid } = this.sql('INSERT INTO chunks(tree, path, start, end, symbol, kind, hash) VALUES(?, ?, ?, ?, ?, ?, ?)').run(tree, path, c.start, c.end, c.symbol, c.kind, c.hash);
      this.sql('INSERT INTO fts(rowid, symbol, path, body, parts) VALUES(?, ?, ?, ?, ?)').run(lastInsertRowid, c.symbol, path, c.text, identifierParts(`${c.symbol} ${c.text}`));
    }
  }

  /** Chunks of a checkout that have no vector for this model yet: the text to compute, once per distinct text. */
  missing(tree: string, model: string): { hash: string; id: number }[] {
    return this.sql('SELECT c.hash AS hash, MIN(c.id) AS id FROM chunks c WHERE c.tree=? AND NOT EXISTS (SELECT 1 FROM vectors v WHERE v.hash=c.hash AND v.model=?) GROUP BY c.hash')
      .all(tree, model)
      .map((r) => ({ hash: String(r.hash), id: Number(r.id) }));
  }

  putVector(hash: string, model: string, vec: Float32Array): void {
    this.sql('INSERT OR REPLACE INTO vectors(hash, model, vec) VALUES(?, ?, ?)').run(hash, model, new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength));
  }

  /** Vectors no chunk of any checkout uses any more. */
  prune(): void {
    this.db.exec('DELETE FROM vectors WHERE hash NOT IN (SELECT hash FROM chunks)');
  }

  chunk(id: number): StoredChunk | null {
    const r = this.sql('SELECT c.id, c.path, c.start, c.end, c.symbol, c.kind, c.hash, f.body FROM chunks c JOIN fts f ON f.rowid=c.id WHERE c.id=?').get(id);
    return r ? { id: Number(r.id), path: String(r.path), start: Number(r.start), end: Number(r.end), symbol: String(r.symbol), kind: r.kind as Chunk['kind'], hash: String(r.hash), text: String(r.body) } : null;
  }

  /** Every vector of a checkout for a model, in one block: `ids[i]` owns `data[i*dims …]`. */
  vectors(tree: string, model: string): { ids: Int32Array; data: Float32Array; dims: number } {
    const rows = this.sql('SELECT c.id AS id, v.vec AS vec FROM chunks c JOIN vectors v ON v.hash=c.hash AND v.model=? WHERE c.tree=?').all(model, tree);
    const dims = rows.length ? (rows[0].vec as Uint8Array).byteLength / 4 : 0;
    const ids = new Int32Array(rows.length);
    const data = new Float32Array(rows.length * dims);
    rows.forEach((r, i) => {
      ids[i] = Number(r.id);
      const blob = r.vec as Uint8Array;
      data.set(new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength)), i * dims);
    });
    return { ids, data, dims };
  }

  /** Best chunks for exact words, by BM25: a symbol counts more than a path, a path more than the body. */
  lexical(tree: string, match: string, limit: number, under = ''): number[] {
    if (!match) return [];
    try {
      return this.sql(`SELECT c.id AS id FROM fts JOIN chunks c ON c.id=fts.rowid WHERE fts MATCH ? AND c.tree=? AND c.path LIKE ? ESCAPE '\\' ORDER BY bm25(fts, 6.0, 3.0, 1.0, 0.6) LIMIT ?`)
        .all(match, tree, `${under.replace(/[\\%_]/g, '\\$&')}%`, limit)
        .map((r) => Number(r.id));
    } catch {
      return []; // a query FTS5 cannot read finds nothing by words; the vectors still answer
    }
  }

  paths(tree: string, ids: Iterable<number>): Map<number, string> {
    const out = new Map<number, string>();
    for (const id of ids) {
      const r = this.sql('SELECT path FROM chunks WHERE id=? AND tree=?').get(id, tree);
      if (r) out.set(id, String(r.path));
    }
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
      this.sql('DELETE FROM chunks WHERE tree=?').run(tree);
      this.sql('DELETE FROM files WHERE tree=?').run(tree);
    });
  }
}
