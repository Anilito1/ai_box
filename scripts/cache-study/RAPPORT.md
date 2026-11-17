# Cache de prompt de l'AI Box : mesures et plan (17/11/2026)

Fenêtre : 03/11 00:00 → 18/11 00:00 (heure de Paris), toutes les transcriptions Claude Code de la machine, sous-agents inclus.
Aucun contenu de conversation n'est lu par les rapports : seulement des tailles, des empreintes et les champs `usage`.
Les montants sont des équivalents au prix de l'API, pas une facture : l'abonnement Max ne facture pas au token.

Scripts (dans ce dossier) : `load.mjs` lit les transcriptions vers un JSON numérique, puis `totals.mjs`, `causes.mjs`,
`context.mjs`, `cap.mjs`, `idle.mjs` et `prefix.mjs` l'analysent. `limits.mjs` servira dès que le hub journalise les limites.

La clé de l'étude : chaque transcription récente du CLI (2.1.308 et suivantes) contient une ligne `api-request` par
appel. Elle donne le modèle, l'effort, l'empreinte des outils et du système (`shapeHash`), la requête qu'elle prolonge
(`base`, `keep`) et ses points de cache. On sait donc, appel par appel, ce que le cache aurait dû contenir et ce qu'il
a réellement relu.

## 1. Où partent les tokens

| | Requêtes | Écriture 5 min | Écriture 1 h | Lecture cache | Output | Équivalent API |
|---|---:|---:|---:|---:|---:|---:|
| Total sur 14 jours | 17 610 | 12,2 M | 64,8 M | 3 867 M | 16,1 M | ≈ 1 836 $ |
| Part du coût API | | 2,5 % | 35,6 % | 41,4 % | 20,5 % | |

- L'input non caché est quasi nul (0,1 M) et le taux de lecture atteint 98 %. Le problème n'est donc pas le taux de
  succès du cache, mais la taille des contextes relus à chaque requête et les réécritures complètes.
- Recoupements : `hub-ai-box-tokens` trouve moins de 1 % d'écart avec son propre parseur. Le journal du hub
  (`usage/turns-*.jsonl`) trouve 3 822 M en lecture et 72 M en écriture (moins de 7 % d'écart, car il couvre aussi Codex
  et Gemini mais pas les sessions lancées hors du hub).

**Par type de session** (coût API) :

| Type | Part | Requêtes | Contexte moyen | Contexte max |
|---|---:|---:|---:|---:|
| Ponctuel | 44 % | 7 538 | 251 K | 807 K |
| Maître | 20 % | 2 057 | 331 K | 829 K |
| Poste | 19 % | 3 579 | 179 K | 619 K |
| Instance | 9 % | 1 980 | 250 K | 678 K |
| Sous-agent | 6 % | 2 259 | 98 K | 531 K |
| Hors hub | 1 % | 197 | 71 K | 116 K |

- **Par modèle** : Opus 5.5 52 %, Fable 5.2 ≈ 34 %, Fable 5.1 7 %, Sonnet 5.5 6 %.
- **Par repo** : Desktop (ponctuels) 29 %, finca3D 16 %, cours de deep learning 8 %, claude-hub 7 %, liz-site 7 %.

**Taille du contexte** : 56 % des lectures viennent de requêtes de plus de 300 K tokens, et 32 % de requêtes de plus de
500 K. Les workers tournent avec `autoCompactWindow` = 1 M, posé par le hub. Le maître hérite du même 1 M depuis les
réglages d'Anil. Seules 14 compactions ont eu lieu en 14 jours.

**Les 10 sessions les plus coûteuses** (sous-agents compris) :

1. hub-maitre (bd1db749), 155 $
2. hub-finca-viewer, 137 $
3. hub-finca-recon, 128 $
4. hub-maitre (7f184e1b), 94 $
5. hub-bleps-ui, 88 $
6. hub-camping-almosita, 73 $
7. hub-ai-box (dd0fcde6), 54 $
8. hub-ai-box-vps-remote2, 50 $
9. hub-maitre (1d75cfb3), 49 $
10. hub-maitre (fca70d2a), 46 $

Ensemble, elles font 47 % du total, dont quatre conversations du maître.

**Les tours les plus coûteux** (journal du hub) :

- Le plus cher : hub-ai-box-vps-remote2 le 09/11, 42,9 $ pour 141 M de lectures en un seul tour.
- Suivent vps-runner (24 $), camping-almosita (23 $) et brain (20 $).
- Profil commun : de longues boucles d'outils sur un gros contexte, chaque appel d'outil relisant tout.
- Les 50 tours les plus chers font 34 % du coût.
- Coût d'un tour : médiane 0,29 $, p90 2,09 $, p99 10,9 $.
- `hub-ai-box-tokens` mesure que 18,7 % des requêtes ne font qu'explorer. Elles portent en général un seul appel
  d'outil, sur 181 K de contexte en moyenne.

## 2. Pourquoi le cache est réécrit (`causes.mjs`)

Sur les 77,0 M tokens écrits, 35,8 M (46 %) sont de la croissance normale : le tour nouveau. Les 41,2 M restants (54 %)
réécrivent un préfixe déjà payé.

| Cause | Tokens | Part des écritures | Qui |
|---|---:|---:|---|
| Inactivité de plus d'1 h, cache 1 h expiré (process vivant) | 12,0 M | 15,6 % | maître 5,3, ponctuels 5,2 |
| Reprise d'une conversation après plus d'1 h (process relancé) | 10,7 M | 13,9 % | ponctuels 6,6, maître 4,0 |
| Début de conversation (préfixe fixe + premier message) | 8,4 M | 10,9 % | 261 démarrages, ≈ 32 K chacun |
| Début de sous-agent | 3,4 M | 4,4 % | 112 démarrages (TTL 5 min) |
| Changement de modèle en cours de conversation | 2,9 M | 3,8 % | ponctuels, hors hub |
| Prompt système changé à la reprise (snapshot off) ou outil advisor | ≈ 1,7 M | 2,2 % | maître |
| Compaction (nouveau prompt après résumé) | 0,8 M | 1,0 % | postes |
| TTL 5 min expiré (sous-agents) | 0,5 M | 0,6 % | |
| Historique modifié, lecture partielle | 0,5 M | 0,7 % | |

**Mesuré sans perte de cache** (journal des transitions) :

- 131 chargements d'outils du hub par ToolSearch, plus WebFetch, Monitor, SendMessage et playwright : ajoutés par
  `tool_addition`, le cache est gardé.
- 7 changements d'effort.
- 499 deltas d'instructions MCP.
- Les modifications de CLAUDE.md en cours de session.

Les postes échappent déjà à la réécriture après 1 h grâce à `renewStale` (nouvelle conversation avec note). Le maître et
les ponctuels n'ont pas ce mécanisme.

**Interruptions** : 566 requêtes sans réponse. Leur coût n'est pas visible dans les transcriptions (non mesurable ici).
La requête suivante relit bien le préfixe de la précédente.

## 3. Taille du préfixe fixe

Mesuré par différence exacte sur des sessions `claude -p` (Sonnet 5.5). Les valeurs marquées ≈ sont converties depuis les
caractères au ratio mesuré de 2,4 à 2,6 caractères par token.

| Bloc | Tokens | Origine |
|---|---:|---|
| Outils intégrés + début du prompt système de Claude Code | 12,8 K | Cache `scope: global`, partagé entre sessions : relu, pas réécrit |
| Suite du prompt système de Claude Code | ≈ 1,8 K | |
| Consignes du hub (append) | maître ≈ 9,7 K, instance ≈ 5,8 K, poste ≈ 3,6 K, ponctuel ≈ 2,1 K | `prompts.ts` + consignes de poste |
| CLAUDE.md global + repo + MEMORY.md, git, e-mail | ≈ 6,8 K | Réglages d'Anil et du repo |
| Liste des skills | ≈ 8,3 à 11 K | Mesuré : `SLASH_COMMAND_TOOL_CHAR_BUDGET=8000` retire 8,3 K |
| MCP : instructions MasterTools, outils différés, avis d'auth | 6,7 K | Mesuré (`--strict-mcp-config`) |
| Hook SessionStart du plugin brain | ≈ 2,9 K | Injecté aussi hors Coiffissimo (80 % des sessions, d'après harness) |
| Environnement, types d'agents, divers | ≈ 1,5 K | |
| **Total d'une session CLI sans le hub** | **44,0 K** | Mesuré |
| Dont réglages utilisateur (plugins, skills, MCP, hook) | 18,7 K | Mesuré (`--setting-sources project,local`) |

- **Ce que coûte 1 K token de préfixe** : environ 5,5 $ API tous les 14 jours, à l'usage actuel. Il est relu par
  15 351 requêtes principales et réécrit à environ 330 démarrages et reconstructions.
- **Usage réel** (agrégats de `hub-ai-box-harness`) :
  - cloudflare : 23 skills listés pour 2 appels ;
  - hyperframes : 9 skills pour 0 appel ;
  - anthropic-skills : 3 appels ;
  - MCP MasterTools : 0 appel en 14 jours, alors que ses instructions sont chargées partout ;
  - playwright : 211 appels.

## 4. Règles officielles

**Documenté** :

- **Préfixe** : ordre tools → system → messages, au plus 4 points de cache, 20 positions de recherche en arrière. Une
  entrée n'est lisible qu'une fois la première réponse commencée. (platform.claude.com/docs/en/build-with-claude/prompt-caching)
- **TTL** : 5 min par défaut ou 1 h. Le compteur est relancé à chaque lecture, sans coût, et se mesure depuis le début
  de la requête. Les entrées 1 h doivent précéder les entrées 5 min. (même page)
- **Prix** (about-claude/pricing) : écriture ×1,25 en 5 min, ×2 en 1 h. Lecture ×0,05 sur Opus 5.5 et Sonnet 5.5,
  ×0,025 sur Fable 5.1 et 5.2, ×0,1 ailleurs.

  | Modèle | Entrée | Sortie | Lecture cache |
  |---|---:|---:|---:|
  | Opus 5.5 | 4 | 20 | 0,20 |
  | Sonnet 5.5 | 2 | 10 | 0,10 |
  | Fable 5.1 | 10 | 50 | 0,25 |
  | Fable 5.2 | 8 | 40 | 0,20 |

  Prix en $ par million de tokens.
- **Invalidation** : un changement d'outils ou de modèle invalide tout. Un changement de système invalide le système et
  les messages. Un changement de `tool_choice` ou d'images invalide les messages. Un changement d'effort ou de
  `thinking` dépend du modèle. Trois parades existent : messages système en milieu de conversation, `tool_addition`, et
  effort par message.
- **Claude Code** (code.claude.com/docs/en/prompt-caching) :
  - TTL 1 h pour la conversation principale sur abonnement, dans les limites du forfait. 5 min pour le reste
    (sous-agents, compaction, titres).
  - Au-delà du forfait (crédits), la conversation principale passe à 5 min.
  - Réglages : `promptCacheTtl` et `subagentPromptCacheTtl`, ou `CLAUDE_CODE_PROMPT_CACHE_TTL` /
    `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`, `FORCE_PROMPT_CACHING_5M`, `ENABLE_PROMPT_CACHING_1H` et
    `DISABLE_PROMPT_CACHING*`.
  - Avec ToolSearch, la liste d'outils du premier appel est gardée toute la conversation.
  - L'effort garde le cache sur Fable 5.1+, Opus 5.5, Sonnet 5.5 et Haiku 5.5.
  - Les éditions de CLAUDE.md, le mode de permission et les skills gardent le cache.
  - Un changement de modèle, une compaction, un `/clear` ou une mise à jour du CLI le cassent.
  - Le cache est de fait propre à une machine et un dossier.
- **Idle compaction** (settings-reference, `idleCompaction`) : compaction avant expiration du cache 1 h, à partir de
  200 K tokens. Elle n'existe qu'en terminal, VS Code et appli de bureau, **pas dans le SDK, donc pas dans l'AI Box**.
- **Prompt système à la reprise** (cli-reference) : par défaut il est enregistré au premier appel et réutilisé.
  `--system-prompt-snapshot off` le reconstruit à chaque requête ; l'AI Box le fait pour le maître et les postes.
- **Liste des skills** (env-vars, `SLASH_COMMAND_TOOL_CHAR_BUDGET`) : son budget vaut 1 % de la fenêtre de contexte,
  donc environ 10 K avec 1 M, et 8 000 caractères par défaut ailleurs.

**Non documenté ou supposé** :

- `scope: "global"` : visible dans les journaux, cité par le changelog 2.1.275 et le blog de Thariq, absent du schéma de
  l'API.
- **Comptage de l'abonnement Max** : aucune page officielle ne donne le poids des lectures et écritures de cache dans les
  limites de 5 h et hebdomadaire.
  - Seuls indices officiels : les lectures « comptent moins » (support Claude, projets) ; la doc des coûts de Claude Code
    dit que relire l'historique « draws usage » au tarif caché ; Fable consomme plus vite et est plafonné à 50 % de la
    limite hebdo.
  - Ajustements communautaires (non officiels, solidité moyenne) :
    - techbytes, compte Opus : 1 % de semaine = 170 M lectures, 4,6 M écritures, 3 M input ou 660 K output. Soit une
      lecture ≈ 0,018 input, une écriture ≈ 0,65 et un output ≈ 4,5.
    - wokey : « les lectures comptent à peine », une écriture ≈ un input, un output ≈ 4 à 7 inputs.
  - Avec les poids de techbytes, la limite hebdo d'Anil se répartit ainsi : lectures 36 %, écritures 26 %, output 38 %.
    Avec ceux de wokey : lectures ≈ 0 %, écritures ≈ 46 %, output ≈ 54 %.
  - **Le prototype 1 ci-dessous mesurera ces poids sur l'usage réel d'Anil.**

## 5. Mémoire (mesurée le 17/11 sur la machine, 16 Go)

- **Process CLI** (`claude.exe`) d'une session active : 290 à 330 Mo de working set, 510 à 560 Mo privés.
- **MCP playwright**, lancé par chaque session : 2 process node, 130 à 160 Mo, plus les shells (bash, cmd, conhost).
- **Par worker actif** : 0,42 à 0,75 Go de working set, 0,7 à 0,9 Go privés. Un worker endormi n'a aucun process : les
  postes s'endorment après 5 min sans travail, les ponctuels se ferment après 15 min.
- **Electron (le hub)** : environ 0,57 Go au total (main 144 Mo, GPU 184 Mo, renderer 192 Mo, utility 52 Mo).
- **Avec 5 workers actifs**, l'arbre du hub occupe 3,5 Go de working set (4,2 Go privés) et il reste 3,3 Go libres. Avec
  8 workers actifs : environ 4 à 6 Go.
- **Seuil Claude Code** : la doc (troubleshooting) avertit à partir de 2,5 Go de tas par session.

## 6. Expériences (13 sessions `claude -p` Sonnet 5.5, ≈ 1,6 $ API)

| Essai | Lu | Écrit | Constat |
|---|---:|---:|---|
| A1 session par défaut | 12,8 K | 31,2 K | Préfixe 44,0 K, dont 12,8 K déjà en cache global |
| A2 `--disable-slash-commands` | | | 38,6 K : liste des skills retirée, mais les outils grossissent |
| A3 `--strict-mcp-config` | | | 37,3 K : MCP = 6,7 K |
| A4 réglages projet seulement | | | 25,3 K : réglages utilisateur = 18,7 K |
| A5 `--disallowedTools NotebookEdit` | | | −8 tokens : un outil différé ne coûte rien |
| A6 append de 19 018 caractères en français | | | +7 724 tokens : 2,46 caractères par token |
| A7 `SLASH_COMMAND_TOOL_CHAR_BUDGET=8000` | | | 31,6 K : skills −8,3 K (plus −4,1 K dus à l'heure de connexion des MCP) |
| B1 reprise, mêmes options | 21,5 K | 22,5 K | Voir la note sous le tableau |
| B2 reprise, effort medium → low | 44,0 K | 0 | Cache gardé |
| B3 reprise, autre `--append-system-prompt`, snapshot on | 44,0 K | 2,1 K | Cache gardé, mais le nouveau texte **n'est pas appliqué** |
| B4 idem, snapshot off (cas du maître et des postes) | 12,8 K | 31,9 K | Tout ce qui suit le prompt système est réécrit |
| B5 reprise avec `CLAUDE_CODE_PROMPT_CACHE_TTL=5m` | 44,0 K | 1,1 K (5 min) | Variable par session efficace |
| B6 reprise sans aucun MCP | 44,0 K | 0,3 K | Cache gardé (outils différés) |

Note sur B1 : la reprise d'une conversation d'un seul tour a réécrit le message système de début de session. Sur les
vraies conversations, les reprises dans le TTL relisent tout : plus de 30 cas dans les journaux, sans perte.

**Simulation du TTL 5 min contre 1 h** (coût cache des sessions principales sur 14 jours) :

| Type | Avec 5 min |
|---|---:|
| Maître | +192 % |
| Ponctuels | +56 % |
| Postes | +22 % |
| Instances | +10 % |

**Garder 1 h.**

## 7. Plan d'optimisation, classé par gain mesuré

Les gains sont calculés sur 14 jours, en équivalent API. La colonne « Limite hebdo » donne la fourchette selon les poids
de techbytes ou de wokey (§4), à confirmer par le prototype 1.

| # | Action | Gain mesuré | Limite hebdo | Effort | Risque | Qui |
|---|---|---|---|---|---|---|
| 1 | Plafonner le contexte : compaction ou passation au-delà de 300 K (400 K si la qualité souffre), au lieu de 1 M | −39 % des lectures, **−273 $ net (15 %)**. À 200 K : −50 %, −319 $ | 12 % / ≈ 0 % | XS (`autoCompactWindow` par rôle dans `launchSettings`, réglage du maître) | Moyen : compaction en pleine tâche | AI Box + réglages d'Anil |
| 2 | Nouvelle conversation (note ou résumé) quand le maître ou un ponctuel se réveille après plus d'1 h avec plus de 150 K de contexte, comme les postes | 17,7 M écritures évitées, **−198 $ (11 %)** : maître 77 $, ponctuels 121 $ | 6 % / 11 % | Maître : prototype fait. Ponctuels : S (note avec la mission) | Moyen : perte du détail du contexte | AI Box |
| 3 | Réduire la liste des skills : `SLASH_COMMAND_TOOL_CHAR_BUDGET` ≈ 8 000-12 000 pour les workers, ou `skillOverrides` sur cloudflare, hyperframes et anthropic-skills | −8,3 K par session, **≈ −46 $ (2,5 %)** | ≈ 2 % | XS | Faible à moyen : découverte des skills | AI Box (env de lancement) ou réglages d'Anil |
| 4 | Ne pas charger MasterTools dans les workers (0 appel) | ≈ −3 K par session, **≈ −16 $ (0,9 %)** | < 1 % | XS (`WORKER_DENIED_MCP`) | Faible | AI Box |
| 5 | Hook brain limité aux dossiers Coiffissimo | ≈ −2,9 K dans 80 % des sessions, **≈ −13 $ (0,7 %)** | < 1 % | XS | Faible | plugin brain (supervision) |
| 6 | Pas de changement de modèle en cours de conversation longue ; repli = nouvelle conversation avec note au-delà de 150 K | **−20 $ (1,1 %)** | 1 à 2 % | S | Faible | AI Box (repli) |
| 7 | Garder le snapshot du prompt système (on) pour le maître et les postes, et envoyer les changements de consignes en message | ≈ −1,7 M écritures, **≈ −25 $ (1,4 %)** | ≈ 1 % | M (prompts.ts : diff à valider) | Moyen : consignes anciennes jusqu'à la compaction | AI Box |
| 8 | `list_workers` plus court par défaut (16 Ko en moyenne, relus ensuite à chaque requête) | ≈ 20-30 M lectures, ≈ −5 $ | < 1 % | S | Faible | AI Box |
| 9 | Exploration en un seul aller-retour (recherche locale, appels parallèles, sous-agent d'exploration) | Jusqu'à 18,7 % des requêtes à 181 K de contexte | À mesurer | POC en cours | | hub-ai-box-tokens |
| — | TTL : garder 1 h pour la conversation principale et 5 min pour les sous-agents | 5 min coûterait +10 % à +192 % | | | | Aucun changement |
| — | Mémoire : couper playwright dans les workers qui n'en ont pas besoin | −130 à 160 Mo par worker actif | | XS | Faible, mais playwright sert (211 appels) | AI Box, par poste |

Les gains 1 et 2 se recouvrent en partie : avec un plafond de contexte, les réécritures après 1 h sont plus petites.

## 8. Prototypes (branche `ai-box/cache`, non mergés)

1. **Journal des limites du forfait.** `CostLog.limits()` écrit `usage/limits-AAAA-MM.jsonl` à chaque changement des
   pourcentages 5 h, 7 j et Fable lus par le hub, avec un test. `scripts/cache-study/limits.mjs` ajuste ensuite la hausse
   hebdo sur les tokens de chaque type, à partir du journal des tours. Après une semaine d'usage, on saura combien
   comptent une lecture et une écriture de cache sur le forfait d'Anil.
2. **Renouvellement du maître réveillé après expiration du cache.** `masterRenewalDue()` dans `shared/team.ts`, avec un
   test. Le maître repart sur une conversation neuve s'il change de sujet, s'il atteint 90 %, ou s'il a été inactif plus
   d'1 h avec plus de 150 K de contexte. Il faut toujours, comme aujourd'hui, un résumé de sujet frais. Gain estimé sur
   la fenêtre : 77 $. Le texte du prompt (« at 90% provider context usage ») est à compléter : ce diff est proposé ici, il
   n'est pas appliqué.

   Diff proposé pour la consigne du maître (`memoryRules`, `src/main/sessions.ts`), à valider avant main : il change le
   prompt système du maître, donc une réécriture unique de sa conversation à la relance suivante.

   ```diff
   -Saved summaries permit an idle master to start a fresh provider conversation on topic switches or at 90% provider context usage.
   +Saved summaries permit an idle master to start a fresh provider conversation on topic switches, at 90% provider context usage, or when woken after an hour idle with a large context.
   ```

## 9. Limites de l'étude

- Les montants sont des équivalents API. Le poids réel du cache dans les limites Max reste inconnu tant que le
  prototype 1 n'a pas tourné une semaine.
- Les gains des pistes 1 et 2 viennent d'une relecture des journaux (`cap.mjs`, `idle.mjs`), pas d'un essai réel. Le
  coût en qualité (contexte perdu, travail refait) n'est pas mesuré.
- Le ratio caractères/tokens (2,4 à 2,6) est mesuré sur Sonnet 5.5. Opus 5.5 et Fable peuvent compter un peu
  différemment ; les totaux du §1 viennent, eux, des champs `usage` réels.
