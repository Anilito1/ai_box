import assert from 'node:assert/strict';
import test from 'node:test';
import { ContextWindows } from './contextWindow';

test('a window the runtime reported is the one used, whatever the model', () => {
  const w = new ContextWindows();
  assert.equal(w.ofTurn({ 'claude-fable-5-2': 1_000_000 }, 'claude-fable-5-2'), 1_000_000);
});

test('a model never heard of has no window: unknown, not a default', () => {
  const w = new ContextWindows();
  assert.equal(w.of('claude-new-9'), 0);
  assert.equal(w.ofTurn({}, 'claude-new-9'), 0);
});

test('a window is kept for the next session of the same model, and a suffix or alias is another key', () => {
  const w = new ContextWindows();
  w.learn({ 'claude-sonnet-5-5[1m]': 1_000_000, 'claude-opus-4-1': 200_000, '': 5, bad: 0 });
  assert.equal(w.of('claude-sonnet-5-5[1m]'), 1_000_000);
  assert.equal(w.of('claude-sonnet-5-5'), 0);
  assert.equal(w.of('claude-opus-4-1'), 200_000);
  assert.equal(w.of('bad'), 0);
});

test("a turn lists its subagents' models too: the session's own window wins, never the largest", () => {
  const w = new ContextWindows();
  const turn = { 'claude-opus-4-1': 200_000, 'claude-sonnet-5-5': 1_000_000 };
  assert.equal(w.ofTurn(turn, 'claude-opus-4-1'), 200_000);
  assert.equal(w.ofTurn(turn, 'claude-other'), 0);
});

test("a turn of a single model answers for a session whose model id is not known yet", () => {
  assert.equal(new ContextWindows().ofTurn({ 'gpt-5.6-luna': 258_400 }, ''), 258_400);
});

test('a non-Claude provider reports its window by its own model id', () => {
  const w = new ContextWindows();
  w.learn({ 'gemini-2.5-pro': 1_000_000 });
  assert.equal(w.of('gemini-2.5-pro'), 1_000_000);
});
