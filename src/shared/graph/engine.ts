import type { ModelSpec } from '../modelCaps';
import { endpoint, nodeName, nodePorts, nodeSpec, type Catalog, type Graph, type GraphNode } from './format';
import { ancestors, errorsOf, topoOrder, validateGraph, type Issue } from './validate';

// Runs a graph: each node once everything it reads is there, nodes that do not depend on each other at the same
// time. The engine knows no provider: the calls go to the runners it is given (simulated or real), so the same code
// runs in the tests and in the main process. No Node, no DOM; its few words come from `say`.

/** What travels on a wire. A wire carries a list: one text, four frames. */
export type Value =
  | { type: 'text'; text: string }
  | {
      type: 'image' | 'video' | 'audio';
      mime: string;
      bytes: Uint8Array;
      /** What it is, in a few words, when the runner knows ("192×112, 3 s"). */
      label?: string;
      /** Simulated media: what it was drawn from, so a simulated reader can say what it "saw". */
      sim?: { seed: number; about: string };
    };

export type MediaValue = Exclude<Value, { type: 'text' }>;

/** One past exchange of the conversation. */
export interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

/** One node to run, with the values its wires brought. */
export interface NodeCall {
  node: GraphNode;
  /** The node's model; null for a conversion. */
  spec: ModelSpec | null;
  inputs: Record<string, Value[]>;
  /** The conversation so far, for the nodes the chat's text is wired to; empty for the others. */
  history: Turn[];
}

export interface NodeResult {
  outputs: Record<string, Value[]>;
  /** What the call cost in US dollars, when known. */
  costUsd?: number;
}

export interface RunContext {
  signal: AbortSignal;
  /** Where a long call is, shown on the node. */
  progress(text: string): void;
}

/** A call that answers when it is done. */
export interface DirectRunner {
  /** What the call will cost, before it is made; null when unknown. A free call says 0. */
  estimate?(call: NodeCall, ctx: RunContext): Promise<number | null>;
  run(call: NodeCall, ctx: RunContext): Promise<NodeResult>;
}

export type Polled = { state: 'pending'; progress?: string } | { state: 'done'; result: NodeResult };

/** A call that goes through the provider's queue: the engine owns the wait, the runner only asks once. */
export interface QueuedRunner<Job = unknown> {
  estimate?(call: NodeCall, ctx: RunContext): Promise<number | null>;
  pollEveryMs?: number;
  submit(call: NodeCall, ctx: RunContext): Promise<Job>;
  poll(job: Job, call: NodeCall, ctx: RunContext): Promise<Polled>;
  /** The provider may forget the job: its result is with the engine. Best effort. */
  release?(job: Job, ctx: RunContext): Promise<void>;
}

export type Runner = DirectRunner | QueuedRunner;

export type NodeState = 'pending' | 'running' | 'done' | 'error' | 'skipped';
export type RunState = 'running' | 'done' | 'error' | 'cancelled';

export type RunEvent =
  | { type: 'run'; state: RunState; order?: string[]; error?: string; issues?: Issue[]; costUsd: number }
  | {
      type: 'node';
      id: string;
      state: NodeState;
      progress?: string;
      outputs?: Record<string, Value[]>;
      error?: string;
      costUsd?: number;
      ms?: number;
      /** A queued job the provider took: what a later run would need to pick it up again. */
      job?: unknown;
    };

/** The engine's own words, said by the caller in its language. */
export type EngineText =
  | 'kind.chat-input'
  | 'kind.chat-output'
  | 'kind.model'
  | 'kind.convert'
  | 'run.invalid'
  | 'run.failed'
  | 'run.no-runner'
  | 'run.empty-input'
  | 'run.cap-reached'
  | 'run.over-cap'
  | 'run.unknown-price'
  | 'run.queued'
  | 'run.timeout';
export type Say = (code: EngineText, params?: Record<string, string | number>) => string;

/** Words for tests and logs: the code and its values. */
export const plainSay: Say = (code, params = {}) => [code, ...Object.entries(params).map(([k, v]) => `${k}=${v}`)].join(' ');

export interface RunOptions {
  graph: Graph;
  catalog: Catalog;
  /** What the user sent: the message and the images attached to it. */
  input: { text: string; images?: MediaValue[] };
  history?: Turn[];
  /** The runner of a node; null when nothing can run it. */
  runnerFor(node: GraphNode, spec: ModelSpec | null): Runner | null;
  onEvent?(event: RunEvent): void;
  signal?: AbortSignal;
  /** The run stops before a call that would take its cost past this. */
  maxCostUsd?: number;
  /** A call whose price is unknown beforehand is refused rather than counted as free: always, or the calls it names. */
  refuseUnknownPrice?: boolean | ((call: NodeCall) => boolean);
  /** How long a queued job may take. */
  jobTimeoutMs?: number;
  say?: Say;
  /** An issue of an invalid graph in words; the code alone by default. */
  describe?(issue: Issue): string;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  now?(): number;
}

export interface RunResult {
  state: Exclude<RunState, 'running'>;
  /** What reached the chat's answer, by port: text, image, video, audio. */
  outputs: Record<string, Value[]>;
  costUsd: number;
  error?: string;
  /** Why the graph could not run at all. */
  issues?: Issue[];
  states: Record<string, NodeState>;
  /** Every node's outputs, for the ones that ran. */
  made: Record<string, Record<string, Value[]>>;
}

/** A pause that ends at once, rejected, when the signal does. */
export const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', stop, { once: true });
  });

/** A node that did not run because one it reads failed, or the run stopped. */
class Skipped extends Error {}

/** One of the engine's own refusals, said through `say`. */
class EngineError extends Error {
  constructor(
    readonly code: EngineText,
    readonly params: Record<string, string | number> = {},
  ) {
    super(code);
  }
}

const usd = (n: number) => n.toFixed(n < 0.1 ? 3 : 2);
const said = (err: unknown) => (err instanceof Error ? err.message : String(err)) || 'error';

export async function runGraph(o: RunOptions): Promise<RunResult> {
  const { graph, catalog } = o;
  const say = o.say ?? plainSay;
  const emit = (event: RunEvent) => o.onEvent?.(event);
  const sleep = o.sleep ?? pause;
  const now = o.now ?? Date.now;
  const states: Record<string, NodeState> = {};
  const name = (node: GraphNode) => nodeName(node, catalog, (n) => say(`kind.${n.kind}`));
  const text = (err: unknown) => (err instanceof EngineError ? say(err.code, err.params) : said(err));
  let spent = 0;
  // Calls on their way, at their estimate: two nodes started together must not both fit under the cap alone.
  let reserved = 0;

  const issues = errorsOf(validateGraph(graph, catalog));
  if (issues.length) {
    const error = say('run.invalid', { problems: issues.map((i) => (o.describe ? o.describe(i) : i.code)).join('\n') });
    emit({ type: 'run', state: 'error', error, issues, costUsd: 0 });
    return { state: 'error', outputs: {}, costUsd: 0, error, issues, states, made: {} };
  }
  const sorted = topoOrder(graph);
  const order = sorted.ok ? sorted.order : [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const answer = graph.nodes.find((n) => n.kind === 'chat-output') as GraphNode;
  const needed = ancestors(graph, answer.id).add(answer.id);

  // One failure ends the run: the calls still on their way are stopped rather than paid for nothing.
  const stop = new AbortController();
  const outside = () => stop.abort(o.signal?.reason);
  if (o.signal?.aborted) outside();
  o.signal?.addEventListener('abort', outside, { once: true });
  let failure: string | null = null;

  const set = (id: string, state: NodeState, more: Partial<Extract<RunEvent, { type: 'node' }>> = {}) => {
    states[id] = state;
    emit({ type: 'node', id, state, ...more });
  };

  emit({ type: 'run', state: 'running', order, costUsd: 0 });
  for (const id of order) set(id, needed.has(id) ? 'pending' : 'skipped');

  const made = new Map<string, Record<string, Value[]>>();

  /** The values the wires bring to a node, port by port, in the order the wires were drawn. */
  const gather = (node: GraphNode): Record<string, Value[]> => {
    const inputs: Record<string, Value[]> = {};
    for (const port of nodePorts(node, catalog)?.inputs ?? []) {
      const values = graph.edges
        .filter((e) => e.to === `${node.id}.${port.id}`)
        .flatMap((e) => {
          const from = endpoint(e.from);
          return made.get(from.node)?.[from.port] ?? [];
        });
      // An input that takes one value reads the first of a list (the first frame of several).
      inputs[port.id] = values.slice(0, port.max ?? 1);
    }
    return inputs;
  };

  async function queued(runner: QueuedRunner, call: NodeCall, ctx: RunContext, id: string): Promise<NodeResult> {
    const job = await runner.submit(call, ctx);
    set(id, 'running', { progress: say('run.queued'), job });
    const started = now();
    const limit = o.jobTimeoutMs ?? 20 * 60_000;
    for (;;) {
      await sleep(runner.pollEveryMs ?? 5000, ctx.signal);
      const polled = await runner.poll(job, call, ctx);
      if (polled.state === 'done') {
        await runner.release?.(job, ctx).catch(() => undefined);
        return polled.result;
      }
      if (polled.progress) ctx.progress(polled.progress);
      // The job is left with the provider: it may still end, and a later run could pick it up.
      if (now() - started > limit) throw new EngineError('run.timeout', { minutes: Math.round(limit / 60_000) });
    }
  }

  async function runNode(node: GraphNode): Promise<NodeResult> {
    if (node.kind === 'chat-input') return { outputs: { text: [{ type: 'text', text: o.input.text }], images: o.input.images ?? [] } };
    const inputs = gather(node);
    if (node.kind === 'chat-output') return { outputs: inputs };

    const spec = nodeSpec(node, catalog);
    const runner = o.runnerFor(node, spec);
    if (!runner) throw new EngineError('run.no-runner');
    for (const port of nodePorts(node, catalog)?.inputs ?? []) {
      if (port.required && inputs[port.id].length === 0) throw new EngineError('run.empty-input', { port: port.id });
    }
    const fromChat = graph.edges.some((e) => endpoint(e.to).node === node.id && byId.get(endpoint(e.from).node)?.kind === 'chat-input' && endpoint(e.from).port === 'text');
    const call: NodeCall = { node, spec, inputs, history: fromChat ? (o.history ?? []) : [] };
    const ctx: RunContext = { signal: stop.signal, progress: (progress) => states[node.id] === 'running' && set(node.id, 'running', { progress }) };

    const cap = o.maxCostUsd;
    if (cap !== undefined && spent + reserved > cap) throw new EngineError('run.cap-reached', { cap: usd(cap), spent: usd(spent + reserved) });
    const estimate = (await runner.estimate?.(call, ctx)) ?? null;
    const refuse = typeof o.refuseUnknownPrice === 'function' ? o.refuseUnknownPrice(call) : o.refuseUnknownPrice === true;
    if (estimate === null && refuse) throw new EngineError('run.unknown-price');
    if (cap !== undefined && estimate !== null && spent + reserved + estimate > cap + 1e-9) {
      throw new EngineError('run.over-cap', { estimate: usd(estimate), cap: usd(cap), spent: usd(spent + reserved) });
    }
    reserved += estimate ?? 0;
    try {
      const result = 'submit' in runner ? await queued(runner, call, ctx, node.id) : await runner.run(call, ctx);
      const cost = result.costUsd ?? estimate ?? 0;
      spent += cost;
      return { outputs: result.outputs, costUsd: cost };
    } finally {
      reserved -= estimate ?? 0;
    }
  }

  const running = new Map<string, Promise<void>>();
  for (const id of order) {
    if (!needed.has(id)) continue;
    const node = byId.get(id) as GraphNode;
    const reads = [...new Set(graph.edges.filter((e) => endpoint(e.to).node === id).map((e) => endpoint(e.from).node))];
    const step = (async () => {
      const before = await Promise.allSettled(reads.map((r) => running.get(r)));
      if (before.some((b) => b.status === 'rejected') || stop.signal.aborted) {
        set(id, 'skipped');
        throw new Skipped();
      }
      const started = now();
      set(id, 'running');
      try {
        const { outputs, costUsd } = await runNode(node);
        made.set(id, outputs);
        set(id, 'done', { outputs, ms: now() - started, ...(costUsd ? { costUsd } : {}) });
      } catch (err) {
        // Stopped because another node failed, or because the user cancelled: not this node's error.
        if (stop.signal.aborted) {
          set(id, 'skipped');
          throw new Skipped();
        }
        failure = say('run.failed', { node: name(node), error: text(err) });
        set(id, 'error', { error: text(err), ms: now() - started });
        stop.abort(new Skipped());
        throw err;
      }
    })();
    // Read by the nodes after it and by the end of the run: never left unhandled.
    step.catch(() => undefined);
    running.set(id, step);
  }

  await Promise.allSettled([...running.values()]);
  o.signal?.removeEventListener('abort', outside);
  const error = failure as string | null;
  // Stopped as the last node ended: everything was made and paid for, so the answer is given.
  const state: RunResult['state'] = error ? 'error' : states[answer.id] === 'done' ? 'done' : 'cancelled';
  emit({ type: 'run', state, costUsd: spent, ...(error ? { error } : {}) });
  return { state, outputs: state === 'done' ? (made.get(answer.id) ?? {}) : {}, costUsd: spent, ...(error ? { error } : {}), states, made: Object.fromEntries(made) };
}
