import { CONVERTERS, CONVERTER_IDS, nodeTitle, type Graph } from '../shared/graph';
import { equivalents } from '../shared/validate';
import { getState } from './api';
import { Chat } from './chat';
import { button, h } from './dom';
import { Editor } from './editor';
import { openJson, openProviders, pickModel, toast } from './panels';
import { Store } from './store';

// The POC's page: the editor on the left, the conversation on the right, a bar of actions above.

const SIM = 'sim';
type Mode = 'sim' | 'real' | 'mixed';

const store = new Store();

/** Where the graph's models are: all simulated, all real, or both. */
function modeOf(graph: Graph): Mode {
  const providers = graph.nodes.flatMap((n) => (n.kind === 'model' && n.model ? [store.catalog.get(n.model)?.provider ?? n.model.split('/')[0]] : []));
  if (providers.every((p) => p === SIM)) return 'sim';
  return providers.some((p) => p === SIM) ? 'mixed' : 'real';
}

/** Puts every node on a model of the other kind that has the same ports: the cheapest that fits. */
function switchMode(to: 'sim' | 'real', providers: () => void): void {
  if (to === 'real' && store.state.providers.length === 0) {
    toast('Aucun fournisseur réel pour l’instant : ajoute-en un (adresse et clé), puis repasse en « Réel ».', [{ label: 'Ouvrir les fournisseurs', run: providers }]);
    return;
  }
  const { graph, catalog } = store;
  const moved: string[] = [];
  const left: string[] = [];
  for (const node of graph.nodes) {
    const spec = node.kind === 'model' && node.model ? catalog.get(node.model) : undefined;
    if (!spec || (spec.provider === SIM) === (to === 'sim')) continue;
    const other = equivalents(graph, node, catalog, (m) => (m.provider === SIM) === (to === 'sim'))[0];
    if (other) {
      node.model = other.ref;
      moved.push(`« ${nodeTitle(node, catalog)} » → ${other.name}`);
    } else left.push(`« ${nodeTitle(node, catalog)} »`);
  }
  store.changed();
  if (to === 'real') toast(`${moved.length ? `Modèles réels choisis (les moins chers qui ont les mêmes entrées et sorties) : ${moved.join(' ; ')}.` : 'Aucun nœud changé.'}${left.length ? ` Pas d’équivalent réel pour ${left.join(', ')} : choisis son modèle à la main.` : ''} Vérifie le plafond avant d’envoyer.`);
  else if (left.length) toast(`Pas d’équivalent simulé pour ${left.join(', ')}.`);
}

async function start(): Promise<void> {
  store.setState(await getState());
  store.restore();

  const name = h('input', 'graph-name');
  name.title = 'Nom du graphe';
  name.addEventListener('input', () => {
    store.graph.name = name.value.slice(0, 80) || 'Sans nom';
    store.changed(false);
  });

  const examples = h('select', 'bar-select', Object.assign(h('option', '', 'Exemples…'), { value: '' }), ...store.state.examples.map((g, i) => Object.assign(h('option', '', g.name), { value: String(i) })));
  examples.title = 'Charger un graphe d’exemple (remplace le graphe en cours)';
  examples.addEventListener('change', () => {
    const picked = store.state.examples[Number(examples.value)];
    if (examples.value !== '' && picked) store.setGraph(structuredClone(picked));
    examples.value = '';
  });

  const mode = { sim: button('seg', 'Simulé', () => switchMode('sim', providers), 'Tous les nœuds sur les modèles simulés : aucune clé, aucun coût'), real: button('seg', 'Réel', () => switchMode('real', providers), 'Tous les nœuds sur des modèles réels équivalents') };
  const canvas = h('div', 'canvas');
  const toastBox = h('div', 'toast');
  toastBox.hidden = true;
  canvas.append(toastBox);
  const chatBox = h('div', 'chat');

  const editor = new Editor(canvas, store, { toast, pickModel: (anchor, current, onPick) => pickModel(store, anchor, current, (spec) => onPick(spec.ref)) });
  const providers = () => openProviders(store, () => store.changed());
  const addModel = button('bar-button', '＋ Modèle', () => pickModel(store, addModel, undefined, (spec) => editor.addModel(spec)), 'Ajouter un nœud de modèle');
  const addConvert = button('bar-button', `＋ ${CONVERTERS[CONVERTER_IDS[0]].label}`, () => editor.addConverter(CONVERTER_IDS[0]), 'Ajouter une conversion faite sans modèle');

  document.body.append(
    h(
      'header',
      'bar',
      h('div', 'brand', 'Graphe de modèles', h('span', 'brand-tag', 'POC')),
      name,
      examples,
      h('span', 'bar-gap'),
      addModel,
      addConvert,
      button('bar-button', 'JSON', () => openJson(store), 'Voir ou coller le graphe en JSON'),
      button('bar-button', 'Fournisseurs', providers, 'Fournisseurs réels et capacités de leurs modèles'),
      h('div', 'segmented', mode.sim, mode.real),
    ),
    h('main', 'main', canvas, chatBox),
  );

  const sync = () => {
    if (document.activeElement !== name) name.value = store.graph.name;
    const now = modeOf(store.graph);
    mode.sim.classList.toggle('on', now === 'sim');
    mode.real.classList.toggle('on', now === 'real');
    mode.sim.parentElement?.classList.toggle('mixed', now === 'mixed');
  };
  store.onGraph.push(sync);
  new Chat(chatBox, store, toast);
  sync();
  editor.render();
}

start().catch((err: unknown) => {
  document.body.append(h('div', 'fatal', `Le POC n’a pas pu démarrer : ${err instanceof Error ? err.message : String(err)}`));
});
