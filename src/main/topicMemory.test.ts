import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TopicMemory, estimateTokens, type Provenance } from './topicMemory';
const p: Provenance = { actor: 'WORKER_001', source: 'MESSAGE_001', anonymized: true };
const fixture = (fn: (path: string) => void) => { const dir = mkdtempSync(join(tmpdir(), 'context-memory-')); try { fn(join(dir, 'memory.sqlite')); } finally { rmSync(dir, { recursive: true, force: true }); } };

test('topic state, provenance and immutable decision revisions survive restart', () => fixture(path => {
  let m = new TopicMemory(path);
  const initial = m.update('topic-a', { objective: 'Anonymized goal', tasks: ['TASK_001'] }, p, 0);
  assert.equal(initial.version, 1);
  const decided = m.decision('topic-a', 'Keep local', p, 1);
  const revised = m.decision('topic-a', 'Keep local with export', { ...p, source: 'MESSAGE_002' }, 2, decided.decisions[0].id);
  assert.equal(revised.decisions.length, 2);
  assert.equal(revised.decisions[1].supersedes, decided.decisions[0].id);
  assert.throws(() => m.update('topic-a', { summary: 'stale' }, p, 1), /conflict/);
  assert.throws(() => m.update('topic-a', { decisions: [] } as never, p, 3), /append-only/);
  m.close(); m = new TopicMemory(path);
  assert.deepEqual(m.get('topic-a'), revised);
  assert.equal(m.history('topic-a').length, 3);
  assert.equal(m.get('topic-b'), null); m.close();
}));

test('compaction keeps decisions and constraints, versions handoff, bounds packet and recent messages', (t) => {
  const m = new TopicMemory(':memory:', { warning: 1800, compact: 2400, hard: 3200, packetTokens: 1800, summaryTokens: 400, recentMessages: 2 });
  m.update('a', { constraints: ['Local only'] }, p, 0);
  m.decision('a', 'DECISION_001', p, 1);
  for (let i = 0; i < 6; i++) m.remember('a', 'Useful '.repeat(130), p);
  assert.equal(m.pressure('a').level, 'warning');
  assert.throws(() => m.remember('a', 'x'.repeat(9000), p), /hard limit/);
  const result = m.compact('a', 'Handoff: next TASK_002', p, 2);
  assert.ok(result.afterTokens < result.beforeTokens);
  t.diagnostic(`Compaction fixture: ${result.beforeTokens} -> ${result.afterTokens} estimated tokens (${Math.round(100 * (1 - result.afterTokens / result.beforeTokens))}% reduction)`);
  assert.equal(result.state.summaryVersion, 1);
  assert.equal(result.state.decisions.length, 1);
  assert.deepEqual(result.state.constraints, ['Local only']);
  const packet = m.packet('a'); assert.ok(estimateTokens(packet) <= 1800); assert.ok(packet.recent.length <= 2);
  m.update('b', { summary: 'PRIVATE_TOPIC_B' }, p, 0);
  m.remember('b', 'OTHER_TOPIC_MESSAGE', p);
  assert.ok(!JSON.stringify(m.packet('a')).includes('PRIVATE_TOPIC_B'));
  assert.ok(!JSON.stringify(m.packet('a')).includes('OTHER_TOPIC_MESSAGE'));
  const old = m.get('a'); assert.throws(() => m.compact('a', 'x'.repeat(4000), p, 3), /budget/); assert.deepEqual(m.get('a'), old);
  m.close();
});

test('thresholds and Unicode packet estimate are conservative; compact pressure and validation', () => {
  assert.ok(estimateTokens('漢'.repeat(100)) >= 100);
  assert.throws(() => new TopicMemory(':memory:', { hard: 1 }), /limits/);
  const m = new TopicMemory(':memory:', { warning: 1000, compact: 1500, hard: 2500 });
  m.update('a', {}, p, 0);
  m.remember('a', 'x'.repeat(4500), p);
  assert.equal(m.pressure('a').level, 'compact');
  m.compact('a', 'Short', p, 1); assert.ok(m.pressure('a').tokens < 1500);
  assert.throws(() => m.remember('a', 'contact person@example.org', p), /Sensitive/);
  assert.throws(() => m.update('a', {}, { ...p, anonymized: false } as never, 2), /Anonymized/);
  assert.throws(() => m.update('a', { tasks: [123] } as never, p, 2), /Invalid/);
  m.close();
});

test('missing database initialized, corrupt file preserved, missing SQLite explicitly unavailable', () => fixture(path => {
  let m = new TopicMemory(path); assert.equal(m.status.mode, 'sqlite'); m.close();
  writeFileSync(path, 'corrupted fixture'); m = new TopicMemory(path);
  assert.equal(m.status.mode, 'unavailable'); assert.throws(() => m.get('a'), /unavailable/); m.close();
  const missing = new TopicMemory(':memory:', {}, () => { throw new Error('No SQLite'); });
  assert.equal(missing.status.mode, 'unavailable'); assert.throws(() => missing.update('a', {}, p, 0), /unavailable/);
}));

test('a handoff carries its covered event watermark and rejects compaction from a stale packet', () => fixture(path => {
  let memory = new TopicMemory(path);
  memory.update('a', { summary: 'Saved initial state' }, p, 0);
  assert.equal(memory.hasFreshSummary('a'), true);
  const packet = memory.packet('a');
  memory.remember('a', 'NEW_EVENT_001', p);
  assert.equal(memory.hasFreshSummary('a'), false);
  assert.throws(() => memory.compact('a', 'Stale summary', p, 1, packet.lastEvent), /event conflict/);
  const latest = memory.packet('a');
  const result = memory.compact('a', 'Covers NEW_EVENT_001', p, 1, latest.lastEvent);
  assert.equal(result.state.summaryEvent, latest.lastEvent);
  assert.equal(result.state.summaryEvent, memory.lastEvent('a'));
  assert.equal(memory.hasFreshSummary('a'), true);
  memory.close(); memory = new TopicMemory(path);
  assert.equal(memory.hasFreshSummary('a'), true);
  memory.trackEvent('a');
  assert.equal(memory.hasFreshSummary('a'), false);
  memory.close();
}));
