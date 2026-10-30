import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pulseState, shortTokens, tokensOf, TurnTokens } from './pulse';
import type { SessionView } from './types';

const START = 1_000_000;
const tool = { name: 'Bash', summary: 'npm test', since: START };

const seen = (over: Partial<SessionView> = {}, signalAt: number | null = START) =>
  ({ status: 'busy', busySince: START, compacting: false, retrying: false, limit: null, tool: null, approvedAt: null, pulse: { signalAt, tokens: 0, estimated: false }, ...over }) as SessionView;

const toneAt = (ms: number, over: Partial<SessionView> = {}) => pulseState(seen(over), START + ms)?.tone;

test('a model that thinks or writes: green under 30 s, orange up to 2 min, red past it', () => {
  assert.equal(toneAt(0), 'ok');
  assert.equal(toneAt(29_999), 'ok');
  assert.equal(toneAt(30_000), 'slow');
  assert.equal(toneAt(120_000), 'slow');
  assert.equal(toneAt(120_001), 'stuck');
});

test('a running tool: green up to 2 min, orange up to 10 min, red past it', () => {
  assert.equal(toneAt(120_000, { tool }), 'ok');
  assert.equal(toneAt(120_001, { tool }), 'slow');
  assert.equal(toneAt(600_000, { tool }), 'slow');
  assert.equal(toneAt(600_001, { tool }), 'stuck');
});

test('a tool that keeps sending events stays green, however long it has been running', () => {
  const now = START + 3_600_000;
  assert.deepEqual(pulseState(seen({ tool }, now - 2000), now), { tone: 'ok', silent: false, ms: 2000 });
});

test('a compaction or an API retry waiting its delay has nothing to say until it ends, like a tool', () => {
  assert.equal(toneAt(120_000, { compacting: true }), 'ok');
  assert.equal(toneAt(600_001, { compacting: true }), 'stuck');
  assert.equal(toneAt(120_000, { retrying: true }), 'ok');
  assert.equal(toneAt(600_001, { retrying: true }), 'stuck');
});

test('a permission waits for the user: nothing is shown', () => {
  assert.equal(pulseState(seen({ status: 'attention' }), START + 3_600_000), null);
});

test('background tasks between turns are neutral, and unknown until a first event', () => {
  assert.deepEqual(pulseState(seen({ status: 'idle', busySince: null }), START + 900_000), { tone: 'neutral', silent: false, ms: 900_000 });
  assert.equal(pulseState(seen({ status: 'idle', busySince: null }, null), START), null);
});

test('a limit is a known wait: neutral, never red', () => {
  assert.equal(toneAt(7_200_000, { limit: { resetsAt: null } }), 'neutral');
});

test('a new turn is judged from its start, never from the event of an older turn', () => {
  const old = START - 3_600_000;
  assert.deepEqual(pulseState(seen({}, old), START + 5000), { tone: 'ok', silent: true, ms: 5000 });
  assert.deepEqual(pulseState(seen({}, null), START + 31_000), { tone: 'slow', silent: true, ms: 31_000 });
});

test('the time waited on an approval is not silence of the process', () => {
  const approvedAt = START + 900_000;
  assert.deepEqual(pulseState(seen({ approvedAt }), approvedAt + 1000), { tone: 'ok', silent: true, ms: 1000 });
  assert.deepEqual(pulseState(seen({ approvedAt }, approvedAt + 500), approvedAt + 1000), { tone: 'ok', silent: false, ms: 500 });
});

test('a clock that went back shows no negative time', () => {
  assert.equal(pulseState(seen({}, START + 5000), START)?.ms, 0);
});

test('tokens read short, in the language of the reader', () => {
  assert.equal(shortTokens(850, 'fr'), '850');
  assert.equal(shortTokens(3200, 'fr'), '3,2 k');
  assert.equal(shortTokens(3200, 'en'), '3.2k');
  assert.equal(shortTokens(1_500_000, 'fr'), '1,5 M');
  assert.equal(shortTokens(1_500_000, 'en'), '1.5M');
  assert.equal(shortTokens(999_960, 'fr'), '1 M');
});

test('the count starts empty and only grows with content', () => {
  const t = new TurnTokens();
  assert.equal(t.count, 0);
  assert.equal(t.estimated, false);
  t.estimate(tokensOf('12345678'));
  assert.equal(t.count, 2);
  assert.equal(t.estimated, true);
  t.estimate(0);
  assert.equal(t.count, 2);
});

test('a real count replaces the estimate of its reply, and the replies of a turn add up', () => {
  const t = new TurnTokens();
  t.estimate(50);
  t.replyCount(80);
  assert.deepEqual([t.count, t.estimated], [80, false]);
  t.nextReply();
  t.estimate(10);
  assert.deepEqual([t.count, t.estimated], [90, true]);
  t.replyCount(25);
  assert.deepEqual([t.count, t.estimated], [105, false]);
});

test('a reply cut before its real count stays in the turn, as an estimate', () => {
  const t = new TurnTokens();
  t.estimate(4000);
  t.nextReply();
  t.replyCount(300);
  assert.deepEqual([t.count, t.estimated], [4300, true]);
  t.turnCount(4500);
  assert.deepEqual([t.count, t.estimated], [4500, false]);
});

test('a real count of zero says nothing: the estimate stays', () => {
  const t = new TurnTokens();
  t.estimate(40);
  t.replyCount(0);
  t.turnCount(0);
  assert.deepEqual([t.count, t.estimated], [40, true]);
});

test('a real count of the whole turn stands for everything before it', () => {
  const t = new TurnTokens();
  t.estimate(40);
  t.turnCount(120);
  t.estimate(5);
  assert.deepEqual([t.count, t.estimated], [125, true]);
  t.turnCount(130);
  assert.deepEqual([t.count, t.estimated], [130, false]);
});

test('each turn starts again from zero', () => {
  const t = new TurnTokens();
  t.replyCount(500);
  t.nextReply();
  t.estimate(10);
  t.reset();
  assert.deepEqual([t.count, t.estimated], [0, false]);
});
