import assert from 'node:assert/strict';
import { test } from 'node:test';

// The periods follow the computer's time zone: these tests pin one with a change of time (25 Oct 2026, 03:00 → 02:00).
process.env.TZ = 'Europe/Paris';

const { byProvider, decodeMission, decodeRecord, encodeMission, encodeRecord, missionRows, modelName, ofProvider, periodRange, recordProvider, summarize, totalsOf, turnDelta } = await import('./costs');
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

test('the repo of a turn survives the file; a turn without one stays without', () => {
  const r: TurnRecord = { at: 1, id: 'w', name: 'hub-w', role: 'worker', models: { a: u(1) }, repo: 'C:\\dev\\shop' };
  assert.equal(decodeRecord(encodeRecord(r))?.repo, 'C:\\dev\\shop');
  assert.equal(decodeRecord(encodeRecord({ ...r, repo: '' }))?.repo, '');
  assert.equal('repo' in (decodeRecord(encodeRecord({ ...r, repo: undefined })) ?? {}), false);
});

test('summarize: by repo, most expensive first, outside any repo last', () => {
  const range = { from: at(2026, 10, 26, 0), to: at(2026, 10, 27, 0) };
  const inRepo = (id: string, cost: number, repo: string | undefined, role: TurnRecord['role'] = 'worker') => ({ ...rec(at(2026, 10, 26), id, role, { opus: u(cost) }), ...(repo === undefined ? {} : { repo }) });
  const s = summarize(
    [
      inRepo('master', 9, '', 'master'),
      inRepo('w1', 1, '/dev/shop'),
      inRepo('w2', 2, '/dev/shop'), // in a worktree: logged with its main folder
      inRepo('w3', 2.5, 'C:\\dev\\api'),
      inRepo('w4', 0.5, undefined), // logged before the repo was kept
      { ...inRepo('w1', 100, '/dev/shop'), at: at(2026, 10, 25) }, // another day
    ],
    range,
  );
  assert.deepEqual(
    s.repos.map((r) => [r.key, r.label, r.usage.cost, r.turns, r.sessions.map((x) => x.label)]),
    [
      ['/dev/shop', 'shop', 3, 2, ['hub-w2', 'hub-w1']],
      ['C:\\dev\\api', 'api', 2.5, 1, ['hub-w3']],
      ['', '', 9.5, 2, ['hub-master', 'hub-w4']],
    ],
  );
  assert.equal(s.total.cost, 15);
});

test('modelName', () => {
  assert.equal(modelName('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelName('claude-sonnet-4-5-20250929[1m]'), 'Sonnet 4.5 (1M)');
  assert.equal(modelName('claude-haiku-4-20250101'), 'Haiku 4');
  assert.equal(modelName('gpt-x'), 'gpt-x');
});
test('a turn keeps its mission, effort, length and tool counts; a mission adds up its turns and relaunches', () => {
  const usage = (cost: number) => ({ cost, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const turn = { at: 10, id: 'w', name: 'hub-w', role: 'worker' as const, models: { a: usage(1.5) }, mission: 'm-1', effort: 'high', ms: 60_000, tools: 4, errors: 1 };
  assert.deepEqual(decodeRecord(encodeRecord(turn)), turn);
  const old = decodeRecord(encodeRecord({ at: 1, id: 'w', name: 'hub-w', role: 'worker', models: { a: usage(1) } }));
  assert.equal(old?.mission, undefined); // turns logged before missions
  const ev = (at: number, kind: 'start' | 'follow') => ({ at, mission: 'm-1', id: 'w', name: 'hub-w', kind, model: 'sonnet', effort: 'high', by: 'master' as const });
  assert.deepEqual(decodeMission(encodeMission(ev(5, 'start'))), ev(5, 'start'));
  const rows = missionRows([turn, { ...turn, at: 20, models: { a: usage(0.5) }, errors: 0 }, { ...turn, mission: 'm-other' }], [ev(5, 'start'), ev(15, 'follow')]);
  assert.equal(rows.length, 1);
  assert.deepEqual({ cost: rows[0].cost, turns: rows[0].turns, follows: rows[0].follows, errors: rows[0].errors, tools: rows[0].tools, by: rows[0].by }, { cost: 2, turns: 2, follows: 1, errors: 1, tools: 8, by: 'master' });
});
test('a follow-up sent after a failed delivery is kept as a retry, and counted on its mission', () => {
  const usage = { cost: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const ev = (at: number, kind: 'start' | 'follow', retry = false) => ({ at, mission: 'm-1', id: 'w', name: 'hub-w', kind, model: 'sonnet', effort: 'medium', by: 'master' as const, ...(retry ? { retry: true as const } : {}) });
  assert.deepEqual(decodeMission(encodeMission(ev(15, 'follow', true))), ev(15, 'follow', true));
  assert.equal(decodeMission(encodeMission(ev(15, 'follow')))?.retry, undefined);
  const rows = missionRows([{ at: 30, id: 'w', name: 'hub-w', role: 'worker', models: { a: usage }, mission: 'm-1' }], [ev(5, 'start'), ev(15, 'follow'), ev(20, 'follow', true)]);
  assert.deepEqual({ follows: rows[0].follows, retries: rows[0].retries }, { follows: 2, retries: 1 });
});

test('a keep-alive or an exploration is logged as such; a turn of work carries no mark', () => {
  const r: TurnRecord = { at: 1, id: 'm', name: 'master', role: 'master', models: { 'claude-opus-5-5': u(0.08, 3, 40, 400_000, 0) }, kind: 'keepAlive' };
  assert.equal(decodeRecord(encodeRecord(r))?.kind, 'keepAlive');
  assert.equal(decodeRecord(encodeRecord({ ...r, kind: 'explore' }))?.kind, 'explore');
  assert.equal('kind' in (decodeRecord(encodeRecord({ ...r, kind: undefined })) ?? {}), false);
  assert.equal('kind' in (decodeRecord(encodeRecord(r).replace('"kd":"keepAlive"', '"kd":"other"')) ?? {}), false);
});

test('a keep-alive or an exploration counts in the cost, not in the turns', () => {
  const day = at(2026, 11, 18, 10);
  const work: TurnRecord = { at: day, id: 'w', name: 'hub-w', role: 'worker', models: { a: u(1) }, mission: 'm-1' };
  const helper: TurnRecord = { ...work, at: day + 1, models: { b: u(0.01) }, kind: 'explore' };
  const ping: TurnRecord = { ...work, at: day + 2, models: { a: u(0.1) }, mission: undefined, kind: 'keepAlive' };
  const sum = summarize([work, helper, ping], periodRange('today', new Date(day)));
  assert.equal(sum.turns, 1);
  assert.equal(sum.sessions[0].turns, 1);
  assert.equal(+sum.total.cost.toFixed(2), 1.11);
  const [row] = missionRows([work, helper], [{ at: day - 1, mission: 'm-1', id: 'w', name: 'hub-w', kind: 'start', model: 'opus', effort: 'high', by: 'master' }]);
  assert.deepEqual([row.turns, +row.cost.toFixed(2)], [1, 1.01]);
});

test('a turn keeps its provider and its models without a price; a video is logged as such', () => {
  const r: TurnRecord = { at: 1, id: 'w', name: 'hub-w', role: 'worker', models: { 'venice-uncensored': u(0.9, 1_000_000, 100_000), 'qwen-x': u(0, 5000, 10) }, provider: 'venice', unpriced: ['qwen-x'] };
  const back = decodeRecord(encodeRecord(r));
  assert.equal(back?.provider, 'venice');
  assert.deepEqual(back?.unpriced, ['qwen-x']);
  const video: TurnRecord = { ...r, models: { 'wan-2.5': u(0.085) }, unpriced: undefined, kind: 'video' };
  assert.equal(decodeRecord(encodeRecord(video))?.kind, 'video');
  assert.equal('unpriced' in (decodeRecord(encodeRecord(video)) ?? {}), false, 'nothing without a price: no mark');
  // A model marked that the turn does not have, or junk, is dropped; an empty provider is none.
  const odd = decodeRecord(encodeRecord(r).replace('"up":["qwen-x"]', '"up":["nope",3,"qwen-x"]').replace('"p":"venice"', '"p":""'));
  assert.deepEqual([odd?.unpriced, 'provider' in (odd ?? {})], [['qwen-x'], false]);
});

test('the turns logged before the provider was kept are still read, and go to the provider their models say', () => {
  // A line as the hub wrote it before: no "p", no "up".
  const old = decodeRecord('{"t":1700000000000,"id":"w","n":"hub-w","r":"worker","m":{"claude-opus-5-5":[1.5,10,20,30,40]},"w":"/dev/shop"}');
  assert.ok(old);
  assert.equal(old.provider, undefined);
  assert.equal(recordProvider(old), 'anthropic');
  const legacy = (model: string) => recordProvider({ models: { [model]: u(1) } });
  assert.deepEqual(['gpt-5.3-codex', 'gemini-2.5-pro', 'deepseek-v4-pro', 'sonnet', 'mystery-model'].map(legacy), ['openai', 'gemini', 'deepseek', 'anthropic', 'anthropic']);
  // A provider the user added that lists the model now; the provider logged always wins.
  const known = (m: string) => (m === 'venice-uncensored' ? 'venice' : undefined);
  assert.equal(recordProvider({ models: { 'venice-uncensored': u(1) } }, known), 'venice');
  assert.equal(recordProvider({ models: { 'venice-uncensored': u(1) }, provider: 'openrouter' }, known), 'openrouter');
});

test('by provider: each at its own prices, the general total is their sum, a price unknown is said and never $0', () => {
  const day = at(2026, 11, 21, 10);
  const range = periodRange('today', new Date(day));
  const w = { id: 'w', name: 'hub-w', role: 'worker' as const };
  const records: TurnRecord[] = [
    { ...w, at: day, models: { 'claude-opus-5-5': u(100, 1000, 100) } }, // logged before the provider was kept: Anthropic
    { ...w, at: day + 1, models: { 'venice-uncensored': u(1.5, 1_000_000, 100_000), 'qwen-x': u(0, 2_000_000, 50_000) }, provider: 'venice', unpriced: ['qwen-x'] },
    { ...w, at: day + 2, models: { 'wan-2.5': u(0.5) }, provider: 'venice', kind: 'video' },
    { ...w, at: day + 3, models: { 'kling-x': u(0) }, provider: 'venice', kind: 'video', unpriced: ['kling-x'] },
    { ...w, at: day + 4, models: { 'gpt-6.1-sol': u(14, 2_000_000, 1_000_000) }, provider: 'openai' },
    { ...w, at: day + 5, models: { 'deepseek-v4-pro': u(2, 1_000_000, 100_000) }, provider: 'deepseek' },
    { ...w, at: day - 86_400_000, models: { 'gpt-6.1-sol': u(99) }, provider: 'openai' }, // another day
  ];
  const rows = byProvider(records, range);
  assert.deepEqual(rows.map((r) => [r.key, +r.usage.cost.toFixed(2), r.turns, r.videos]), [['anthropic', 100, 1, 0], ['openai', 14, 1, 0], ['venice', 2, 1, 2], ['deepseek', 2, 1, 0]]); // same cost: the most tokens first
  const venice = rows.find((r) => r.key === 'venice');
  assert.deepEqual(venice?.unpriced, { tokens: 2_050_000, videos: 1 });
  assert.deepEqual(rows.find((r) => r.key === 'openai')?.unpriced, { tokens: 0, videos: 0 });

  const all = summarize(records, range);
  assert.equal(+all.total.cost.toFixed(2), 118);
  assert.equal(+all.total.cost.toFixed(2), +rows.reduce((sum, r) => sum + r.usage.cost, 0).toFixed(2));
  assert.deepEqual([all.turns, all.videos, all.unpriced], [4, 2, { tokens: 2_050_000, videos: 1 }]);

  // One provider's view: its turns alone, by model, the one without a price last and marked.
  const mine = summarize(ofProvider(records, 'venice'), range);
  assert.deepEqual([+mine.total.cost.toFixed(2), mine.turns, mine.videos], [2, 1, 2]);
  assert.deepEqual(mine.models.map((m) => [m.model, m.usage.cost, m.unpriced]), [
    ['venice-uncensored', 1.5, { tokens: 0, videos: 0 }],
    ['wan-2.5', 0.5, { tokens: 0, videos: 0 }],
    ['qwen-x', 0, { tokens: 2_050_000, videos: 0 }],
    ['kling-x', 0, { tokens: 0, videos: 1 }],
  ]);
  assert.equal(ofProvider(records, 'anthropic').length, 1);
});
