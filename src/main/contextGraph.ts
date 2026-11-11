/** Optional local storage. Importing this module never opens a database or loads SQLite. */
import { isAbsolute, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, realpathSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { ContextGraphSettings, ContextGraphStatus, ContextGraphExport, ContextGraphMetadata, ContextGraphProvenance, ContextGraphNodeKind, ContextGraphRelation, ContextGraphNode, ContextGraphEdge, ContextGraphSnapshot } from '../shared/contextGraph';
import type { TopicState } from './topicMemory';

type Sqlite = Pick<typeof import('node:sqlite'), 'DatabaseSync'>;
export type NodeKind = ContextGraphNodeKind;
export type Relation = ContextGraphRelation;
export type Provenance = ContextGraphProvenance;
export type Metadata = ContextGraphMetadata;
export interface NodeInput { topicId: string; id: string; kind: NodeKind; metadata?: Metadata; provenance: Provenance }
export interface EdgeInput { topicId: string; from: string; to: string; relation: Relation; metadata?: Metadata; provenance: Provenance }
export type GraphNode = ContextGraphNode;
export type GraphEdge = ContextGraphEdge;
export type Snapshot = ContextGraphSnapshot;
export type GraphStatus = 'ready' | 'disabled' | 'sqlite-unavailable' | 'storage-error' | 'unsupported-schema' | 'closed';
export interface GraphOptions {
  /** Explicit opt-in; no default application data path. Parent directory must exist. */
  enabled?: boolean;
  path?: string;
  /** Dependency injection for hosts without node:sqlite and isolated tests. */
  loadSqlite?: () => Promise<Sqlite>;
}
const pairs: Record<Relation, [NodeKind, NodeKind]> = {
  'topic-worker': ['topic', 'worker'], 'topic-task': ['topic', 'task'],
  'worker-artifact': ['worker', 'artifact'], 'artifact-test': ['artifact', 'test'],
  'decision-topic': ['decision', 'topic'], 'artifact-source': ['artifact', 'source'], 'branch-commit': ['branch', 'commit'], 'topic-artifact': ['topic', 'artifact'], 'topic-handoff': ['topic', 'handoff'],
};
const kinds = new Set(Object.values(pairs).flat());
const MAX_NODES = 10_000;
const MAX_EDGES = 30_000;
function identifier(value: string): void {
  // Opaque references only. Block common credential formats even when syntactically IDs.
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/.test(value)
    || /(?:sk-|gh[pousr]_|github_pat_|AKIA|eyJ|bearer|password|secret|token)/i.test(value)) throw new Error('Invalid opaque graph identifier');
}
function payload(metadata: Metadata = {}, provenance: Provenance): [string, string] {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
    || Object.keys(metadata).some(k => !['status', 'count', 'digest', 'confidence', 'sourceVersion'].includes(k))
    || (metadata.status !== undefined && !['pending', 'active', 'passed', 'failed', 'done'].includes(metadata.status))
    || (metadata.count !== undefined && (!Number.isSafeInteger(metadata.count) || metadata.count < 0))
    || (metadata.confidence !== undefined && (!Number.isFinite(metadata.confidence) || metadata.confidence < 0 || metadata.confidence > 1))
    || (metadata.sourceVersion !== undefined && (!Number.isSafeInteger(metadata.sourceVersion) || metadata.sourceVersion < 0))
    || (metadata.digest !== undefined && !/^[a-f0-9]{64}$/.test(metadata.digest))) throw new Error('Invalid graph metadata');
  if (!provenance || Object.keys(provenance).some(k => !['origin', 'reference'].includes(k))
    || !['user', 'worker', 'import', 'test'].includes(provenance.origin)) throw new Error('Invalid graph provenance');
  identifier(provenance.reference);
  // Stable serialization keeps upserts idempotent even if input keys are reordered.
  return [JSON.stringify({ status: metadata.status, count: metadata.count, digest: metadata.digest, confidence: metadata.confidence, sourceVersion: metadata.sourceVersion }),
    JSON.stringify({ origin: provenance.origin, reference: provenance.reference })];
}
type Row = Record<string, unknown>;
function decode(row: Row): GraphNode & GraphEdge {
  const { metadata, provenance, ...rest } = row;
  return { ...rest, metadata: JSON.parse(String(metadata)), provenance: JSON.parse(String(provenance)), archived: row.archived === 1 } as GraphNode & GraphEdge;
}

export class ContextGraph {
  private db?: DatabaseSync;
  private state: GraphStatus;
  private inTransaction = false;
  private constructor(status: GraphStatus, db?: DatabaseSync) { this.state = status; this.db = db; }
  get status(): GraphStatus { return this.state; }

  static async init(options: GraphOptions = {}): Promise<ContextGraph> {
    if (!options.enabled) return new ContextGraph('disabled');
    if (!options.path || (options.path !== ':memory:' && !isAbsolute(options.path))) return new ContextGraph('storage-error');
    let sqlite: Sqlite;
    try { sqlite = await (options.loadSqlite ?? (() => import('node:sqlite')))(); }
    catch { return new ContextGraph('sqlite-unavailable'); }
    let db: DatabaseSync | undefined;
    try {
      db = new sqlite.DatabaseSync(options.path);
      db.exec('PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;');
      const check = db.prepare('PRAGMA quick_check').get();
      if (!check || Object.values(check)[0] !== 'ok') throw new Error('Invalid database');
      const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
      if (version !== 0 && version !== 1) { db.close(); return new ContextGraph('unsupported-schema'); }
      // Never repurpose an unrelated database, even when it has user_version=0.
      if (version === 0 && Number(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()?.n) !== 0) throw new Error('Unrecognized database');
      const pageSize = Number(db.prepare('PRAGMA page_size').get()?.page_size);
      const maxPages = Math.floor(16 * 1024 * 1024 / pageSize);
      if (Number(db.prepare('PRAGMA page_count').get()?.page_count) > maxPages) throw new Error('Graph quota exceeded');
      db.exec(`PRAGMA max_page_count=${maxPages};`);
      if (version === 0) db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE nodes (
          topicId TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('topic','worker','task','artifact','test','decision','source','branch','commit','handoff')),
          metadata TEXT NOT NULL CHECK(json_valid(metadata)), provenance TEXT NOT NULL CHECK(json_valid(provenance)),
          createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, version INTEGER NOT NULL,
          archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)), PRIMARY KEY(topicId,id));
        CREATE TABLE edges (
          topicId TEXT NOT NULL, "from" TEXT NOT NULL, "to" TEXT NOT NULL, relation TEXT NOT NULL CHECK(relation IN ('topic-worker','topic-task','worker-artifact','artifact-test','decision-topic','artifact-source','branch-commit','topic-artifact','topic-handoff')),
          metadata TEXT NOT NULL CHECK(json_valid(metadata)), provenance TEXT NOT NULL CHECK(json_valid(provenance)),
          createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, version INTEGER NOT NULL,
          archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)), PRIMARY KEY(topicId,"from","to",relation),
          FOREIGN KEY(topicId,"from") REFERENCES nodes(topicId,id) ON DELETE CASCADE,
          FOREIGN KEY(topicId,"to") REFERENCES nodes(topicId,id) ON DELETE CASCADE);
        CREATE INDEX edges_target ON edges(topicId,"to");
        PRAGMA user_version=1; COMMIT;`);
      // Fail closed on damaged/incompatible tables; do not delete or recreate a file.
      db.prepare('SELECT topicId,id,kind,metadata,provenance,createdAt,updatedAt,version,archived FROM nodes LIMIT 0').all();
      db.prepare('SELECT topicId,"from","to",relation,metadata,provenance,createdAt,updatedAt,version,archived FROM edges LIMIT 0').all();
      return new ContextGraph('ready', db);
    } catch { try { db?.close(); } catch { /* retain original degraded status */ } return new ContextGraph('storage-error'); }
  }

  upsertNode(input: NodeInput): boolean {
    if (!this.db) return false;
    identifier(input.topicId); identifier(input.id);
    if (!kinds.has(input.kind)) throw new Error('Invalid graph node kind');
    const [metadata, provenance] = payload(input.metadata, input.provenance);
    return this.write(() => {
      const old = this.db!.prepare('SELECT kind FROM nodes WHERE topicId=? AND id=?').get(input.topicId, input.id);
      if (old && old.kind !== input.kind) throw new Error('Node kind is immutable');
      if (!old) this.quota('nodes', MAX_NODES);
      const now = Date.now();
      return this.db!.prepare(`INSERT INTO nodes VALUES (?,?,?,?,?,?,?,1,0)
        ON CONFLICT(topicId,id) DO UPDATE SET metadata=excluded.metadata, provenance=excluded.provenance,
        updatedAt=excluded.updatedAt, version=nodes.version+1
        WHERE nodes.metadata<>excluded.metadata OR nodes.provenance<>excluded.provenance`)
        .run(input.topicId, input.id, input.kind, metadata, provenance, now, now).changes !== 0;
    });
  }

  upsertEdge(input: EdgeInput): boolean {
    if (!this.db) return false;
    identifier(input.topicId); identifier(input.from); identifier(input.to);
    if (!Object.hasOwn(pairs, input.relation)) throw new Error('Invalid graph relation');
    const [metadata, provenance] = payload(input.metadata, input.provenance);
    return this.write(() => {
      const expected = pairs[input.relation];
      for (const [id, kind] of [[input.from, expected[0]], [input.to, expected[1]]]) {
        const node = this.db!.prepare('SELECT kind,archived FROM nodes WHERE topicId=? AND id=?').get(input.topicId, id);
        if (!node || node.kind !== kind || node.archived) throw new Error('Missing or incompatible active endpoint');
      }
      const old = this.db!.prepare('SELECT 1 FROM edges WHERE topicId=? AND "from"=? AND "to"=? AND relation=?')
        .get(input.topicId, input.from, input.to, input.relation);
      if (!old) this.quota('edges', MAX_EDGES);
      const now = Date.now();
      return this.db!.prepare(`INSERT INTO edges VALUES (?,?,?,?,?,?,?,?,1,0)
        ON CONFLICT(topicId,"from","to",relation) DO UPDATE SET metadata=excluded.metadata, provenance=excluded.provenance,
        updatedAt=excluded.updatedAt, version=edges.version+1
        WHERE edges.metadata<>excluded.metadata OR edges.provenance<>excluded.provenance`)
        .run(input.topicId, input.from, input.to, input.relation, metadata, provenance, now, now).changes !== 0;
    });
  }

  neighbors(topicId: string, id: string, options: { direction?: 'in' | 'out' | 'both'; limit?: number } = {}): { nodes: GraphNode[]; edges: GraphEdge[] } {
    if (!this.db) return { nodes: [], edges: [] };
    identifier(topicId); identifier(id);
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid neighborhood limit');
    const direction = options.direction ?? 'both';
    if (!['in', 'out', 'both'].includes(direction)) throw new Error('Invalid direction');
    const clause = direction === 'in' ? 'e."to"=?' : direction === 'out' ? 'e."from"=?' : '(e."from"=? OR e."to"=?)';
    const rows = this.db.prepare(`SELECT e.* FROM edges e
      JOIN nodes a ON a.topicId=e.topicId AND a.id=e."from"
      JOIN nodes b ON b.topicId=e.topicId AND b.id=e."to"
      WHERE e.topicId=? AND ${clause} AND e.archived=0 AND a.archived=0 AND b.archived=0
      ORDER BY e."from",e."to",e.relation LIMIT ?`).all(...(direction === 'both' ? [topicId, id, id, limit] : [topicId, id, limit]));
    const edges = rows.map(decode);
    const ids = new Set(edges.map(e => e.from === id ? e.to : e.from));
    return { edges, nodes: [...ids].sort().map(key => decode(this.db!.prepare('SELECT * FROM nodes WHERE topicId=? AND id=?').get(topicId, key)!)) };
  }

  /** Explicit restore is required; upsert never silently restores archived records. */
  archiveNode(topicId: string, id: string, archived = true): boolean {
    if (!this.db) return false;
    identifier(topicId); identifier(id);
    return this.db.prepare('UPDATE nodes SET archived=?,version=version+1,updatedAt=? WHERE topicId=? AND id=? AND archived<>?')
      .run(Number(archived), Date.now(), topicId, id, Number(archived)).changes !== 0;
  }
  archiveEdge(input: Pick<EdgeInput, 'topicId' | 'from' | 'to' | 'relation'>, archived = true): boolean {
    if (!this.db) return false;
    identifier(input.topicId); identifier(input.from); identifier(input.to);
    if (!Object.hasOwn(pairs, input.relation)) throw new Error('Invalid graph relation');
    return this.db.prepare('UPDATE edges SET archived=?,version=version+1,updatedAt=? WHERE topicId=? AND "from"=? AND "to"=? AND relation=? AND archived<>?')
      .run(Number(archived), Date.now(), input.topicId, input.from, input.to, input.relation, Number(archived)).changes !== 0;
  }
  /** Only archived nodes can be purged; incident edges are deleted through foreign keys. */
  deleteNode(topicId: string, id: string, confirmation: 'delete-archived'): boolean {
    if (!this.db) return false;
    identifier(topicId); identifier(id);
    if (confirmation !== 'delete-archived') throw new Error('Deletion requires confirmation');
    return this.db.prepare('DELETE FROM nodes WHERE topicId=? AND id=? AND archived=1').run(topicId, id).changes !== 0;
  }
  exportSnapshot(topicId?: string): Snapshot {
    if (!this.db) return { schemaVersion: 1, nodes: [], edges: [] };
    if (topicId !== undefined) identifier(topicId);
    return this.write(() => ({ schemaVersion: 1,
      nodes: (topicId === undefined ? this.db!.prepare('SELECT * FROM nodes ORDER BY topicId,id').all() : this.db!.prepare('SELECT * FROM nodes WHERE topicId=? ORDER BY id').all(topicId)).map(decode),
      edges: (topicId === undefined ? this.db!.prepare('SELECT * FROM edges ORDER BY topicId,"from","to",relation').all() : this.db!.prepare('SELECT * FROM edges WHERE topicId=? ORDER BY "from","to",relation').all(topicId)).map(decode),
    }));
  }
  statistics(): Pick<ContextGraphStatus, 'counts' | 'lastProvenance'> {
    if (!this.db) return { counts: { nodes: 0, edges: 0, archivedNodes: 0, archivedEdges: 0 }, lastProvenance: null };
    const counts = (table: 'nodes' | 'edges') => this.db!.prepare(`SELECT count(*) AS n,coalesce(sum(archived),0) AS archived FROM ${table}`).get()!;
    const n = counts('nodes'), e = counts('edges');
    const last = this.db.prepare('SELECT provenance,updatedAt FROM (SELECT provenance,updatedAt FROM nodes UNION ALL SELECT provenance,updatedAt FROM edges) ORDER BY updatedAt DESC,provenance LIMIT 1').get();
    return { counts: { nodes: Number(n.n), edges: Number(e.n), archivedNodes: Number(n.archived), archivedEdges: Number(e.archived) },
      lastProvenance: last ? { ...JSON.parse(String(last.provenance)), at: Number(last.updatedAt) } : null };
  }
  /** Explicit destructive operation; repeated calls converge to an empty graph. */
  purge(): void { if (this.db) this.write(() => { this.db!.exec('DELETE FROM edges; DELETE FROM nodes;'); }); }
  /** Topic relevant, most recent first, stable ties; only edges whose endpoints fit the node budget. */
  retrieve(topicId: string, limit = 20): Snapshot {
    identifier(topicId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid retrieval limit');
    if (!this.db) return { schemaVersion: 1, nodes: [], edges: [] };
    const nodes = this.db.prepare("SELECT * FROM nodes WHERE topicId=? AND archived=0 ORDER BY (kind='topic') DESC,updatedAt DESC,id LIMIT ?").all(topicId, limit).map(decode);
    const ids = nodes.map(n => n.id);
    if (!ids.length) return { schemaVersion: 1, nodes: [], edges: [] };
    const slots = ids.map(() => '?').join(',');
    const edges = this.db.prepare(`SELECT * FROM edges WHERE topicId=? AND archived=0 AND "from" IN (${slots}) AND "to" IN (${slots}) ORDER BY updatedAt DESC,"from","to",relation LIMIT 100`).all(topicId, ...ids, ...ids).map(decode);
    return { schemaVersion: 1, nodes, edges };
  }
  close(): void { this.db?.close(); this.db = undefined; this.state = 'closed'; }
  private quota(table: 'nodes' | 'edges', max: number): void {
    if (Number(this.db!.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n) >= max) throw new Error('Graph quota exceeded');
  }
  batch(fn: (graph: ContextGraph) => void): void { if (this.db) this.write(() => fn(this)); }
  private write<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    this.db!.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try { const result = fn(); this.db!.exec('COMMIT'); return result; }
    catch (error) { this.db!.exec('ROLLBACK'); throw error; }
    finally { this.inTransaction = false; }
  }
}
export const init = ContextGraph.init;

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const opaque = (kind: string, value: string): string => `${kind}:${digest(value)}`;
export const GRAPH_LIMITS = { nodes: MAX_NODES, edges: MAX_EDGES, bytes: 16 * 1024 * 1024, retrievalNodes: 50, retrievalEdges: 100 };
export interface GraphScope { workspace: string; sessionId: string }
interface RuntimeOptions {
  dataDir: string;
  settings(): ContextGraphSettings;
  save(settings: ContextGraphSettings): void;
  loadSqlite?: GraphOptions['loadSqlite'];
}
/** Resolve against configured roots in main, including symlinks; renderer/tool input never supplies storage paths. */
export function graphWorkspace(cwd: string, roots: string[]): string | null {
  const canonical = (p: string): string | null => { try { return realpathSync(p); } catch { return null; } };
  const dir = canonical(cwd);
  if (!dir) return null;
  return roots.map(canonical).filter((root): root is string => root !== null).sort((a, b) => b.length - a.length).find(root => {
    const rel = relative(root, dir);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  }) ?? null;
}

/** Serializes toggles, writes and shutdown. Disabled startup never loads SQLite or creates directories. */
export class ContextGraphRuntime {
  private readonly graphs = new Map<string, ContextGraph>();
  private readonly errors = new Map<string, ContextGraphStatus['error']>();
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(private readonly options: RuntimeOptions) {}
  private ids(scope: GraphScope) { return { workspaceId: opaque('workspace', scope.workspace), sessionId: opaque('session', scope.sessionId) }; }
  private key(scope: GraphScope) { const ids = this.ids(scope); return `${ids.workspaceId}/${ids.sessionId}`; }
  private enabled(scope: GraphScope) {
    const settings = this.options.settings();
    return settings.enabled === true && settings.workspaces.includes(this.ids(scope).workspaceId);
  }
  private queue<T>(fn: () => T | Promise<T>): Promise<T> {
    const job = this.tail.then(fn); this.tail = job.catch(() => undefined); return job;
  }
  private async open(scope: GraphScope): Promise<ContextGraph> {
    const key = this.key(scope), old = this.graphs.get(key);
    if (old) return old;
    const ids = this.ids(scope);
    const dir = join(this.options.dataDir, 'context-graph', digest(ids.workspaceId));
    let graph: ContextGraph | undefined;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, `${digest(ids.sessionId)}.sqlite`);
      graph = await ContextGraph.init({ enabled: true, path, loadSqlite: this.options.loadSqlite });
      if (graph.status === 'ready') chmodSync(path, 0o600);
    } catch { try { graph?.close(); } catch { /* preserve degraded status */ } graph = await ContextGraph.init({ enabled: true }); }
    this.graphs.set(key, graph);
    if (graph.status !== 'ready') this.errors.set(key, graph.status as ContextGraphStatus['error']);
    return graph;
  }
  private describe(scope: GraphScope, graph?: ContextGraph): ContextGraphStatus {
    const enabled = this.enabled(scope), error = this.closed ? 'closed' : this.errors.get(this.key(scope)) ?? null;
    const statistics = graph?.statistics() ?? { counts: { nodes: 0, edges: 0, archivedNodes: 0, archivedEdges: 0 }, lastProvenance: null };
    return { ...this.ids(scope), enabled, state: error ? 'unavailable' : enabled ? 'enabled' : 'disabled',
      ...statistics, countsAvailable: graph?.status === 'ready', limits: { ...GRAPH_LIMITS }, error };
  }
  private async access<T>(scope: GraphScope, fallback: T, fn: (graph: ContextGraph) => T, explicit = false): Promise<T> {
    if (this.closed || (!this.enabled(scope) && !explicit)) return fallback;
    const graph = await this.open(scope);
    if (graph.status !== 'ready' || (this.errors.has(this.key(scope)) && !explicit)) return fallback;
    try { return fn(graph); }
    catch (error) {
      this.errors.set(this.key(scope), error instanceof Error && error.message === 'Graph quota exceeded' ? 'quota-exceeded' : 'storage-error');
      return fallback;
    } finally {
      if (!this.enabled(scope)) { graph.close(); this.graphs.delete(this.key(scope)); }
    }
  }
  status(scope: GraphScope): Promise<ContextGraphStatus> {
    return this.queue(async () => {
      await this.access(scope, undefined, () => undefined);
      try { return this.describe(scope, this.graphs.get(this.key(scope))); }
      catch { this.errors.set(this.key(scope), 'storage-error'); return this.describe(scope); }
    });
  }
  setEnabled(scope: GraphScope, enabled: boolean): Promise<ContextGraphStatus> {
    return this.queue(async () => {
      if (this.closed) return this.describe(scope);
      const id = this.ids(scope).workspaceId, settings = this.options.settings();
      const workspaces = [...new Set(settings.workspaces.filter(w => w !== id).concat(enabled ? [id] : []))];
      if (workspaces.length > 20) throw new Error('Workspace opt-in limit exceeded');
      try { this.options.save({ enabled: workspaces.length > 0, workspaces }); }
      catch { throw new Error('Unable to save graph setting'); }
      // A workspace toggle covers every session in that workspace, without touching other workspaces.
      for (const [key, graph] of this.graphs) if (key.startsWith(`${id}/`)) { graph.close(); this.graphs.delete(key); this.errors.delete(key); }
      this.errors.delete(this.key(scope));
      await this.access(scope, undefined, () => undefined);
      return this.describe(scope, this.graphs.get(this.key(scope)));
    });
  }
  exportSnapshot(scope: GraphScope): Promise<ContextGraphExport> {
    return this.queue(async () => {
      let status: ContextGraphStatus | undefined;
      const snapshot = await this.access(scope, { schemaVersion: 1 as const, nodes: [], edges: [] } as Snapshot, graph => {
        const snapshot = graph.exportSnapshot(); status = this.describe(scope, graph); return snapshot;
      }, true);
      return { status: status ?? this.describe(scope), snapshot };
    });
  }
  purge(scope: GraphScope): Promise<ContextGraphStatus> {
    return this.queue(async () => {
      let status: ContextGraphStatus | undefined;
      // Purge remains available while disabled; it never enables ingestion.
      await this.access(scope, undefined, graph => { graph.purge(); this.errors.delete(this.key(scope)); status = this.describe(scope, graph); }, true);
      return status ?? this.describe(scope);
    });
  }
  retrieve(scope: GraphScope, topic: string, limit = 20): Promise<Snapshot> {
    if (!Number.isInteger(limit) || limit < 1 || limit > GRAPH_LIMITS.retrievalNodes) return Promise.reject(new Error('Invalid retrieval limit'));
    return this.queue(() => this.access(scope, { schemaVersion: 1 as const, nodes: [], edges: [] }, graph => graph.retrieve(opaque('topic', topic), limit)));
  }
  /** Only metadata from an accepted structured memory operation. No text, paths, actor names or message bodies survive. */
  record(scope: GraphScope, state: TopicState, operation: 'update' | 'decision' | 'compact'): Promise<void> {
    return this.queue(async () => {
      await this.access(scope, undefined, graph => graph.batch(() => {
        const topicId = opaque('topic', state.topic), provenance: Provenance = { origin: 'worker', reference: opaque('source', state.provenance.source) };
        const metadata: Metadata = { sourceVersion: state.version, confidence: 1 };
        graph.upsertNode({ topicId, id: topicId, kind: 'topic', provenance, metadata });
        const worker = opaque('worker', scope.sessionId);
        graph.upsertNode({ topicId, id: worker, kind: 'worker', provenance, metadata });
        graph.upsertEdge({ topicId, from: topicId, to: worker, relation: 'topic-worker', provenance, metadata });
        const add = (kind: 'task' | 'artifact' | 'decision' | 'handoff', key: string, value: string, reference = provenance) => {
          const id = opaque(kind, key);
          graph.upsertNode({ topicId, id, kind, provenance: reference, metadata: { ...metadata, digest: digest(value) } });
          const relation = kind === 'decision' ? 'decision-topic' : `topic-${kind}` as Relation;
          graph.upsertEdge({ topicId, from: kind === 'decision' ? id : topicId, to: kind === 'decision' ? topicId : id, relation, provenance: reference, metadata });
        };
        for (const task of state.tasks) add('task', task, task);
        for (const file of state.artifacts) add('artifact', file, file);
        for (const decision of state.decisions) add('decision', decision.id, decision.text, { origin: 'worker', reference: opaque('source', decision.provenance.source) });
        if (operation === 'compact' || (operation === 'update' && state.summary)) add('handoff', String(state.summaryVersion), state.summary);
      }));
    });
  }
  close(): Promise<void> {
    this.closed = true;
    return this.queue(() => { for (const graph of this.graphs.values()) graph.close(); this.graphs.clear(); });
  }
}
