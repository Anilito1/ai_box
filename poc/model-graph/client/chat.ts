import type { Turn } from '../shared/engine';
import { nodeTitle } from '../shared/graph';
import type { ClientEvent, ClientValue } from '../shared/protocol';
import { errorsOf, validateGraph } from '../shared/validate';
import { runGraph } from './api';
import { button, h, present, seconds, usd } from './dom';
import type { NodeRun, Store } from './store';
import { outputsView, valueView } from './views';

// The conversation: the user writes to the graph as to one chatbot. Each message runs the whole graph; the answer
// shows the steps while they run, then what reached the "Réponse chat" node.

const ICONS: Record<string, string> = { pending: '○', running: '◐', done: '✓', error: '✕', skipped: '–' };
const SUGGESTIONS = ['Un renard roux qui court dans la neige au lever du soleil', 'Une ville futuriste sous la pluie, néons violets'];

interface Attached {
  mime: string;
  base64: string;
  url: string;
}

export class Chat {
  private readonly list = h('div', 'messages');
  private readonly input = h('textarea', 'composer-input');
  private readonly send = button('send', 'Envoyer', () => (this.stop ? this.stop.abort() : void this.submit()));
  private readonly attach = button('attach', '＋ image', () => this.file.click(), 'Joindre des images : elles sortent du port « images » de l’entrée du chat');
  private readonly file = h('input');
  private readonly chips = h('div', 'attached');
  private readonly cap = h('input', 'cap');
  private readonly spent = h('span', 'spent');
  private history: Turn[] = [];
  private attached: Attached[] = [];
  private stop: AbortController | null = null;

  constructor(
    root: HTMLElement,
    private readonly store: Store,
    private readonly toast: (message: string) => void,
  ) {
    this.input.rows = 2;
    this.input.placeholder = 'Écris au graphe…';
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (!this.stop) void this.submit();
      }
    });
    this.file.type = 'file';
    this.file.accept = 'image/*';
    this.file.multiple = true;
    this.file.hidden = true;
    this.file.addEventListener('change', () => void this.addFiles());
    this.cap.type = 'number';
    this.cap.min = '0';
    this.cap.step = '0.05';
    this.cap.value = '0.50';
    this.cap.title = 'Le graphe s’arrête avant une étape qui ferait dépasser ce coût';
    root.append(
      h('div', 'chat-head', h('div', 'chat-title', 'Chat'), button('link', 'Effacer', () => this.clear()), h('div', 'chat-sub', 'Un seul chatbot : chaque message traverse tout le graphe.')),
      this.list,
      h('div', 'composer', this.chips, h('div', 'composer-row', this.input, h('div', 'composer-side', this.send, this.attach)), this.file, h('label', 'cap-row', 'Plafond par message', this.cap, '$', this.spent)),
    );
    store.onGraph.push(() => this.showAttach());
    store.onLoad.push(() => this.clear());
    this.showAttach();
    this.clear();
  }

  private showAttach(): void {
    const entry = this.store.graph.nodes.find((n) => n.kind === 'chat-input');
    this.attach.hidden = !entry || !this.store.graph.edges.some((e) => e.from === `${entry.id}.images`);
  }

  private clear(): void {
    if (this.stop) return;
    this.history = [];
    this.list.replaceChildren(
      h(
        'div',
        'empty',
        h('p', '', 'Écris un message : il entre par « Entrée chat », traverse les modèles de gauche à droite, et ce qui arrive à « Réponse chat » s’affiche ici.'),
        ...SUGGESTIONS.map((text) =>
          button('suggestion', text, () => {
            this.input.value = text;
            void this.submit();
          }),
        ),
      ),
    );
  }

  private async addFiles(): Promise<void> {
    for (const file of [...(this.file.files ?? [])].slice(0, 8 - this.attached.length)) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      this.attached.push({ mime: file.type || 'image/png', base64: btoa(binary), url: URL.createObjectURL(file) });
    }
    this.file.value = '';
    this.showAttached();
  }

  private showAttached(): void {
    this.chips.replaceChildren(
      ...this.attached.map((a) => {
        const img = h('img');
        img.src = a.url;
        return h(
          'span',
          'chip',
          img,
          button('chip-remove', '×', () => {
            this.attached = this.attached.filter((x) => x !== a);
            this.showAttached();
          }),
        );
      }),
    );
  }

  private scroll(): void {
    this.list.scrollTop = this.list.scrollHeight;
  }

  private async submit(): Promise<void> {
    const text = this.input.value.trim();
    const { store } = this;
    if (!text && this.attached.length === 0) return;
    const refused = errorsOf(validateGraph(store.graph, store.catalog));
    if (refused.length) {
      this.toast(`Le graphe ne peut pas encore tourner : ${refused[0].message}`);
      return;
    }
    // No cap, no run: an empty box must not mean "whatever it costs".
    const cap = Number(this.cap.value);
    if (this.cap.value.trim() === '' || !Number.isFinite(cap) || cap < 0) {
      this.toast('Indique un plafond par message, en dollars : le graphe s’arrête avant de le dépasser.');
      return;
    }
    const images = this.attached;
    this.attached = [];
    this.showAttached();
    this.input.value = '';
    if (this.history.length === 0) this.list.replaceChildren();

    const mine = h('div', 'message user', h('div', 'bubble', text));
    if (images.length) mine.firstElementChild?.append(h('div', 'media-row many', ...images.map((a) => Object.assign(h('img', 'thumb'), { src: a.url }))));
    const steps = h('div', 'steps');
    const summary = h('summary', '', 'Exécution du graphe…');
    const details = h('details', 'run', summary, steps);
    details.open = true;
    const answer = h('div', 'answer');
    this.list.append(mine, h('div', 'message assistant', h('div', 'bubble', details, answer)));
    this.scroll();

    const rows = new Map<string, HTMLElement>();
    const started = Date.now();
    let order: string[] = [];
    let final: Record<string, ClientValue[]> = {};
    let ended = false;
    const row = (id: string, run: NodeRun) => {
      const node = store.graph.nodes.find((n) => n.id === id);
      if (!node || node.kind === 'chat-input' || node.kind === 'chat-output') return;
      let el = rows.get(id);
      if (!el) {
        el = h('div', 'step');
        rows.set(id, el);
        steps.append(el);
      }
      el.dataset.state = run.state;
      const facts = [run.state === 'running' ? (run.progress ?? 'en cours') : '', run.state === 'done' && run.ms !== undefined ? seconds(run.ms) : '', run.costUsd ? usd(run.costUsd) : '', run.state === 'skipped' ? 'non exécuté' : ''].filter(Boolean).join(' · ');
      el.replaceChildren(
        ...present(
          h('div', 'step-line', h('span', 'step-icon', ICONS[run.state]), h('span', 'step-name', nodeTitle(node, store.catalog)), h('span', 'step-facts', facts)),
          run.error ? h('div', 'run-error', run.error) : null,
          run.state === 'done' && run.outputs ? outputsView(run.outputs, true) : null,
        ),
      );
    };

    const onEvent = (e: ClientEvent) => {
      if (e.type === 'node') {
        // An event that only says "still running, here" keeps what the node already had.
        const { type: _type, id, ...rest } = e;
        const run: NodeRun = { ...(e.state === 'running' ? store.runs.get(id) : {}), ...rest };
        store.setRun(id, run);
        if (store.graph.nodes.find((n) => n.id === id)?.kind === 'chat-output' && e.state === 'done') final = e.outputs ?? {};
        row(id, run);
      } else if (e.type === 'run' && e.state === 'running') {
        order = e.order ?? [];
        for (const id of order) row(id, { state: 'pending' });
      } else if (e.type === 'run') {
        ended = true;
        const count = rows.size;
        const cost = e.costUsd ? ` · ${usd(e.costUsd)}` : '';
        summary.textContent = `${e.state === 'done' ? `${count} étape${count > 1 ? 's' : ''}` : e.state === 'cancelled' ? 'Arrêté' : 'Échec'} · ${seconds(Date.now() - started)}${cost}`;
        this.spent.textContent = e.costUsd ? `dernier message : ${usd(e.costUsd)}` : '';
        if (e.state === 'done') {
          details.open = false;
          // Media first, then the words about it.
          const shown = [...(final.video ?? []), ...(final.image ?? []), ...(final.audio ?? []), ...(final.text ?? [])];
          answer.replaceChildren(...shown.map((v) => valueView(v, false)));
          if (shown.length === 0) answer.append(h('div', 'value-note', 'Le graphe a tourné, mais rien n’est arrivé à « Réponse chat ».'));
          const said = (final.text ?? []).flatMap((v) => (v.type === 'text' ? [v.text] : [])).join('\n\n');
          this.history.push({ role: 'user', text }, { role: 'assistant', text: said || '[réponse sans texte : image ou vidéo]' });
        } else {
          answer.replaceChildren(h('div', 'run-error', e.state === 'cancelled' ? 'Exécution arrêtée.' : (e.error ?? 'Le graphe a échoué.')));
        }
      }
      this.scroll();
    };

    this.stop = new AbortController();
    store.clearRuns();
    store.running = true;
    this.send.textContent = 'Arrêter';
    this.send.classList.add('stop');
    try {
      await runGraph({ graph: store.graph, text, images: images.map(({ mime, base64 }) => ({ mime, base64 })), history: this.history, maxCostUsd: cap }, onEvent, this.stop.signal);
      if (!ended) throw new Error('Le serveur du POC a coupé l’exécution sans la conclure.');
    } catch (err) {
      const stopped = this.stop.signal.aborted;
      // Whatever went wrong here, nothing more is asked of the providers.
      this.stop.abort();
      summary.textContent = stopped ? 'Arrêté' : 'Échec';
      answer.replaceChildren(h('div', 'run-error', stopped ? 'Exécution arrêtée.' : err instanceof Error ? err.message : 'Le serveur du POC ne répond plus.'));
      // The nodes still shown as running will hear nothing more.
      for (const [id, run] of store.runs) if (run.state === 'running' || run.state === 'pending') store.setRun(id, { ...run, state: 'skipped' });
    } finally {
      this.stop = null;
      store.running = false;
      this.send.textContent = 'Envoyer';
      this.send.classList.remove('stop');
      for (const [id, run] of store.runs) row(id, run);
      this.scroll();
      this.input.focus();
    }
  }
}
