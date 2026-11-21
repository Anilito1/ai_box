import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { isCustomAccount, providerOfAccount } from '../../shared/providers';
import type { Account, ProviderShapesView } from '../../shared/types';
import { applyCaps, guessedShape, PRESETS, specOf, type ModelShape, type ModelSpec } from '../../shared/modelCaps';
import { pause, runGraph, type MediaValue, type NodeCall, type RunEvent, type RunResult, type Turn, type Value } from '../../shared/graph/engine';
import { catalogOf, endpoint, GraphFormatError, nodeName, parseGraph, serializeGraph, type Catalog, type Graph, type GraphNode } from '../../shared/graph/format';
import { GRAPH_MAX_USD_LIMIT, GRAPH_PREFS_DEFAULT, type ClientValue, type GraphCatalogView, type GraphInfo, type GraphListing, type GraphPrefs, type GraphResult, type GraphRunEvent, type GraphRunRequest, type GraphSeed } from '../../shared/graph/protocol';
import type { Issue } from '../../shared/graph/validate';
import { t, type Key } from '../i18n';
import { blankGraph, EXAMPLES } from './examples';
import { framesRunner } from './runners/frames';
import { realRunner, sniff } from './runners/real';
import { SIM, simModels, simRunner } from './runners/sim';

// The graphs of models: where they are kept (one file each), the models they may use (every provider whose API the
// hub can call, and a simulated one), and their runs, from the Graphs view or from a session's run_graph tool. The
// keys stay here: the view only learns which providers there are.

export interface GraphServiceOptions {
  /** One file per graph, and the costs' settings. */
  dir: string;
  /** What the view's test runs made, the latest kept. */
  runsDir: string;
  /** Where run_graph saves what it made, for the user to keep (the videos folder). */
  outDir(): string;
  accounts(): Account[];
  /** An account's stored key, else empty. */
  key(accountId: string): string;
  fetch?: typeof fetch;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  /** The simulated models go this many times faster (tests). */
  simSpeed?: number;
}

const GRAPH_ID = /^g-[a-z0-9]{8}$/;
const RUN_ID = /^[a-z0-9-]{8,40}$/;
/** Test runs whose files are kept: the older ones go. */
const RUNS_KEPT = 40;
const IMAGES_MAX = 8;
const IMAGE_BYTES_MAX = 20 * 1024 * 1024;
const DEEPSEEK_OPENAI = 'https://api.deepseek.com';
/** The images run_graph takes from a path: a picture file, nothing else. */
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
/** The first bytes of a PNG, a JPEG, a GIF, a WebP. */
const isPicture = (b: Uint8Array) =>
  (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) || (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) || (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45);

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'audio/wav': 'wav', 'audio/mpeg': 'mp3' };
const MIME = Object.fromEntries(Object.entries(EXT).map(([mime, ext]) => [ext, mime]));

/** The address whose OpenAI-shaped API a graph calls for an account; null for an account it cannot use. */
export function graphBase(a: Account): string | null {
  if (isCustomAccount(a)) return a.baseUrl;
  // OpenAI's own API with a key; DeepSeek's key also opens its OpenAI-shaped address beside its Anthropic one.
  if (a.kind === 'openai') return a.baseUrl;
  if (providerOfAccount(a) === 'deepseek') return DEEPSEEK_OPENAI;
  return null;
}

const say = (code: string, params?: Record<string, string | number>) => t(`graph.${code}` as Key, params);

export class GraphService {
  /** What each account's list said of its models, as the account checks read it. */
  private readonly listed = new Map<string, ModelShape[]>();
  private readonly runs = new Map<string, AbortController>();

  constructor(private readonly o: GraphServiceOptions) {}

  // ── Models ─────────────────────────────────────────────────────────────────────────────────────────────────────

  /** An account's list was read (its check): its models' shapes are kept for the graphs and its form. */
  noteListed(accountId: string, shapes: ModelShape[] | undefined): void {
    if (shapes) this.listed.set(accountId, shapes);
  }

  forget(accountId: string): void {
    this.listed.delete(accountId);
  }

  /** A provider's models in its form: what the list says, and what was declared. */
  shapesView(a: Account): ProviderShapesView {
    return { listed: (this.listed.get(a.id) ?? []).map(({ model, preset, maxImages, source }) => ({ model, preset, ...(maxImages !== undefined ? { maxImages } : {}), source })), manual: a.modelCaps ?? {} };
  }

  /** An account's models with their shapes: listed, its session and video models the list lacks, then declared. */
  private shapesOf(a: Account): ModelShape[] {
    const listed = this.listed.get(a.id) ?? [];
    const known = new Set(listed.map((m) => m.model.toLowerCase()));
    const extra: ModelShape[] = [];
    // Models the user typed and the list does not have: a session model answers text; a video model makes videos.
    for (const model of a.models) if (!known.has(model.toLowerCase())) extra.push({ model, name: '', preset: 'llm', source: 'guessed' });
    for (const model of a.videoModels ?? []) {
      if (known.has(model.toLowerCase())) continue;
      const guess = guessedShape(model, 'text-to-video');
      extra.push(PRESETS[guess.preset].api === 'video' ? guess : { ...guess, preset: 'text-to-video' });
    }
    return applyCaps([...listed, ...extra], a.modelCaps ?? {});
  }

  /** The accounts a graph can call, with the address it calls them at. */
  private providers(): { account: Account; baseUrl: string }[] {
    return this.o.accounts().flatMap((account) => {
      const baseUrl = graphBase(account);
      return baseUrl ? [{ account, baseUrl }] : [];
    });
  }

  /** Every model a graph may use: the simulated ones first. */
  models(): ModelSpec[] {
    return [...simModels(), ...this.providers().flatMap(({ account }) => this.shapesOf(account).map((shape) => specOf(account.id, shape)))];
  }

  catalogView(): GraphCatalogView {
    return { providers: [{ id: SIM, name: t('graph.sim.provider') }, ...this.providers().map(({ account }) => ({ id: account.id, name: account.name }))], models: this.models() };
  }

  // ── Graphs on disk ─────────────────────────────────────────────────────────────────────────────────────────────

  private file(id: string): string {
    return join(this.o.dir, `${id}.json`);
  }

  private write(path: string, text: string): void {
    mkdirSync(this.o.dir, { recursive: true });
    // Whole or not at all: a graph is never left half written.
    const stage = `${path}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(stage, text);
    renameSync(stage, path);
  }

  list(): GraphListing {
    const graphs: GraphInfo[] = [];
    for (const name of existsSync(this.o.dir) ? readdirSync(this.o.dir) : []) {
      const id = name.replace(/\.json$/, '');
      if (!name.endsWith('.json') || !GRAPH_ID.test(id)) continue;
      const graph = this.get(id);
      if (graph) graphs.push({ id, name: graph.name, updatedAt: statSync(this.file(id)).mtimeMs });
    }
    graphs.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return { graphs, examples: EXAMPLES.map((e) => ({ id: e.id, name: e.graph().name })) };
  }

  get(id: string): Graph | null {
    if (!GRAPH_ID.test(id)) return null;
    try {
      return parseGraph(JSON.parse(readFileSync(this.file(id), 'utf8')));
    } catch {
      return null;
    }
  }

  create(seed: GraphSeed): GraphResult {
    let graph: Graph | null = null;
    if ('blank' in seed) graph = blankGraph();
    else if ('example' in seed) graph = EXAMPLES.find((e) => e.id === seed.example)?.graph() ?? null;
    else if ('copy' in seed) {
      const from = this.get(seed.copy);
      graph = from ? { ...from, name: t('graph.copyOf', { name: from.name }).slice(0, 80) } : null;
    }
    if (!graph) return { ok: false, error: 'not-found' };
    let id = '';
    do id = `g-${randomBytes(6).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '0').slice(0, 8)}`;
    while (existsSync(this.file(id)));
    this.write(this.file(id), serializeGraph(graph));
    return { ok: true, error: '', id };
  }

  save(id: string, raw: unknown): GraphResult {
    if (!GRAPH_ID.test(id) || !existsSync(this.file(id))) return { ok: false, error: 'not-found' };
    try {
      this.write(this.file(id), serializeGraph(parseGraph(raw)));
      return { ok: true, error: '', id };
    } catch (err) {
      return { ok: false, error: err instanceof GraphFormatError ? `format:${err.code}` : 'write' };
    }
  }

  delete(id: string): GraphResult {
    if (!GRAPH_ID.test(id)) return { ok: false, error: 'not-found' };
    rmSync(this.file(id), { force: true });
    return { ok: true, error: '' };
  }

  prefs(next?: unknown): GraphPrefs {
    const path = join(this.o.dir, 'prefs.json');
    const read = (raw: unknown): GraphPrefs => {
      const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const max = typeof o.maxUsd === 'number' && Number.isFinite(o.maxUsd) && o.maxUsd > 0 ? Math.min(o.maxUsd, GRAPH_MAX_USD_LIMIT) : GRAPH_PREFS_DEFAULT.maxUsd;
      return { maxUsd: Math.round(max * 100) / 100, refuseUnknownPrice: o.refuseUnknownPrice === true };
    };
    if (next !== undefined) {
      const prefs = read(next);
      this.write(path, `${JSON.stringify(prefs, null, 2)}\n`);
      return prefs;
    }
    try {
      return read(JSON.parse(readFileSync(path, 'utf8')));
    } catch {
      return { ...GRAPH_PREFS_DEFAULT };
    }
  }

  // ── Runs ───────────────────────────────────────────────────────────────────────────────────────────────────────

  private runnerFor(catalog: Catalog) {
    const accounts = new Map(this.providers().map((p) => [p.account.id, p]));
    return (node: GraphNode, spec: ModelSpec | null) => {
      if (node.kind === 'convert') return node.convert === 'frames' ? framesRunner : null;
      if (!spec || !catalog.has(spec.ref)) return null;
      if (spec.provider === SIM) return simRunner(spec, { sleep: this.o.sleep ?? pause, speed: this.o.simSpeed });
      const p = accounts.get(spec.provider);
      return p ? realRunner({ baseUrl: p.baseUrl, key: this.o.key(p.account.id), fetch: this.o.fetch ?? fetch }, spec) : null;
    };
  }

  /** An issue of a graph that cannot run, in words, its nodes named. */
  private describe(graph: Graph, catalog: Catalog) {
    return (issue: Issue): string => {
      const name = (id: unknown) => {
        const node = graph.nodes.find((n) => n.id === id);
        return node ? nodeName(node, catalog, (n) => say(`kind.${n.kind}`)) : String(id ?? '');
      };
      const type = (v: unknown) => (typeof v === 'string' && v ? say(`type.${v}`) : '');
      const p = {
        ...issue.params,
        node: name(issue.params.node),
        ...(issue.code === 'cycle' ? { nodes: String(issue.params.nodes).split(',').map(name).join(', ') } : {}),
        ...(issue.code === 'count' ? { kind: say(`kind.${issue.params.kind}`) } : {}),
        ...(issue.params.type ? { type: type(issue.params.type) } : {}),
        ...(issue.params.have ? { have: type(issue.params.have), want: type(issue.params.want) } : {}),
      };
      return issue.code === 'edge' ? say('issue.edge', { from: String(issue.params.from), to: String(issue.params.to), why: say(`refusal.${issue.refusal}`, p) }) : say(`issue.${issue.code}`, p);
    };
  }

  /**
   * A run under the user's settings. `unattended` (run_graph, no one watching): besides what the settings refuse, an
   * image, a video or a voice of unknown price is refused, so that the cap is not left to count it as free.
   */
  private async execute(graph: Graph, input: { text: string; images: MediaValue[] }, history: Turn[], maxUsd: number, signal: AbortSignal, onEvent?: (e: RunEvent) => void, unattended = false): Promise<RunResult> {
    const catalog = catalogOf(this.models());
    const prefs = this.prefs();
    return runGraph({
      graph,
      catalog,
      input,
      history,
      runnerFor: this.runnerFor(catalog),
      // The user's cap is the ceiling: a run may only ask for less.
      maxCostUsd: Math.min(prefs.maxUsd, Number.isFinite(maxUsd) && maxUsd >= 0 ? maxUsd : prefs.maxUsd),
      refuseUnknownPrice: prefs.refuseUnknownPrice || (unattended ? (call: NodeCall) => call.spec !== null && call.spec.api !== 'chat' : false),
      signal,
      say,
      describe: this.describe(graph, catalog),
      ...(this.o.sleep ? { sleep: this.o.sleep } : {}),
      onEvent,
    });
  }

  /** A test run of the view: its events go to `emit`, what it makes is kept in a folder of the run. */
  async run(runId: string, request: GraphRunRequest, emit: (event: GraphRunEvent) => void): Promise<void> {
    if (!RUN_ID.test(runId) || this.runs.has(runId)) return;
    const stop = new AbortController();
    this.runs.set(runId, stop);
    const dir = join(this.o.runsDir, runId);
    const files = new WeakMap<Uint8Array, string>();
    let count = 0;
    const toClient = (node: string, port: string, v: Value): ClientValue => {
      if (v.type === 'text') return v;
      let file = files.get(v.bytes);
      if (!file) {
        file = `${node}-${port}-${++count}.${EXT[v.mime] ?? 'bin'}`;
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, file), v.bytes);
        files.set(v.bytes, file);
      }
      return { type: v.type, mime: v.mime, file, size: v.bytes.length, ...(v.label ? { label: v.label } : {}) };
    };
    try {
      this.prune();
      const graph = parseGraph(request.graph);
      const images = (Array.isArray(request.images) ? request.images : []).slice(0, IMAGES_MAX).flatMap((i): MediaValue[] => {
        const bytes = i?.data instanceof Uint8Array ? i.data : null;
        return bytes && bytes.length > 0 && bytes.length <= IMAGE_BYTES_MAX ? [{ type: 'image', mime: sniff(bytes), bytes }] : [];
      });
      const history = (Array.isArray(request.history) ? request.history : []).filter((x) => (x?.role === 'user' || x?.role === 'assistant') && typeof x.text === 'string').slice(-40);
      await this.execute(graph, { text: String(request.text ?? '').slice(0, 32_000), images }, history, Number(request.maxUsd), stop.signal, (e) => {
        if (e.type === 'run') return emit(e);
        const { outputs, job: _job, ...rest } = e;
        emit({ ...rest, ...(outputs ? { outputs: Object.fromEntries(Object.entries(outputs).map(([port, values]) => [port, values.map((v) => toClient(e.id, port, v))])) } : {}) });
      });
    } catch (err) {
      // A fault of the hub's, not of a node: the view is told the run is over.
      emit({ type: 'run', state: 'error', error: err instanceof GraphFormatError ? say('run.unreadable') : t('graph.run.internal'), costUsd: 0 });
    } finally {
      this.runs.delete(runId);
    }
  }

  cancel(runId: string): void {
    this.runs.get(runId)?.abort(new Error('cancelled'));
  }

  /** A file a test run made; null for any name that is not one. */
  media(runId: string, file: string): { mime: string; data: Uint8Array } | null {
    if (!RUN_ID.test(runId) || !/^[a-z0-9_-]{1,40}-[a-z0-9_-]{1,40}-\d{1,4}\.[a-z0-9]{2,4}$/i.test(file)) return null;
    const mime = MIME[extname(file).slice(1)];
    const path = join(this.o.runsDir, runId, file);
    if (!mime || !existsSync(path)) return null;
    return { mime, data: new Uint8Array(readFileSync(path)) };
  }

  /** The oldest test runs' files go, the latest RUNS_KEPT stay. */
  private prune(): void {
    try {
      if (!existsSync(this.o.runsDir)) return;
      const runs = readdirSync(this.o.runsDir)
        .filter((name) => RUN_ID.test(name))
        .map((name) => ({ name, at: statSync(join(this.o.runsDir, name)).mtimeMs }))
        .sort((a, b) => b.at - a.at);
      for (const old of runs.slice(RUNS_KEPT)) rmSync(join(this.o.runsDir, old.name), { recursive: true, force: true });
    } catch {
      // A folder held by another program (an antivirus scan) goes next time.
    }
  }

  // ── Tools ──────────────────────────────────────────────────────────────────────────────────────────────────────

  /** The graph a tool names: its id, else its name (any case). */
  private find(ref: string): { id: string; graph: Graph } | null {
    const wanted = ref.trim();
    const byId = GRAPH_ID.test(wanted) ? this.get(wanted) : null;
    if (byId) return { id: wanted, graph: byId };
    const info = this.list().graphs.find((g) => g.name.toLowerCase() === wanted.toLowerCase());
    const graph = info ? this.get(info.id) : null;
    return info && graph ? { id: info.id, graph } : null;
  }

  /** What a graph takes and gives, in a line: what list_graphs says of it. */
  private describeGraph(id: string, graph: Graph): string {
    const wired = (kind: GraphNode['kind'], side: 'from' | 'to') => {
      const node = graph.nodes.find((n) => n.kind === kind);
      return [...new Set(graph.edges.map((e) => endpoint(e[side])).filter((p) => p.node === node?.id).map((p) => p.port))];
    };
    const models = graph.nodes.filter((n) => n.kind === 'model').length;
    return t('graph.tool.line', { id, name: graph.name, takes: wired('chat-input', 'from').join(', ') || '-', gives: wired('chat-output', 'to').join(', ') || '-', models });
  }

  toolList(): string {
    const { graphs } = this.list();
    if (graphs.length === 0) return t('graph.tool.none');
    const prefs = this.prefs();
    return [t('graph.tool.head', { count: graphs.length, cap: prefs.maxUsd.toFixed(2) }), ...graphs.flatMap((g) => {
      const graph = this.get(g.id);
      return graph ? [this.describeGraph(g.id, graph)] : [];
    })].join('\n');
  }

  /** run_graph: one message through a saved graph; what reached its answer is said, its files saved for the user. */
  async toolRun(args: { graph?: string | null; message?: string | null; images?: string[] | null; max_usd?: number | null }, ctx: { cwd: string; signal: AbortSignal }): Promise<string> {
    const found = this.find(args.graph ?? '');
    if (!found) throw new Error(t('graph.tool.unknown', { graph: args.graph ?? '', list: this.list().graphs.map((g) => `${g.id} (${g.name})`).join(', ') || '-' }));
    const images: MediaValue[] = [];
    for (const path of (args.images ?? []).slice(0, IMAGES_MAX)) {
      const full = isAbsolute(path) ? path : resolve(ctx.cwd, path);
      const info = IMAGE_EXT.test(full) && existsSync(full) ? statSync(full) : null;
      if (!info?.isFile() || info.size <= 0 || info.size > IMAGE_BYTES_MAX) throw new Error(t('graph.tool.badImage', { path }));
      const bytes = new Uint8Array(readFileSync(full));
      if (!isPicture(bytes)) throw new Error(t('graph.tool.badImage', { path }));
      images.push({ type: 'image', mime: sniff(bytes), bytes });
    }
    const result = await this.execute(found.graph, { text: (args.message ?? '').slice(0, 32_000), images }, [], args.max_usd ?? Number.POSITIVE_INFINITY, ctx.signal, undefined, true);
    if (result.state !== 'done') throw new Error(result.error ?? t('graph.tool.cancelled'));
    const texts = (result.outputs.text ?? []).flatMap((v) => (v.type === 'text' ? [v.text] : []));
    const media = Object.entries(result.outputs).flatMap(([port, values]) => values.filter((v): v is MediaValue => v.type !== 'text').map((v) => ({ port, v })));
    const saved: string[] = [];
    if (media.length > 0) {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const parent = join(this.o.outDir(), 'graphs');
      mkdirSync(parent, { recursive: true });
      const dir = mkdtempSync(join(parent, `${stamp}-${found.id}-`));
      media.forEach(({ port, v }, i) => {
        const path = join(dir, `${port}-${i + 1}.${EXT[v.mime] ?? 'bin'}`);
        writeFileSync(path, v.bytes);
        saved.push(`${v.type}: ${path}`);
      });
    }
    const steps = Object.values(result.states).filter((s) => s === 'done').length;
    return [
      t('graph.tool.done', { name: found.graph.name, steps, cost: result.costUsd.toFixed(3) }),
      ...(texts.length ? ['', t('graph.tool.answer'), ...texts] : []),
      ...(saved.length ? ['', t('graph.tool.files'), ...saved.map((s) => `- ${s}`)] : []),
    ].join('\n');
  }
}

