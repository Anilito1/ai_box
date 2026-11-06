import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitBackground, subagentRows, subagentTime } from './subagentList';
import type { SubagentView } from './types';

const sub = (id: string, status: SubagentView['status'], description = id): SubagentView => ({
  id,
  description,
  agentType: '',
  model: '',
  background: false,
  status,
  startedAt: 0,
  endedAt: status === 'running' ? null : 1,
  activity: '',
  activityAt: null,
  tools: 0,
  log: [],
  result: '',
});

test('every running subagent is listed; the ended ones fold past two into "+n"', () => {
  const list = [sub('a', 'running'), sub('b', 'running'), sub('c', 'done'), sub('d', 'failed'), sub('e', 'stopped'), sub('f', 'done')];
  const folded = subagentRows(list, false);
  assert.deepEqual(folded.shown.map((a) => a.id), ['a', 'b', 'c', 'd']);
  assert.equal(folded.folded, 2);
  const open = subagentRows(list, true);
  assert.equal(open.shown.length, 6);
  assert.equal(open.folded, 0);
  assert.deepEqual(subagentRows(undefined, false), { shown: [], folded: 0 });
});

test('the time a subagent ran, or has been running', () => {
  assert.equal(subagentTime({ startedAt: 0, endedAt: 8_400 }, 99_999), '8 s');
  assert.equal(subagentTime({ startedAt: 0, endedAt: null }, 185_000), '3 min 05 s');
  assert.equal(subagentTime({ startedAt: 0, endedAt: 4_320_000 }, 0), '1 h 12 min');
  // Under a card, the minutes are enough.
  assert.equal(subagentTime({ startedAt: 0, endedAt: null }, 185_000, true), '3 min');
});

test('a running subagent leaves the background list for a link to its row; a shell stays', () => {
  const subs = [sub('toolu_1', 'running', 'Maquette V2'), sub('toolu_2', 'done', 'Serve on port 8821'), sub('toolu_3', 'running', 'Maquette V2')];
  const split = splitBackground(['Maquette V2', 'Serve on port 8821', 'Maquette V2', 'Maquette V2'], subs);
  // An ended subagent of the same name is no match: that task is a shell.
  assert.deepEqual(split.tasks, ['Serve on port 8821', 'Maquette V2']);
  assert.deepEqual(split.linked, [
    { label: 'Maquette V2', id: 'toolu_1' },
    { label: 'Maquette V2', id: 'toolu_3' },
  ]);
});
