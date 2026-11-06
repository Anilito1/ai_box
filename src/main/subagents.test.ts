import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { translate } from './providers/claude/events';
import type { AgentEvent } from './providers/types';
import { Subagents } from './subagents';

// A session's stream as the SDK sends it (trimmed to what the hub reads), through the translation then the tracker,
// as sessions.ts feeds it.
const msg = (m: Record<string, unknown>) => m as unknown as SDKMessage;

function tracker() {
  let clock = 1_000;
  const subs = new Subagents(() => clock);
  const feed = (m: Record<string, unknown>) => {
    for (const ev of translate(msg(m)) as AgentEvent[]) {
      if (ev.type === 'assistant') subs.calls(ev.blocks);
      else if (ev.type === 'toolResults') subs.results(ev.blocks);
      else if (ev.type === 'agentTask') subs.task(ev);
      else if (ev.type === 'agentProgress') subs.progress(ev);
      else if (ev.type === 'agentSteps') subs.steps(ev.parent, ev.blocks);
    }
  };
  return { subs, feed, tick: (ms: number) => (clock += ms) };
}

const call = (id: string, input: Record<string, unknown>, name = 'Agent') => ({
  type: 'assistant',
  uuid: `u-${id}`,
  parent_tool_use_id: null,
  message: { content: [{ type: 'tool_use', id, name, input }] },
});
const result = (id: string, content: string, isError = false) => ({
  type: 'user',
  parent_tool_use_id: null,
  message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
});
const own = (parent: string, content: unknown[], type = 'assistant') => ({ type, uuid: `s-${parent}`, parent_tool_use_id: parent, message: { content } });

test('an Agent call launches a subagent with its description, type, model and mode', () => {
  const { subs, feed } = tracker();
  feed(call('toolu_1', { description: 'Audit des routes', subagent_type: 'Explore', model: 'sonnet', prompt: 'Lis tout' }));
  const [a] = subs.views();
  assert.deepEqual(
    { id: a.id, description: a.description, agentType: a.agentType, model: a.model, background: a.background, status: a.status, startedAt: a.startedAt },
    { id: 'toolu_1', description: 'Audit des routes', agentType: 'Explore', model: 'sonnet', background: false, status: 'running', startedAt: 1_000 },
  );
  // The old name of the tool, and a call without a description (its prompt says what it is).
  feed(call('toolu_2', { prompt: 'Compte les fichiers' }, 'Task'));
  assert.equal(subs.views()[1].description, 'Compte les fichiers');
  // Any other tool is no subagent. (Steps name tools as the chat does, in the user's language: English here.)
  feed(call('toolu_3', { command: 'ls' }, 'Bash'));
  assert.equal(subs.views().length, 2);
});

test('its own frames make its activity: tools, text and errors, newest last', () => {
  const { subs, feed, tick } = tracker();
  feed(call('toolu_1', { description: 'Audit' }));
  tick(500);
  feed(own('toolu_1', [{ type: 'tool_use', id: 'x1', name: 'Grep', input: { pattern: 'TODO' } }]));
  feed(own('toolu_1', [{ type: 'tool_result', tool_use_id: 'x1', content: 'no such file', is_error: true }], 'user'));
  tick(500);
  feed(own('toolu_1', [{ type: 'text', text: 'Trois routes   sans test.' }]));
  // Frames of an unknown parent are dropped.
  feed(own('toolu_9', [{ type: 'text', text: 'ailleurs' }]));
  const [a] = subs.views();
  assert.deepEqual(a.log, [
    { at: 1_500, kind: 'tool', text: 'Search in files TODO' },
    { at: 1_500, kind: 'error', text: 'no such file' },
    { at: 2_000, kind: 'text', text: 'Trois routes sans test.' },
  ]);
  assert.equal(a.activity, 'Trois routes sans test.');
  assert.equal(a.activityAt, 2_000);
  assert.equal(a.tools, 1);
  assert.equal(subs.views().length, 1);
});

test('a foreground subagent ends with the result of its call; its later notification changes nothing', () => {
  const { subs, feed, tick } = tracker();
  feed(call('toolu_1', { description: 'Audit' }));
  feed({ type: 'system', subtype: 'task_started', task_type: 'local_agent', task_id: 't1', tool_use_id: 'toolu_1', description: 'Audit', is_backgrounded: false });
  tick(4_000);
  feed(result('toolu_1', 'Rapport : 3 routes sans test.'));
  tick(1_000);
  feed({ type: 'system', subtype: 'task_notification', task_id: 't1', tool_use_id: 'toolu_1', status: 'failed', summary: 'autre chose' });
  const [a] = subs.views();
  assert.equal(a.status, 'done');
  assert.equal(a.endedAt, 5_000);
  assert.equal(a.result, 'Rapport : 3 routes sans test.');
  assert.equal(subs.running, 0);
});

test('a failed call or a failed task makes a failed subagent', () => {
  const { subs, feed } = tracker();
  feed(call('toolu_1', { description: 'A' }));
  feed(result('toolu_1', 'Agent crashed', true));
  feed(call('toolu_2', { description: 'B', run_in_background: true }));
  feed({ type: 'system', subtype: 'task_started', task_type: 'local_agent', task_id: 't2', tool_use_id: 'toolu_2' });
  feed({ type: 'system', subtype: 'task_updated', task_id: 't2', patch: { status: 'failed', error: 'API error' } });
  const byId = Object.fromEntries(subs.views().map((a) => [a.id, a]));
  assert.equal(byId.toolu_1.status, 'failed');
  assert.equal(byId.toolu_1.result, 'Agent crashed');
  assert.equal(byId.toolu_2.status, 'failed');
  assert.equal(byId.toolu_2.result, 'API error');
});

test('a background subagent outlives its call: the placeholder result leaves it running, its notification ends it', () => {
  const { subs, feed, tick } = tracker();
  feed(call('toolu_1', { description: 'Maquette V2', run_in_background: true }));
  feed({ type: 'system', subtype: 'task_started', task_type: 'local_agent', task_id: 't1', tool_use_id: 'toolu_1', is_backgrounded: true });
  feed(result('toolu_1', 'Async agent launched successfully. agentId: a1'));
  assert.equal(subs.views()[0].status, 'running');
  tick(60_000);
  feed({ type: 'system', subtype: 'task_progress', task_id: 't1', description: 'Maquette V2', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 }, last_tool_name: 'Write' });
  assert.equal(subs.views()[0].activity, 'Write');
  tick(60_000);
  feed({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed', summary: 'Maquette prête', output_file: '/tmp/x' });
  const [a] = subs.views();
  assert.deepEqual([a.status, a.endedAt, a.result, a.background], ['done', 121_000, 'Maquette prête', true]);
  // Stopped by the user: "stopped", not "failed".
  feed(call('toolu_2', { description: 'Autre', run_in_background: true }));
  feed({ type: 'system', subtype: 'task_started', task_type: 'local_agent', task_id: 't2', tool_use_id: 'toolu_2' });
  feed({ type: 'system', subtype: 'task_notification', task_id: 't2', status: 'stopped', summary: '', output_file: '' });
  assert.equal(subs.views().find((x) => x.id === 'toolu_2')?.status, 'stopped');
});

test('several subagents in parallel keep their own steps and end one by one', () => {
  const { subs, feed, tick } = tracker();
  feed({
    type: 'assistant',
    uuid: 'u1',
    parent_tool_use_id: null,
    message: {
      content: [
        { type: 'tool_use', id: 'a', name: 'Agent', input: { description: 'Front' } },
        { type: 'tool_use', id: 'b', name: 'Agent', input: { description: 'Back' } },
        { type: 'tool_use', id: 'c', name: 'Agent', input: { description: 'Docs' } },
      ],
    },
  });
  feed(own('a', [{ type: 'tool_use', id: 'x', name: 'Read', input: { file_path: '/r/src/app.ts' } }]));
  feed(own('b', [{ type: 'tool_use', id: 'y', name: 'Bash', input: { command: 'npm test' } }]));
  tick(1_000);
  feed(result('b', 'ok'));
  const views = subs.views();
  // Running ones first, oldest first; then the ended.
  assert.deepEqual(views.map((a) => [a.id, a.status]), [['a', 'running'], ['c', 'running'], ['b', 'done']]);
  assert.equal(views[0].activity, 'Read src/app.ts');
  assert.equal(views[2].activity, 'Command npm test');
  assert.equal(subs.running, 2);
  // The process goes: what still ran was stopped with it.
  subs.stopAll();
  assert.deepEqual(subs.views().map((a) => a.status).sort(), ['done', 'stopped', 'stopped']);
});

test('a task whose call was not seen is still listed; the log and the ended list stay bounded', () => {
  const { subs, feed, tick } = tracker();
  feed({ type: 'system', subtype: 'task_started', task_type: 'local_agent', task_id: 't9', description: 'Repris', subagent_type: 'Plan' });
  assert.deepEqual([subs.views()[0].id, subs.views()[0].description, subs.views()[0].agentType], ['t9', 'Repris', 'Plan']);
  feed(call('toolu_1', { description: 'Bavard' }));
  for (let i = 0; i < 100; i++) feed(own('toolu_1', [{ type: 'text', text: `étape ${i}` }]));
  const log = subs.views().find((a) => a.id === 'toolu_1')?.log ?? [];
  assert.equal(log.length, 40);
  assert.equal(log.at(-1)?.text, 'étape 99');
  for (let i = 0; i < 30; i++) {
    feed(call(`e${i}`, { description: `n${i}` }));
    tick(10);
    feed(result(`e${i}`, 'fini'));
  }
  const ended = subs.views().filter((a) => a.status !== 'running');
  assert.equal(ended.length, 12);
  assert.equal(ended[0].description, 'n29');
});
