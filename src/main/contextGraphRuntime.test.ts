import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readdirSync, rmSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextGraphRuntime, graphWorkspace } from './contextGraph';
import { TopicMemory } from './topicMemory';
import { SessionManager } from './sessions';
import { loadConfig, saveConfig, applyPatch } from './config';
import type { ContextGraphSettings } from '../shared/contextGraph';

const provenance = { actor: 'WORKER_001', source: 'MESSAGE_001', anonymized: true as const };
function fixture(loadSqlite?: ConstructorParameters<typeof ContextGraphRuntime>[0]['loadSqlite']) {
  const dir = mkdtempSync(join(tmpdir(), 'graph-runtime-'));
  const scope = { workspace: join(dir, 'workspace'), sessionId: 'SESSION_001' };
  mkdirSync(scope.workspace);
  scope.workspace = realpathSync(scope.workspace);
  let settings: ContextGraphSettings = { enabled: false, workspaces: [] };
  const runtime = new ContextGraphRuntime({ dataDir: dir, settings: () => settings, save: next => { settings = next; }, loadSqlite });
  const memory = new TopicMemory(':memory:');
  const state = memory.update('TOPIC_001', { tasks: ['ANONYMIZED_TASK'], artifacts: ['/synthetic/artifact.ts'], summary: 'ANONYMIZED_HANDOFF' }, provenance, 0);
  return { dir, scope, runtime, memory, state, settings: () => settings,
    async close() { await runtime.close(); memory.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('disabled startup and writes have no graph storage side effects; opt-in survives settings reload', async () => {
  let loaded = false;
  const f = fixture(async () => { loaded = true; throw new Error('no sqlite'); });
  try {
    const before = readdirSync(f.dir);
    await f.runtime.record(f.scope, f.state, 'update');
    assert.equal((await f.runtime.status(f.scope)).state, 'disabled');
    assert.equal(loaded, false); assert.deepEqual(readdirSync(f.dir), before);
    const status = await f.runtime.setEnabled(f.scope, true);
    assert.equal(status.state, 'unavailable'); assert.equal(status.error, 'sqlite-unavailable'); assert.equal(status.enabled, true);
    const config = loadConfig(f.dir, 'fr');
    assert.deepEqual(config.contextGraph, { enabled: false, workspaces: [] });
    config.contextGraph = f.settings(); saveConfig(f.dir, config);
    assert.deepEqual(loadConfig(f.dir, 'fr').contextGraph, f.settings());
    assert.equal(applyPatch(config, { contextGraph: { enabled: true, workspaces: [] } } as never), 'contextGraph');
    assert.deepEqual((await f.runtime.retrieve(f.scope, 'TOPIC_001')).nodes, []);
    assert.equal((await f.runtime.exportSnapshot(f.scope)).snapshot.nodes.length, 0);
  } finally { await f.close(); }
});

test('structured writes are opaque, idempotent, versioned and scoped by workspace/session/topic', async () => {
  const f = fixture();
  try {
    await f.runtime.setEnabled(f.scope, true);
    await f.runtime.record(f.scope, f.state, 'update');
    const first = await f.runtime.exportSnapshot(f.scope);
    assert.equal(first.status.state, 'enabled'); assert.equal(first.status.countsAvailable, true);
    assert.equal(first.snapshot.nodes.length, 5); assert.equal(first.snapshot.edges.length, 4);
    const serialized = JSON.stringify(first);
    for (const raw of ['ANONYMIZED_TASK', '/synthetic/artifact.ts', 'ANONYMIZED_HANDOFF', 'WORKER_001', 'MESSAGE_001', 'TOPIC_001', 'SESSION_001', f.scope.workspace]) assert.ok(!serialized.includes(raw));
    assert.ok(first.snapshot.nodes.every(n => n.metadata.confidence === 1 && n.metadata.sourceVersion === 1 && n.version === 1));
    await f.runtime.record(f.scope, f.state, 'update');
    assert.deepEqual(await f.runtime.exportSnapshot(f.scope), first);
    assert.equal((await f.runtime.retrieve(f.scope, 'TOPIC_001', 2)).nodes.length, 2);
    const bounded = await f.runtime.retrieve(f.scope, 'TOPIC_001', 2);
    const ids = new Set(bounded.nodes.map(n => n.id));
    assert.ok(bounded.edges.every(e => ids.has(e.from) && ids.has(e.to)));
    await assert.rejects(f.runtime.retrieve(f.scope, 'TOPIC_001', 51), /limit/);
    assert.equal((await f.runtime.retrieve(f.scope, 'OTHER_TOPIC')).nodes.length, 0);
    const otherSession = { ...f.scope, sessionId: 'SESSION_002' };
    assert.equal((await f.runtime.status(otherSession)).enabled, true);
    assert.equal((await f.runtime.exportSnapshot(otherSession)).snapshot.nodes.length, 0);
    const otherWorkspace = { workspace: join(f.dir, 'other'), sessionId: f.scope.sessionId };
    assert.equal((await f.runtime.status(otherWorkspace)).state, 'disabled');
    await f.runtime.setEnabled(otherWorkspace, true);
    assert.equal((await f.runtime.exportSnapshot(otherWorkspace)).snapshot.nodes.length, 0);
    const decision = f.memory.decision('TOPIC_001', 'ANONYMIZED_DECISION', provenance, 1);
    await f.runtime.record(f.scope, decision, 'decision');
    assert.equal((await f.runtime.retrieve(f.scope, 'TOPIC_001')).nodes.filter(n => n.kind === 'decision').length, 1);
  } finally { await f.close(); }
});

test('disabled export/purge are explicit, repeatable and never enable ingestion; reopening preserves state', async () => {
  const f = fixture();
  try {
    await f.runtime.setEnabled(f.scope, true); await f.runtime.record(f.scope, f.state, 'compact');
    const before = await f.runtime.exportSnapshot(f.scope);
    await f.runtime.setEnabled(f.scope, false);
    const disabled = await f.runtime.status(f.scope);
    assert.equal(disabled.state, 'disabled'); assert.equal(disabled.countsAvailable, false);
    await f.runtime.record(f.scope, f.memory.update('TOPIC_001', { tasks: ['SHOULD_NOT_BE_STORED'] }, provenance, 1), 'update');
    const exported = await f.runtime.exportSnapshot(f.scope);
    assert.deepEqual(exported.snapshot, before.snapshot); assert.equal(exported.status.state, 'disabled');
    assert.deepEqual(await f.runtime.exportSnapshot(f.scope), exported);
    const first = await f.runtime.purge(f.scope), second = await f.runtime.purge(f.scope);
    assert.deepEqual(first, second); assert.equal(first.counts.nodes, 0); assert.equal(first.state, 'disabled');
    assert.equal((await f.runtime.exportSnapshot(f.scope)).snapshot.nodes.length, 0);
    await f.runtime.setEnabled(f.scope, true);
    assert.equal((await f.runtime.status(f.scope)).counts.nodes, 0);
    await f.runtime.close();
    assert.equal((await f.runtime.status(f.scope)).state, 'unavailable');
    assert.equal((await f.runtime.status(f.scope)).error, 'closed');
    assert.equal((await f.runtime.retrieve(f.scope, 'TOPIC_001')).nodes.length, 0);
  } finally { await f.close(); }
});

test('authoritative session resolution rejects arbitrary identifiers, workspace escapes and symlink escapes', async () => {
  const f = fixture();
  try {
    const outside = join(f.dir, 'outside'); mkdirSync(outside);
    symlinkSync(outside, join(f.scope.workspace, 'escape'));
    assert.equal(graphWorkspace(join(f.scope.workspace, 'escape'), [f.scope.workspace]), null);
    assert.equal(graphWorkspace(`${f.scope.workspace}-other`, [f.scope.workspace]), null);
    assert.equal(graphWorkspace(join(f.scope.workspace, 'escape', 'missing'), [f.scope.workspace]), null);
    assert.equal(graphWorkspace(f.scope.workspace, [f.scope.workspace]), f.scope.workspace);
    const manager = Object.assign(Object.create(SessionManager.prototype), { contextGraph: f.runtime,
      opts: { cfg: { workspaces: [f.scope.workspace] } }, sessions: new Map([
        ['known', { id: 'known', role: 'master', cwd: f.scope.workspace }],
        ['outside', { id: 'outside', role: 'worker', cwd: outside }],
      ]),
    });
    assert.throws(() => manager.contextGraphStatus('../arbitrary'), /session/);
    assert.throws(() => manager.contextGraphStatus({ path: f.dir }), /session/);
    assert.throws(() => manager.contextGraphStatus('outside'), /workspace/);
    assert.throws(() => manager.contextGraphSetEnabled('known', 'true'), /setting/);
    assert.equal((await manager.contextGraphStatus('known')).state, 'disabled');
  } finally { await f.close(); }
});

test('retrieval tool enforces worker topic assignment', async () => {
  const f = fixture();
  try {
    const session = { id: f.scope.sessionId, role: 'worker', name: 'WORKER_001', cwd: f.scope.workspace };
    const manager = Object.assign(Object.create(SessionManager.prototype), { contextGraph: f.runtime, contextMemory: f.memory,
      opts: { cfg: { workspaces: [f.scope.workspace], groups: [] }, capabilities: async () => '' },
      sessions: new Map([[session.id, session]]), topics: { linkOf: () => 'TOPIC_001' },
      groupsLed: () => [], groupOf: () => undefined,
    });
    const tools = manager.hubTools(session);
    const graph = tools.find((t: { name: string }) => t.name === 'context_graph');
    assert.ok(graph);
    const rejected = await graph.handler({ topic: 'OTHER_TOPIC' });
    assert.equal(rejected.isError, true);
    await f.runtime.setEnabled(f.scope, true);
    await f.runtime.record(f.scope, f.state, 'update');
    const accepted = await graph.handler({ topic: 'TOPIC_001', limit: 2 });
    assert.equal(accepted.isError, undefined);
    assert.equal(JSON.parse(accepted.content[0].text).nodes.length, 2);
    const memory = tools.find((t: { name: string }) => t.name === 'topic_memory');
    const saved = await memory.handler({ topic: 'TOPIC_001', action: 'update', version: 1, anonymized: true, source: 'MESSAGE_002', state: { tasks: ['UPDATED_TASK'] } });
    assert.equal(saved.isError, undefined);
    const after = await f.runtime.exportSnapshot(f.scope);
    assert.ok(after.snapshot.nodes.some(n => n.kind === 'task' && n.metadata.sourceVersion === 2));
    await memory.handler({ topic: 'TOPIC_001', action: 'remember', anonymized: true, source: 'MESSAGE_003', text: 'TRANSCRIPT_LIKE_NOTE' });
    assert.deepEqual(await f.runtime.exportSnapshot(f.scope), after, 'remember never ingests graph content');
    const failed = await memory.handler({ topic: 'TOPIC_001', action: 'update', version: 0, anonymized: true, source: 'MESSAGE_004', state: { tasks: ['REJECTED_TASK'] } });
    assert.equal(failed.isError, true);
    assert.deepEqual(await f.runtime.exportSnapshot(f.scope), after, 'rejected memory writes never ingest graph content');

  } finally { await f.close(); }
});
