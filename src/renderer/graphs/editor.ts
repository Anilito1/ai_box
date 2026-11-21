import { MEDIA_TYPES, type MediaType, type ModelSpec, type Port } from '../../shared/modelCaps';
import { endpoint, freshId, GRAPH_LIMITS, nodePorts, nodeSpec, type ConverterId, type GraphEdge, type GraphNode, type NodeKind, type NodeOf } from '../../shared/graph/format';
import { canConnect, topoOrder, validateGraph, type Bridge, type Issue, type Verdict } from '../../shared/graph/validate';
import type { HubApi } from '../../shared/types';
import { t } from '../i18n';
import { bridgeLabel, converterHint, issueText, kindName, refusalText, titleOf } from './describe';
import { button, el, present, seconds, svg, usd } from './dom';
import { portLabel, typeLabel } from './shape';
import type { GraphStore } from './store';
import { outputsView } from './values';

// The graph on screen: nodes as cards, their typed ports on the edges of the card (inputs left, outputs right), wires
// between them. A wire is drawn by dragging from an output to an input; while it is dragged, the inputs that would
// take it light up and the others fade. Each sort of node draws its own body (LOOKS): a new sort is a new entry.

export interface EditorUi {
  toast(message: string, actions?: { label: string; run(): void }[]): void;
  /** Opens the list of models next to `anchor`. */
  pickModel(anchor: HTMLElement, current: string, onPick: (spec: ModelSpec) => void): void;
}

const NODE_WIDTH = 196;
const COLUMN = NODE_WIDTH + 38;

interface Point {
  x: number;
  y: number;
}

/** How each sort of node looks: whether it can be named and removed, and what its card holds under its title. */
interface Look<K extends NodeKind> {
  own: boolean;
  body(node: NodeOf<K>, editor: Editor): (Node | null | false)[];
}

const LOOKS: { [K in NodeKind]: Look<K> } = {
  'chat-input': { own: false, body: () => [el('div', 'gr-hint', t('graphs.node.inputHint'))] },
  'chat-output': { own: false, body: () => [el('div', 'gr-hint', t('graphs.node.outputHint'))] },
  model: { own: true, body: (node, editor) => editor.modelBody(node) },
  convert: { own: true, body: (node, editor) => [el('div', 'gr-hint', converterHint(node.convert)), node.convert === 'frames' && editor.option(node, 'count', t('graphs.node.frames'), ['1', '2', '4', '6', '8'], '4')] },
};

export class Editor {
  private zoom = 1;
  /** Until the user zooms, the graph is kept whole in the window. */
  private fitted = true;
  private selected: GraphEdge | null = null;
  private issues: Issue[] = [];
  private readonly scroller = el('div', 'gr-scroller');
  private readonly sizer = el('div', 'gr-sizer');
  private readonly stage = el('div', 'gr-stage');
  private readonly wires = svg('svg', { class: 'gr-wires' });
  private readonly status = el('div', 'gr-issues');

  constructor(
    root: HTMLElement,
    private readonly hub: HubApi,
    private readonly store: GraphStore,
    private readonly ui: EditorUi,
  ) {
    this.sizer.append(this.stage);
    this.scroller.append(this.sizer);
    const tools = el(
      'div',
      'gr-canvas-tools',
      button('gr-tool', '−', () => this.setZoom(this.zoom - 0.1), t('graphs.zoomOut')),
      button('gr-tool', '+', () => this.setZoom(this.zoom + 0.1), t('graphs.zoomIn')),
      button('gr-tool wide', t('graphs.fit'), () => this.fit(), t('graphs.fitHint')),
      button('gr-tool wide', t('graphs.arrange'), () => this.arrange(), t('graphs.arrangeHint')),
    );
    const legend = el('div', 'gr-legend', ...MEDIA_TYPES.map((type: MediaType) => el('span', `gr-legend-item type-${type}`, el('span', 'gr-dot'), typeLabel(type))));
    root.append(this.scroller, tools, legend, this.status);

    store.onGraph.push(() => this.render());
    store.onRun.push((id) => this.updateRun(id));
    new ResizeObserver(() => (this.fitted ? this.fit() : this.layout())).observe(this.scroller);
    this.scroller.addEventListener('pointerdown', (e) => {
      if (e.target === this.scroller || e.target === this.stage || e.target === this.sizer) this.select(null);
    });
    document.addEventListener('keydown', (e) => {
      if (!this.selected || this.scroller.offsetParent === null) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) this.removeEdge(this.selected);
    });
  }

  // ── Drawing ──────────────────────────────────────────────────────────────────────────────────────────────────

  render(): void {
    const { graph, catalog } = this.store;
    this.issues = validateGraph(graph, catalog);
    if (this.selected && !graph.edges.includes(this.selected)) this.selected = null;
    this.stage.replaceChildren(this.wires, ...graph.nodes.map((n) => this.nodeView(n)));
    for (const id of this.store.runs.keys()) this.updateRun(id, false);
    this.showIssues();
    if (this.fitted) this.fit();
    else this.layout();
  }

  private card(id: string): HTMLElement | null {
    return this.stage.querySelector<HTMLElement>(`.gr-node[data-id="${CSS.escape(id)}"]`);
  }

  private nodeView(node: GraphNode): HTMLElement {
    const { graph, catalog } = this.store;
    const ports = nodePorts(node, catalog);
    const problem = this.issues.find((i) => i.node === node.id && i.level === 'error' && i.code !== 'edge');
    const card = el('div', `gr-node kind-${node.kind}${problem ? ' has-issue' : ''}`);
    card.dataset.id = node.id;
    card.style.left = `${node.x}px`;
    card.style.top = `${node.y}px`;
    card.style.width = `${NODE_WIDTH}px`;
    if (problem) card.title = issueText(graph, catalog, problem);
    const look = LOOKS[node.kind] as Look<NodeKind>;

    const head = el('div', 'gr-node-head', el('span', 'gr-state'));
    if (!look.own) head.append(el('span', 'gr-node-name', kindName(node)));
    else {
      const title = el('input', 'gr-node-title');
      title.value = node.title ?? '';
      title.maxLength = GRAPH_LIMITS.title;
      title.placeholder = node.kind === 'model' ? t('graphs.node.role') : kindName(node);
      title.setAttribute('aria-label', t('graphs.node.roleHint'));
      title.title = t('graphs.node.roleHint');
      title.addEventListener('input', () => {
        if (title.value.trim()) node.title = title.value.trim();
        else delete node.title;
        this.store.changed(false);
      });
      head.append(title, button('gr-node-delete', '×', () => this.removeNode(node), t('graphs.node.remove')));
    }
    card.append(head, ...present(...look.body(node, this)));

    if (ports) {
      card.append(
        el(
          'div',
          'gr-ports',
          el('div', 'gr-ports-in', ...ports.inputs.map((p) => this.portView(node, p, 'in'))),
          el('div', 'gr-ports-out', ...ports.outputs.map((p) => this.portView(node, p, 'out'))),
        ),
      );
    }
    const spec = nodeSpec(node, catalog);
    if (node.kind === 'model' && spec?.api === 'chat') card.append(this.instruction(node));
    card.append(el('div', 'gr-node-run'));
    card.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('input, textarea, select, button, .gr-port, video, audio, a')) return;
      this.dragNode(node, card, e);
    });
    return card;
  }

  /** A model node's body: its model (a button that opens the list), its provider, a video's duration. */
  modelBody(node: NodeOf<'model'>): (Node | null | false)[] {
    const spec = nodeSpec(node, this.store.catalog);
    const label = spec ? spec.name || spec.model : node.model ? t('graphs.node.gone', { model: node.model }) : t('graphs.node.pick');
    const pick = button(`gr-node-model${spec ? '' : ' missing'}`, label, () => this.ui.pickModel(pick, node.model, (s) => this.setModel(node, s.ref)), t('graphs.node.change'));
    return [
      pick,
      spec && el('div', 'gr-node-provider', this.store.providerName(spec.provider), spec.source === 'guessed' ? el('span', 'gr-guessed', t('graphs.node.guessed')) : null),
      spec?.api === 'video' && !!spec.durations?.length && this.option(node, 'duration', t('graphs.node.duration'), spec.durations),
    ];
  }

  private instruction(node: NodeOf<'model'>): HTMLElement {
    const text = el('textarea', 'gr-instruction');
    text.rows = 3;
    text.maxLength = GRAPH_LIMITS.instruction;
    text.placeholder = t('graphs.node.instruction');
    text.setAttribute('aria-label', t('graphs.node.instruction'));
    text.value = node.instruction ?? '';
    text.addEventListener('input', () => {
      if (text.value.trim()) node.instruction = text.value;
      else delete node.instruction;
      this.store.changed(false);
    });
    return text;
  }

  option(node: GraphNode, key: string, label: string, values: string[], fallback = values[0]): HTMLElement {
    const select = el('select', 'gr-select', ...values.map((v) => Object.assign(el('option', '', v), { value: v })));
    // A value kept from another model (its "3s" where this one takes "5s") gives way to this model's own.
    const kept = node.options?.[key];
    select.value = kept !== undefined && values.includes(kept) ? kept : fallback;
    select.setAttribute('aria-label', label);
    select.addEventListener('change', () => {
      node.options = { ...node.options, [key]: select.value };
      this.store.changed(false);
    });
    return el('label', 'gr-option', el('span', '', label), select);
  }

  private portView(node: GraphNode, port: Port, side: 'in' | 'out'): HTMLElement {
    // The answer takes whatever comes: how many of each is of no interest on its card.
    const label = node.kind === 'chat-output' ? typeLabel(port.type) : portLabel(port);
    const optional = side === 'in' && !port.required && node.kind !== 'chat-output';
    const view = el('div', `gr-port ${side} type-${port.type}${optional ? ' optional' : ''}`, el('span', 'gr-dot'), el('span', 'gr-port-type', label), optional ? el('span', 'gr-port-name', t('graphs.port.optional')) : null);
    view.dataset.ref = `${node.id}.${port.id}`;
    view.title = side === 'in' ? t(port.required ? 'graphs.port.inRequired' : 'graphs.port.in', { port: port.id, type: portLabel(port) }) : t('graphs.port.out', { port: port.id, type: portLabel(port) });
    if (side === 'out') view.addEventListener('pointerdown', (e) => e.button === 0 && this.dragWire(view.dataset.ref as string, port.type, e));
    return view;
  }

  /** What the run left on a node: its state, where a long call is, what it made. */
  private updateRun(id: string, redraw = true): void {
    const card = this.card(id);
    if (!card) return;
    const run = this.store.runs.get(id);
    const box = card.querySelector('.gr-node-run') as HTMLElement;
    if (!run) {
      delete card.dataset.state;
      box.replaceChildren();
    } else {
      card.dataset.state = run.state;
      const facts = [t(`graphs.state.${run.state}`), run.state === 'running' ? run.progress : '', run.state === 'done' && run.ms !== undefined && run.ms >= 100 ? seconds(run.ms) : '', run.costUsd ? usd(run.costUsd) : ''].filter(Boolean).join(' · ');
      const kind = this.store.graph.nodes.find((n) => n.id === id)?.kind;
      const chat = kind === 'chat-input' || kind === 'chat-output';
      box.replaceChildren(
        ...present(
          // The chat's own ends only show their state, on the dot: the conversation shows the rest.
          !(chat && !run.error) && el('div', 'gr-run-line', facts),
          run.error && el('div', 'gr-run-error', run.error),
          run.outputs && !chat && outputsView(this.hub, this.store.runId, run.outputs, true),
        ),
      );
    }
    // A node that grew moved nothing above it, but the wires that go around it must go lower.
    if (redraw) this.layout();
  }

  private showIssues(): void {
    const { graph, catalog } = this.store;
    const errors = this.issues.filter((i) => i.level === 'error');
    const warnings = this.issues.filter((i) => i.level === 'warning');
    this.status.className = `gr-issues ${errors.length ? 'bad' : 'ok'}`;
    if (errors.length === 0 && warnings.length === 0) {
      const models = graph.nodes.filter((n) => n.kind === 'model').length;
      this.status.replaceChildren(el('span', 'gr-issues-title', t('graphs.ready')), ` ${t('graphs.readyCount', { models, wires: graph.edges.length })}`);
      return;
    }
    this.status.replaceChildren(
      el('span', 'gr-issues-title', errors.length ? t('graphs.problems', { count: errors.length }) : t('graphs.ready')),
      el('ul', '', ...[...errors, ...warnings].slice(0, 6).map((i) => el('li', i.level, issueText(graph, catalog, i)))),
    );
  }

  // ── Size and wires ───────────────────────────────────────────────────────────────────────────────────────────

  private boxes(): { node: GraphNode; x: number; y: number; w: number; h: number }[] {
    return this.store.graph.nodes.map((node) => {
      const card = this.card(node.id);
      return { node, x: node.x, y: node.y, w: card?.offsetWidth ?? NODE_WIDTH, h: card?.offsetHeight ?? 120 };
    });
  }

  /** Sizes the stage around the nodes and draws the wires again. */
  private layout(): void {
    if (this.scroller.clientWidth === 0) return;
    const boxes = this.boxes();
    const right = Math.max(0, ...boxes.map((b) => b.x + b.w)) + 40;
    const bottom = Math.max(0, ...boxes.map((b) => b.y + b.h)) + 110;
    const width = Math.max(right, this.scroller.clientWidth / this.zoom);
    const height = Math.max(bottom, this.scroller.clientHeight / this.zoom);
    this.stage.style.width = `${width}px`;
    this.stage.style.height = `${height}px`;
    this.stage.style.transform = `scale(${this.zoom})`;
    this.sizer.style.width = `${Math.floor(width * this.zoom)}px`;
    this.sizer.style.height = `${Math.floor(height * this.zoom)}px`;
    this.wires.setAttribute('width', String(width));
    this.wires.setAttribute('height', String(height));
    this.drawWires();
  }

  fit(): void {
    const boxes = this.boxes();
    const right = Math.max(0, ...boxes.map((b) => b.x + b.w)) + 40;
    if (this.scroller.clientWidth > 0) this.zoom = Math.max(0.55, Math.min(1, (this.scroller.clientWidth - 4) / right));
    this.fitted = true;
    this.layout();
  }

  private setZoom(zoom: number): void {
    this.zoom = Math.max(0.5, Math.min(1.4, Math.round(zoom * 10) / 10));
    this.fitted = false;
    this.layout();
  }

  /** A point of the window in the stage's own coordinates. */
  private toStage(clientX: number, clientY: number): Point {
    const rect = this.stage.getBoundingClientRect();
    return { x: (clientX - rect.left) / this.zoom, y: (clientY - rect.top) / this.zoom };
  }

  private portEl(ref: string, side: 'in' | 'out'): HTMLElement | null {
    return this.stage.querySelector<HTMLElement>(`.gr-port.${side}[data-ref="${CSS.escape(ref)}"]`);
  }

  private anchor(ref: string, side: 'in' | 'out'): Point | null {
    const dot = this.portEl(ref, side)?.querySelector('.gr-dot');
    if (!dot) return null;
    const rect = dot.getBoundingClientRect();
    return this.toStage(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  /**
   * The path of a wire. Straight ahead it is one curve; when cards stand between its two ends it goes under them
   * (down, along, up), each such wire a little lower than the one before so that two never run on the same line.
   */
  private route(a: Point, b: Point, skip: string[], lane: { count: number }): string {
    const between = this.boxes().filter((box) => !skip.includes(box.node.id) && box.x < b.x - 8 && box.x + box.w > a.x + 8 && box.y < Math.max(a.y, b.y) + 8 && box.y + box.h > Math.min(a.y, b.y) - 8);
    if (between.length === 0 || b.x <= a.x) {
      const reach = Math.max(36, Math.abs(b.x - a.x) / 2);
      return `M ${a.x} ${a.y} C ${a.x + reach} ${a.y}, ${b.x - reach} ${b.y}, ${b.x} ${b.y}`;
    }
    const under = Math.max(...between.map((box) => box.y + box.h)) + 22 + 12 * lane.count++;
    const turn = 22;
    return `M ${a.x} ${a.y} C ${a.x + turn} ${a.y}, ${a.x + turn} ${under}, ${a.x + 2 * turn} ${under} L ${b.x - 2 * turn} ${under} C ${b.x - turn} ${under}, ${b.x - turn} ${b.y}, ${b.x} ${b.y}`;
  }

  private drawWires(): void {
    const { graph, catalog, runs } = this.store;
    const bad = new Set(this.issues.flatMap((i) => (i.edge ? [i.edge] : [])));
    const lane = { count: 0 };
    this.wires.replaceChildren();
    this.stage.querySelector('.gr-wire-delete')?.remove();
    for (const port of this.stage.querySelectorAll('.gr-port.wired')) port.classList.remove('wired');
    for (const edge of graph.edges) {
      const a = this.anchor(edge.from, 'out');
      const b = this.anchor(edge.to, 'in');
      if (!a || !b) continue;
      const from = endpoint(edge.from);
      const to = endpoint(edge.to);
      const fromNode = graph.nodes.find((n) => n.id === from.node) as GraphNode;
      const type = nodePorts(fromNode, catalog)?.outputs.find((p) => p.id === from.port)?.type ?? 'text';
      const flowed = runs.get(from.node)?.state === 'done';
      const flowing = flowed && runs.get(to.node)?.state === 'running';
      const d = this.route(a, b, [from.node, to.node], lane);
      const path = svg('path', { d, class: `gr-wire type-${type}${bad.has(edge) ? ' bad' : ''}${flowed ? ' flowed' : ''}${flowing ? ' flowing' : ''}${edge === this.selected ? ' selected' : ''}` });
      const hit = svg('path', { d, class: 'gr-wire-hit' });
      hit.addEventListener('click', () => this.select(edge));
      hit.append(Object.assign(svg('title'), { textContent: t('graphs.wire.hint', { from: edge.from, to: edge.to }) }));
      this.wires.append(path, hit);
      this.portEl(edge.from, 'out')?.classList.add('wired');
      this.portEl(edge.to, 'in')?.classList.add('wired');
      if (edge === this.selected) {
        const mid = path.getPointAtLength(path.getTotalLength() / 2);
        const remove = button('gr-wire-delete', '×', () => this.removeEdge(edge), t('graphs.wire.remove'));
        remove.style.left = `${mid.x}px`;
        remove.style.top = `${mid.y}px`;
        this.stage.append(remove);
      }
    }
  }

  private select(edge: GraphEdge | null): void {
    this.selected = edge;
    this.drawWires();
  }

  // ── Editing ──────────────────────────────────────────────────────────────────────────────────────────────────

  private dragNode(node: GraphNode, card: HTMLElement, start: PointerEvent): void {
    const from = this.toStage(start.clientX, start.clientY);
    const origin = { x: node.x, y: node.y };
    let moved = false;
    const move = (e: PointerEvent) => {
      const at = this.toStage(e.clientX, e.clientY);
      node.x = Math.max(0, Math.round(origin.x + at.x - from.x));
      node.y = Math.max(0, Math.round(origin.y + at.y - from.y));
      card.style.left = `${node.x}px`;
      card.style.top = `${node.y}px`;
      moved = true;
      this.drawWires();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      card.classList.remove('dragging');
      if (!moved) return;
      this.store.changed(false);
      this.layout();
    };
    card.classList.add('dragging');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    start.preventDefault();
  }

  private dragWire(from: string, type: MediaType, start: PointerEvent): void {
    const { graph, catalog } = this.store;
    const a = this.anchor(from, 'out');
    if (!a) return;
    start.preventDefault();
    start.stopPropagation();
    // Every input says at once whether it would take this wire.
    const verdicts = new Map<string, Verdict>();
    for (const port of this.stage.querySelectorAll<HTMLElement>('.gr-port.in')) {
      const verdict = canConnect(graph, catalog, from, port.dataset.ref as string);
      verdicts.set(port.dataset.ref as string, verdict);
      port.classList.add(verdict.ok ? 'can' : 'cannot');
    }
    this.stage.classList.add('wiring');
    const path = svg('path', { class: `gr-wire type-${type} dragging` });
    this.wires.append(path);
    const target = (e: PointerEvent) => (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('.gr-port.in') ?? null;
    let over: HTMLElement | null = null;
    const move = (e: PointerEvent) => {
      const at = this.toStage(e.clientX, e.clientY);
      const reach = Math.max(36, Math.abs(at.x - a.x) / 2);
      path.setAttribute('d', `M ${a.x} ${a.y} C ${a.x + reach} ${a.y}, ${at.x - reach} ${at.y}, ${at.x} ${at.y}`);
      over?.classList.remove('over');
      over = target(e);
      over?.classList.add('over');
    };
    const up = (e: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const to = target(e)?.dataset.ref;
      this.stage.classList.remove('wiring');
      for (const port of this.stage.querySelectorAll('.gr-port.in')) port.classList.remove('can', 'cannot', 'over');
      path.remove();
      if (!to) return;
      const verdict = verdicts.get(to) as Verdict;
      if (verdict.ok) {
        graph.edges.push({ from, to });
        this.store.changed();
        return;
      }
      const bridges = verdict.bridges;
      const hint = verdict.code === 'type' ? ` ${bridges.length ? t('graphs.bridge.insert', { list: bridges.map((b) => `« ${bridgeLabel(b, catalog)} »`).join(t('graphs.bridge.or')) }) : t('graphs.bridge.none')}` : '';
      this.ui.toast(
        `${refusalText(graph, catalog, verdict.code, verdict.params)}${hint}`,
        bridges.map((bridge) => ({ label: t('graphs.bridge.action', { name: bridgeLabel(bridge, catalog) }), run: () => this.insertBridge(from, to, bridge) })),
      );
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /** Puts a conversion or a model between an output and an input of different types, wired on both sides. */
  private insertBridge(from: string, to: string, bridge: Bridge): void {
    const { graph, catalog } = this.store;
    const a = graph.nodes.find((n) => n.id === endpoint(from).node) as GraphNode;
    const b = graph.nodes.find((n) => n.id === endpoint(to).node) as GraphNode;
    const typeOf = (node: GraphNode, port: string, side: 'inputs' | 'outputs') => nodePorts(node, catalog)?.[side].find((p) => p.id === port)?.type;
    const node: GraphNode =
      bridge.kind === 'convert'
        ? { id: freshId(graph, bridge.convert), kind: 'convert', convert: bridge.convert, x: 0, y: 0 }
        : { id: freshId(graph, catalog.get(bridge.model)?.model ?? 'model'), kind: 'model', model: bridge.model, x: 0, y: 0 };
    // Between the two when there is room for a card, below otherwise.
    const room = b.x - a.x >= 2 * COLUMN;
    node.x = Math.round((a.x + b.x) / 2);
    node.y = room ? Math.min(a.y, b.y) : Math.max(a.y, b.y) + 300;
    graph.nodes.push(node);
    const ports = nodePorts(node, catalog);
    const input = ports?.inputs.find((p) => p.type === typeOf(a, endpoint(from).port, 'outputs'));
    const output = ports?.outputs.find((p) => p.type === typeOf(b, endpoint(to).port, 'inputs'));
    for (const edge of [input && { from, to: `${node.id}.${input.id}` }, output && { from: `${node.id}.${output.id}`, to }]) {
      if (edge && canConnect(graph, catalog, edge.from, edge.to).ok) graph.edges.push(edge);
    }
    this.store.changed();
  }

  private removeEdge(edge: GraphEdge): void {
    const { graph } = this.store;
    graph.edges = graph.edges.filter((e) => e !== edge);
    this.selected = null;
    this.store.changed();
  }

  private removeNode(node: GraphNode): void {
    const { graph } = this.store;
    graph.nodes = graph.nodes.filter((n) => n !== node);
    graph.edges = graph.edges.filter((e) => endpoint(e.from).node !== node.id && endpoint(e.to).node !== node.id);
    this.store.runs.delete(node.id);
    this.store.changed();
  }

  private setModel(node: NodeOf<'model'>, ref: string): void {
    node.model = ref;
    this.store.changed();
    // The wires stay as they were: the ones the new model cannot take are shown broken, with why.
    const broken = this.issues.filter((i) => i.code === 'edge' && i.node === node.id).length;
    if (broken) this.ui.toast(t('graphs.model.broken', { count: broken }));
  }

  /** A place for a new card: under the others, in view. */
  private freeSpot(): Point {
    const boxes = this.boxes();
    const rect = this.scroller.getBoundingClientRect();
    const view = this.toStage(rect.left + 40, rect.top + 60);
    let spot = { x: Math.round(view.x + 40), y: Math.round(Math.max(view.y, Math.max(0, ...boxes.map((b) => b.y + b.h)) + 30)) };
    while (boxes.some((b) => Math.abs(b.x - spot.x) < 30 && Math.abs(b.y - spot.y) < 30)) spot = { x: spot.x + 30, y: spot.y + 30 };
    return spot;
  }

  private add(node: GraphNode): void {
    const { graph } = this.store;
    if (graph.nodes.length >= GRAPH_LIMITS.nodes) return this.ui.toast(t('graphs.tooMany', { max: GRAPH_LIMITS.nodes }));
    graph.nodes.push(node);
    this.store.changed();
    const card = this.card(node.id);
    card?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    card?.classList.add('fresh');
  }

  addModel(spec: ModelSpec): void {
    this.add({ id: freshId(this.store.graph, spec.model), kind: 'model', model: spec.ref, ...this.freeSpot() });
  }

  addConverter(convert: ConverterId): void {
    this.add({ id: freshId(this.store.graph, convert), kind: 'convert', convert, ...this.freeSpot() });
  }

  /** Lines the nodes up from left to right: each one a column after everything it reads. */
  arrange(): void {
    const { graph } = this.store;
    const order = topoOrder(graph);
    if (!order.ok) return this.ui.toast(t('graphs.arrangeLoop'));
    const depth = new Map<string, number>();
    for (const id of order.order) {
      const before = graph.edges.filter((e) => endpoint(e.to).node === id).map((e) => depth.get(endpoint(e.from).node) ?? 0);
      depth.set(id, before.length ? Math.max(...before) + 1 : 0);
    }
    // The answer goes last, alone, whatever feeds it.
    const last = Math.max(0, ...depth.values());
    for (const n of graph.nodes) if (n.kind === 'chat-output') depth.set(n.id, Math.max(last, depth.get(n.id) ?? 0));
    const heights = new Map(this.boxes().map((b) => [b.node.id, b.h]));
    const next = new Map<number, number>();
    for (const node of graph.nodes) {
      const column = depth.get(node.id) ?? 0;
      const y = next.get(column) ?? 70;
      node.x = 36 + column * COLUMN;
      node.y = y;
      next.set(column, y + (heights.get(node.id) ?? 140) + 34);
    }
    this.fitted = true;
    this.store.changed();
  }

  /** The title a node goes by, for the chat's steps. */
  title(node: GraphNode): string {
    return titleOf(node, this.store.catalog);
  }
}
