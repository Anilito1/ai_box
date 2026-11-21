import { parseGraph, serializeGraph, type Graph } from '../../shared/graph/format';
import type { ModelSpec } from '../../shared/modelCaps';
import { t } from '../i18n';
import { formatText } from './describe';
import { button, el, usd } from './dom';
import { signatureText, signatureView } from './shape';
import type { GraphStore } from './store';

// What opens over the editor: the list of models, the graph's JSON, and the short messages.

const price = (spec: ModelSpec): string => (spec.price?.perCall !== undefined ? t('graphs.price.call', { price: usd(spec.price.perCall) }) : spec.price?.output !== undefined ? t('graphs.price.tokens', { price: usd(spec.price.output) }) : '');

let openPicker: HTMLElement | null = null;
const closePicker = () => {
  openPicker?.remove();
  openPicker = null;
};
document.addEventListener('pointerdown', (e) => {
  if (openPicker && !openPicker.contains(e.target as Node)) closePicker();
});
document.addEventListener('keydown', (e) => e.key === 'Escape' && closePicker());

/** The list of models, grouped by provider, with a search over names and shapes ("image", "video"). */
export function pickModel(store: GraphStore, anchor: HTMLElement, current: string, onPick: (spec: ModelSpec) => void): void {
  closePicker();
  const search = el('input', 'gr-picker-search');
  search.placeholder = t('graphs.picker.search');
  search.setAttribute('aria-label', t('graphs.picker.search'));
  const list = el('div', 'gr-picker-list');
  const box = el('div', 'gr-picker', search, list);
  box.setAttribute('role', 'dialog');
  const words = new Map(store.view.models.map((m) => [m.ref, `${m.name} ${m.model} ${signatureText(m)} ${store.providerName(m.provider)}`.toLowerCase()]));
  const fill = () => {
    const wanted = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    const found = store.view.models.filter((m) => wanted.every((w) => (words.get(m.ref) ?? '').includes(w)));
    list.replaceChildren();
    let group = '';
    for (const m of found.slice(0, 150)) {
      if (m.provider !== group) {
        group = m.provider;
        list.append(el('div', 'gr-picker-group', store.providerName(group)));
      }
      const row = button(`gr-picker-row${m.ref === current ? ' current' : ''}`, '', () => {
        closePicker();
        onPick(m);
      });
      row.append(el('span', 'gr-picker-name', m.name || m.model, m.source === 'guessed' ? el('span', 'gr-guessed', t('graphs.node.guessedShort')) : null), el('span', 'gr-picker-price', price(m)), signatureView(m));
      row.title = m.model;
      list.append(row);
    }
    if (found.length === 0) list.append(el('div', 'gr-picker-empty', t('graphs.picker.none')));
    if (found.length > 150) list.append(el('div', 'gr-picker-empty', t('graphs.picker.more', { count: found.length - 150 })));
  };
  search.addEventListener('input', fill);
  fill();
  document.body.append(box);
  const rect = anchor.getBoundingClientRect();
  box.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - box.offsetWidth - 8))}px`;
  box.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - box.offsetHeight - 8))}px`;
  openPicker = box;
  search.focus();
}

/** A short message at the bottom of the editor, with what can be done about it. */
export function toaster(box: HTMLElement) {
  let timer = 0;
  box.hidden = true;
  box.setAttribute('role', 'status');
  return (message: string, actions: { label: string; run(): void }[] = []): void => {
    const close = () => {
      box.hidden = true;
    };
    box.replaceChildren(
      el('div', 'gr-toast-text', message),
      el(
        'div',
        'gr-toast-actions',
        ...actions.map((a) =>
          button('gr-toast-action', a.label, () => {
            close();
            a.run();
          }),
        ),
        button('gr-toast-close', t('graphs.close'), close),
      ),
    );
    box.hidden = false;
    clearTimeout(timer);
    timer = window.setTimeout(close, actions.length ? 20_000 : 9000);
  };
}

/** The graph as it is saved: to read, copy, or paste another one over it. */
export function openJson(graph: Graph, apply: (graph: Graph) => void): void {
  const text = el('textarea', 'gr-json');
  text.value = serializeGraph(graph);
  text.spellcheck = false;
  text.setAttribute('aria-label', t('graphs.json.title'));
  const error = el('div', 'gr-run-error');
  const box = el('dialog', 'gr-dialog');
  box.append(
    el('div', 'gr-dialog-head', el('h2', '', t('graphs.json.title')), button('gr-dialog-close', '×', () => box.close(), t('graphs.close'))),
    el('p', 'gr-muted', t('graphs.json.hint')),
    text,
    error,
    el(
      'div',
      'gr-dialog-actions',
      button('btn ghost small', t('graphs.json.copy'), () => void navigator.clipboard.writeText(text.value)),
      button('btn primary small', t('graphs.json.apply'), () => {
        try {
          apply(parseGraph(JSON.parse(text.value)));
          box.close();
        } catch (err) {
          error.textContent = formatText(err);
        }
      }),
    ),
  );
  box.addEventListener('close', () => box.remove());
  document.body.append(box);
  box.showModal();
}
