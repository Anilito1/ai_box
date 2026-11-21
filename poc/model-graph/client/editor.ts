import { portLabel, typeName, type MediaType, type ModelSpec, type Port } from '../shared/capabilities';
import { CONVERTERS, endpoint, freshId, nodePorts, nodeTitle, type ConverterId, type GraphEdge, type GraphNode } from '../shared/graph';
import { canConnect, topoOrder, validateGraph, type Bridge, type Issue, type Verdict } from '../shared/validate';
import { button, h, present, seconds, svg, usd } from './dom';
import type { Store } from './store';
import { outputsView } from './views';

// The graph on screen: nodes as cards, their typed ports on the edges of the card (inputs left, outputs right), wires
// between them. A wire is drawn by dragging from an output to an input; while it is dragged, the inputs that would
// take it light up and the others fade.

export interface EditorUi {
  toast(message: string, actions?: { label: string; run(): void }[]): void;
  /** Opens the list of models next to `anchor`. */
  pickModel(anchor: HTMLElement, current: string | undefined, onPick: (ref: string) => void): void;
}

const NODE_WIDTH = 196;
const COLUMN = NODE_WIDTH + 38;
const STATES: Record<string, string> = { pending: 'en attente', running: 'en cours', done: 'fait', error: 'erreur', skipped: 'non exécuté' };

interface Point {
  x: number;
  y: number;
}

export class Editor {
  private zoom = 1;
  /** Until the user zooms, the graph is kept whole in the window. */
  private fitted = true;
  private selected: GraphEdge | null = null;
  private issues: Issue[] = [];
  private readonly scroller = h('div', 'scroller');
  private readonly sizer = h('div', 'sizer');
  private readonly stage = h('div', 'stage');
  private readonly wires = svg('svg', { class: 'wires' });
  private readonly status = h('div', 'issues');

  constructor(
    root: HTMLElement,
    private readonly store: Store,
    private readonly ui: EditorUi,
  ) {
    this.sizer.append(this.stage);
    this.scroller.append(this.sizer);
    const tools = h(
      'div',
      'canvas-tools',
      button('tool', '−', () => this.setZoom(this.zoom - 0.1), 'Dézoomer'),
      button('tool', '+', () => this.setZoom(this.zoom + 0.1), 'Zoomer'),
      button('tool wide', 'Ajuster', () => this.fit(), 'Voir tout le graphe'),
      button('tool wide', 'Ranger', () => this.arrange(), 'Aligner les nœuds de gauche à droite'),
    );
    const legend = h('div', 'legend', ...(['text', 'image', 'video', 'audio'] as MediaType[]).map((t) => h('span', `legend-item type-${t}`, h('span', 'dot'), { text: 'texte', image: 'image', video: 'vidéo', audio: 'audio' }[t])));
    root.append(this.scroller, tools, legend, this.status);

    store.onGraph.push(() => this.render());
    store.onRun.push((id) => this.updateRun(id));
    new ResizeObserver(() => (this.fitted ? this.fit() : this.layout())).observe(this.scroller);
    this.scroller.addEventListener('pointerdown', (e) => {
      if (e.target === this.scroller || e.target === this.stage || e.target === this.sizer) this.select(null);
    });
    document.addEventListener('keydown', (e) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) this.removeEdge(this.selected);
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

  private nodeView(node: GraphNode): HTMLElement {
    const { catalog } = this.store;
    const spec = node.kind === 'model' && node.model ? catalog.get(node.model) : undefined;
    const ports = nodePorts(node, catalog);
    const problem = this.issues.find((i) => i.node === node.id && i.level === 'error' && i.code !== 'edge');
    const el = h('div', `node kind-${node.kind}${problem ? ' has-issue' : ''}`);
    el.dataset.id = node.id;
    el.style.left = `${node.x}px`;
    el.style.top = `${node.y}px`;
    el.style.width = `${NODE_WIDTH}px`;
    if (problem) el.title = problem.message;

    const head = h('div', 'node-head', h('span', 'state-dot'));
    if (node.kind === 'chat-input' || node.kind === 'chat-output') {
      head.append(h('span', 'node-name', nodeTitle(node, catalog)));
    } else {
      const title = h('input', 'node-title');
      title.value = node.title ?? '';
      title.placeholder = node.kind === 'convert' ? nodeTitle(node, catalog) : 'Rôle de ce modèle';
      title.title = 'À quoi sert ce nœud';
      title.addEventListener('input', () => {
        if (title.value.trim()) node.title = title.value.trim().slice(0, 80);
        else delete node.title;
        this.store.changed(false);
      });
      head.append(title, button('node-delete', '×', () => this.removeNode(node), 'Supprimer ce nœud'));
    }
    el.append(head);

    if (node.kind === 'chat-input') el.append(h('div', 'node-hint', 'Le message écrit dans le chat, et ses images jointes.'));
    if (node.kind === 'chat-output') el.append(h('div', 'node-hint', 'Ce que le chat affiche en réponse.'));
    if (node.kind === 'convert' && node.convert) el.append(h('div', 'node-hint', CONVERTERS[node.convert]?.hint ?? ''));
    if (node.kind === 'model') {
      const pick = button(`node-model${spec ? '' : ' missing'}`, spec ? spec.name : node.model ? `${node.model} (introuvable)` : 'Choisir un modèle…', () => this.ui.pickModel(pick, node.model, (ref) => this.setModel(node, ref)), 'Changer de modèle');
      el.append(pick);
      if (spec) {
        const provider = this.store.state.providers.find((p) => p.id === spec.provider)?.name ?? 'Simulé';
        el.append(h('div', 'node-provider', provider, spec.source === 'guessed' ? h('span', 'guessed', 'capacités devinées') : null));
      }
    }

    if (ports) {
      el.append(
        h(
          'div',
          'ports',
          h('div', 'ports-in', ...ports.inputs.map((p) => this.portView(node, p, 'in'))),
          h('div', 'ports-out', ...ports.outputs.map((p) => this.portView(node, p, 'out'))),
        ),
      );
    }

    if (spec?.api === 'chat') {
      const text = h('textarea', 'node-instruction');
      text.rows = 3;
      text.placeholder = 'Consigne : le rôle de ce modèle dans la chaîne';
      text.value = node.instruction ?? '';
      text.addEventListener('input', () => {
        if (text.value.trim()) node.instruction = text.value;
        else delete node.instruction;
        this.store.changed(false);
      });
      el.append(text);
    }
    if (spec?.api === 'video' && spec.durations?.length) el.append(this.option(node, 'duration', 'Durée', spec.durations));
    if (node.kind === 'convert' && node.convert === 'frames') el.append(this.option(node, 'count', 'Images', ['1', '2', '4', '6', '8'], '4'));

    el.append(h('div', 'node-run'));
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('input, textarea, select, button, .port, video, audio, a')) return;
      this.dragNode(node, el, e);
    });
    return el;
  }

  private option(node: GraphNode, key: string, label: string, values: string[], fallback = values[0]): HTMLElement {
    const select = h('select', 'node-select', ...values.map((v) => Object.assign(h('option', '', v), { value: v })));
    // A value kept from another model (its "3s" where this one takes "5s") gives way to this model's own.
    const kept = node.options?.[key];
    select.value = kept !== undefined && values.includes(kept) ? kept : fallback;
    select.addEventListener('change', () => {
      node.options = { ...node.options, [key]: select.value };
      this.store.changed(false);
    });
    return h('label', 'node-option', h('span', '', label), select);
  }

  private portView(node: GraphNode, port: Port, side: 'in' | 'out'): HTMLElement {
    // The answer takes whatever comes: how many of each is of no interest on the card.
    const label = node.kind === 'chat-output' ? typeName(port.type) : portLabel(port);
    const optional = side === 'in' && !port.required && node.kind !== 'chat-output';
    const el = h('div', `port ${side} type-${port.type}${optional ? ' optional' : ''}`, h('span', 'dot'), h('span', 'port-type', label), optional ? h('span', 'port-name', 'facultatif') : null);
    el.dataset.ref = `${node.id}.${port.id}`;
    el.title = side === 'in' ? `Entrée « ${port.id} » : ${portLabel(port)}${port.required ? ' (obligatoire)' : ' (facultative)'}` : `Sortie « ${port.id} » : ${portLabel(port)}. Tire depuis ici vers une entrée de même couleur.`;
    if (side === 'out') el.addEventListener('pointerdown', (e) => e.button === 0 && this.dragWire(el.dataset.ref as string, port.type, e));
    return el;
  }

  /** What the run left on a node: its state, where a long call is, what it made. */
  private updateRun(id: string, redraw = true): void {
    const el = this.stage.querySelector<HTMLElement>(`.node[data-id="${id}"]`);
    if (!el) return;
    const run = this.store.runs.get(id);
    const box = el.querySelector('.node-run') as HTMLElement;
    if (!run) {
      delete el.dataset.state;
      box.replaceChildren();
    } else {
      el.dataset.state = run.state;
      const facts = [STATES[run.state], run.state === 'running' ? run.progress : '', run.state === 'done' && run.ms !== undefined && run.ms >= 100 ? seconds(run.ms) : '', run.costUsd ? usd(run.costUsd) : ''].filter(Boolean).join(' · ');
      const kind = this.store.graph.nodes.find((n) => n.id === id)?.kind;
      const chat = kind === 'chat-input' || kind === 'chat-output';
      box.replaceChildren(
        ...present(
          // The chat's own nodes only show their state, on the dot: the conversation shows the rest.
          chat && !run.error ? null : h('div', 'run-line', facts),
          run.error ? h('div', 'run-error', run.error) : null,
          run.outputs && !chat ? outputsView(run.outputs, true) : null,
        ),
      );
    }
    // A node that grew moved nothing above it, but the wires that go around it must go lower.
    if (redraw) this.layout();
  }

  private showIssues(): void {
    const errors = this.issues.filter((i) => i.level === 'error');
    const warnings = this.issues.filter((i) => i.level === 'warning');
    const { graph } = this.store;
    this.status.className = `issues ${errors.length ? 'bad' : 'ok'}`;
    if (errors.length === 0 && warnings.length === 0) {
      const models = graph.nodes.filter((n) => n.kind === 'model').length;
      this.status.replaceChildren(h('span', 'issues-title', '✓ Graphe prêt'), ` ${models} modèle${models > 1 ? 's' : ''}, ${graph.edges.length} liens`);
      return;
    }
    this.status.replaceChildren(
      h('span', 'issues-title', errors.length ? `${errors.length} problème${errors.length > 1 ? 's' : ''} à corriger` : '✓ Graphe prêt'),
      h('ul', '', ...[...errors, ...warnings].slice(0, 6).map((i) => h('li', i.level, i.message))),
    );
  }

  // ── Size and wires ───────────────────────────────────────────────────────────────────────────────────────────

  private boxes(): { node: GraphNode; x: number; y: number; w: number; h: number }[] {
    return this.store.graph.nodes.map((node) => {
      const el = this.stage.querySelector<HTMLElement>(`.node[data-id="${node.id}"]`);
      return { node, x: node.x, y: node.y, w: el?.offsetWidth ?? NODE_WIDTH, h: el?.offsetHeight ?? 120 };
    });
  }

  /** Sizes the stage around the nodes and draws the wires again. */
  private layout(): void {
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
    this.zoom = Math.max(0.5, Math.min(1, (this.scroller.clientWidth - 4) / right));
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

  private anchor(ref: string, side: 'in' | 'out'): Point | null {
    const dot = this.stage.querySelector(`.port.${side}[data-ref="${ref}"] .dot`);
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
    this.stage.querySelector('.wire-delete')?.remove();
    for (const el of this.stage.querySelectorAll('.port.wired')) el.classList.remove('wired');
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
      const path = svg('path', { d, class: `wire type-${type}${bad.has(edge) ? ' bad' : ''}${flowed ? ' flowed' : ''}${flowing ? ' flowing' : ''}${edge === this.selected ? ' selected' : ''}` });
      const hit = svg('path', { d, class: 'wire-hit' });
      hit.addEventListener('click', () => this.select(edge));
      hit.append(Object.assign(svg('title'), { textContent: `${edge.from} → ${edge.to} — clique pour sélectionner, puis Suppr` }));
      this.wires.append(path, hit);
      for (const [ref, side] of [[edge.from, 'out'], [edge.to, 'in']] as const) this.stage.querySelector(`.port.${side}[data-ref="${ref}"]`)?.classList.add('wired');
      if (edge === this.selected) {
        const mid = path.getPointAtLength(path.getTotalLength() / 2);
        const remove = button('wire-delete', '×', () => this.removeEdge(edge), 'Supprimer ce lien');
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

  private dragNode(node: GraphNode, el: HTMLElement, start: PointerEvent): void {
    const from = this.toStage(start.clientX, start.clientY);
    const origin = { x: node.x, y: node.y };
    let moved = false;
    const move = (e: PointerEvent) => {
      const at = this.toStage(e.clientX, e.clientY);
      node.x = Math.max(0, Math.round(origin.x + at.x - from.x));
      node.y = Math.max(0, Math.round(origin.y + at.y - from.y));
      el.style.left = `${node.x}px`;
      el.style.top = `${node.y}px`;
      moved = true;
      this.drawWires();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      el.classList.remove('dragging');
      if (!moved) return;
      this.store.changed(false);
      this.layout();
    };
    el.classList.add('dragging');
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
    for (const el of this.stage.querySelectorAll<HTMLElement>('.port.in')) {
      const verdict = canConnect(graph, catalog, from, el.dataset.ref as string);
      verdicts.set(el.dataset.ref as string, verdict);
      el.classList.add(verdict.ok ? 'can' : 'cannot');
    }
    this.stage.classList.add('wiring');
    const path = svg('path', { class: `wire type-${type} dragging` });
    this.wires.append(path);
    const target = (e: PointerEvent) => (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('.port.in') ?? null;
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
      for (const el of this.stage.querySelectorAll('.port.in')) el.classList.remove('can', 'cannot', 'over');
      path.remove();
      if (!to) return;
      const verdict = verdicts.get(to) as Verdict;
      if (verdict.ok) {
        graph.edges.push({ from, to });
        this.store.changed();
        return;
      }
      this.ui.toast(
        verdict.message,
        verdict.bridges.map((bridge) => ({ label: `Insérer « ${bridge.label} »`, run: () => this.insertBridge(from, to, bridge) })),
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

  private setModel(node: GraphNode, ref: string): void {
    node.model = ref;
    this.store.changed();
    // The wires stay as they were: the ones the new model cannot take are shown broken, with why.
    const broken = this.issues.filter((i) => i.code === 'edge' && i.node === node.id).length;
    if (broken) this.ui.toast(`Ce modèle n’a pas les mêmes entrées et sorties : ${broken} lien${broken > 1 ? 's' : ''} en pointillés rouges ne convien${broken > 1 ? 'nent' : 't'} plus. Retire-les ou choisis un autre modèle.`);
  }

  /** A place for a new card: right of the last column, in view. */
  private freeSpot(): Point {
    const boxes = this.boxes();
    const view = this.toStage(this.scroller.getBoundingClientRect().left + 40, this.scroller.getBoundingClientRect().top + 60);
    let spot = { x: Math.round(view.x + 40), y: Math.round(Math.max(view.y, Math.max(0, ...boxes.map((b) => b.y + b.h)) + 30)) };
    while (boxes.some((b) => Math.abs(b.x - spot.x) < 30 && Math.abs(b.y - spot.y) < 30)) spot = { x: spot.x + 30, y: spot.y + 30 };
    return spot;
  }

  addModel(spec: ModelSpec): void {
    const { graph } = this.store;
    graph.nodes.push({ id: freshId(graph, spec.model), kind: 'model', model: spec.ref, ...this.freeSpot() });
    this.store.changed();
    this.reveal(graph.nodes[graph.nodes.length - 1].id);
  }

  addConverter(convert: ConverterId): void {
    const { graph } = this.store;
    graph.nodes.push({ id: freshId(graph, convert), kind: 'convert', convert, ...this.freeSpot() });
    this.store.changed();
    this.reveal(graph.nodes[graph.nodes.length - 1].id);
  }

  private reveal(id: string): void {
    const el = this.stage.querySelector<HTMLElement>(`.node[data-id="${id}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    el?.classList.add('fresh');
  }

  /** Lines the nodes up from left to right: each one a column after everything it reads. */
  arrange(): void {
    const { graph } = this.store;
    const order = topoOrder(graph);
    if (!order.ok) {
      this.ui.toast('Le graphe fait une boucle : retire un lien avant de ranger.');
      return;
    }
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
}
