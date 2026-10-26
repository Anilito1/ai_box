import assert from 'node:assert/strict';
import { test } from 'node:test';

// The periods follow the computer's time zone: these tests pin one with a change of time (25 Oct 2026, 03:00 → 02:00).
process.env.TZ = 'Europe/Paris';

const { decodeRecord, encodeRecord, modelName, periodRange, summarize, totalsOf, turnDelta } = await import('./costs');
type TurnRecord = import('./costs').TurnRecord;

const u = (cost: number, input = 0, output = 0, cacheRead = 0, cacheWrite = 0) => ({ cost, input, output, cacheRead, cacheWrite });
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();

test('the time zone is pinned', () => {
  assert.equal(new Date(Date.UTC(2026, 6, 1, 12)).getHours(), 14);
});

test('totalsOf reads the SDK fields and ignores junk', () => {
  const t = totalsOf(0.5, {
    'claude-haiku-5-5': { costUSD: 0.5, inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40, contextWindow: 1 },
    broken: { costUSD: -1, inputTokens: 'x' },
  });
  assert.deepEqual(t.models['claude-haiku-5-5'], u(0.5, 10, 20, 30, 40));
  assert.deepEqual(t.models.broken, u(0));
  assert.deepEqual(totalsOf(Number.NaN, undefined), { cost: 0, models: {} });
});

test('turnDelta: difference of running totals', () => {
  const t1 = { cost: 1, models: { a: u(1, 10, 1, 100, 5) } };
  const t2 = { cost: 1.5, models: { a: u(1.2, 12, 2, 200, 5), b: u(0.3, 3, 3, 3, 3) } };
  assert.deepEqual(turnDelta(null, t1), { a: u(1, 10, 1, 100, 5) });
  const d = turnDelta(t1, t2);
  assert.ok(d);
  assert.ok(Math.abs(d.a.cost - 0.2) < 1e-12);
  assert.deepEqual({ ...d.a, cost: 0 }, u(0, 2, 1, 100, 0));
  assert.deepEqual(d.b, u(0.3, 3, 3, 3, 3));
});

test('turnDelta: nothing spent is null, a reset counts from zero', () => {
  const t = { cost: 1, models: { a: u(1, 10) } };
  assert.equal(turnDelta(t, t), null);
  assert.equal(turnDelta(null, { cost: 0, models: {} }), null);
  // A new conversation in the same process: the totals went down.
  assert.deepEqual(turnDelta(t, { cost: 0.2, models: { a: u(0.2, 2) } }), { a: u(0.2, 2) });
});

test('a record survives the file, a torn line does not', () => {
  const r: TurnRecord = { at: 1_700_000_000_000, id: 'master', name: 'hub-maitre', role: 'master', models: { 'claude-opus-5-5': u(0.123456789, 1, 2, 3, 4) } };
  const back = decodeRecord(encodeRecord(r));
  assert.deepEqual(back, { ...r, models: { 'claude-opus-5-5': u(0.12345679, 1, 2, 3, 4) } });
  assert.equal(decodeRecord(encodeRecord(r).slice(0, 30)), null);
  assert.equal(decodeRecord('{"t":1,"id":"x","n":"y","r":"boss","m":{}}'), null);
  assert.equal(decodeRecord('{"t":1,"id":"x","n":"y","r":"post","m":{"a":[1,2]}}'), null);
  assert.equal(decodeRecord('null'), null);
});

test('periodRange: calendar days in local time', () => {
  const now = new Date(at(2026, 10, 26, 9, 30));
  assert.deepEqual(periodRange('today', now), { from: at(2026, 10, 26, 0), to: at(2026, 10, 27, 0) });
  assert.deepEqual(periodRange('7d', now), { from: at(2026, 10, 20, 0), to: at(2026, 10, 27, 0) });
  assert.deepEqual(periodRange('30d', now), { from: at(2026, 9, 27, 0), to: at(2026, 10, 27, 0) });
  assert.deepEqual(periodRange('month', now), { from: at(2026, 10, 1, 0), to: at(2026, 10, 27, 0) });
  // Across a year.
  assert.deepEqual(periodRange('7d', new Date(at(2027, 1, 2))), { from: at(2026, 12, 27, 0), to: at(2027, 1, 3, 0) });
  // The day the clocks go back lasts 25 hours.
  const day = periodRange('today', new Date(at(2026, 10, 25, 9)));
  assert.equal(day.to - day.from, 25 * 3_600_000);
});

const rec = (when: number, id: string, role: TurnRecord['role'], models: TurnRecord['models'], name = `hub-${id}`): TurnRecord => ({ at: when, id, name, role, models });

test('summarize: totals and sessions of the range only', () => {
  const range = { from: at(2026, 10, 20, 0), to: at(2026, 10, 27, 0) };
  const records = [
    rec(at(2026, 10, 19, 23, 59), 'master', 'master', { opus: u(100) }), // before
    rec(at(2026, 10, 20, 0, 0), 'master', 'master', { opus: u(1, 10, 1) }),
    rec(at(2026, 10, 25, 2, 30), 'w1', 'worker', { haiku: u(0.5, 5, 5) }),
    rec(at(2026, 10, 26, 23, 59), 'p1', 'post', { opus: u(2), haiku: u(0.25) }, 'hub-backend'),
    rec(at(2026, 10, 26, 22), 'p1', 'post', { opus: u(1) }, 'hub-api'),
    rec(at(2026, 10, 27, 0, 0), 'master', 'master', { opus: u(100) }), // after
  ];
  const s = summarize(records, range);
  assert.equal(s.turns, 4);
  assert.equal(s.total.cost, 4.75);
  assert.equal(s.total.input, 15);
  assert.deepEqual(
    s.sessions.map((r) => [r.key, r.label, r.role, r.usage.cost, r.turns, r.models]),
    [
      ['p1', 'hub-backend', 'post', 3.25, 2, ['opus', 'haiku']],
      ['master', 'hub-master', 'master', 1, 1, ['opus']],
      ['w1', 'hub-w1', 'worker', 0.5, 1, ['haiku']],
    ],
  );
  assert.equal(summarize([], range).total.cost, 0);
});

test('modelName', () => {
  assert.equal(modelName('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelName('claude-sonnet-4-5-20250929[1m]'), 'Sonnet 4.5 (1M)');
  assert.equal(modelName('claude-haiku-4-20250101'), 'Haiku 4');
  assert.equal(modelName('gpt-x'), 'gpt-x');
});