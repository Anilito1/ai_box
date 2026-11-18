# Recherche locale : gain réel en tokens, pilote, protocole A/B, plan d'optimisation

Chiffres agrégés seulement : aucun extrait de transcription, de code client ou de mémoire.

## 1. Plafond mesuré sur l'usage réel

**Données.** Transcriptions Claude Code locales du 03/11 au 17/11/2026 (`~/.claude/projects`), toutes produites par
l'AI Box : 267 sessions, 112 sous-agents, 17 775 requêtes API dédupliquées, environ 1 770 $ (prix tiré du journal de
coût du hub ; environ 1 836 $ au tarif API selon l'étude du cache). Les totaux de tokens recoupent ceux de
`hub-ai-box-cache` à moins de 1 % : cacheRead 3 887 M, écritures 77,6 M, output 16,2 M. Le contexte moyen relu par
requête est de 223 k tokens. Le coût se répartit ainsi : relectures du cache 63 %, écritures 24 %, sortie 13 %.

**Méthode** (`usage.mjs`, lecteur commun `transcripts.mjs`). Chaque requête API est partagée en deux parts :
- **contenu** : les résultats d'outils que son contexte porte encore, au prorata de leurs tokens et au prix réel de
  la requête (son mélange lecture/écriture de cache) ;
- **aller-retour** : le reste, c'est-à-dire relire le préfixe et produire la sortie. Il est imputé aux classes
  d'appels que la requête lance. Une requête qui ne lance que de l'exploration est un aller-retour d'exploration :
  sans cette étape, elle n'aurait pas eu lieu.

Ce qui compte comme exploration : Grep, Glob, `ls`/`find`/`grep`, Read et `cat`/`head`/`sed`, les fichiers mémoire
(MEMORY, CLAUDE.md, règles) et la lecture de `topic_memory`. Sont comptés à part : les images, l'historique git et le
web. La taille d'un résultat est convertie en tokens avec un ratio mesuré sur 488 requêtes : 2,25 caractères par token
(p25 2,11, p75 2,40).

**Résultats**

| | Coût | Exploration | dont contenu | dont allers-retours |
|---|---|---|---|---|
| Tout | 1 766 $ | 19,9 % | 9,1 % | 10,8 % |
| Maître | 461 $ | 9,8 % | 3,1 % | 6,7 % |
| Postes | 311 $ | 28,3 % | 11,2 % | 17,1 % |
| Instances de poste | 193 $ | 34,5 % | 15,3 % | 19,2 % |
| Workers ponctuels | 791 $ | 19,1 % | 10,4 % | 8,7 % |
| Sous-agents (inclus ci-dessus) | 101 $ | 31,1 % | 10,5 % | 20,6 % |

- **Par nature** : Read 12,4 %, Grep/Glob/`ls` 6,8 %, mémoire 0,6 %. Hors exploration : images 5,4 %, git 1,3 %.
- **Par repo** (exploration en part du coût du repo) : claude-hub 14,6 % (298 $), marketing-factory 20,9 % (74 $),
  liz-site 20,8 % (135 $), NFC 25,3 % (44 $), finca3D 7,8 % (288 $). Les sessions hors repo pèsent 677 $, surtout le
  maître, lancé sur le Bureau.
- **Relectures** d'une plage déjà lue, sans édition du fichier entre-temps : 0,8 %. Celles qui suivent une édition :
  0,1 %. Lectures de fichiers que la session modifie ensuite : 3,2 %. Lectures de pure consultation : 7,8 %.
- **Ce qui coûte, c'est l'aller-retour** :
  - 18,7 % des requêtes ne font qu'explorer ;
  - 91 % d'entre elles ne lancent qu'un seul appel ;
  - chacune relit 181 k tokens de contexte en moyenne.
- Une réponse de Grep ou Glob fait 674 tokens en moyenne. C'est moins qu'une réponse de `search_code` (800 par défaut) :
  la recherche ne gagne pas sur la taille des sorties, elle gagne sur le nombre d'allers-retours.
- **Épisodes** (suites de requêtes qui ne font qu'explorer) : on en compte 1 886. 66 % tiennent en une seule requête et
  16 % en font trois ou plus. Ces épisodes longs portent 3,2 % du coût en allers-retours : 5,8 % chez les postes, 7,6 %
  chez les instances et 12,6 % chez les sous-agents.

**Plafond** (recherche et lecture bornée réunies, adoption parfaite)

| Poste | Gain | Hypothèse |
|---|---|---|
| Allers-retours de localisation | 1,2 % | une série de L recherches successives devient une seule |
| Contenu des localisations | 0,5 % | chaque série est remplacée par une réponse de 800 tokens |
| Lectures complètes de gros fichiers | 1,0 % | un Read sur plus de 200 lignes ramené à 70 lignes (médiane des Read bornés) |
| Relectures sans édition | 0,8 % | supprimées |
| Mémoire | 0,2 % | une réponse de 400 tokens remplace la lecture |
| **Plafond strict** | **3,6 %** | |
| + 25 % des lectures de consultation | **5,5 %** | les extraits de la recherche répondent sans ouvrir le fichier |

- **Par type de session** : maître 2,4 à 3,5 %, postes 4,7 à 7,5 %, instances 8 à 9,9 %, ponctuels 2,3 à 4,4 %,
  sous-agents 7,7 à 11,9 %.
- **Part propre aux outils de recherche** (localisation, mémoire, consultation) : environ 2 à 4 %. La règle de lecture
  bornée apporte le reste, environ 1,8 %, sans recherche.
- **Gain réaliste** = plafond × adoption × taux de bonne réponse. Avec une adoption de 50 à 70 % et un hit@5 de 70 à
  80 %, on obtient environ **1 à 2,5 %** du coût total. L'estimation antérieure de 4 à 10 % était optimiste : les
  sessions appliquent déjà une lecture économe (consigne globale), et les sorties de Grep sont petites.

## 2. Adoption

Constat (`claude.exe` 2.1.321, Sonnet) : Claude Code diffère les outils MCP derrière sa recherche d'outils. Une session
ne voit que le nom `mcp__hub__search_code`, sans sa description, et aucun prompt du hub ne le mentionne. Taille ajoutée
au préfixe, avec une base de 17 787 tokens :

| Variante | Ce que le modèle voit | Préfixe |
|---|---|---|
| différé (état actuel) | le nom seul | +0 |
| `alwaysLoad` sur search_code | description et schéma | +454 |
| instructions du serveur | un bloc d'usage, l'outil reste différé | +152 |
| les deux | | +661 |

`alwaysLoad` coûte environ 0,2 % du coût total : lecture du préfixe en cache à chaque requête, plus une écriture par
session. Les instructions seules coûtent environ 0,05 %, mais chaque session qui veut l'outil paie d'abord un
aller-retour ToolSearch, environ 18 k tokens-équivalents. `alwaysLoad` devient rentable dès qu'environ un quart des
sessions s'en sert. Les descriptions disent maintenant quand utiliser l'outil, ce qu'il rend et ce qu'il coûte
(`scripts/search-mcp.mjs`) ; `hub-ai-box` reprendra le même texte dans i18n.

Un indice de recherche (`_meta anthropic/searchHint`) ajoute 64 tokens, mais le modèle ne voit que le nom nu dans la
liste différée : pour l'adoption, il équivaut à « différé ».

**Micro-test d'adoption.** Sonnet, outils sans aucune consigne de prompt (bras `tool-bare`), 6 missions sur 3 repos,
coupées à 4 tours, index par mots seuls (le GPU était pris). Coût 1,51 $, soit 1 cent au-dessus du plafond de 1,5 $ :
le garde-fou ne contrôle le budget qu'avant chaque variante.

| Variante | search_code appelé | en premier | Première action sinon |
|---|---|---|---|
| différé | 0 / 6 | 0 / 6 | Grep 4, Read 2 ; aucun ToolSearch |
| `alwaysLoad` | 3 / 6 | 2 / 6 | les missions qui citent un nom propre (Meta, Stripe) partent sur Grep |
| instructions | non mesuré (plafond atteint) | | |

Décision avec `hub-ai-box` : `alwaysLoad` sur search_code seul ; where_is et search_memory restent différés. Même à
adoption égale, les instructions ne feraient gagner qu'environ 0,15 % du coût, que les allers-retours ToolSearch
reprendraient.

## 3. Mini-pilote

_À compléter._

## 4. Protocole et coût de l'A/B complet

_À compléter._

## 5. Plan d'optimisation classé

Impact en part du coût total des sessions du hub, environ 125 $ par jour sur la période. Il est mesuré (M) ou estimé
à partir des mesures (E). Seules les pistes 1 à 3 et 5 dépendent de la recherche. Les pistes 2 à 4 sont des consignes
de prompt : elles sont conçues ici, sans toucher à `prompts.ts`.

| # | Piste | Impact | Effort | Risque |
|---|---|---|---|---|
| 1 | **Montrer search_code à l'agent** (`alwaysLoad` et description utile, forme convenue avec hub-ai-box) | condition de tout gain : sans elle, l'adoption est quasi nulle (M) ; coût +0,2 % (M) | XS | le préfixe change une fois, ce qui réécrit le cache une fois par session |
| 2 | **Consigne de prompt « chercher puis lire borné »** pour les postes, les instances et les ponctuels : search_code d'abord, puis Read sur les lignes rendues | relève l'adoption (pilote : bras tool contre tool-bare) ; part propre à la recherche 1 à 2,5 % (E) | XS | une ligne de plus dans chaque prompt ; à mesurer sur le maître à part |
| 3 | **Grouper les explorations indépendantes** dans un même tour (appels en parallèle) | 91 % des requêtes d'exploration ne portent qu'un appel, et chacune relit 181 k tokens (M). Fusionner 25 % de ces allers-retours rapporterait 2,7 % ; réaliste 1 à 2 % (E) | XS | faible ; à mesurer par un bras du grand A/B |
| 4 | **Déléguer les explorations longues** (3 requêtes ou plus) à un sous-agent Sonnet à petit contexte | ces épisodes portent 3,2 % du coût en allers-retours, plus leur contenu (M). Un aller-retour y coûte environ 13 % du même dans un contexte de 181 k sur Opus, d'où 2 à 3 % net (E). La consigne existe déjà (« Agent Explore ») mais n'est pas suivie : aucun sous-agent Explore en 14 jours (M) | S | le détail reste chez le sous-agent, ce qui peut provoquer des relectures ; à mesurer |
| 5 | **Indexer plus de repos** | multiplie la couverture. claude-hub seul couvre 17 % du coût ; avec tous les repos git servis, environ 60 % (M) | S, puis une indexation GPU par repo | secrets (filtre de `files.ts` à vérifier par repo), indexation hors des heures de travail |
| 6 | **Lecture bornée** (règle seule, sans recherche) | relectures 0,8 % et lectures complètes de gros fichiers 1,0 % (M) ; réaliste 0,5 à 1 % (E), car la consigne globale l'impose déjà en partie | XS | faible |
| 7 | **Brief enrichi** : le maître joint 5 à 10 emplacements trouvés par la recherche | le premier épisode d'exploration du worker ; 0,5 à 1 % (E), à mesurer (bras brief) | S | une fausse piste coûte une lecture |
| 8 | **Latence à froid** (7 à 36 s selon hub-ai-box) : préchauffer au lancement d'une session qui a la recherche | indirect : temps et adoption, puisqu'une réponse lente pousse vers Grep | S (hub-ai-box) | VRAM : la règle « 0 au repos » reste à tenir |
| 9 | **Réponse plus courte** : budget 500 ou k=3 au lieu de 800 et 5 | 0,1 à 0,3 % (E) | XS | hit@3 plus faible (mesure de qualité) |
| 10 | **search_memory** sur topic_memory, notes de passation et fichiers mémoire | la mémoire pèse 0,6 % du coût (1,3 % chez le maître) : plafond 0,2 à 0,6 % (M) | S | faible |
| 11 | **Catalogue Supabase** (`where_is` sur edges, tables, RPC, crons) | les repos Coiffissimo font environ 6 % du coût de la période, avec une forte part de localisation dans les petits repos : ≤ 0,5 % du total (E), mais un gain fort par session | déjà fait, il faut l'indexer | faible |

**Multiplicateur hors périmètre** : le contexte moyen relu est de 223 k tokens, et les relectures de cache font 63 %
du coût. Chaque aller-retour évité vaut proportionnellement à la taille du contexte. Réduire celle-ci (compactage,
sessions neuves par sujet) relève de l'étude du cache (`hub-ai-box-cache`) : c'est le plus gros levier global, mais
il fait baisser d'autant le gain en dollars de la recherche.

## 6. Exploration déléguée : moins d'allers-retours du gros contexte (18/11)

Question : faire tomber le coût de l'exploration elle-même, plutôt que mieux classer des fichiers. Mesures du 18/11,
sessions principales Sonnet 5.5, `claude.exe` 2.1.321. Dépense : 27,7 $ au tarif API, sous le plafond de 30 $ tenu par
`scripts/search-bench/budget.mjs`. Chiffres agrégés seulement.

**En bref.** Confier une exploration à une aide Haiku 5.5 dans un contexte neuf divise par deux les requêtes de la
session qui demande et baisse le coût de 36 % sur les missions où il faut comprendre du code, sans perte de réussite,
au prix de 18 s de plus. Sur l'usage réel, cela vaut au plus 7,6 % du coût total, 3 à 6 % en pratique (estimation).
La règle de regroupement, la carte du dépôt et le sous-agent natif n'apportent pas ce gain.

### 6.1 État de l'art

- **Recherche déléguée à un sous-agent rapide** : c'est la seule technique qui publie une baisse du nombre de tours.
  Cognition (SWE-grep) borne une recherche à 4 tours de 8 appels en parallèle, contre 10 à 20 tours en série pour une
  recherche agentique ordinaire (https://cognition.com/blog/swe-grep). Morph (WarpGrep) annonce −26 % de tours et −39 %
  de tokens d'entrée avec Opus 4.5 sur SWE-bench (chiffres de l'éditeur, non vérifiés :
  https://www.morphllm.com/benchmarks/warp-grep). Amp a ses sous-agents Search, Oracle et Librarian
  (https://ampcode.com/news/librarian), sans chiffre publié.
- **Claude Code** a son sous-agent Explore, en lecture seule, sans CLAUDE.md ni état git. Il prend aujourd'hui le
  modèle du parent, plus Haiku (https://code.claude.com/docs/en/sub-agents). Anthropic ne publie aucun chiffre de coût.
- **Contre-indication connue** : un système multi-agents consomme environ 15 fois les tokens d'une conversation, et le
  code se prête moins au parallélisme que la recherche documentaire
  (https://www.anthropic.com/engineering/multi-agent-research-system). La délégation ne paie que si l'aide est très bon
  marché et bornée.
- **Appels groupés par programme** : −37 % de tokens sur des tâches de recherche chez Anthropic, jamais mesuré sur de
  l'exploration de code (https://www.anthropic.com/engineering/advanced-tool-use).
- **Sorties bornées** : SWE-agent résout 18,0 % des tâches avec une fenêtre de 100 lignes contre 12,7 % avec le fichier
  entier (2024, GPT-4 : https://arxiv.org/html/2405.15793v1). **Carte du dépôt** (Aider, tree-sitter et PageRank, 1 K
  tokens par défaut : https://aider.chat/docs/repomap.html), **LSP** et **lectures signées** : aucune mesure publiée de
  coût ou de nombre de tours.

### 6.2 Plafond sur l'usage réel

`delegation.mjs`, mêmes transcriptions que la section 1 (03/11 au 17/11). Une suite de L requêtes qui ne font
qu'explorer devient une requête : l'appel à l'aide et sa réponse de 900 tokens (taille mesurée). Les L−1 allers-retours
économisés sont comptés au prix réel de la session ; le contenu remplacé exclut les lectures de fichiers que la session
modifie ensuite. L'aide est payée à part : 0,006 $ par exploration sur Haiku 5.5, 0,045 $ sur Sonnet (mesurés, 6.3).

| Suites déléguées | Suites | Requêtes | Contexte moyen | Allers-retours | Contenu | Net, aide Haiku | Net, aide Sonnet |
|---|---|---|---|---|---|---|---|
| 2 requêtes ou plus | 924 | 3 023 | 152 K | 3,9 % | 3,9 % | **7,6 %** | 6,0 % |
| 3 requêtes ou plus | 438 | 2 051 | 132 K | 2,8 % | 2,8 % | 5,5 % | 4,7 % |

- **Par type de session** (suites de 2 ou plus, aide Haiku) : instances 12,6 %, postes 10,0 %, ponctuels 6,3 %,
  maître 4,8 %.
- **Ce qui reste hors de portée** : 64 % des suites (1 655 sur 2 579) ne font qu'une requête. Aucune piste de cet axe
  ne les supprime ; leur coût dépend de la taille du contexte (axe « contexte »).
- Ce plafond suppose que toute suite est déléguée et que la réponse suffit. Le gain réaliste est le plafond multiplié
  par l'adoption mesurée en 6.4.

### 6.3 L'outil `explore`

`scripts/explore-mcp.mjs` : un outil MCP `explore(question, paths?, thorough?)`. Il lance une session Claude Code neuve
en lecture seule (Grep, Glob, Read ; ni Bash, ni MCP, ni réglages ; confinée au dépôt par `--restricted`, vérifié : une
lecture hors du dépôt est refusée), avec un prompt système court, le plan des dossiers
du dépôt et la question. Sa réponse est bornée à 4 000 caractères : la réponse directe, puis une ligne `chemin:lignes`
par étape. Une aide qui échoue le dit, et la session reprend ses propres recherches.

- **Contexte de départ** : 3,9 K tokens, contre 17,8 K pour une session Claude Code par défaut.
- **Forme d'une exploration** (Haiku) : 5 à 6 requêtes, déjà groupées (2 à 4 appels par requête).

Appelé seul (`explore-eval.mjs`) sur 36 questions à vérité connue de 3 repos : les 10 questions du banc commité, qui
ont des lignes attendues, et les 26 missions de l'A/B posées comme questions (fichier attendu).

| Aide | Bon fichier cité | Bonnes lignes | Coût par exploration | Durée moyenne (p90) | Échecs |
|---|---|---|---|---|---|
| Haiku 5.5 | 36/36 | 10/10 | 0,0038 $ (max 0,009 $) | 24,6 s (33 s) | 0 |
| Haiku 5.5 + carte du dépôt (2 K tokens) | 35/36 | 10/10 | 0,0046 $ | 17,0 s | 0 |
| Sonnet 5.5 (14 questions) | 14/14 | 4/4 | 0,043 $ (max 0,116 $) | 15,7 s (24 s) | 0 |

- **Haiku contre Sonnet** : même justesse sur ces questions, Sonnet 36 % plus rapide (moins de requêtes), Haiku 11 fois
  moins cher. `hub-aibox-routage` trouve la même chose sur des relevés mécaniques (47/48 contre 31/32).
- **Carte du dépôt** donnée à l'aide (`repo-map.ts` : définitions par fichier, fichiers les plus référencés d'abord) :
  −0,9 tour (±0,5) et −2,7 s (±1,4) par exploration, apparié sur 36 questions, pour +21 % de coût et un fichier manqué.
  Les durées moyennes des deux lignes Haiku ne se comparent pas directement (3 explorations en parallèle pour l'une, 2
  pour l'autre). Taille de la carte entière : 3 K tokens (50 fichiers), 12 K (195 fichiers), 71 K (1 357 fichiers) ;
  0,7 à 8 s à construire, sans cache.
- **Démarrage du processus** : environ 1 s machine au repos (mesuré : une aide lancée 8 s avant sa question répond
  aussi vite qu'une aide lancée avec elle, 9,0 s contre 8,9 s). Garder une aide prête d'avance n'apporte rien.

### 6.4 A/B dans le régime réel

`missions.mjs`, 26 missions vérifiables (13 d'explication, 13 de modification, 3 repos, les mêmes que l'A/B de la
recherche), une session Sonnet par mission et par bras. Chaque session porte **202 K tokens de contexte de
remplissage** (`BENCH_PAD_TOKENS`) dans son prompt système, pour que chaque requête relise un contexte de la taille
réelle (181 K en moyenne en exploration, 240 K chez les instances). Le remplissage est le même pour tous les bras et
lu depuis le cache. Intervalles à 95 %, par rééchantillonnage des missions (`ab-report.mjs`).

| Bras | Missions | Requêtes de la session | Coût mesuré | Coût à 181 K, session Opus | Aide appelée | Réussite | Durée |
|---|---|---|---|---|---|---|---|
| `explore` (outil + consigne, aide Haiku) | explication (13) | 3,6 → 2,0 : **−45 %** [−53 ; −33] | **−36 %** [−44 ; −28] | −38 % [−45 ; −29] | 13/13 | 13/13 | 20 → 40 s : +18 s [14 ; 22] |
| | modification (13) | 4,5 → 5,2 : +14 % [−13 ; +57] | +12 % [−7 ; +42] | +12 % [−7 ; +41] | 2/13 | 13/13 | +8 s [−4 ; 19] |
| | toutes (26) | −12 % [−32 ; +12] | −12 % [−26 ; +6] | −12 % [−27 ; +5] | 15/26 | 26/26 | +13 s [7 ; 19] |
| `batch` (règle de regroupement seule) | explication (13) | −4 % [−14 ; +5] | +1 % [−10 ; +15] | +1 % [−10 ; +15] | | 13/13 | −1 s [−3 ; 1] |
| | modification (13) | +5 % [−13 ; +30] | +10 % [−4 ; +28] | +11 % [−3 ; +28] | | 13/13 | −4 s [−14 ; 7] |
| | toutes (26) | +1 % [−9 ; +16] | +6 % [−4 ; +18] | +6 % [−3 ; +18] | | 26/26 | −2 s [−7 ; 3] |

- **La délégation paie là où il faut comprendre** : sur les missions d'explication, la session ne fait plus que deux
  requêtes (l'appel et la réponse), l'aide coûte 0,0055 $ et 24 s par appel, et la réussite ne bouge pas. Là où l'aide
  est appelée (15 missions), le coût à 181 K sur Opus baisse de 33 % [−42 ; −24].
- **Elle ne sert pas quand la cible est nommée** : pour changer une constante ou un texte, la session va droit au Grep
  et n'appelle l'aide que 2 fois sur 13. L'écart de coût sur ces missions n'est pas significatif.
- **Le gain ne vient pas que du contexte relu** : sans remplissage, le calcul donne encore −31 % [−38 ; −24] sur les
  missions d'explication. La session principale n'écrit plus le contenu des fichiers dans son cache (tokens propres à
  la mission : −35 % [−42 ; −28]) ; c'est Haiku qui les lit, 20 à 80 fois moins cher.
- **La règle de regroupement ne change rien** : Sonnet regroupe déjà 28 % de ses requêtes sans consigne, 40 % avec,
  mais le nombre de requêtes ne baisse pas (+9 % de tokens propres, non significatif). La piste 3 de la
  section 5 (1 à 2 % attendus) n'est pas confirmée sur l'exploration. Les chaînes de Bash de travail sont mesurées par
  `hub-aibox-contexte`.
- **Le prix est la latence** : +18 s par exploration déléguée.
- Coût de l'outil dans le préfixe : environ 370 tokens (description et consigne), soit 0,00007 $ par requête sur Opus.
- **Limites** : missions courtes où l'exploration fait toute la mission ; une seule exécution par paire ; le
  remplissage est un texte sans rapport, pas une vraie conversation ; les coûts « session Opus » sont recalculés à
  partir des tokens mesurés sur Sonnet, en supposant le même comportement.

### 6.5 Variantes de la délégation

Les 13 missions d'explication, sans remplissage, comparées au bras `current` de 6.4 ramené au même contexte. La
première ligne reprend le bras `explore` de 6.4.

| Variante | Aide appelée | Requêtes | Coût par mission, petit contexte | Coût à 181 K, session Opus | Durée | Réussite |
|---|---|---|---|---|---|---|
| `current` | | 3,6 | 0,108 $ | 0,347 $ | 20 s | 13/13 |
| Outil + consigne, aide Haiku | 13/13 | 2,0 | 0,075 $ : −31 % [−38 ; −24] | −38 % [−45 ; −29] | +18 s | 13/13 |
| Outil seul, sans consigne | 7/13 | 2,7 | 0,094 $ : −13 % [−29 ; +6] | −19 % [−36 ; 0] | +11 s [5 ; 18] | 13/13 |
| Outil + consigne, aide Sonnet | 13/13 | 2,2 | 0,147 $ : +36 % [+13 ; +64] | −14 % [−28 ; +2] | +19 s [12 ; 27] | 13/13 |
| Sous-agent natif de Claude Code (outil Agent, même prompt, Haiku demandé) | 13/13 | 2,0 | 0,139 $ facturés | non calculé | +22 s [16 ; 27] | 13/13 |

- **La consigne double l'adoption** : 7/13 avec la seule description de l'outil, 13/13 avec une phrase dans le prompt.
  C'est mieux que `search_code` (7/26 sans consigne, 13/26 avec, section 2).
- **Une aide Sonnet ne vaut pas son prix** : 0,072 $ par appel contre 0,0055 $, pour 22 s contre 24 s. Dans un petit
  contexte elle coûte plus cher que de ne rien déléguer.
- **Le sous-agent natif n'est pas fiable sur le coût** : dans 6 sessions sur 13 il a tourné sur Sonnet, parce que la
  session appelante a passé `model: "sonnet"` dans son appel (vérifié sur 3 sessions rejouées : 2 demandes
  explicites). La consigne globale « délégations toujours en Sonnet » l'explique sans doute. Il part aussi en
  arrière-plan par défaut : en session `-p`, la session rend la main avant sa réponse si l'appel ne dit pas
  `run_in_background: false`. Avec un outil du hub, le modèle, les bornes et le coût sont fixés par le hub.

### 6.6 Pistes écartées ou non mesurées

| Piste | Verdict | Mesure |
|---|---|---|
| Règle « regroupe tes recherches » | écartée pour l'exploration | requêtes +1 % [−9 ; +16], coût +6 % [−4 ; +18] (6.4) |
| Carte du dépôt donnée à l'aide | marginale | −0,9 tour, −2,7 s, +21 % de coût, 35/36 (6.3) |
| Carte du dépôt dans le contexte principal | non mesurée | 3 à 71 K tokens selon le repo ; à 2 K elle ne montre que 22 à 27 fichiers |
| Aide lancée d'avance | écartée | le démarrage ne coûte qu'environ 1 s (6.3) |
| Lectures signées, anti-relecture | non prototypée | plafond 0,9 % du coût (relectures, section 1) |
| Lecture par plages imposée | non reprise | plafond 1,0 % (section 1), déjà en partie appliquée |
| LSP et index de symboles | non mesurés | une opération LSP reste un aller-retour du gros contexte ; un serveur par langage et par worktree à maintenir. Utile seulement comme outil de l'aide |
| Outil « grouper » dédié | non prototypé | Claude Code sait déjà lancer plusieurs appels par message ; la règle qui le demande n'a rien changé |

### 6.7 Architecture recommandée

1. **Un outil `explore` dans le serveur MCP du hub**, à côté de `search_code` (`src/main/sessions.ts`, `hubTools`),
   montré d'emblée (`alwaysLoad`), avec une phrase dans le prompt des workers et des postes. Il reprend
   `scripts/explore-mcp.mjs` : session neuve Haiku 5.5, lecture seule, `--restricted`, réponse bornée.
2. **Garde-fous** : plafond de dépense et de tours par appel (0,10 $ et 16 tours dans le prototype), délai de 180 s,
   repli en clair vers Grep et Read, nombre d'aides simultanées borné par le hub, coût de l'aide ajouté au journal de
   coût de la session qui l'appelle.
3. **Règles de permission** : l'aide ne charge aucun réglage ; il faut lui transmettre les refus de lecture de la
   session (fichiers de secrets), sinon elle lit ce que la session n'a pas le droit de lire. Sa réponse est une donnée
   d'outil, pas une consigne.
4. **Pas d'index requis** : ni modèle local, ni GPU, ni index à tenir à jour. La recherche locale de la section 1 reste
   utile comme outil de l'aide, pas comme condition.
5. **Rien n'est retiré du contexte principal** : la session garde tout ce qu'elle a lu ; elle lit seulement moins de
   fichiers bruts, puisque l'aide les lit à sa place.

Gain attendu : au plus 7,6 % du coût total (6.2) ; 3 à 6 % en comptant l'adoption mesurée (estimation), davantage chez
les instances et les postes (plafonds de 12,6 % et 10,0 %). Coût de maintenance : environ 130 lignes, aucune
dépendance nouvelle.

### 6.8 Décisions à prendre

- **Haiku pour l'aide**, contre la consigne « jamais Haiku en délégation » : même justesse mesurée (36/36 contre
  14/14), 13 fois moins cher en situation, à peine plus lent.
- **Activer `explore` chez les workers et les postes**, avec sa phrase de consigne, en acceptant +18 s par exploration
  déléguée.
- **La session principale voit une synthèse** au lieu des fichiers : rien n'est retiré, mais elle a moins de code brut
  en contexte et doit relire les lignes qu'elle modifie.
- **Mesure en production** avant de généraliser : l'A/B porte sur 26 missions courtes ; le gain réel de 3 à 6 % est
  une estimation.
