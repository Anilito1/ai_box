import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { shouldShelve, signature } from '../../../scripts/vps/power.mjs';
import { ITEM_MAX, OUTBOX_MAX, Relay, stamp, withSeq } from '../../../scripts/vps/relay.mjs';
import { ovhSignature } from '../power';
import { readRunner, runnerLine } from '../remote';

type Line = Record<string, unknown>;

/** A relay with a fake Claude Code and a fake hub: what each one was sent, as objects. */
function setup(o: { outbox?: unknown[]; restart?: (same: boolean, send: () => void) => boolean } = {}) {
  const cli: Line[] = [];
  const hub: Line[] = [];
  const notes: string[] = [];
  const saved: unknown[][] = [];
  const kept: { seq: number; line: string }[] = [];
  let n = 0;
  const relay = new Relay({
    toCli: (l: string) => cli.push(JSON.parse(l)),
    journal: { append: (seq: number, line: string) => kept.push({ seq, line }), since: (s: number) => kept.filter((k) => k.seq > s) },
    outbox: o.outbox as never,
    saveOutbox: (items: unknown[]) => saved.push(items),
    notify: (kind: string) => notes.push(kind),
    texts: () => ({ queued: 'saved for the master', offline: 'hub offline', late: '[late {time}]', full: 'too many' }),
    newId: () => `id${++n}`,
    now: () => Date.UTC(2026, 10, 9, 23, 14),
    ...(o.restart ? { restart: o.restart } : {}),
  });
  const client = { send: (l: string) => hub.push(JSON.parse(l)) };
  const fromCli = (m: Line) => relay.fromCli(JSON.stringify(m));
  const fromHub = (m: Line) => relay.fromHub(JSON.stringify(m));
  /** The hub attaches and initializes, as its SDK does at each launch. */
  const attach = (since: number, initId = 'init') => {
    relay.attach(client, since);
    fromHub({ type: 'control_request', request_id: initId, request: { subtype: 'initialize', hooks: null } });
  };
  return { relay, cli, hub, notes, saved, kept, fromCli, fromHub, attach };
}

const hubCall = (id: string, name: string, args: Line = {}, rpc: unknown = 7) => ({
  type: 'control_request',
  request_id: id,
  request: { subtype: 'mcp_message', server_name: 'hub', message: { jsonrpc: '2.0', id: rpc, method: 'tools/call', params: { name, arguments: args } } },
});

test('attached, every line goes through; message lines are numbered and kept, deltas and control are not', () => {
  const r = setup();
  r.attach(0);
  assert.deepEqual(r.cli.map((m) => (m.request as Line).subtype), ['initialize']);
  r.fromCli({ type: 'control_response', response: { subtype: 'success', request_id: 'init', response: { models: ['m'] } } });
  r.fromCli({ type: 'system', subtype: 'init' });
  r.fromCli({ type: 'stream_event', event: {} });
  r.fromCli({ type: 'assistant', message: { content: [] } });
  r.fromCli(hubCall('c1', 'message_master', { message: 'hi' }));
  assert.deepEqual(
    r.hub.map((m) => [m.type, m.aibox_seq ?? null]),
    [['control_response', null], ['system', 1], ['stream_event', null], ['assistant', 2], ['control_request', null]],
  );
  assert.deepEqual(r.kept.map((k) => k.seq), [1, 2]);
  assert.equal(withSeq('{"a":1}', 3), '{"a":1,"aibox_seq":3}');
  // The hub answers its own tool: the answer reaches Claude Code.
  r.fromHub({ type: 'control_response', response: { subtype: 'success', request_id: 'c1', response: {} } });
  assert.equal(r.cli.at(-1)?.type, 'control_response');
  assert.equal(r.relay.waiting(), 0);
});

test('the hub away: a report is kept and answered, other tools say offline, a permission waits', () => {
  const r = setup();
  r.fromCli({ type: 'user', message: {} });
  r.fromCli(hubCall('c1', 'message_master', { message: 'done, pushed' }));
  assert.equal(r.relay.outbox.length, 1);
  assert.deepEqual(r.relay.outbox[0], { id: 'id1', at: Date.UTC(2026, 10, 9, 23, 14), afterSeq: 1, name: 'message_master', args: { message: 'done, pushed' } });
  assert.equal(r.saved.length, 1);
  const answer = r.cli.at(-1)?.response as Line;
  assert.equal(answer.request_id, 'c1');
  assert.deepEqual((answer.response as Line).mcp_response, { jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: 'saved for the master' }] } });

  r.fromCli(hubCall('c2', 'topic_memory', { topic: 'x', action: 'read' }));
  assert.equal(((((r.cli.at(-1)?.response as Line).response as Line).mcp_response as Line).result as Line).isError, true);
  r.fromCli({ type: 'control_request', request_id: 'c3', request: { subtype: 'mcp_message', server_name: 'hub', message: { jsonrpc: '2.0', method: 'notifications/initialized' } } });
  assert.deepEqual(((r.cli.at(-1)?.response as Line).response as Line).mcp_response, { jsonrpc: '2.0', result: {}, id: 0 });
  r.fromCli({ type: 'control_request', request_id: 'c4', request: { subtype: 'hook_callback', callback_id: 'h' } });
  assert.deepEqual((r.cli.at(-1)?.response as Line).response, {});

  const before = r.cli.length;
  r.fromCli({ type: 'control_request', request_id: 'p1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } });
  assert.equal(r.cli.length, before, 'a permission is never answered without the user');
  assert.equal(r.relay.waiting(), 1);
  assert.ok(r.relay.busy());
  assert.deepEqual(r.notes, ['blocked']);
  // The end of a turn with a report kept: the phone hears that a report waits.
  r.fromCli({ type: 'result', subtype: 'success' });
  assert.deepEqual(r.notes, ['blocked', 'report']);
});

test('back: initialize answered from the first one, then the missed lines, the kept report where it was written, the waiting request', () => {
  const r = setup();
  r.attach(0);
  r.fromCli({ type: 'control_response', response: { subtype: 'success', request_id: 'init', response: { models: ['m'] } } });
  r.fromCli({ type: 'assistant', n: 1 });
  r.relay.detach();
  r.fromCli({ type: 'assistant', n: 2 });
  r.fromCli(hubCall('c1', 'message_master', { message: 'report' }));
  r.fromCli({ type: 'assistant', n: 3 });
  r.fromCli({ type: 'control_request', request_id: 'p1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } });
  r.hub.length = 0;
  const toCli = r.cli.length;

  r.relay.attach({ send: (l: string) => r.hub.push(JSON.parse(l)) }, 1);
  // Claude Code goes on meanwhile: held until what was missed is given.
  r.fromCli({ type: 'assistant', n: 4 });
  assert.equal(r.hub.length, 0);
  r.fromHub({ type: 'control_request', request_id: 'init2', request: { subtype: 'initialize', hooks: null } });
  assert.equal(r.cli.length, toCli, 'a running Claude Code is not initialized twice');
  const shape = r.hub.map((m) => (m.type === 'control_request' ? `req:${(m.request as Line).subtype}` : m.type === 'control_response' ? `res:${(m.response as Line).request_id}` : `n${m.n}`));
  assert.deepEqual(shape, ['res:init2', 'n2', 'req:mcp_message', 'n3', 'n4', 'req:can_use_tool']);
  const handed = r.hub[2];
  const args = (((handed.request as Line).message as Line).params as Line).arguments as Line;
  assert.equal(args.message, `[late ${stamp(Date.UTC(2026, 10, 9, 23, 14))}]\nreport`);
  assert.equal(stamp(Date.UTC(2026, 10, 9, 23, 14)), '2026-11-09 23:14 UTC');

  // The hub ran it: forgotten, never handed twice; the permission's answer reaches Claude Code.
  r.fromHub({ type: 'control_response', response: { subtype: 'success', request_id: handed.request_id, response: {} } });
  assert.equal(r.relay.outbox.length, 0);
  r.fromHub({ type: 'control_response', response: { subtype: 'success', request_id: 'p1', response: { behavior: 'allow' } } });
  assert.equal((r.cli.at(-1)?.response as Line).request_id, 'p1');
  // A late answer to what was answered meanwhile is one too many.
  const n = r.cli.length;
  r.fromHub({ type: 'control_response', response: { subtype: 'success', request_id: 'c1', response: {} } });
  assert.equal(r.cli.length, n);
});

test('a worker that loops cannot fill the disk nor flood the master; a forged file hands nothing over', () => {
  const r = setup();
  for (let i = 0; i < OUTBOX_MAX + 5; i++) r.fromCli(hubCall(`c${i}`, 'message_master', { message: `n${i}` }));
  assert.equal(r.relay.outbox.length, OUTBOX_MAX);
  assert.equal(((((r.cli.at(-1)?.response as Line).response as Line).mcp_response as Line).result as Line).isError, true);
  r.fromCli(hubCall('big', 'send_message', { to: 'x', message: 'y'.repeat(ITEM_MAX + 1) }));
  assert.equal(r.relay.outbox.length, OUTBOX_MAX);
  const forged = setup({
    outbox: [
      { id: 'a', at: 1, afterSeq: 0, name: 'message_worker', args: { name: 'x', message: 'rm' } },
      { id: 'b', at: 'soon', afterSeq: 0, name: 'message_master', args: {} },
      { id: 'c', at: 1, afterSeq: 0, name: 'message_master', args: { message: 'ok' } },
    ],
  });
  assert.deepEqual(forged.relay.outbox.map((i: { id: string }) => i.id), ['c']);
});

test('a report kept but not run by the hub before it left again is handed at the next attach', () => {
  const r = setup({ outbox: [{ id: 'q1', at: 0, afterSeq: 0, name: 'send_message', args: { to: 'x', message: 'm' } }] });
  r.relay.initResponse = {};
  r.attach(0);
  assert.equal(r.hub.filter((m) => m.type === 'control_request').length, 1);
  r.relay.detach();
  r.hub.length = 0;
  r.attach(0, 'init3');
  assert.equal(r.hub.filter((m) => m.type === 'control_request').length, 1);
  assert.equal(r.relay.outbox.length, 1);
});

test('the hub leaves while one of its tools runs: the call is taken up as if it had been away', () => {
  const r = setup();
  r.attach(0);
  r.fromCli({ type: 'control_response', response: { subtype: 'success', request_id: 'init', response: {} } });
  r.fromCli(hubCall('c1', 'message_master', { message: 'x' }));
  r.relay.detach();
  assert.equal(r.relay.outbox.length, 1);
  assert.equal((r.cli.at(-1)?.response as Line).request_id, 'c1');
});

test('a new connection in place of a cut one not noticed yet: what was asked is asked again, no false "offline"', () => {
  const r = setup();
  r.attach(0);
  r.fromCli({ type: 'control_response', response: { subtype: 'success', request_id: 'init', response: {} } });
  r.fromCli(hubCall('c1', 'message_master', { message: 'x' }));
  const toCli = r.cli.length;
  r.hub.length = 0;
  r.attach(0, 'init2');
  assert.equal(r.cli.length, toCli, 'Claude Code gets no answer of the relay meanwhile');
  assert.equal(r.relay.outbox.length, 0);
  assert.deepEqual(r.notes, []);
  assert.equal(r.hub.filter((m) => m.request_id === 'c1').length, 1);
});

test('lines older than the journal keeps: the hub is told to read the transcript again', () => {
  const r = setup();
  r.fromCli({ type: 'assistant' });
  r.fromCli({ type: 'assistant' });
  r.kept.shift();
  r.relay.initResponse = {};
  r.attach(0);
  assert.deepEqual(r.hub.map((m) => m.type), ['control_response', 'aibox_gap', 'assistant']);
});

test('at rest with other settings: started again; at work: kept as it is', () => {
  const asked: boolean[] = [];
  let sent = 0;
  const r = setup({
    restart: (same, send) => {
      asked.push(same);
      if (same) return false;
      send();
      sent++;
      return true;
    },
  });
  r.attach(0);
  r.fromCli({ type: 'control_response', response: { subtype: 'success', request_id: 'init', response: { v: 1 } } });
  r.relay.detach();
  r.hub.length = 0;
  // Same settings: the first answer is given again.
  r.attach(0, 'i2');
  assert.deepEqual(asked, [true]);
  assert.equal(r.hub[0].type, 'control_response');
  r.relay.detach();
  // Other settings, at rest: the new initialize goes to the new process.
  r.relay.attach({ send: () => {} }, 0);
  r.fromHub({ type: 'control_request', request_id: 'i3', request: { subtype: 'initialize', hooks: null, append: 'new' } });
  assert.deepEqual(asked, [true, false]);
  assert.equal(sent, 1);
  assert.equal(r.relay.initResponse, null);
  // At work: never started again.
  r.fromCli({ type: 'control_response', response: { subtype: 'success', request_id: 'i3', response: { v: 2 } } });
  r.fromCli({ type: 'system', subtype: 'session_state_changed', state: 'running' });
  r.relay.detach();
  r.relay.attach({ send: () => {} }, 0);
  r.fromHub({ type: 'control_request', request_id: 'i4', request: { subtype: 'initialize', hooks: null, append: 'newer' } });
  assert.deepEqual(asked, [true, false]);
});

test('busy as Claude Code says it: its state, its background tasks', () => {
  const r = setup();
  r.fromCli({ type: 'system', subtype: 'session_state_changed', state: 'running' });
  assert.ok(r.relay.busy());
  r.fromCli({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't' }] });
  r.fromCli({ type: 'result', subtype: 'success' });
  r.fromCli({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
  assert.ok(r.relay.busy(), 'a task in the background keeps it at work');
  r.fromCli({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  assert.ok(!r.relay.busy());
});

test('the hub reads the runner: numbers told, its own lines taken out', async () => {
  assert.deepEqual(runnerLine('{"type":"assistant","aibox_seq":12}'), { seq: 12 });
  assert.equal(runnerLine('{"type":"aibox_gap"}'), 'gap');
  assert.equal(runnerLine('{"type":"aibox_state"}'), 'meta');
  assert.equal(runnerLine('{"type":"stream_event"}'), null);
  const src = new PassThrough();
  const seqs: number[] = [];
  let gaps = 0;
  const out = readRunner(src, { onSeq: (n) => seqs.push(n), onGap: () => gaps++ });
  let text = '';
  out.on('data', (b: Buffer) => (text += b.toString()));
  // Repeated gaps read the transcript once; a number that goes back is not taken.
  src.write('{"type":"aibox_gap"}\n{"type":"assistant","aibox_seq":4}\n{"type":"stream_ev');
  src.end('ent"}\n{"type":"aibox_gap"}\n{"type":"assistant","aibox_seq":2}\n');
  await new Promise((r) => out.on('end', r));
  assert.deepEqual(seqs, [4]);
  assert.equal(gaps, 1);
  assert.equal(text, '{"type":"assistant","aibox_seq":4}\n{"type":"stream_event"}\n{"type":"assistant","aibox_seq":2}\n');
});

test('the server shelves itself only on a fresh word that nothing ran for the delay', () => {
  const now = 10 * 3_600_000;
  const s = { idleHours: 2 };
  assert.equal(shouldShelve(null, s, now), 'no-state');
  assert.equal(shouldShelve({ at: now - 5 * 60_000, busy: false, idleSince: 0 }, s, now), 'stale');
  assert.equal(shouldShelve({ at: now, busy: true, idleSince: 0 }, s, now), 'busy');
  assert.equal(shouldShelve({ at: now, busy: false, idleSince: now - 3_600_000 }, s, now), 'not-yet');
  assert.equal(shouldShelve({ at: now, busy: false, idleSince: now - 3 * 3_600_000 }, s, now), 'shelve');
  assert.equal(shouldShelve({ at: now, busy: false, idleSince: 0 }, null, now), 'no-state');
  // The file is the workers' to write: a Claude Code still running says more than it.
  assert.equal(shouldShelve({ at: now, busy: false, idleSince: 0 }, s, now, 1), 'busy');
  // Signed on the server as the app signs on the PC.
  assert.equal(signature('s', 'c', 'POST', 'https://eu.api.ovh.com/1.0/x', '', 1), ovhSignature('s', 'c', 'POST', 'https://eu.api.ovh.com/1.0/x', '', 1));
});
