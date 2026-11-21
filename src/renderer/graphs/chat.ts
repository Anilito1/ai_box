import type { Turn } from '../../shared/graph/engine';
import type { ClientValue, GraphPrefs, GraphRunEvent } from '../../shared/graph/protocol';
import { GRAPH_MAX_USD_LIMIT } from '../../shared/graph/protocol';
import { equivalents, errorsOf, validateGraph } from '../../shared/graph/validate';
import type { HubApi } from '../../shared/types';
import { t } from '../i18n';
import { issueText, titleOf } from './describe';
import { button, el, present, seconds, usd } from './dom';
import type { GraphStore, NodeRun } from './store';
import { forgetMedia, outputsView, valueView } from './values';

// The test chat: the user writes to the graph as to one chatbot. Each message runs the whole graph in the main
// process; the answer shows the steps while they run, then what reached the chat's answer. Above it, the models'
// side (simulated or real) and what a message may cost.

const SIM = 'sim';
const ICONS: Record<string, string> = { pending: '○', running: '◐', done: '✓', error: '✕', skipped: '–' };

interface Attached {
  mime: string;
  data: Uint8Array;
  url: string;
}

export interface ChatHost {
  toast(message: string, actions?: { label: string; run(): void }[]): void;
  /** Settings › Accounts, where a provider and its key are added. */
  openProviders(): void;
}

export class GraphChat {
  private readonly list = el('div', 'gr-messages');
  private readonly input = el('textarea', 'gr-composer-input');
  private readonly send = button('gr-send', t('graphs.chat.send'), () => (this.stop ? this.cancel() : void this.submit()));
  private readonly attach = button('gr-attach', t('graphs.chat.attach'), () => this.file.click(), t('graphs.chat.attachHint'));
  private readonly file = el('input');
  private readonly chips = el('div', 'gr-attached');
  private readonly cap = el('input', 'gr-cap');
  private readonly unknown = el('input');
  private readonly spent = el('span', 'gr-spent');
  private readonly modes = { sim: button('gr-seg', t('graphs.mode.sim'), () => this.switchMode('sim'), t('graphs.mode.simHint')), real: button('gr-seg', t('graphs.mode.real'), () => this.switchMode('real'), t('graphs.mode.realHint')) };
  private history: Turn[] = [];
  private attached: Attached[] = [];
  private stop: AbortController | null = null;
  private runId = '';
  /** The events of the run under way, as they come. */
  private onEvent: ((e: GraphRunEvent) => void) | null = null;
  private prefs: GraphPrefs = { maxUsd: 1, refuseUnknownPrice: false };

  /** A run is under way: the graph it runs stays the one shown. */
  get busy(): boolean {
    return this.stop !== null;
  }

  constructor(
    root: HTMLElement,
    private readonly hub: HubApi,
    private readonly store: GraphStore,
    private readonly host: ChatHost,
  ) {
    this.input.rows = 2;
    this.input.placeholder = t('graphs.chat.placeholder');
    this.input.setAttribute('aria-label', t('graphs.chat.placeholder'));
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (!this.stop) void this.submit();
      }
    });
    this.file.type = 'file';
    this.file.accept = 'image/png,image/jpeg,image/webp,image/gif';
    this.file.multiple = true;
    this.file.hidden = true;
    this.file.addEventListener('change', () => void this.addFiles());
    this.cap.type = 'number';
    this.cap.min = '0.01';
    this.cap.max = String(GRAPH_MAX_USD_LIMIT);
    this.cap.step = '0.05';
    this.cap.title = t('graphs.cap.hint');
    this.cap.setAttribute('aria-label', t('graphs.cap'));
    this.cap.addEventListener('change', () => void this.savePrefs());
    this.unknown.type = 'checkbox';
    this.unknown.addEventListener('change', () => void this.savePrefs());
    root.append(
      el('div', 'gr-chat-head', el('div', 'gr-chat-title', t('graphs.chat.title')), button('gr-link', t('graphs.chat.clear'), () => this.clear()), el('div', 'gr-chat-sub', t('graphs.chat.sub'))),
      el(
        'div',
        'gr-chat-settings',
        el('div', 'gr-segmented', this.modes.sim, this.modes.real),
        el('label', 'gr-cap-row', t('graphs.cap'), this.cap, '$'),
        el('label', 'gr-check', this.unknown, t('graphs.unknownPrice')),
      ),
      this.list,
      el('div', 'gr-composer', this.chips, el('div', 'gr-composer-row', this.input, el('div', 'gr-composer-side', this.send, this.attach)), this.file, el('div', 'gr-composer-foot', this.spent)),
    );
    store.onGraph.push(() => this.sync());
    store.onLoad.push(() => this.clear());
    hub.onGraphRun((runId, event) => runId === this.runId && this.onEvent?.(event));
    void hub.graphsPrefs().then((p) => this.showPrefs(p));
    this.clear();
  }

  private showPrefs(prefs: GraphPrefs): void {
    this.prefs = prefs;
    this.cap.value = prefs.maxUsd.toFixed(2);
    this.unknown.checked = prefs.refuseUnknownPrice;
  }

  private async savePrefs(): Promise<void> {
    const max = Number(this.cap.value);
    const next = { maxUsd: Number.isFinite(max) && max > 0 ? max : this.prefs.maxUsd, refuseUnknownPrice: this.unknown.checked };
    this.showPrefs(await this.hub.graphsPrefs(next));
  }

  /** The attach button for a graph whose input sends images on; the models' side lit. */
  private sync(): void {
    const { graph, catalog } = this.store;
    const entry = graph.nodes.find((n) => n.kind === 'chat-input');
    this.attach.hidden = !entry || !graph.edges.some((e) => e.from === `${entry.id}.images`);
    const providers = graph.nodes.flatMap((n) => (n.kind === 'model' && n.model ? [catalog.get(n.model)?.provider ?? n.model.split('/')[0]] : []));
    const sim = providers.every((p) => p === SIM);
    const real = providers.length > 0 && providers.every((p) => p !== SIM);
    this.modes.sim.classList.toggle('on', sim);
    this.modes.real.classList.toggle('on', real);
    this.modes.sim.parentElement?.classList.toggle('mixed', !sim && !real);
  }

  /** Puts every model node on a model of the other side with the same wired ports: the cheapest known that fits. */
  private switchMode(to: 'sim' | 'real'): void {
    const { graph, catalog } = this.store;
    if (this.stop) return;
    if (to === 'real' && !this.store.view.providers.some((p) => p.id !== SIM)) {
      return this.host.toast(t('graphs.mode.noProvider'), [{ label: t('graphs.mode.openProviders'), run: () => this.host.openProviders() }]);
    }
    const moved: string[] = [];
    const left: string[] = [];
    for (const node of graph.nodes) {
      if (node.kind !== 'model') continue;
      const spec = node.model ? catalog.get(node.model) : undefined;
      if (!spec || (spec.provider === SIM) === (to === 'sim')) continue;
      const other = equivalents(graph, node, catalog, (m) => (m.provider === SIM) === (to === 'sim'))[0];
      if (other) {
        moved.push(`« ${titleOf(node, catalog)} » → ${other.name || other.model}`);
        node.model = other.ref;
      } else left.push(`« ${titleOf(node, catalog)} »`);
    }
    this.store.changed();
    const parts = [moved.length ? t(to === 'real' ? 'graphs.mode.movedReal' : 'graphs.mode.movedSim', { list: moved.join(' ; ') }) : t('graphs.mode.unchanged'), left.length ? t('graphs.mode.left', { list: left.join(', ') }) : ''];
    this.host.toast(parts.filter(Boolean).join(' '));
  }

  private clear(): void {
    if (this.stop) return;
    this.history = [];
    // A new conversation: the files the last one showed leave memory.
    forgetMedia('');
    this.list.replaceChildren(el('div', 'gr-empty', el('p', '', t('graphs.chat.empty')), ...[t('graphs.chat.try1'), t('graphs.chat.try2')].map((text) => button('gr-suggestion', text, () => {
      this.input.value = text;
      void this.submit();
    }))));
  }

  private async addFiles(): Promise<void> {
    for (const file of [...(this.file.files ?? [])].slice(0, 8 - this.attached.length)) {
      if (file.size > 20 * 1024 * 1024) {
        this.host.toast(t('graphs.chat.tooBig', { name: file.name }));
        continue;
      }
      this.attached.push({ mime: file.type || 'image/png', data: new Uint8Array(await file.arrayBuffer()), url: URL.createObjectURL(file) });
    }
    this.file.value = '';
    this.showAttached();
  }

  private showAttached(): void {
    this.chips.replaceChildren(
      ...this.attached.map((a) => {
        const img = el('img');
        img.src = a.url;
        img.alt = '';
        return el('span', 'gr-chip', img, button('gr-chip-remove', '×', () => {
          URL.revokeObjectURL(a.url);
          this.attached = this.attached.filter((x) => x !== a);
          this.showAttached();
        }, t('graphs.chat.detach')));
      }),
    );
  }

  private scroll(): void {
    this.list.scrollTop = this.list.scrollHeight;
  }

  private cancel(): void {
    this.stop?.abort();
    if (this.runId) this.hub.graphsCancel(this.runId);
  }

  private async submit(): Promise<void> {
    const text = this.input.value.trim();
    const { store } = this;
    if ((!text && this.attached.length === 0) || !store.id) return;
    const refused = errorsOf(validateGraph(store.graph, store.catalog));
    if (refused.length) return this.host.toast(t('graphs.chat.invalid', { problem: issueText(store.graph, store.catalog, refused[0]) }));
    const images = this.attached;
    this.attached = [];
    this.showAttached();
    this.input.value = '';
    if (this.history.length === 0) this.list.replaceChildren();

    const bubble = el('div', 'gr-bubble', text);
    if (images.length) bubble.append(el('div', 'gr-media-row many', ...images.map((a) => Object.assign(el('img', 'gr-thumb'), { src: a.url, alt: '' }))));
    const steps = el('div', 'gr-steps');
    const summary = el('summary', '', t('graphs.chat.running'));
    const details = el('details', 'gr-run', summary, steps);
    details.open = true;
    const answer = el('div', 'gr-answer');
    this.list.append(el('div', 'gr-message user', bubble), el('div', 'gr-message assistant', el('div', 'gr-bubble', details, answer)));
    this.scroll();

    const runId = `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const rows = new Map<string, HTMLElement>();
    const started = Date.now();
    let final: Record<string, ClientValue[]> = {};
    let ended = false;
    // The call's answer and the run's events come by two channels: the last event may come after the answer.
    let finish = () => {};
    const finished = new Promise<void>((resolve) => (finish = resolve));
    const row = (id: string, run: NodeRun) => {
      const node = store.graph.nodes.find((n) => n.id === id);
      if (!node || node.kind === 'chat-input' || node.kind === 'chat-output') return;
      let line = rows.get(id);
      if (!line) {
        line = el('div', 'gr-step');
        rows.set(id, line);
        steps.append(line);
      }
      line.dataset.state = run.state;
      const facts = [run.state === 'running' ? (run.progress ?? t('graphs.state.running')) : '', run.state === 'done' && run.ms !== undefined ? seconds(run.ms) : '', run.costUsd ? usd(run.costUsd) : '', run.state === 'skipped' ? t('graphs.state.skipped') : ''].filter(Boolean).join(' · ');
      line.replaceChildren(
        ...present(
          el('div', 'gr-step-line', el('span', 'gr-step-icon', ICONS[run.state]), el('span', 'gr-step-name', titleOf(node, store.catalog)), el('span', 'gr-step-facts', facts)),
          run.error && el('div', 'gr-run-error', run.error),
          run.state === 'done' && run.outputs && outputsView(this.hub, runId, run.outputs, true),
        ),
      );
    };

    this.onEvent = (e) => {
      if (e.type === 'node') {
        // An event that only says "still running, here" keeps what the node already had.
        const { type: _type, id, ...rest } = e;
        const run: NodeRun = { ...(e.state === 'running' ? store.runs.get(id) : {}), ...rest };
        store.setRun(id, run);
        if (store.graph.nodes.find((n) => n.id === id)?.kind === 'chat-output' && e.state === 'done') final = e.outputs ?? {};
        row(id, run);
      } else if (e.state === 'running') {
        for (const id of e.order ?? []) row(id, { state: 'pending' });
      } else {
        ended = true;
        finish();
        const cost = e.costUsd ? ` · ${usd(e.costUsd)}` : '';
        summary.textContent = `${e.state === 'done' ? t('graphs.chat.steps', { count: rows.size }) : e.state === 'cancelled' ? t('graphs.chat.stopped') : t('graphs.chat.failed')} · ${seconds(Date.now() - started)}${cost}`;
        this.spent.textContent = e.costUsd ? t('graphs.chat.spent', { cost: usd(e.costUsd) }) : '';
        if (e.state === 'done') {
          details.open = false;
          // Media first, then the words about them.
          const shown = [...(final.video ?? []), ...(final.image ?? []), ...(final.audio ?? []), ...(final.text ?? [])];
          answer.replaceChildren(...shown.map((v) => valueView(this.hub, runId, v, false)));
          if (shown.length === 0) answer.append(el('div', 'gr-note', t('graphs.chat.nothing')));
          const said = (final.text ?? []).flatMap((v) => (v.type === 'text' ? [v.text] : [])).join('\n\n');
          this.history.push({ role: 'user', text }, { role: 'assistant', text: said || t('graphs.chat.noText') });
        } else {
          const why = e.issues?.length ? e.issues.map((i) => issueText(store.graph, store.catalog, i)).join('\n') : (e.error ?? t('graphs.chat.failed'));
          answer.replaceChildren(el('div', 'gr-run-error', e.state === 'cancelled' ? t('graphs.chat.stoppedLong') : why));
        }
      }
      this.scroll();
    };

    this.stop = new AbortController();
    this.runId = runId;
    store.clearRuns();
    store.runId = runId;
    this.send.textContent = t('graphs.chat.stop');
    this.send.classList.add('stop');
    try {
      await this.hub.graphsRun(runId, { graph: store.graph, text, images: images.map(({ mime, data }) => ({ mime, data })), history: this.history, maxUsd: this.prefs.maxUsd });
      await Promise.race([finished, new Promise((resolve) => setTimeout(resolve, 5000))]);
      if (!ended) throw new Error(t('graphs.chat.cut'));
    } catch (err) {
      summary.textContent = this.stop.signal.aborted ? t('graphs.chat.stopped') : t('graphs.chat.failed');
      answer.replaceChildren(el('div', 'gr-run-error', this.stop.signal.aborted ? t('graphs.chat.stoppedLong') : err instanceof Error ? err.message : String(err)));
      // The nodes still shown as running will hear nothing more.
      for (const [id, run] of store.runs) if (run.state === 'running' || run.state === 'pending') store.setRun(id, { ...run, state: 'skipped' });
    } finally {
      for (const a of images) URL.revokeObjectURL(a.url);
      this.onEvent = null;
      this.stop = null;
      this.send.textContent = t('graphs.chat.send');
      this.send.classList.remove('stop');
      for (const [id, run] of store.runs) row(id, run);
      this.scroll();
      this.input.focus();
    }
  }
}
