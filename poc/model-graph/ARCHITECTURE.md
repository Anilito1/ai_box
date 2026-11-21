# Graphe de modèles — note d'architecture

Ce que le POC établit, et comment le porter dans AI Box. Les chemins `shared/…`, `server/…`, `client/…` sont ceux de
ce dossier ; les chemins `src/…` sont ceux de l'app.

## 1. Le constat de départ

Aujourd'hui un modèle d'un fournisseur API a un `ModelKind` (`text`, `image`, `video` — `src/shared/video.ts`) qui dit
à la fois ce qu'il fabrique et comment l'appeler. `checkOpenAI` ne garde de la liste que les modèles `text`
(`src/main/accounts.ts`), et la vidéo a son propre type (`VideoModel`) avec un seul champ d'entrée (`input`). Un
modèle « image(s) de référence → image » n'a donc aucune place : ni session, ni vidéo.

Le POC sépare deux notions :

- **les ports** : entrées et sorties typées, ce que l'éditeur doit savoir pour relier ;
- **l'API** : quel adaptateur exécute (`chat`, `image`, `image-edit`, `video`, `speech`, `transcription`).

Deux modèles de même API peuvent avoir des ports différents (LLM texte, LLM vision, LLM qui lit la vidéo).

## 2. Modèle de capacités

```ts
type MediaType = 'text' | 'image' | 'video' | 'audio';
interface Port { id: string; type: MediaType; required?: boolean; max?: number }   // max : images de référence
interface ModelSpec {
  ref: string;            // "fournisseur/modèle" : ce qu'un nœud nomme
  api: ModelApi;          // l'adaptateur
  inputs: Port[]; outputs: Port[];
  source: 'listed' | 'guessed' | 'manual';
  queued: boolean;        // file + polling
  price?: { perCall?: number; input?: number; output?: number };
  durations?: string[]; aspectRatios?: string[]; resolutions?: string[];
}
```

Les identifiants de ports sont les mêmes pour tous les modèles d'une API (`prompt`, `images`, `image`, `video`,
`text`) : changer de modèle garde les liens, et passer de « simulé » à « réel » est un simple remplacement.

### Détection (`shared/detect.ts`), de la source la plus sûre à la moins sûre

| Source | Ce qui est lu | Résultat |
| --- | --- | --- |
| Liste typée (Venice `GET /models?type=all`, Together) | `type` ; pour un LLM `capabilities.supportsVision`, `supportsVideoInput`, `supportsMultipleImages`, `maxImages` ; pour `inpaint` `constraints.combineImages`, `maxInputImages` ; pour `video` `constraints.model_type`, `durations`, `resolutions` ; `pricing` | `listed` |
| Modalités (OpenRouter) | `architecture.input_modalities`, `output_modalities`, `pricing` | `listed` |
| Liste nue (OpenAI, DeepSeek, serveur local : un `id` seul) | des mots du nom (`dall-e`, `i2v`, `whisper`, `vision`…) | `guessed`, signalé dans l'éditeur |
| Déclaration à la main | une forme parmi dix (« Image(s) de référence → image »…) et un nombre d'images | `manual`, gagne toujours |

Vérifié sur la liste publique de Venice (21 novembre 2026) : 432 entrées, 401 reconnues (148 LLM dont 107 qui lisent
les images et 31 aussi la vidéo, 51 texte → image, 36 éditeurs à images de référence — le type `inpaint` de Venice, c'est
là que tombe un modèle « Reference to Image » —, 150 vidéo, 11 voix, 5 transcription) ; 31 laissées de côté
(musique, embeddings, upscale, décision).

### Stockage proposé dans AI Box

- `Account` (`src/shared/types.ts`) gagne `modelCaps?: Record<string, { preset: PresetId; maxImages?: number }>` : **seules
  les déclarations à la main** sont écrites dans `config.json`. Petit, stable, relu par `normalizeAccount`.
- Ce que disent les listes n'est **pas** persisté : relu et gardé en mémoire comme `VideoService` le fait déjà (liste
  redemandée après dix minutes). Un modèle dont les capacités changent chez le fournisseur se voit donc à l'ouverture
  du graphe, comme un lien en erreur, et non comme une donnée périmée.
- `checkOpenAI` rend la liste complète passée par `detectModels` ; « les modèles qui lancent une session » devient
  « les `ModelSpec` d'API `chat` ». `VideoModel` devient un `ModelSpec` d'API `video` (mêmes champs `durations`,
  `aspectRatios`, `resolutions`), et `ModelKind` disparaît.

## 3. Le graphe

Format (`shared/graph.ts`), versionné, lisible et corrigeable à la main :

```json
{ "version": 1, "name": "Texte → image → vidéo → analyse",
  "nodes": [ { "id": "image", "kind": "model", "model": "venice/flux-3", "title": "Crée l’image", "x": 504, "y": 70 } ],
  "edges": [ { "from": "writer.text", "to": "image.prompt" } ] }
```

- Quatre sortes de nœuds : `chat-input` (sorties `text`, `images`), `chat-output` (entrées texte, image, vidéo,
  audio), `model`, `convert` (conversion locale sans modèle ; une seule aujourd'hui : `frames`, vidéo → images).
- Les ports ne sont pas enregistrés : ils viennent du modèle au moment où le graphe est lu.
- Règles (`shared/validate.ts`, les mêmes pour l'éditeur et le moteur) : même type aux deux bouts ; une entrée prend
  `max` liens (1 par défaut) ; pas de boucle ; entrées obligatoires reliées ; un seul nœud d'entrée et un de réponse.
  Un refus dit pourquoi et propose un pont : une conversion locale d'abord, sinon des modèles du catalogue qui lisent
  le premier type et donnent le second.
- **Où il vit dans l'app** : un fichier par graphe, `<données>/graphs/<id>.json`, plutôt que dans `config.json` (les
  consignes des nœuds sont du texte long, et un fichier s'exporte et se partage). `version` permet la migration à la
  lecture.

## 4. Exécution

`shared/engine.ts` ne connaît aucun fournisseur. On lui donne des *runners* :

```ts
interface DirectRunner { estimate?(call): Promise<number | null>; run(call, ctx): Promise<NodeResult> }
interface QueuedRunner { estimate?; submit(call, ctx): Promise<Job>; poll(job, call, ctx): Promise<Polled>; release?(job, ctx) }
```

- Ordre topologique (Kahn) ; chaque nœud démarre dès que tout ce qu'il lit est fini, donc deux branches indépendantes
  tournent en même temps. Un nœud qui ne mène pas à la réponse n'est pas exécuté (il ne coûte rien).
- **Appels longs** : pour un runner à file, c'est le moteur qui tient l'attente (intervalle, délai maximal,
  annulation, progression). Le runner vidéo réel est l'adaptateur existant `src/main/video/venice.ts`, appelé tel
  quel (`quote`, `submit`, `poll`, `release`) : aucun code Venice n'est dupliqué.
- **Événements** : `run` (début, fin) et `node` (en attente, en cours + progression, fait + sorties + coût + durée,
  erreur, non exécuté). L'éditeur et le chat ne font que les afficher.
- Dans l'app : le moteur va dans `src/shared/`, un `GraphService` dans `src/main/graph/` fournit les runners (la clé
  d'un compte lue par `secrets.get('account:<id>')`, jamais envoyée au renderer), et les événements passent par un
  canal IPC. Le serveur HTTP du POC n'est que le substitut de cet IPC.
- Les fichiers produits sont en mémoire dans le POC ; dans l'app ils s'écrivent sur disque, comme les vidéos
  aujourd'hui (`<Vidéos>/AI-Box`), et la conversation ne porte que des chemins.

## 5. Un graphe comme « modèle » du composer

Trois voies, de la plus à la moins recommandée :

1. **Un fournisseur virtuel « Graphes ».** Chaque graphe valide apparaît dans le sélecteur de modèle (`.cbtn-model`,
   `src/renderer/chat.ts`) sous un groupe « Graphes ». Une session sur un graphe ne passe pas par le SDK Claude Code :
   le message va à `GraphService.run`, et les événements deviennent des éléments de conversation (un nouveau type
   d'élément « exécution de graphe » : étapes repliables, médias, coût — exactement ce que montre le chat du POC).
   C'est la seule voie qui donne vraiment « un seul chatbot ». Coût : un type de session sans outils ni fichiers, à
   faire accepter aux endroits qui supposent une session Claude Code.
2. **Un outil du hub**, `run_graph(graph, message, max_usd)`, à côté de `generate_video` : n'importe quel modèle de
   session peut lancer un graphe. Peu de code (le serveur MCP existe), utile en complément, mais l'utilisateur parle
   alors à un agent qui appelle le graphe, pas au graphe.
3. **Derrière le pont** (`src/main/bridge.ts`), le graphe répondant comme un modèle Anthropic. Aucun changement du
   renderer, mais le SDK enverrait son prompt système et ses outils à un graphe qui n'en fait rien, et les médias
   n'ont pas de place dans la réponse. À écarter.

Recommandation : la voie 2 d'abord (petite, sans risque, valide le moteur dans l'app), puis la voie 1.

## 6. Coûts et plafond

- Avant chaque nœud, `estimate` donne son prix quand il est connaissable : prix à l'appel de la liste (image,
  édition), `POST /video/quote` (vidéo), et pour un LLM ce qui part (texte et images, estimé) au prix de la liste ; son
  coût réel est compté après coup (`usage` × prix au million).
- Le plafond est **par exécution** : le moteur refuse de lancer un nœud dont l'estimation ferait dépasser le plafond,
  en comptant ce qui est déjà engagé par les nœuds en cours (deux branches parallèles ne passent pas chacune « juste
  en dessous »). Une fois le plafond dépassé, plus rien ne démarre.
- Limite assumée : un prix inconnu compte pour zéro. Dans l'app, prévoir un réglage « refuser un nœud dont le prix est
  inconnu » et un plafond par défaut dans les réglages, comme `max_usd` de `generate_video`.

## 7. Erreurs, annulation, reprise

- Un graphe invalide est refusé **avant** tout appel, avec la liste des problèmes.
- Un nœud en échec arrête l'exécution : les appels en cours sont annulés (signal d'abandon), les nœuds en aval sont
  marqués « non exécuté », et le message du fournisseur est rendu tel quel, clé masquée (`veniceError`).
- Annulation par l'utilisateur : même chemin, état `cancelled`.
- **Reprise — non faite dans le POC, mais préparée** : l'événement d'un nœud en file porte son `job`. Dans l'app, on
  l'écrit avec l'exécution (`<données>/graph-runs/<id>.json` : entrées, sorties déjà obtenues, jobs en file). Au
  redémarrage, un job en file est redemandé au fournisseur (comme `job_id` dans `generate_video`), et « relancer »
  repart du nœud en échec en réutilisant les sorties des nœuds déjà faits, sans les repayer.

## 8. Ce que le POC ne couvre pas

- Texte en flux (les LLM répondent d'un bloc), outils et agents dans un nœud LLM, mémoire au-delà de l'historique du
  chat donné aux nœuds reliés au message.
- Boucles, conditions, sous-graphes, nœuds « modèle de texte » (gabarit) ou « choix ».
- Paramètres fins par modèle (taille et graine d'une image, prompt négatif, `safe_mode` de Venice) : seule la durée
  d'une vidéo est réglable sur le nœud ; le reste passe par `options` dans le JSON.
- Vidéo à images de référence de Venice (`reference_image_urls`) et vidéo → vidéo : l'adaptateur existant ne sait
  envoyer qu'un prompt et une image de départ ; un modèle vidéo → vidéo réel est donc refusé avant tout appel.
  Musique, upscale, embeddings : ignorés.
- Persistance : le graphe est dans le `localStorage` de la page, les fichiers produits en mémoire du serveur.
- Le mode réel n'a été vérifié que contre un faux fournisseur (formes des requêtes tirées de la spécification OpenAPI
  de Venice) et, pour la détection, sur la vraie liste publique. Aucun appel payant.
- Confort d'édition : pas d'annulation (Ctrl+Z), pas de sélection multiple, pas d'édition au clavier, pas d'i18n.

## 9. Risques

- **Coût** : une vidéo coûte bien plus cher qu’un appel de LLM, et un graphe en lance sans que l'utilisateur relise le prompt.
  Le plafond par exécution doit être actif par défaut.
- **Capacités fausses** : une heuristique de nom peut se tromper ; l'erreur n'apparaît qu'à l'exécution, chez le
  fournisseur. D'où le marquage « deviné » et la déclaration à la main.
- **API d'images hétérogènes** hors Venice (`/images/generations` et `/images/edits` varient d'un fournisseur à
  l'autre) : prévoir un adaptateur par API, comme pour la vidéo.
- **Taille des médias** : image et vidéo voyagent en `data:` URL dans les requêtes ; une vidéo de 50 Mo dépasse les
  limites de la plupart des API de chat. Il faudra des adresses de dépôt, ou réduire avant d'envoyer.
- **Contenu et consentement** : refus de modération, `409 needs_consent` de Venice pour certains modèles vidéo : à
  traduire en messages clairs, pas en échec opaque.
- **Durée** : une exécution peut durer vingt minutes ; fermer l'app au milieu doit laisser une exécution reprenable.
- **Périmètre** : la tentation d'un « n8n dans l'app ». Tenir la ligne du POC : des modèles, des liens typés, une
  entrée, une réponse.

## 10. Ordre d'intégration proposé

1. Capacités : `ModelSpec` et `detectModels` dans `src/shared/`, `modelCaps` sur `Account`, les réglages d'un
   fournisseur montrent la forme de chaque modèle et permettent de la déclarer. Utile seul : c'est la correction du
   problème « tous les modèles sont des LLM ».
2. Moteur et runners dans `src/main/graph/`, outil `run_graph`.
3. Éditeur dans une vue de l'app (le code de `client/editor.ts` est sans dépendance), stockage des graphes.
4. Graphes dans le sélecteur de modèle, élément de conversation « exécution de graphe », reprise.
