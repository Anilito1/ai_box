import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { hash, type SourceItem, type Publication } from './model';

/** Dedicated directory only. SQLite transactions + FULL fsync; one writer, independent readers. */
export class LocalStore {
  private db: DatabaseSync;
  constructor(private path: string, private maxBytes = 32_000_000) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, expires INTEGER, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS publications(key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS control(id TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT OR IGNORE INTO control VALUES('kill',0);`);
    try { this.transaction(() => {
      const owner = Number(this.db.prepare("SELECT value FROM control WHERE id='owner'").get()?.value ?? 0);
      if (owner) {
        let alive = true;
        try { process.kill(owner, 0); } catch (e) { alive = (e as NodeJS.ErrnoException).code !== 'ESRCH'; }
        if (alive) throw new Error('BLOCKED_STORE_IN_USE');
      }
      this.db.prepare("INSERT OR REPLACE INTO control VALUES('owner',?)").run(process.pid);
    }); } catch (e) { this.db.close(); throw e; }
    // A crash during submit is ambiguous, never automatically retried.
    this.transaction(() => { for (const p of this.publications()) if (p.state === 'SUBMITTING') this.savePublication({ ...p, state: 'UNKNOWN', reason: 'CRASH_DURING_SUBMIT' }); });
  }
  close(): void { this.db.prepare("DELETE FROM control WHERE id='owner'").run(); this.db.close(); }
  transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  private capacity(data: string): void { if (statSync(this.path).size + Buffer.byteLength(data) > this.maxBytes) throw new Error('BLOCKED_STORAGE_BUDGET'); }
  put(kind: string, id: string, value: unknown, expires: number | null = null): void {
    const data = JSON.stringify(value); this.capacity(data);
    this.db.prepare('INSERT OR REPLACE INTO records VALUES(?,?,?,?)').run(kind, id, data, expires);
  }
  get<T>(kind: string, id: string): T | undefined { const r = this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind, id); return r ? JSON.parse(String(r.data)) as T : undefined; }
  ingest(item: SourceItem): boolean {
    if (this.get('item', item.id) || this.get('dedup', hash(item.title.trim().toLowerCase().replace(/\s+/g, ' ')) + item.sourceId)) return false;
    this.put('item', item.id, item, item.expiresAt);
    this.put('dedup', hash(item.title.trim().toLowerCase().replace(/\s+/g, ' ')) + item.sourceId, true, item.expiresAt);
    return true;
  }
  prune(now: number): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM records WHERE expires IS NOT NULL AND expires<=?').run(now);
      for (const p of this.publications()) if (p.draft.expiresAt <= now) {
        const draft = { ...p.draft, text: '', altText: '', urls: [], claimIds: [] };
        this.savePublication({ ...p, draft, state: ['PUBLISHED', 'UNKNOWN'].includes(p.state) ? p.state : 'BLOCKED', reason: 'EXPIRED_CONTENT_PURGED' });
      }
    });
  }
  killed(): boolean { return this.db.prepare("SELECT value FROM control WHERE id='kill'").get()!.value === 1; }
  kill(value: boolean): void { this.db.prepare("UPDATE control SET value=? WHERE id='kill'").run(value ? 1 : 0); }
  spend(bucket: string, limit: number): boolean {
    const n = this.get<number>('budget', bucket) ?? 0;
    if (n >= limit) return false;
    this.put('budget', bucket, n + 1); return true;
  }
  enqueue(p: Publication): boolean {
    const data = JSON.stringify(p); this.capacity(data);
    return this.db.prepare('INSERT OR IGNORE INTO publications VALUES(?,?)').run(p.key, data).changes === 1;
  }
  publication(key: string): Publication | undefined { const r = this.db.prepare('SELECT data FROM publications WHERE key=?').get(key); return r ? JSON.parse(String(r.data)) as Publication : undefined; }
  publications(): Publication[] { return this.db.prepare('SELECT data FROM publications').all().map(r => JSON.parse(String(r.data)) as Publication); }
  savePublication(p: Publication): void { const data = JSON.stringify(p); this.capacity(data); this.db.prepare('UPDATE publications SET data=? WHERE key=?').run(data, p.key); }
}
