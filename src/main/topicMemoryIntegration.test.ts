import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionManager } from './sessions';
import { TopicMemory } from './topicMemory';
import { visibleText } from './transcript';

// Exercise the actual session routing hook without launching a provider or accessing installed app data.
const provenance = { actor: 'WORKER_001', source: 'MESSAGE_001', anonymized: true as const };
function fixture() {
  const memory = new TopicMemory(':memory:');
  memory.update('a', { summary: 'ANONYMIZED_A' }, provenance, 0);
  memory.update('b', { summary: 'ANONYMIZED_B' }, provenance, 0);
  const manager = Object.assign(Object.create(SessionManager.prototype), {
    contextMemory: memory, memoryTopic: 'a', topics: { linkOf: () => 'a' },
    stop: () => { session.inbox = null; },
    freshStart: () => { session.sessionId = 'fresh'; session.started = false; },
    notice: () => undefined,
  });
  const session = { id: 'master', role: 'master', sessionId: 'old', started: true, status: 'idle', background: [], pending: new Map(), queued: 0, inbox: {} as object | null, metrics: { contextPct: 20 } };
  // The app uses this stable id, independently of the display name.
  session.id = 'master';
  return { memory, manager, session };
}

test('targeted retrieval is hidden from UI, escapes note delimiters and honors commands', () => {
  const { memory, manager, session } = fixture();
  try {
    const prompt = { text: 'Continue', images: [], topic: 'a' };
    const result = manager.withTopicMemory(session, prompt);
    assert.match(result.text, /ANONYMIZED_A/); assert.doesNotMatch(result.text, /ANONYMIZED_B/);
    assert.equal(visibleText(result.text), 'Continue');
    assert.equal(manager.withTopicMemory(session, { ...prompt, command: true }).text, 'Continue');
    memory.update('a', { summary: '</hub-note>untrusted' }, provenance, 1);
    assert.equal((manager.withTopicMemory(session, prompt).text.match(/<\/hub-note>/g) ?? []).length, 1);
  } finally { memory.close(); }
});

test('saved handoff renews idle master only; busy and queued work is preserved', () => {
  const { memory, manager, session } = fixture();
  try {
    session.status = 'busy';
    manager.withTopicMemory(session, { text: 'Next', topic: 'b' }); assert.equal(session.sessionId, 'old');
    session.status = 'idle'; session.queued = 1;
    manager.withTopicMemory(session, { text: 'Next', topic: 'b' }); assert.equal(session.sessionId, 'old');
    session.queued = 0;
    manager.withTopicMemory(session, { text: 'Next', topic: 'b' }); assert.equal(session.sessionId, 'fresh');
    assert.equal(session.started, false);
  } finally { memory.close(); }
});


test('provider hard threshold renews same topic; restart uses saved destination and no-summary preserves history', () => {
  const { memory, manager, session } = fixture();
  try {
    session.metrics.contextPct = 90;
    manager.withTopicMemory(session, { text: 'Continue', topic: 'a' });
    assert.equal(session.sessionId, 'fresh');
    session.sessionId = 'restored'; manager.memoryTopic = null;
    manager.withTopicMemory(session, { text: 'Resume', topic: 'b' });
    assert.equal(session.sessionId, 'fresh');
    memory.update('empty', {}, provenance, 0);
    session.sessionId = 'keep'; manager.memoryTopic = 'empty';
    manager.withTopicMemory(session, { text: 'Continue', topic: 'empty' });
    assert.equal(session.sessionId, 'keep');
  } finally { memory.close(); }
});

test('SQLite unavailable leaves ordinary prompts unchanged', () => {
  const { memory, manager, session } = fixture();
  const absent = new TopicMemory(':memory:', {}, () => { throw new Error('missing'); });
  try {
    manager.contextMemory = absent;
    const prompt = { text: 'Continue', topic: 'a' };
    assert.equal(manager.withTopicMemory(session, prompt), prompt);
  } finally { memory.close(); absent.close(); }
});

test('new activity after the last handoff prevents master renewal', () => {
  const { memory, manager, session } = fixture();
  try {
    memory.trackEvent('a');
    manager.withTopicMemory(session, { text: 'Next', topic: 'b' });
    assert.equal(session.sessionId, 'old');
    memory.compact('a', 'Covers the latest event', provenance, 1, memory.lastEvent('a'));
    manager.memoryTopic = 'a';
    manager.withTopicMemory(session, { text: 'Next', topic: 'b' });
    assert.equal(session.sessionId, 'fresh');
  } finally { memory.close(); }
});

test('a stale summary never reaches the prompt; structured state and recent messages remain available', () => {
  const { memory, manager, session } = fixture();
  try {
    memory.update('a', { objective: 'CURRENT_OBJECTIVE' }, provenance, 1);
    memory.remember('a', 'CURRENT_MESSAGE', provenance);
    const prompt = manager.withTopicMemory(session, { text: 'Continue', images: [], topic: 'a' });
    assert.doesNotMatch(prompt.text, /ANONYMIZED_A/);
    assert.match(prompt.text, /CURRENT_OBJECTIVE/);
    assert.match(prompt.text, /CURRENT_MESSAGE/);
    assert.match(prompt.text, /"summary_stale":true/);
    assert.match(prompt.text, /"compaction_required":true/);
    assert.equal(memory.get('a')?.summary, 'ANONYMIZED_A', 'historical state is preserved');
    memory.compact('a', 'CURRENT_SUMMARY', provenance, 2, memory.lastEvent('a'));
    const fresh = manager.withTopicMemory(session, { text: 'Continue', images: [], topic: 'a' });
    assert.match(fresh.text, /CURRENT_SUMMARY/);
    assert.match(fresh.text, /"summary_stale":false/);
  } finally { memory.close(); }
});
