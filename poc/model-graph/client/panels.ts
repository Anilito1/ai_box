import { PRESETS, PRESET_IDS, portLabel, signature, type ModelSpec, type PresetId } from '../shared/capabilities';
import { parseGraph, serializeGraph } from '../shared/graph';
import { addProvider, declareModel, removeProvider } from './api';
import { button, h, usd } from './dom';
import type { Store } from './store';

// What opens over the editor: the list of models, the providers, the graph's JSON, and the short messages.

/** A model's ports as coloured chips: what goes in, an arrow, what comes out. */
export function signatureView(spec: Pick<ModelSpec, 'inputs' | 'outputs'>): HTMLElement {
  const chips = (ports: ModelSpec['inputs']) => ports.map((p) => h('span', `chip-type type-${p.type}`, portLabel(p)));
  return h('span', 'signature', ...chips(spec.inputs), h('span', 'arrow', '→'), ...chips(spec.outputs));
}

const price = (spec: ModelSpec): string => (spec.price?.perCall !== undefined ? `${usd(spec.price.perCall)} l’appel` : spec.price?.output !== undefined ? `${usd(spec.price.output)} / M tokens` : '');

let openPopover: HTMLElement | null = null;
const closePopover = () => {
  openPopover?.remove();
  openPopover = null;
};
document.addEventListener('pointerdown', (e) => {
  if (openPopover && !openPopover.contains(e.target as Node)) closePopover();
});
document.addEventListener('keydown', (e) => e.key === 'Escape' && closePopover());

/** The list of models, with a search over names and types ("image", "vidéo"). */
export function pickModel(store: Store, anchor: HTMLElement, current: string | undefined, onPick: (spec: ModelSpec) => void): void {
  closePopover();
  const search = h('input', 'picker-search');
  search.placeholder = 'Chercher un modèle, ou un type : image, vidéo…';
  const list = h('div', 'picker-list');
  const box = h('div', 'picker', search, list);
  const names = new Map([['sim', 'Simulé (sans clé)'], ...store.state.providers.map((p): [string, string] => [p.id, p.name])]);
  const fill = () => {
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    const found = store.state.models.filter((m) => {
      const text = `${m.name} ${m.model} ${signature(m)} ${names.get(m.provider) ?? ''}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
    list.replaceChildren();
    let group = '';
    for (const m of found.slice(0, 150)) {
      if (m.provider !== group) {
        group = m.provider;
        list.append(h('div', 'picker-group', names.get(group) ?? group));
      }
      const row = button(`picker-row${m.ref === current ? ' current' : ''}`, '', () => {
        closePopover();
        onPick(m);
      });
      row.append(h('span', 'picker-name', m.name, m.source === 'guessed' ? h('span', 'guessed', 'deviné') : null), signatureView(m), h('span', 'picker-price', price(m)));
      row.title = m.ref;
      list.append(row);
    }
    if (found.length === 0) list.append(h('div', 'picker-empty', 'Aucun modèle ne correspond.'));
    if (found.length > 150) list.append(h('div', 'picker-empty', `${found.length - 150} autres : précise la recherche.`));
  };
  search.addEventListener('input', fill);
  fill();
  document.body.append(box);
  const rect = anchor.getBoundingClientRect();
  box.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - box.offsetWidth - 8))}px`;
  box.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - box.offsetHeight - 8))}px`;
  openPopover = box;
  search.focus();
}

let toastTimer = 0;

/** A short message at the bottom of the editor, with what can be done about it. */
export function toast(message: string, actions: { label: string; run(): void }[] = []): void {
  const box = document.querySelector('.toast') as HTMLElement;
  const close = () => {
    box.hidden = true;
  };
  box.replaceChildren(
    h('div', 'toast-text', message),
    h(
      'div',
      'toast-actions',
      ...actions.map((a) =>
        button('toast-action', a.label, () => {
          close();
          a.run();
        }),
      ),
      button('toast-close', 'Fermer', close),
    ),
  );
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(close, actions.length ? 20_000 : 9000);
}

function dialog(title: string, ...content: (Node | string)[]): HTMLDialogElement {
  const box = h('dialog', 'dialog');
  box.append(h('div', 'dialog-head', h('h2', '', title), button('dialog-close', '×', () => box.close(), 'Fermer')), ...content);
  box.addEventListener('close', () => box.remove());
  document.body.append(box);
  box.showModal();
  return box;
}

const field = (label: string, input: HTMLElement) => h('label', 'field', h('span', '', label), input);

/** The providers: the ones of this run, what their lists told, and the models declared by hand. */
export function openProviders(store: Store, onChange: () => void): void {
  const body = h('div', 'dialog-body');
  const box = dialog('Fournisseurs', body);
  const failed = (err: unknown) => toast(err instanceof Error ? err.message : 'Le serveur du POC a refusé.');
  const apply = (state: typeof store.state) => {
    store.setState(state);
    onChange();
    fill();
  };

  const fill = () => {
    const cards = store.state.providers.map((p) => {
      const models = store.state.models.filter((m) => m.provider === p.id);
      // What the list let the POC detect: the count of models of each shape.
      const shapes = new Map<string, number>();
      for (const m of models) shapes.set(signature(m), (shapes.get(signature(m)) ?? 0) + 1);
      const guessed = models.filter((m) => m.source === 'guessed').length;
      const model = h('input');
      model.placeholder = 'Identifiant du modèle';
      const preset = h('select', '', ...PRESET_IDS.map((id) => Object.assign(h('option', '', PRESETS[id].label), { value: id })));
      const max = h('input', 'narrow');
      max.type = 'number';
      max.min = '1';
      max.max = '30';
      max.placeholder = 'max';
      max.title = 'Nombre maximal d’images en entrée (facultatif)';
      return h(
        'div',
        'provider',
        h('div', 'provider-head', h('strong', '', p.name), h('span', 'muted', p.baseUrl), h('span', p.hasKey ? 'tag ok' : 'tag', p.hasKey ? 'clé en mémoire' : 'sans clé'), p.fromEnv ? h('span', 'tag', '.env') : null, button('link danger', 'Retirer', () => removeProvider(p.id).then(apply, failed))),
        p.error ? h('div', 'run-error', p.error) : null,
        h('div', 'shapes', ...[...shapes].sort((a, b) => b[1] - a[1]).map(([shape, count]) => h('span', 'shape', `${count} × ${shape}`))),
        guessed ? h('div', 'muted', `${guessed} modèle${guessed > 1 ? 's' : ''} dont la liste ne dit rien : capacités devinées d’après le nom. Corrige-les ci-dessous si besoin.`) : null,
        h(
          'div',
          'declare',
          h('span', 'muted', 'Déclarer à la main :'),
          model,
          preset,
          max,
          button('small', 'Déclarer', () => declareModel(p.id, { model: model.value, preset: preset.value as PresetId, ...(max.value ? { maxImages: Number(max.value) } : {}) }).then(apply, failed)),
        ),
        p.manual.length ? h('div', 'muted', `Déclarés : ${p.manual.map((m) => `${m.model} (${PRESETS[m.preset].label})`).join(', ')}`) : null,
      );
    });

    const name = h('input');
    name.placeholder = 'Venice, DeepSeek…';
    const url = h('input');
    url.placeholder = 'https://api.venice.ai/api/v1';
    const key = h('input');
    key.type = 'password';
    key.placeholder = 'Clé API';
    key.autocomplete = 'off';
    const add = button('primary', 'Ajouter et lire ses modèles', () => {
      add.disabled = true;
      add.textContent = 'Lecture de la liste…';
      addProvider({ name: name.value, baseUrl: url.value, key: key.value }).then(apply, (err) => {
        failed(err);
        add.disabled = false;
        add.textContent = 'Ajouter et lire ses modèles';
      });
    });
    body.replaceChildren(
      h('p', 'muted', 'Le fournisseur « Simulé » est toujours là et ne demande aucune clé. Un fournisseur réel est une adresse compatible OpenAI (…/v1) et sa clé : la clé reste dans la mémoire du serveur local du POC, n’est écrite nulle part et ne revient jamais dans cette page.'),
      ...cards,
      h('div', 'provider add', h('strong', '', 'Ajouter un fournisseur'), h('div', 'add-row', field('Nom', name), field('Adresse', url), field('Clé', key)), add),
      h('p', 'muted', 'Pour les retrouver à chaque lancement : fichier poc/model-graph/.env (non commité), modèle dans env.example.'),
    );
  };
  fill();
  box.addEventListener('close', onChange);
}

/** The graph as it is saved: to read, copy, or paste another one. */
export function openJson(store: Store): void {
  const text = h('textarea', 'json');
  text.value = serializeGraph(store.graph);
  text.spellcheck = false;
  const error = h('div', 'run-error');
  const box = dialog(
    'Le graphe en JSON',
    h('p', 'muted', 'Le format enregistré : des nœuds, des liens « nœud.port → nœud.port », un numéro de version. Les ports ne sont pas enregistrés : ils viennent du modèle de chaque nœud.'),
    text,
    error,
    h(
      'div',
      'dialog-actions',
      button('small', 'Copier', () => void navigator.clipboard.writeText(text.value)),
      button('primary', 'Appliquer', () => {
        try {
          store.setGraph(parseGraph(JSON.parse(text.value)));
          box.close();
        } catch (err) {
          error.textContent = err instanceof SyntaxError ? `JSON illisible : ${err.message}` : err instanceof Error ? err.message : 'Graphe refusé.';
        }
      }),
    ),
  );
}
