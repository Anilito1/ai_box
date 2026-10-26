import { slugify } from './team';

/**
 * Topics of the master's conversation: one per job the user follows (a feature, an audit, a migration…). The master
 * names the topic of each reply with the hub tool `topic`; the hub files the turn under it (the user's message before
 * it, the reply, the workers it writes to, their messages) and shows a badge while the master waits for the user.
 * A reply that names none is filed under the topic of the worker it is about, else it stays in "All".
 */

/** `worker`: longest session name slug a worker can have ("<post>-<job>" of 48, plus "-2"…). */
/** `links`: workers whose topic is remembered; `also`: further topics of one message. */
export const TOPIC_LIMITS = { id: 48, title: 60, question: 200, workers: 12, topics: 80, worker: 64, links: 400, also: 12 } as const;

/** A topic the hub made for a worker the master never filed (older conversations): a slug never holds a colon. */
const IMPLICIT = 'worker:';

export interface Topic {
  id: string;
  /** Empty: the topic keeps its title (a new one needs one). */
  title: string;
  /** The master waits for the user on it: a question, a decision, a go. */
  awaiting: boolean;
  question: string;
  /** Session names ("hub-…") of the workers on it. */
  workers: string[];
  /** Last activity, ms. A replayed transcript has no times: its topics count in its order, below any live one. */
  at: number;
}

/** What the master gave the `topic` tool, cleaned. */
export interface TopicCall {
  id: string;
  /** Empty: the topic keeps its title (a new one needs one). */
  title: string;
  awaiting: boolean;
  question: string;
  workers: string[];
}

/** One line of plain text: no control or format characters (direction overrides could disguise it), capped. */
export function oneLineText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const flat = v.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** slugify() cuts after trimming its dashes: a cut can leave one at the end. */
const slug = (raw: string, max: number) => slugify(raw, max).replace(/-+$/, '');

/** A worker as its session is named: "hub-<slug>", whatever the master typed. */
export const workerName = (raw: string): string => {
  const name = slug(raw, TOPIC_LIMITS.worker);
  return name ? `hub-${name}` : '';
};

const WORKER = /^hub-[a-z0-9]+(-[a-z0-9]+)*$/;
const isWorker = (v: unknown): v is string => typeof v === 'string' && v.length <= TOPIC_LIMITS.worker + 4 && WORKER.test(v);

/** A topic id the hub knows the shape of: a slug, or a worker's own topic. */
export const isTopicId = (v: unknown): v is string =>
  typeof v === 'string' &&
  (v.startsWith(IMPLICIT) ? isWorker(v.slice(IMPLICIT.length)) : v.length <= TOPIC_LIMITS.id && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(v));

export const isImplicit = (id: string) => id.startsWith(IMPLICIT);

/** The worker a worker's own topic is about ("brain" for "worker:hub-brain"), else ''. */
export const implicitWorker = (id: string) => (isImplicit(id) ? id.slice(IMPLICIT.length).replace(/^hub-/, '') : '');

/** The `topic` tool's input as the hub keeps it; null without a usable id. */
export function parseTopicCall(raw: unknown): TopicCall | null {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const id = typeof o.id === 'string' ? slug(o.id, TOPIC_LIMITS.id) : '';
  if (!id) return null;
  const names = Array.isArray(o.workers) ? o.workers.slice(0, 40).map((w) => (typeof w === 'string' ? workerName(w) : '')) : [];
  const awaiting = o.awaiting_user === true;
  return {
    id,
    title: oneLineText(o.title, TOPIC_LIMITS.title),
    awaiting,
    question: awaiting ? oneLineText(o.question, TOPIC_LIMITS.question) : '',
    workers: [...new Set(names.filter(Boolean))].slice(0, TOPIC_LIMITS.workers),
  };
}

/** Where a message to the master comes from, as far as topics go. */
export interface TopicInput {
  /** The topic the hub put on it: the one the user wrote in, or the worker's that a hub message is about. */
  topic?: string | null;
  /** Session name of the worker that wrote it. */
  worker?: string | null;
  /** Written by the user: an answer on a topic clears its badge. */
  user?: boolean;
}

interface Input {
  id: string;
  topic: string | null;
  worker: string | null;
  user: boolean;
  /** Filed under a worker's own topic: the topic the master names for this turn takes it over. */
  soft: boolean;
  /** Filed by the reply that took it (not by the user's choice nor a worker's topic). */
  byReply: boolean;
  /** Further topics of a request about several jobs: each one its reply named after the first. */
  also: string[];
  /** What the model was sent: the replay of a queued prompt says which one it took. */
  key: string;
}

interface Turn {
  /** The topic in force: the one the reply named last. */
  topic: string | null;
  /** Every topic the reply named, in order. */
  named: string[];
  /** The messages the reply answers. */
  inputs: Input[];
  /** Items of the reply before it named a topic. */
  items: Set<string>;
  /** The reply's text: a reply about several jobs speaks of each, so it goes to each topic it names. */
  texts: string[];
  /** Workers the reply wrote to before it named a topic. */
  workers: string[];
  /** Workers a topic call of this reply named: what the reply writes to them goes to that topic. */
  workerTopics: Map<string, string>;
  /** Topics this reply created. */
  created: Set<string>;
  /** Topic of the reply's last tool call: an approval it asks for belongs there. */
  lastTool: string | null;
  replied: boolean;
}

/** The turn being read, and the prompts shown but not yet taken by the model. */
interface Context {
  turn: Turn;
  queue: Input[];
  now: () => number;
  /** `also`: a further topic of these items, their own one staying. */
  assign: (ids: string[], topic: string, also?: boolean) => void;
}

/** A transcript entry as the replay reads it, in order. */
export type ReplayStep =
  | { kind: 'input'; id: string; input: TopicInput }
  | { kind: 'topic'; call: TopicCall }
  /** `spawn`: the session is named when it starts (the hub may add "-2"). */
  | { kind: 'wrote'; worker: string; spawn?: boolean }
  /** An item of the reply: `text` (the reply's words), `tool` a call, `worker` the worker the call writes to. */
  | { kind: 'item'; id: string; text?: boolean; tool?: boolean; worker?: string };

export interface TopicState {
  /** The master's conversation the topics belong to. */
  conversation: string;
  topics: Topic[];
  links: [string, string][];
}

const newTurn = (): Turn => ({
  topic: null,
  named: [],
  inputs: [],
  items: new Set(),
  texts: [],
  workers: [],
  workerTopics: new Map(),
  created: new Set(),
  lastTool: null,
  replied: false,
});

/**
 * Files the master's conversation by topic as it goes (and once more from its transcript at each start). Item ids are
 * the conversation's; the hub sets each item's topics from what the calls return (its own first), and from `assign`
 * for the items a later call settles.
 */
export class TopicTracker {
  private topics = new Map<string, Topic>();
  /** The topic of each worker: the last one the master wrote to it under. */
  private links = new Map<string, string>();
  /** Workers about to start under a name already taken: the topic the new one gets (null: the reply's, later). */
  private expected = new Map<string, string | null>();
  private ctx: Context;
  /** Off while a transcript is replayed: its topics have no real time yet. */
  private pruning = true;

  constructor(assign: (ids: string[], topic: string, also?: boolean) => void, now: () => number = Date.now) {
    this.ctx = { turn: newTurn(), queue: [], now, assign };
  }

  has(id: string): boolean {
    return this.topics.has(id);
  }

  get(id: string): Topic | undefined {
    return this.topics.get(id);
  }

  linkOf(worker: string): string | undefined {
    return this.links.get(worker);
  }

  /** Named for the first time by the reply in progress. */
  createdNow(id: string): boolean {
    return this.ctx.turn.created.has(id);
  }

  /** Most recent activity first. */
  list(): Topic[] {
    return [...this.topics.values()].sort((a, b) => b.at - a.at);
  }

  /** A new conversation: nothing of the last one applies. */
  reset(): void {
    this.topics.clear();
    this.links.clear();
    this.expected.clear();
    this.ctx.turn = newTurn();
    this.ctx.queue = [];
  }

  /**
   * A message reaches the master's conversation: filed now when its topic is known. `queued`: the model takes it
   * later (`taken()`), `key` being what it was sent; else it is part of the turn now. Returns its topic.
   */
  shown(id: string, meta: TopicInput, queued: boolean, key = ''): string | null {
    const input = this.input(id, meta, key);
    if (queued) this.ctx.queue.push(input);
    else this.take(input);
    return input.topic;
  }

  /**
   * The model took a queued message (`key`: the text it replays; unknown, the oldest). Those queued before it were
   * taken without a replay (a command Claude Code runs itself): they go with it. A reply under way ends there.
   */
  taken(key = ''): void {
    const { queue } = this.ctx;
    const at = key ? queue.findIndex((i) => i.key === key) : -1;
    for (const input of queue.splice(0, Math.max(0, at) + 1)) this.take(input);
  }

  /** An item of the master's reply (`text`: its words): its topics, its own first; none until the reply names one. */
  reply(id: string, text = false): string[] {
    const { turn } = this.ctx;
    turn.replied = true;
    if (text && !turn.texts.includes(id)) turn.texts.push(id);
    if (!turn.topic) {
      turn.items.add(id);
      return [];
    }
    this.touch(turn.topic);
    return text ? [turn.topic, ...turn.named.filter((t) => t !== turn.topic)] : [turn.topic];
  }

  /** A tool call of the reply: under the topic its worker was named in, else the reply's. */
  tool(id: string, worker?: string): string[] {
    const { turn } = this.ctx;
    const named = worker ? turn.workerTopics.get(worker) : undefined;
    if (named) turn.replied = true;
    const topics = named ? [this.touch(named)] : this.reply(id);
    turn.lastTool = topics[0] ?? turn.lastTool;
    return topics;
  }

  /** A notice or an approval card in the master's conversation: the topic of the reply's last call, if named. */
  note(): string | null {
    const topic = this.ctx.turn.lastTool ?? this.ctx.turn.topic;
    return topic ? this.touch(topic) : null;
  }

  /**
   * The master named the topic of its reply (a later call of the same reply switches to another). A new topic needs a
   * title: without one the call is refused (null), as the tool refuses it.
   */
  declare(call: TopicCall): Topic | null {
    const { turn } = this.ctx;
    const at = this.ctx.now();
    let topic = this.topics.get(call.id);
    if (!topic) {
      if (!call.title) return null;
      topic = { id: call.id, title: call.title, awaiting: false, question: '', workers: [], at };
      this.topics.set(call.id, topic);
      turn.created.add(call.id);
    } else if (call.title) topic.title = call.title;
    const first = !turn.topic;
    const fresh = !turn.named.includes(call.id);
    turn.topic = call.id;
    turn.replied = true;
    if (fresh) turn.named.push(call.id);
    if (first) {
      const ids: string[] = [];
      for (const input of turn.inputs) {
        if (input.topic && !input.soft) continue;
        if (input.topic !== call.id) ids.push(input.id);
        Object.assign(input, { topic: call.id, soft: false, byReply: true });
        const link = input.worker ? this.links.get(input.worker) : undefined;
        if (input.worker && (!link || isImplicit(link))) this.link(input.worker, call.id);
      }
      ids.push(...turn.items);
      turn.items.clear();
      for (const w of turn.workers) this.link(w, call.id);
      turn.workers = [];
      if (ids.length > 0) this.ctx.assign(ids, call.id);
    } else if (fresh) {
      // A reply about several jobs: the user's request and the reply's words belong to each topic it names.
      const requests = turn.inputs.filter((i) => i.byReply && i.user && i.topic !== call.id && !i.also.includes(call.id) && i.also.length < TOPIC_LIMITS.also);
      for (const input of requests) input.also.push(call.id);
      const ids = [...requests.map((i) => i.id), ...(turn.named.length <= TOPIC_LIMITS.also ? turn.texts : [])];
      if (ids.length > 0) this.ctx.assign(ids, call.id, true);
    }
    for (const w of call.workers) {
      this.link(w, call.id);
      turn.workerTopics.set(w, call.id);
    }
    topic.awaiting = call.awaiting;
    topic.question = call.question;
    topic.at = Math.max(topic.at, at);
    this.prune();
    return topic;
  }

  /** The master's reply wrote to a worker (spawn_worker, message_worker): the worker follows the reply's topic. */
  wrote(worker: string): void {
    const { turn } = this.ctx;
    const topic = turn.workerTopics.get(worker) ?? turn.topic;
    if (topic) this.link(worker, topic);
    else if (!turn.workers.includes(worker)) turn.workers.push(worker);
  }

  /** The reply starts a worker under a name another worker has: the new one, whatever its name, takes the topic. */
  expect(worker: string): void {
    const { turn } = this.ctx;
    this.expected.set(worker, turn.workerTopics.get(worker) ?? turn.topic);
  }

  /** The worker a reply started under `asked` runs as `actual`. */
  alias(asked: string, actual: string): void {
    if (!this.expected.has(asked)) return;
    const topic = this.expected.get(asked);
    this.expected.delete(asked);
    if (asked === actual) return;
    if (topic) this.link(actual, topic);
    else this.wrote(actual);
  }

  /**
   * The master's turn is over. `drained`: nothing waits any more, so the messages still queued were taken without
   * being replayed. A reply that named no topic goes to the one topic its messages and workers point to.
   */
  end(drained = false): void {
    const { ctx } = this;
    const turn = ctx.turn;
    ctx.turn = newTurn();
    if (drained) turn.inputs.push(...ctx.queue.splice(0));
    const first = turn.named[0];
    if (first) {
      const late = turn.inputs.filter((i) => !i.topic || i.soft);
      for (const input of late) Object.assign(input, { topic: first, soft: false });
      if (late.length > 0) ctx.assign(late.map((i) => i.id), first);
      return;
    }
    const topics = new Set<string>();
    const loose = new Set<string>();
    for (const input of turn.inputs) {
      const topic = input.topic ?? (input.worker ? this.links.get(input.worker) : undefined);
      if (topic) topics.add(topic);
      else if (input.worker) loose.add(input.worker);
    }
    for (const w of turn.workers) {
      const topic = this.links.get(w);
      if (topic) topics.add(topic);
      else loose.add(w);
    }
    // A general message, or one about several jobs: it stays in "All".
    if (topics.size + loose.size !== 1) return;
    const topic = topics.size === 1 ? ([...topics][0] as string) : this.implicit([...loose][0] as string);
    const ids: string[] = [];
    for (const input of turn.inputs) {
      if (input.topic) continue;
      input.topic = topic;
      ids.push(input.id);
      if (input.user) this.answered(topic);
    }
    for (const w of turn.workers) if (!this.links.has(w)) this.link(w, topic);
    ids.push(...turn.items);
    if (ids.length > 0) {
      this.touch(topic);
      ctx.assign(ids, topic);
    }
  }

  /**
   * Files a transcript read from disk: the topics and the workers' links come out of the master's own calls. Returns
   * the topics of each item it could file, its own first. The turn in progress and the queue are left alone.
   */
  replay(steps: ReplayStep[]): Map<string, string[]> {
    const filed = new Map<string, string[]>();
    const file = (id: string, topics: string[], also = false) => {
      const before = also ? (filed.get(id) ?? []) : [];
      if (topics.length > 0) filed.set(id, [...new Set([...before, ...topics])]);
    };
    const live = this.ctx;
    const kept = this.links;
    let tick = 0;
    this.links = new Map();
    this.pruning = false;
    this.ctx = { turn: newTurn(), queue: [], now: () => ++tick, assign: (ids, topic, also) => ids.forEach((id) => file(id, [topic], also)) };
    try {
      for (const step of steps) {
        if (step.kind === 'input') {
          const topic = this.shown(step.id, step.input, false);
          if (topic) file(step.id, [topic]);
        } else if (step.kind === 'topic') {
          this.declare(step.call);
        } else if (step.kind === 'wrote') {
          this.wrote(step.worker);
        } else {
          file(step.id, step.tool ? this.tool(step.id, step.worker) : this.reply(step.id, step.text));
        }
      }
      this.end();
    } finally {
      // Workers the window does not reach keep the link they had.
      for (const [w, topic] of kept) if (!this.links.has(w) && this.topics.has(topic)) this.link(w, topic);
      this.ctx = live;
      this.pruning = true;
    }
    this.prune();
    for (const [id, topics] of filed) {
      const left = topics.filter((t) => this.topics.has(t));
      if (left.length > 0) filed.set(id, left);
      else filed.delete(id);
    }
    return filed;
  }

  state(conversation: string): TopicState {
    return { conversation, topics: this.list(), links: [...this.links] };
  }

  /** Topics saved with this conversation; anything malformed is dropped. */
  restore(raw: unknown, conversation: string): void {
    this.reset();
    const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof TopicState, unknown>>;
    if (s.conversation !== conversation || !Array.isArray(s.topics)) return;
    for (const t of s.topics.slice(0, TOPIC_LIMITS.topics) as Partial<Topic>[]) {
      if (!t || !isTopicId(t.id) || typeof t.at !== 'number' || !Number.isFinite(t.at)) continue;
      const workers = Array.isArray(t.workers) ? t.workers.filter(isWorker) : [];
      this.topics.set(t.id, {
        id: t.id,
        title: oneLineText(t.title, TOPIC_LIMITS.title) || t.id,
        awaiting: t.awaiting === true,
        question: oneLineText(t.question, TOPIC_LIMITS.question),
        workers: workers.slice(0, TOPIC_LIMITS.workers),
        at: t.at,
      });
    }
    if (!Array.isArray(s.links)) return;
    for (const pair of s.links) {
      if (Array.isArray(pair) && isWorker(pair[0]) && typeof pair[1] === 'string' && this.topics.has(pair[1])) this.links.set(pair[0], pair[1]);
    }
  }

  private input(id: string, meta: TopicInput, key: string): Input {
    const worker = meta.worker || null;
    const given = meta.topic && this.topics.has(meta.topic) ? meta.topic : null;
    const topic = given ?? (worker ? (this.links.get(worker) ?? null) : null);
    const input: Input = { id, topic, worker, user: !!meta.user, soft: !!topic && isImplicit(topic), byReply: false, also: [], key };
    if (topic) {
      this.touch(topic);
      if (input.user) this.answered(topic);
    }
    return input;
  }

  /** A message the model takes: a reply already under way ends with it. */
  private take(input: Input): void {
    if (this.ctx.turn.replied) this.end();
    this.ctx.turn.inputs.push(input);
  }

  private answered(id: string): void {
    const topic = this.topics.get(id);
    if (topic) Object.assign(topic, { awaiting: false, question: '' });
  }

  private touch(id: string): string {
    const topic = this.topics.get(id);
    if (topic) topic.at = Math.max(topic.at, this.ctx.now());
    return id;
  }

  private link(worker: string, id: string): void {
    const before = this.links.get(worker);
    if (before && before !== id) {
      const old = this.topics.get(before);
      if (old) old.workers = old.workers.filter((w) => w !== worker);
    }
    // The most recent last: the oldest link goes once there are too many.
    this.links.delete(worker);
    this.links.set(worker, id);
    if (this.links.size > TOPIC_LIMITS.links) this.links.delete(this.links.keys().next().value as string);
    const topic = this.topics.get(id);
    if (topic && !topic.workers.includes(worker)) topic.workers = [...topic.workers, worker].slice(-TOPIC_LIMITS.workers);
  }

  /** The topic of a worker no topic was named for: its own, under its name. */
  private implicit(worker: string): string {
    const id = `${IMPLICIT}${worker}`;
    if (!this.topics.has(id)) this.topics.set(id, { id, title: worker.replace(/^hub-/, ''), awaiting: false, question: '', workers: [], at: this.ctx.now() });
    this.link(worker, id);
    this.prune();
    return id;
  }

  /** Oldest topics go first, never one that waits for the user. */
  private prune(): void {
    if (!this.pruning || this.topics.size <= TOPIC_LIMITS.topics) return;
    const old = [...this.topics.values()].filter((t) => !t.awaiting).sort((a, b) => a.at - b.at);
    for (const t of old.slice(0, this.topics.size - TOPIC_LIMITS.topics)) {
      this.topics.delete(t.id);
      for (const [w, id] of this.links) if (id === t.id) this.links.delete(w);
    }
  }
}
