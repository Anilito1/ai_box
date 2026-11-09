import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface Provenance { actor: string; source: string; anonymized: true }
export interface Decision { id: string; text: string; provenance: Provenance; at: number; supersedes?: string }
export interface TopicState {
  topic: string; objective: string; summary: string; decisions: Decision[]; constraints: string[];
  tasks: string[]; blockers: string[]; artifacts: string[]; nextStep: string;
  version: number; summaryVersion: number; createdAt: number; updatedAt: number; provenance: Provenance;
}
export interface MemoryLimits { warning: number; compact: number; hard: number; summaryTokens: number; packetTokens: number; recentMessages: number }
const DEFAULTS: MemoryLimits = { warning: 8000, compact: 12000, hard: 16000, summaryTokens: 1600, packetTokens: 4000, recentMessages: 4 };
// Conservative UTF-8 estimate, including non-Latin text. This is a budget, not provider token accounting.
export const estimateTokens = (value: unknown): number => Math.ceil(Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8') / 3);
export const cleanId = (s: string) => { if (!/^[a-zA-Z0-9:_./-]{1,160}$/.test(s)) throw new Error('Invalid memory identifier'); return s; };
export function check(value: unknown, provenance: Provenance): void {
  if (provenance.anonymized !== true || !provenance.actor || !provenance.source) throw new Error('Anonymized content and provenance required');
  const raw = JSON.stringify({ value, provenance });
  if (Buffer.byteLength(raw) > 48_000) throw new Error('Memory entry too large');
  if (/-----BEGIN .*PRIVATE KEY|\bBearer\s+[\w.-]+|\bsk-[\w-]{12,}|[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(raw)) throw new Error('Sensitive content rejected; anonymize before storing');
}

/** Local, topic-scoped short memory. No transcript ingestion, no network, no renderer dependency. */
export class TopicMemory {
  private db: DatabaseSync | null = null;
  readonly limits: MemoryLimits;
  readonly status: { mode: 'sqlite' | 'unavailable'; reason?: string };
  constructor(path: string, limits: Partial<MemoryLimits> = {}, load: () => typeof import('node:sqlite') = () => createRequire(import.meta.url)('node:sqlite')) {
    this.limits = { ...DEFAULTS, ...limits };
    if (Object.values(this.limits).some(n => !Number.isSafeInteger(n) || n < 1) || !(this.limits.warning < this.limits.compact && this.limits.compact < this.limits.hard) || this.limits.summaryTokens > 2000 || this.limits.packetTokens < 512) throw new Error('Invalid context memory limits');
    try {
      if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      this.db = new (load().DatabaseSync)(path);
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2000;');
      const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
      if (version > 1) throw new Error('Unsupported memory schema');
      this.db.exec(`BEGIN;
        CREATE TABLE IF NOT EXISTS states(topic TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(topic,version));
        CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY, topic TEXT NOT NULL, body TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS messages_topic ON messages(topic,seq);
        CREATE TABLE IF NOT EXISTS handoffs(topic TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(topic,version));
        PRAGMA user_version=1; COMMIT;`);
      this.status = { mode: 'sqlite' };
    } catch {
      try { this.db?.close(); } catch { /* preserve original database */ }
      this.db = null;
      this.status = { mode: 'unavailable', reason: 'Local memory unavailable (SQLite missing, database unreadable or unsupported). Existing data preserved.' };
    }
  }
  close(): void { this.db?.close(); this.db = null; }
  protected database(): DatabaseSync { if (!this.db) throw new Error(this.status.reason ?? 'Memory closed'); return this.db; }
  private transaction<T>(fn: () => T): T {
    const db = this.database(); db.exec('BEGIN IMMEDIATE');
    try { const out = fn(); db.exec('COMMIT'); return out; } catch (err) { db.exec('ROLLBACK'); throw err; }
  }
  get(topic: string): TopicState | null {
    const row = this.database().prepare('SELECT body FROM states WHERE topic=? ORDER BY version DESC LIMIT 1').get(cleanId(topic));
    return row ? JSON.parse(String(row.body)) : null;
  }
  history(topic: string, limit = 10): TopicState[] {
    return this.database().prepare('SELECT body FROM states WHERE topic=? ORDER BY version DESC LIMIT ?').all(cleanId(topic), Math.min(50, Math.max(1, limit))).map(r => JSON.parse(String(r.body)));
  }
  update(topic: string, patch: Partial<Pick<TopicState, 'objective' | 'summary' | 'constraints' | 'tasks' | 'blockers' | 'artifacts' | 'nextStep'>>, provenance: Provenance, expectedVersion: number): TopicState {
    check(patch, provenance);
    const allowed = ['objective', 'summary', 'constraints', 'tasks', 'blockers', 'artifacts', 'nextStep'];
    if (Object.keys(patch).some(key => !allowed.includes(key))) throw new Error('Unsupported state field; decisions require append-only API');
    for (const [key, value] of Object.entries(patch)) {
      const list = ['constraints', 'tasks', 'blockers', 'artifacts'].includes(key);
      if (list ? !Array.isArray(value) || value.length > 30 || value.some(v => typeof v !== 'string') : typeof value !== 'string') throw new Error('Invalid state field');
    }
    return this.transaction(() => this.writeState(topic, patch, provenance, expectedVersion));
  }
  private writeState(topic: string, patch: Partial<TopicState>, provenance: Provenance, expectedVersion: number): TopicState {
    const old = this.get(topic), now = Date.now();
    if ((old?.version ?? 0) !== expectedVersion) throw new Error('Memory version conflict; retrieve latest state');
    const state: TopicState = { objective: '', summary: '', decisions: [], constraints: [], tasks: [], blockers: [], artifacts: [], nextStep: '', summaryVersion: 0, createdAt: now, ...old, ...patch, topic, version: expectedVersion + 1, updatedAt: now, provenance };
    if (estimateTokens(state.summary) > this.limits.summaryTokens) throw new Error('Summary exceeds budget; shorten explicitly');
    if (estimateTokens(state) > Math.min(this.limits.packetTokens, this.limits.compact) - 256) throw new Error('Structured state exceeds packet budget; resolve tasks or compact constraints (decisions retained)');
    this.database().prepare('INSERT INTO states VALUES(?,?,?)').run(topic, state.version, JSON.stringify(state));
    return state;
  }
  decision(topic: string, text: string, provenance: Provenance, expectedVersion: number, supersedes?: string): TopicState {
    check(text, provenance);
    return this.transaction(() => {
      const state = this.get(topic);
      if (!state) throw new Error('Unknown topic');
      if (supersedes && !state.decisions.some(d => d.id === supersedes)) throw new Error('Unknown superseded decision');
      const decision: Decision = { id: randomUUID(), text, provenance, at: Date.now(), ...(supersedes ? { supersedes } : {}) };
      const next = this.writeState(topic, { decisions: [...state.decisions, decision] }, provenance, expectedVersion);
      return next;
    });
  }
  pressure(topic: string): { tokens: number; level: 'normal' | 'warning' | 'compact' | 'hard' } {
    let tokens = estimateTokens(this.get(topic) ?? {});
    for (const row of this.database().prepare('SELECT body FROM messages WHERE topic=?').all(topic)) tokens += estimateTokens(String(row.body));
    return { tokens, level: tokens >= this.limits.hard ? 'hard' : tokens >= this.limits.compact ? 'compact' : tokens >= this.limits.warning ? 'warning' : 'normal' };
  }
  remember(topic: string, text: string, provenance: Provenance): ReturnType<TopicMemory['pressure']> {
    check(text, provenance);
    return this.transaction(() => {
      if (!this.get(topic)) throw new Error('Unknown topic');
      const body = JSON.stringify({ text, provenance, at: Date.now() });
      if (this.pressure(topic).tokens + estimateTokens(body) >= this.limits.hard) throw new Error('Context hard limit: compact before adding more memory');
      this.database().prepare('INSERT INTO messages(topic,body) VALUES(?,?)').run(topic, body);
      return this.pressure(topic);
    });
  }
  compact(topic: string, summary: string, provenance: Provenance, expectedVersion: number): { state: TopicState; beforeTokens: number; afterTokens: number } {
    check(summary, provenance); if (!summary.trim()) throw new Error('A useful handoff summary is required');
    return this.transaction(() => {
      const beforeTokens = this.pressure(topic).tokens, old = this.get(topic);
      if (!old) throw new Error('Unknown topic');
      const state = this.writeState(topic, { summary, summaryVersion: old.summaryVersion + 1 }, provenance, expectedVersion);
      const db = this.database();
      db.prepare('INSERT INTO handoffs VALUES(?,?,?)').run(topic, state.summaryVersion, JSON.stringify({ state, beforeTokens, at: Date.now() }));
      db.prepare('DELETE FROM messages WHERE topic=? AND seq NOT IN (SELECT seq FROM messages WHERE topic=? ORDER BY seq DESC LIMIT ?)').run(topic, topic, this.limits.recentMessages);
      // Large recent messages may still exceed the target. Their state is now in the explicit handoff.
      while (this.pressure(topic).tokens >= this.limits.compact) db.prepare('DELETE FROM messages WHERE seq=(SELECT seq FROM messages WHERE topic=? ORDER BY seq LIMIT 1)').run(topic);
      return { state, beforeTokens, afterTokens: this.pressure(topic).tokens };
    });
  }
  packet(topic: string): { state: TopicState; recent: unknown[]; estimatedTokens: number; truncated: boolean } {
    const state = this.get(topic); if (!state) throw new Error('Unknown topic');
    const recent = this.database().prepare('SELECT body FROM messages WHERE topic=? ORDER BY seq DESC LIMIT ?').all(topic, this.limits.recentMessages).reverse().map(r => JSON.parse(String(r.body)));
    const result = { state, recent, estimatedTokens: 0, truncated: false };
    while (estimateTokens(result) > this.limits.packetTokens) {
      result.truncated = true;
      if (recent.length) recent.shift();
      else throw new Error('State exceeds context packet budget');
    }
    result.estimatedTokens = estimateTokens(result) + 4; return result;
  }
}
