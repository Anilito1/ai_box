import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { init, type ContextGraph, type Metadata, type NodeKind, type Relation } from './contextGraph';

const provenance = { origin: 'test' as const, reference: 'fixture-001' };
function node(graph: ContextGraph, id: string, kind: NodeKind, topicId = 'topic-001') {
  return graph.upsertNode({ topicId, id, kind, provenance });
}
function edge(graph: ContextGraph, from: string, to: string, relation: Relation, topicId = 'topic-001') {
  return graph.upsertEdge({ topicId, from, to, relation, provenance });
}

test('opt-in and SQLite unavailable are explicit, side-effect free modes', async () => {
  let loaded = false;
  const graph = await init({ loadSqlite: async () => { loaded = true; throw new Error('unavailable'); } });
  assert.equal(graph.status, 'disabled');
  assert.equal(loaded, false);
  assert.equal(node(graph, 'worker-001', 'worker'), false);
  assert.deepEqual(graph.neighbors('topic-001', 'worker-001'), { nodes: [], edges: [] });
  assert.deepEqual(graph.exportSnapshot('topic-001'), { schemaVersion: 1, nodes: [], edges: [] });
  const unavailable = await init({ enabled: true, path: ':memory:', loadSqlite: async () => { throw new Error('missing builtin'); } });
  assert.equal(unavailable.status, 'sqlite-unavailable');
  assert.equal(edge(unavailable, 'a', 'b', 'topic-worker'), false);
  assert.equal((await init({ enabled: true, path: 'relative.sqlite' })).status, 'storage-error');
});

test('typed relations, provenance, idempotence and bounded directed neighborhood', async () => {
  const graph = await init({ enabled: true, path: ':memory:' });
  try {
    assert.equal(graph.status, 'ready');
    const relations: [NodeKind, NodeKind, Relation][] = [
      ['topic', 'worker', 'topic-worker'], ['topic', 'task', 'topic-task'], ['worker', 'artifact', 'worker-artifact'],
      ['artifact', 'test', 'artifact-test'], ['decision', 'topic', 'decision-topic'],
      ['artifact', 'source', 'artifact-source'], ['branch', 'commit', 'branch-commit'],
    ];
    for (const [from, to, relation] of relations) {
      node(graph, from, from); node(graph, to, to);
      assert.equal(edge(graph, from, to, relation), true);
      assert.equal(edge(graph, from, to, relation), false);
    }
    const snapshot = graph.exportSnapshot('topic-001');
    assert.equal(snapshot.edges.length, 7);
    assert.equal(snapshot.nodes.length, 9);
    assert.deepEqual(snapshot.edges[0].provenance, provenance);
    assert.ok(snapshot.nodes.every(n => n.version === 1 && n.createdAt === n.updatedAt));
    assert.equal(node(graph, 'worker', 'worker'), false);
    assert.equal(graph.upsertNode({ topicId: 'topic-001', id: 'worker', kind: 'worker', provenance, metadata: { count: 2, status: 'done' } }), true);
    assert.equal(graph.upsertNode({ topicId: 'topic-001', id: 'worker', kind: 'worker', provenance, metadata: { status: 'done', count: 2 } }), false);
    assert.equal(graph.exportSnapshot('topic-001').nodes.find(n => n.id === 'worker')!.version, 2);
    assert.equal(graph.neighbors('topic-001', 'topic', { direction: 'in' }).edges.length, 1);
    assert.equal(graph.neighbors('topic-001', 'topic', { direction: 'out', limit: 1 }).edges.length, 1);
    assert.equal(graph.neighbors('topic-001', 'topic').edges.length, 3);
    assert.throws(() => graph.neighbors('topic-001', 'topic', { limit: 501 }));
    assert.throws(() => node(graph, 'worker', 'task'), /immutable/);
    assert.throws(() => edge(graph, 'topic', 'artifact', 'topic-worker'), /endpoint/);
    assert.throws(() => edge(graph, 'missing', 'worker', 'topic-worker'), /endpoint/);
    assert.equal(JSON.parse(JSON.stringify(snapshot)).schemaVersion, 1);
  } finally { graph.close(); }
});

test('topic isolation, archival, explicit restoration and controlled cascading deletion', async () => {
  const graph = await init({ enabled: true, path: ':memory:' });
  try {
    node(graph, 'topic', 'topic'); node(graph, 'worker', 'worker');
    node(graph, 'topic', 'topic', 'topic-002');
    assert.throws(() => edge(graph, 'topic', 'worker', 'topic-worker', 'topic-002'));
    edge(graph, 'topic', 'worker', 'topic-worker');
    assert.deepEqual(graph.neighbors('topic-002', 'topic').nodes, []);
    assert.equal(graph.exportSnapshot('topic-002').nodes.length, 1);
    assert.equal(graph.deleteNode('topic-001', 'worker', 'delete-archived'), false);
    const key = { topicId: 'topic-001', from: 'topic', to: 'worker', relation: 'topic-worker' as const };
    graph.archiveEdge(key);
    assert.equal(graph.neighbors('topic-001', 'topic').edges.length, 0);
    assert.equal(edge(graph, 'topic', 'worker', 'topic-worker'), false);
    graph.archiveEdge(key, false);
    assert.equal(graph.neighbors('topic-001', 'topic').edges.length, 1);
    assert.equal(graph.archiveNode('topic-001', 'worker'), true);
    assert.equal(graph.archiveNode('topic-001', 'worker'), false);
    node(graph, 'worker', 'worker');
    assert.equal(graph.neighbors('topic-001', 'topic').edges.length, 0);
    assert.throws(() => edge(graph, 'topic', 'worker', 'topic-worker'));
    graph.archiveNode('topic-001', 'worker', false);
    assert.equal(graph.neighbors('topic-001', 'topic').edges.length, 1);
    graph.archiveNode('topic-001', 'worker');
    assert.equal(graph.deleteNode('topic-001', 'worker', 'delete-archived'), true);
    assert.equal(graph.exportSnapshot('topic-001').edges.length, 0);
    assert.equal(graph.exportSnapshot('topic-002').nodes.length, 1);
  } finally { graph.close(); }
});

test('raw payloads and common credentials are rejected before persistence', async () => {
  const graph = await init({ enabled: true, path: ':memory:' });
  try {
    for (const id of ['sk-example-credential', 'github_pat_example', '/Users/person/private', 'person@example.com', 'raw conversation', 'a'.repeat(97)]) {
      assert.throws(() => node(graph, id, 'worker'));
    }
    for (const metadata of [{ prompt: 'raw text' }, { status: 'raw' }, { count: -1 }, { digest: 'credential' }]) {
      assert.throws(() => graph.upsertNode({ topicId: 'topic-001', id: 'worker', kind: 'worker', provenance, metadata: metadata as Metadata }));
    }
    assert.throws(() => graph.upsertNode({ topicId: 'topic-001', id: 'worker', kind: 'worker', provenance: { ...provenance, reference: 'secret-value' } }));
    assert.equal(graph.exportSnapshot('topic-001').nodes.length, 0);
  } finally { graph.close(); }
});

test('missing DB creation, durable reopen, corruption and foreign schema preservation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-graph-'));
  const path = join(dir, 'graph.sqlite');
  try {
    const graph = await init({ enabled: true, path });
    node(graph, 'topic', 'topic'); node(graph, 'worker', 'worker'); edge(graph, 'topic', 'worker', 'topic-worker');
    const before = graph.exportSnapshot('topic-001'); graph.close();
    assert.equal(graph.status, 'closed');
    const reopened = await init({ enabled: true, path });
    assert.deepEqual(reopened.exportSnapshot('topic-001'), before);
    reopened.close();
    const corrupt = join(dir, 'corrupt.sqlite');
    writeFileSync(corrupt, 'not a database');
    assert.equal((await init({ enabled: true, path: corrupt })).status, 'storage-error');
    assert.equal(readFileSync(corrupt, 'utf8'), 'not a database');
    const foreign = join(dir, 'foreign.sqlite');
    const db = new DatabaseSync(foreign); db.exec('CREATE TABLE unrelated (id TEXT);'); db.close();
    assert.equal((await init({ enabled: true, path: foreign })).status, 'storage-error');
    const check = new DatabaseSync(foreign);
    assert.deepEqual(check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name), ['unrelated']);
    check.exec('PRAGMA user_version=99'); check.close();
    assert.equal((await init({ enabled: true, path: foreign })).status, 'unsupported-schema');
    assert.equal((await init({ enabled: true, path: join(dir, 'missing', 'db.sqlite') })).status, 'storage-error');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('row quota permits updates but bounds new nodes', async () => {
  const graph = await init({ enabled: true, path: ':memory:' });
  try {
    for (let i = 0; i < 10_000; i++) node(graph, `worker-${i}`, 'worker');
    assert.equal(node(graph, 'worker-0', 'worker'), false);
    assert.throws(() => node(graph, 'worker-overflow', 'worker'), /quota/);
    graph.archiveNode('topic-001', 'worker-0'); graph.deleteNode('topic-001', 'worker-0', 'delete-archived');
    assert.equal(node(graph, 'worker-overflow', 'worker'), true);
  } finally { graph.close(); }
});


test('a structured batch rolls back fully on validation failure', async () => {
  const graph = await init({ enabled: true, path: ':memory:' });
  try {
    assert.throws(() => graph.batch(g => { node(g, 'topic', 'topic'); node(g, 'invalid path', 'task'); }));
    assert.deepEqual(graph.exportSnapshot().nodes, []);
    graph.batch(g => { node(g, 'topic', 'topic'); node(g, 'task', 'task'); edge(g, 'topic', 'task', 'topic-task'); });
    assert.equal(graph.statistics().counts.nodes, 2);
  } finally { graph.close(); }
});
