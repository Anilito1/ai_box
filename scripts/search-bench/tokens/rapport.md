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
