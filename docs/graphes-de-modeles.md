# Graphes de modèles

Un graphe enchaîne des modèles appelés par API (un LLM, un modèle d'image, un modèle vidéo…) et répond à un message
comme un seul chatbot. L'utilisateur les crée dans la vue **Graphes** (bouton du header), les essaie dans son chat
d'essai (modèles simulés ou réels, avec un plafond de coût), et une session peut en faire tourner un avec l'outil
`run_graph`.

## Capacités des modèles

`src/shared/modelCaps.ts`. Chaque modèle d'un fournisseur a une **forme** (`PresetId` : `llm`, `llm-vision`,
`text-to-image`, `reference-to-image`, `image-to-video`…) qui fixe ses ports typés (texte, image, vidéo, audio) et
l'appel qui l'exécute (`ModelApi`). Ports et API sont séparés : deux LLM de même API peuvent lire des choses différentes.

- `checkOpenAI` (`src/main/accounts.ts`) lit la liste du fournisseur (`?type=all` chez Venice) et passe chaque entrée
  par `detectModels` : le `type` et les capacités de Venice ou Together, les modalités d'OpenRouter, sinon une
  supposition d'après le nom, marquée `guessed`. Seuls les modèles de forme « chat » sont proposés pour une session.
- Ce que l'utilisateur déclare à la main gagne toujours : `Account.modelCaps` (fournisseurs ajoutés seulement), édité
  dans Réglages › Comptes › un fournisseur › « Ce que fait chaque modèle ». C'est la seule chose stockée ; ce que dit
  la liste est relu à chaque vérification du compte (`GraphService.noteListed`). Un modèle déclaré autre chose qu'un
  LLM quitte les modèles de session du compte (`normalizeAccount`).

## Le graphe

`src/shared/graph/`, sans Node ni DOM ni texte (les problèmes sont des codes et des valeurs ; le renderer et le main
les disent chacun dans leur langue).

- `format.ts` : JSON versionné (`version: 1`), nœuds en union discriminée par `kind`, liens `nœud.port → nœud.port`.
  Les ports ne sont pas enregistrés : ils viennent du modèle du nœud. Chaque sorte de nœud est une entrée de
  `NODE_KINDS` (ses ports, combien un graphe en a, ses champs enregistrés).
- `validate.ts` : liens permis (même type, nombre de valeurs par entrée, pas de boucle), ponts proposés (conversion
  locale, sinon modèle du catalogue), ordre topologique, problèmes d'un graphe, modèles équivalents.
- `engine.ts` : exécution en DAG à un passage ; branches indépendantes en parallèle ; un appel en file (vidéo) est
  attendu par le moteur ; plafond par exécution qui compte les appels en cours ; refus des prix inconnus en option.

## Dans le main

`src/main/graph/` : `GraphService` (un fichier par graphe dans `<données>/graphs/<id>.json`, réglages du coût dans
`<données>/graphs/prefs.json`, fichiers des essais dans `<données>/graph-runs/`, les 40 derniers gardés), runners
simulés (image, vraie vidéo MP4 et son faits sur place) et réels (chat, images et voix en forme OpenAI, endpoints
d'images de Venice, vidéo par l'adaptateur `video/venice.ts`), conversion vidéo → images (ffmpeg pour une vraie vidéo),
outils `list_graphs` et `run_graph`. Les clés restent dans le main ; la vue ne reçoit que des noms de fichiers.

Comptes appelables : les fournisseurs ajoutés, la clé OpenAI, la clé DeepSeek (par son adresse OpenAI).

`run_graph` : le plafond de l'utilisateur est un maximum que `max_usd` peut seulement abaisser ; ce que la réponse
du graphe contient de médias est enregistré dans `Vidéos/AI-Box/graphs/`.

## Ajouter une sorte de nœud

Par exemple une case « worker » (un agent avec son poste, son modèle, son dossier, sa consigne et sa conversation) :

1. `format.ts` : un membre de plus dans l'union `GraphNode` (`kind: 'worker'` et ses champs) et une entrée dans
   `NODE_KINDS` (ses ports, sa lecture du JSON). Une relation autre que « donnée » (« peut parler à », « passe le
   relais à ») serait un champ facultatif `kind` sur `GraphEdge`, ignoré par le moteur actuel.
2. `validate.ts` : ses règles propres, s'il en a, à côté des règles générales.
3. `src/renderer/graphs/editor.ts` : une entrée dans `LOOKS` (le corps de sa carte).
4. Son exécution : le moteur ne fait tourner que la partie « modèles » (DAG à un passage) ; un worker aurait la
   sienne, côté `SessionManager` (une session et sa conversation), le graphe ne disant que qui parle à qui.

## Pas encore

Graphe sélectionnable comme modèle dans une conversation, élément de conversation « exécution de graphe », reprise
d'une exécution coupée, texte en flux, vidéo → vidéo et vidéo à images de référence chez Venice.
