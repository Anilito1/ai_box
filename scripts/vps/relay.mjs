// The relay between one Claude Code session on the server and the hub, whether the hub is there or not (runner.mjs
// holds one per conversation). No I/O of its own: the runner gives it the CLI's and the hub's lines and the ways out.
//
// Claude Code speaks stream-json on stdio; the hub's Agent SDK speaks it on the other side, over SSH. While the hub is
// attached, every line goes through as it is, and the relay only watches. Each message line (not the streamed deltas
// nor the control traffic) gets a number, "aibox_seq", and is kept in the session's journal. While the hub is away:
//   - a call of the hub's tools that only tells something (message_master, message_lead, send_message) is answered
//     "saved", and kept in the outbox; at the next attach it is handed to the hub as the same call, then forgotten;
//   - any other tool of the hub answers that the hub is offline;
//   - a permission, a question, anything else waits, untouched, and goes to the hub when it attaches.
// The hub attaches with the number of the last line it got: the lines after it, the outbox and the requests still
// waiting are given in that order, once its SDK's `initialize` has been answered (from the first one's answer when the
// process already ran).

/** The hub's tools that only tell something: kept while the hub is away, given to it when it attaches. */
export const QUEUED_TOOLS = ['message_master', 'message_lead', 'send_message'];
const HUB = 'hub';

const parse = (line) => {
  try {
    const o = JSON.parse(line);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
};
const json = (o) => JSON.stringify(o);

/** Messages kept for the hub at most, and the size of one: a worker that loops cannot fill the disk nor flood the master. */
export const OUTBOX_MAX = 50;
export const ITEM_MAX = 64 * 1024;

const validItem = (i) =>
  !!i &&
  typeof i === 'object' &&
  typeof i.id === 'string' &&
  /^[\w-]{1,64}$/.test(i.id) &&
  Number.isFinite(i.at) &&
  Number.isInteger(i.afterSeq) &&
  QUEUED_TOOLS.includes(i.name) &&
  !!i.args &&
  typeof i.args === 'object' &&
  !Array.isArray(i.args) &&
  JSON.stringify(i.args).length <= ITEM_MAX;

/** A message line with its number: the SDK hands unknown fields through to the hub, which reads it back. */
export const withSeq = (line, seq) => (line.endsWith('}') ? `${line.slice(0, -1)},"aibox_seq":${seq}}` : line);

/** "2026-11-09 23:14 UTC": when a queued message was written, in the note the hub's copy starts with. */
export const stamp = (at) => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

export class Relay {
  /**
   * @param {{
   *   toCli(line: string): void,
   *   journal: { append(seq: number, line: string): void, since(seq: number): { seq: number, line: string }[] },
   *   seq?: number,
   *   outbox?: { id: string, at: number, afterSeq: number, name: string, args: Record<string, unknown> }[],
   *   saveOutbox(items: unknown[]): void,
   *   notify(kind: 'done' | 'blocked' | 'report'): void,
   *   texts(): { queued: string, offline: string, late: string, full: string },
   *   newId(): string,
   *   restart?(sameInit: boolean, sendInit: () => void): boolean,
   *   now?: () => number,
   * }} o
   */
  constructor(o) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.seq = o.seq ?? 0;
    // Read back from disk (aibox's): only what the relay itself would have kept is handed over later.
    this.outbox = (o.outbox ?? []).filter(validItem);
    /** The hub's side of the stream, or null while it is away. */
    this.client = null;
    /** Attached, but what it missed is not given yet: what comes meanwhile waits in the journal. */
    this.holding = false;
    this.since = 0;
    /** As Claude Code reports it (session_state_changed), else from the turns' starts and results. */
    this.state = 'idle';
    this.stateEvents = false;
    this.runningSince = null;
    this.tasks = 0;
    this.activeAt = this.now();
    /** Requests of Claude Code not answered yet, by id: their line, and what they ask. */
    this.pending = new Map();
    /** The answer of the first `initialize`: a hub attaching to a running process gets it again. */
    this.initResponse = null;
    this.initId = null;
    /** What that first `initialize` asked: another one asks something else when the hub's settings changed. */
    this.initRequest = '';
    /** The ids of the outbox's calls handed to the hub, until it answers them. */
    this.handed = new Map();
    /** The runner's own requests to Claude Code (an interrupt): their answer goes to it, not to the hub. */
    this.own = new Map();
  }

  /** Working, waiting for an answer, or with tasks of its own running in the background: never ended as idle. */
  busy() {
    return this.state !== 'idle' || this.tasks > 0 || this.waiting() > 0;
  }

  /** Requests that wait for the hub (a permission, a question): none of them can be answered without it. */
  waiting() {
    return this.pending.size;
  }

  view() {
    return { state: this.state, tasks: this.tasks, waiting: this.waiting(), outbox: this.outbox.length, attached: this.client !== null, seq: this.seq, activeAt: this.activeAt };
  }

  // ---------- Claude Code's side ----------

  fromCli(line) {
    const m = parse(line);
    if (!m) return this.toHub(line);
    if (m.type === 'stream_event' || m.type === 'keep_alive') return this.toHub(line);
    if (m.type === 'control_request') return this.cliAsks(line, m);
    if (m.type === 'control_cancel_request') {
      this.pending.delete(m.request_id);
      return this.toHub(line);
    }
    if (m.type === 'control_response') return this.cliAnswers(line, m);
    this.activeAt = this.now();
    if (m.type === 'system' && m.subtype === 'session_state_changed' && ['idle', 'running', 'requires_action'].includes(m.state)) {
      this.stateEvents = true;
      this.setState(m.state);
    } else if (m.type === 'system' && m.subtype === 'background_tasks_changed') {
      this.tasks = Array.isArray(m.tasks) ? m.tasks.length : 0;
    } else if (m.type === 'result' && !this.stateEvents) {
      this.setState('idle');
    }
    this.seq += 1;
    const out = withSeq(line, this.seq);
    this.o.journal.append(this.seq, out);
    this.toHub(out);
    if (m.type === 'result' && !this.client) this.o.notify(this.outbox.length > 0 ? 'report' : 'done');
  }

  setState(state) {
    if (state !== 'idle' && this.state === 'idle') this.runningSince = this.now();
    if (state === 'idle') this.runningSince = null;
    this.state = state;
  }

  cliAsks(line, m) {
    this.pending.set(m.request_id, { line, m });
    if (this.client) {
      if (!this.holding) this.client.send(line);
      return;
    }
    this.offline(m.request_id);
  }

  cliAnswers(line, m) {
    const id = m.response?.request_id;
    if (id !== undefined && id === this.initId) {
      this.initId = null;
      if (m.response.subtype === 'success') this.initResponse = m.response.response ?? {};
      if (this.client) {
        this.client.send(line);
        this.replay();
      }
      return;
    }
    const mine = this.own.get(id);
    if (mine) {
      this.own.delete(id);
      return mine(m.response);
    }
    this.toHub(line);
  }

  /** The hub is away: what can be answered without it is, the rest waits for it. */
  offline(id) {
    const p = this.pending.get(id);
    if (!p) return;
    const r = p.m.request ?? {};
    if (r.subtype === 'mcp_message') {
      const msg = r.message && typeof r.message === 'object' ? r.message : {};
      // A notification: the SDK's own answer, with nothing in it.
      if (msg.id === undefined || msg.id === null) return this.answerCli(id, { mcp_response: { jsonrpc: '2.0', result: {}, id: 0 } });
      const name = msg.params?.name;
      if (r.server_name === HUB && msg.method === 'tools/call' && QUEUED_TOOLS.includes(name)) {
        const args = msg.params.arguments && typeof msg.params.arguments === 'object' ? msg.params.arguments : {};
        const item = { id: this.o.newId(), at: this.now(), afterSeq: this.seq, name, args };
        if (this.outbox.length >= OUTBOX_MAX || !validItem(item)) {
          return this.answerCli(id, { mcp_response: { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: this.o.texts().full }], isError: true } } });
        }
        this.outbox.push(item);
        this.o.saveOutbox(this.outbox);
        return this.answerCli(id, { mcp_response: { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: this.o.texts().queued }] } } });
      }
      const offline = this.o.texts().offline;
      if (msg.method === 'tools/call') return this.answerCli(id, { mcp_response: { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: offline }], isError: true } } });
      return this.answerCli(id, { mcp_response: { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: offline } } });
    }
    // The hub registers no hooks: no decision, as the SDK would give for an unknown one.
    if (r.subtype === 'hook_callback') return this.answerCli(id, {});
    // A permission, a question, a form: only the user can answer, through the hub.
    this.o.notify('blocked');
  }

  answerCli(id, response) {
    this.pending.delete(id);
    this.o.toCli(json({ type: 'control_response', response: { subtype: 'success', request_id: id, response } }));
  }

  /** A request of the runner's own (an interrupt before the server stops): its answer comes back to `done`. */
  ask(request, done) {
    const id = `aibox-${this.o.newId()}`;
    this.own.set(id, done);
    this.o.toCli(json({ type: 'control_request', request_id: id, request }));
  }

  // ---------- the hub's side ----------

  toHub(line) {
    if (this.client && !this.holding) this.client.send(line);
  }

  /**
   * The hub is here, with the number of the last line it got. What it missed comes once its `initialize` is answered:
   * by Claude Code when it was just started for it, else from the first answer, given again.
   */
  attach(client, since) {
    // In place of a connection not noticed as cut yet: what was asked of it is asked again of this one (replay), with
    // no "offline" answer in between. Delivery is at least once: a call the old hub ran just before the cut comes twice.
    this.handed.clear();
    this.client = client;
    this.since = Number.isInteger(since) && since >= 0 ? since : 0;
    this.holding = true;
  }

  fromHub(line) {
    const m = parse(line);
    if (!m) return this.o.toCli(line);
    if (m.type === 'control_request' && m.request?.subtype === 'initialize') {
      const asked = json(m.request);
      if (this.initResponse && this.client) {
        // At rest, with other settings than it runs with (instructions, tools, model...): started again with them, as
        // a session of the PC would be. At work: kept as it is, the work matters more.
        if (!this.busy() && this.o.restart?.(asked === this.initRequest, () => this.o.toCli(line))) {
          Object.assign(this, { initResponse: null, initId: m.request_id, initRequest: asked });
          return;
        }
        this.client.send(json({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: this.initResponse } }));
        return this.replay();
      }
      this.initId = m.request_id;
      this.initRequest = asked;
      return this.o.toCli(line);
    }
    if (m.type === 'control_response') {
      const id = m.response?.request_id;
      const handed = this.handed.get(id);
      if (handed !== undefined) {
        this.handed.delete(id);
        // Given to the hub, which ran it (a failure of the hub is its own, not a reason to give it twice).
        this.outbox = this.outbox.filter((i) => i.id !== handed);
        this.o.saveOutbox(this.outbox);
        return;
      }
      // Answered meanwhile without the hub: its late answer would be one too many.
      if (!this.pending.has(id)) return;
      this.pending.delete(id);
      return this.o.toCli(line);
    }
    if (m.type === 'user') {
      this.activeAt = this.now();
      if (!this.stateEvents) this.setState('running');
    }
    this.o.toCli(line);
  }

  /** What the hub missed: the lines after its last one, the outbox where it was written, then the requests waiting. */
  replay() {
    const c = this.client;
    if (!c) return;
    const lines = this.since < this.seq ? this.o.journal.since(this.since) : [];
    // Older than the journal keeps: the hub reads the conversation again from its transcript.
    if (lines.length < this.seq - this.since) c.send(json({ type: 'aibox_gap' }));
    const queue = [...this.outbox].sort((a, b) => a.afterSeq - b.afterSeq);
    const hand = (item) => {
      const rid = `aibox-q-${item.id}`;
      this.handed.set(rid, item.id);
      const args = { ...item.args };
      if (typeof args.message === 'string') args.message = `${this.o.texts().late.replace('{time}', stamp(item.at))}\n${args.message}`;
      c.send(json({ type: 'control_request', request_id: rid, request: { subtype: 'mcp_message', server_name: HUB, message: { jsonrpc: '2.0', id: rid, method: 'tools/call', params: { name: item.name, arguments: args } } } }));
    };
    for (const { seq, line } of lines) {
      while (queue.length > 0 && queue[0].afterSeq < seq) hand(queue.shift());
      c.send(line);
    }
    for (const item of queue) hand(item);
    for (const { line } of this.pending.values()) c.send(line);
    this.holding = false;
  }

  /** The hub left: what it was asked and did not answer is taken up as if it had been away all along. */
  detach() {
    this.client = null;
    this.holding = false;
    this.handed.clear();
    for (const id of [...this.pending.keys()]) this.offline(id);
  }
}
