# Étude : workers de l'AI Box sur un VPS

Statut : étude d'architecture, non commitée, aucune ressource créée. Rédigée le 2026-11-09 par hub-ai-box-vps-remote.
Constats marqués `confirmed` (lu dans le code ou mesuré) ou `needs_validation` (source externe ou hypothèse à tester).

## 0. Ce que fait le hub aujourd'hui (lu dans le code)

- **Lancement** : `SessionManager.launch` (`src/main/sessions.ts:1562`) appelle `adapter.start(spec)`. Pour Claude,
  `src/main/providers/claude/adapter.ts:183` appelle `query()` du SDK Agent (`@anthropic-ai/claude-agent-sdk` 0.3.308),
  qui lance `claude.exe` en processus enfant et lui parle en JSON sur stdin/stdout. `confirmed`
- **Outils du hub** (`message_master`, `spawn_worker`, `topic_memory`…) : serveur MCP **en processus**
  (`createSdkMcpServer`) ; chaque appel d'outil du CLI remonte par stdio jusqu'au processus principal Electron, qui
  exécute le handler. Idem `canUseTool` (demandes de permission affichées dans l'app) et `onElicitation`. `confirmed`
- **Codex / Gemini** : ils joignent les outils du hub par HTTP sur `127.0.0.1:<port>` avec un jeton par lancement
  (`src/main/mcpHub.ts`). Les comptes OpenAI pour Claude passent par un pont local (`bridge.ts`). `confirmed`
- **Comptes** : un compte abonnement = un dossier `CLAUDE_CONFIG_DIR` (identifiants OAuth dedans), un compte API = une
  variable `ANTHROPIC_API_KEY` (`src/main/accounts.ts:119-148`). `confirmed`
- **Postes** (`TeamRole`, `src/shared/types.ts:83`) : nom, consignes, dossiers (le premier est le cwd), modèle, effort,
  mode, compte. Aucun attribut d'emplacement. `confirmed`
- **Worktrees** : `git worktree add --no-track -b <branche>` à côté du repo (`src/main/worktrees.ts:106`), puis install
  des dépendances en tâche de fond ; à la fermeture, le worktree est retiré seulement si rien ne serait perdu. `confirmed`
- **Serveurs MCP des workers** : ceux de l'utilisateur (`~/.claude.json`, `.mcp.json` des repos, plugins), moins une
  liste refusée aux workers (`deniedMcpServers`, `adapter.ts:36`). Blender, Unity, Playwright tournent sur le PC. `confirmed`
- **Historique** : transcripts JSONL lus par `getSessionMessages(id, { dir: cwd })` sur la machine du CLI. `confirmed`
- **Fermeture** : `will-quit` → `manager.killAll()` (`src/main/main.ts:1384`) : fermer l'app tue tous les workers. Aucune
  notification hors de l'app (pas de push téléphone). `confirmed`
- **Mesure locale** (4 `claude.exe` actifs ce jour) : 262 à 328 Mo de mémoire résidente, ~300 Mo en moyenne, ~590 Mo de
  mémoire privée engagée ; à ajouter : les serveurs MCP (node) et surtout les builds/tests lancés par les workers. Le
  SDK annonce lui-même 230–260 Mo pour un processus Claude Code inactif. `confirmed`

### Le point technique qui change tout

Le SDK a une option `spawnClaudeCodeProcess(options) => SpawnedProcess` documentée « pour faire tourner Claude Code
dans des VM, des conteneurs ou des environnements distants » (`sdk.d.ts:2474`), et sa doc parle explicitement de CLI
« over SSH or WSL ». Le hub peut donc lancer `ssh vps claude …` à la place de `claude.exe` **sans rien changer
d'autre** : stdio traverse SSH, et avec lui les outils du hub, les permissions et les événements. `confirmed` (types
lus), `needs_validation` (essai réel).

Limite fondamentale : le flux stdio est la session. Si le PC s'éteint, SSH coupe, le CLI reçoit EOF et s'arrête. Pour
que le travail continue PC fermé, il faut **un relais sur le VPS** qui garde le processus vivant, tamponne ses sorties
et répond pour le hub absent. C'est tout l'enjeu des architectures ci-dessous.

## 1. Évaluation honnête

### 1.1 Ce que ça apporte vraiment

- Le travail lancé continue quand le PC dort ou part dans un sac : c'est le seul vrai gain. Les 1 à 2 h/jour visées
  supposent qu'aujourd'hui des missions s'arrêtent faute de PC allumé (soirée, trajets, nuit). Si le PC est un fixe
  qui peut rester allumé, l'option D1 (0 €) donne presque tout le gain.
- Décharge du PC (RAM, CPU des builds) : vrai mais secondaire : 4 `claude.exe` font ~1,2 Go ; ce sont les builds,
  les installs et Playwright qui pèsent.
- **Ce que ça n'apporte pas : plus de capacité de calcul de l'IA.** Les workers sur abonnement puisent dans les
  mêmes limites (fenêtre de 5 h et plafond hebdomadaire Pro/Max, partagées entre Claude et Claude Code, Agent SDK
  compris). Faire tourner la nuit consomme du quota qui manquera le lendemain. Le plafond hebdomadaire devient la
  vraie limite de « beaucoup de travail ».
- Le maître reste sur le PC dans l'architecture recommandée : PC fermé, les missions en cours vont au bout, aucune
  nouvelle n'est lancée. Le gain est « vider une file de missions préparées », pas « une équipe autonome toute la nuit ».

### 1.2 Ce que ça casse ou complique

| Sujet | Impact | Réponse proposée |
|---|---|---|
| Deux copies de chaque repo | Le VPS a son clone, le PC le sien ; la vérité commune est GitHub | Workers distants toujours en worktree sur une branche à eux ; synchro par push/fetch, jamais de copie de fichiers |
| Qui a la main sur un checkout | Un même dossier ne peut être écrit des deux côtés | Bail par branche dans l'état du hub (3.2) |
| Serveurs de dev, aperçus | `localhost:3000` est sur le VPS | Tunnel `ssh -L` / port Tailscale ouvert à la demande par le hub, URL locale identique |
| Playwright, captures | Un navigateur sans écran marche sur le VPS (headless) ; le MCP Playwright du PC, non | Tests headless côté VPS ; tout pilotage du navigateur du PC = poste « local » |
| `npm run ui` de l'AI Box | Electron sans écran sur Linux : `xvfb-run` nécessaire | Le poste ai-box reste « local » au départ |
| Secrets et comptes | Claude, GitHub, Cloudflare, Supabase, OpenAI à recréer sur le serveur | Minimum : Claude + GitHub ; les déploiements et la prod pro restent au PC (4.4) |
| Conditions d'utilisation | Abonnement personnel, binaire officiel, sa propre connexion : explicitement admis même sur une machine hébergée ; usage « ordinaire et individuel » attendu | Un seul utilisateur, aucun partage ; flotte nocturne non bornée = zone grise : plafonner le nombre de workers distants |
| Latence | Tokens streamés VPS → PC : +20 à 40 ms Francfort/Paris, imperceptible ; l'IA elle-même est bien plus lente | Rien |
| Fiabilité | Nouveau maillon (réseau, VPS) | Ré-attache et journal (3.5) ; les postes locaux n'en dépendent pas |
| Mise à jour | Le CLI et le runner du VPS doivent suivre la version du PC | L'AI Box pousse sa version au runner et refuse un écart de version |
| Coût | VPS 8–20 €/mois | Négligeable devant l'abonnement |

## 2. Architectures comparées

### A. Workers distants, hub local (« runner » sur le VPS)

```
PC (AI Box, inchangée à l'écran)                      VPS (Tailscale uniquement, aucun port public)
┌──────────────────────────────────────┐              ┌───────────────────────────────────────────────┐
│ Electron : UI, maître, hub MCP,      │  tailnet     │ aibox-runner (systemd, utilisateur aibox)      │
│ comptes, git panel                   │  (WireGuard) │  ├─ claude worker-A  cwd ~/repos/x-wt-a        │
│  SessionManager.launch               │◄────────────►│  ├─ claude worker-B  cwd ~/repos/y-wt-b        │
│   └─ spawnClaudeCodeProcess ─────────┼── stdio ────►│  ├─ journal d'événements numérotés par session │
│      (target = vps)                  │  ré-attache  │  └─ file « pour le hub » quand le PC est absent │
│ Postes « local » : claude.exe local  │              │ repos clonés, ~/.claude-<compte>, gh, ntfy     │
│ (Blender, Unity, Playwright, PC)     │              └──────────────────┬────────────────────────────┘
└──────────────────────────────────────┘                                 │ push branches
                         ▲  pull / fetch                                 ▼
                         └──────────────────────── GitHub ◄──────────────┘
```

- **Fonctionnement** : un poste marqué « distant » se lance par `spawnClaudeCodeProcess`, qui ouvre un canal vers le
  runner (SSH par Tailscale, ou WebSocket sur l'IP tailnet). Le runner démarre `claude` avec les mêmes arguments, garde
  le processus vivant, numérote chaque ligne de sortie et l'écrit dans un journal. PC fermé : le canal tombe, le
  runner continue ; il répond lui-même aux appels destinés au hub (voir 3.4) et met en file les rapports au maître.
  PC rouvert : le hub se ré-attache, rejoue les événements depuis le dernier numéro reçu, livre la file au maître.
- **Ce qui change dans le hub** : une cible par lancement (`LaunchSpec.target`) ; `spawnClaudeCodeProcess` pour Claude ;
  traduction des chemins (cwd Windows → chemin VPS) ; `hasConversation`/`history` exécutés côté VPS (via le runner, ou
  l'option `sessionStore` du SDK pour recopier les transcripts) ; worktrees créés sur le VPS (`worktrees.ts` passe par
  un exécuteur git distant) ; panneau git et état des repos en lecture distante ; `killAll` à la fermeture ne tue plus
  que les sessions locales (les distantes sont « détachées ») ; indicateur « sur le VPS / détaché / en file ».
  Nouveau composant : le runner (~600–900 lignes Node, testable seul). Codex et Gemini : même principe plus tard
  (leur MCP HTTP du hub passerait par un tunnel inverse) ; au départ, distant = Claude seulement, le reste masqué.
- **Sécurité** : runner joignable uniquement sur l'interface Tailscale, jeton par session, ACL Tailscale « PC → VPS
  port runner » seulement ; les identifiants Claude et GitHub vivent sur le VPS (voir 4).
- **Coût** : le VPS seul (voir 5), aucun autre service.
- **Effort** : phase 1 (lancement par SSH, PC allumé) 1 jour ; runner avec détache/ré-attache 1 à 2 semaines ; finitions
  (git panel distant, notifications) 1 semaine.
- **Risques** : le runner doit comprendre une partie du protocole stream-json du CLI (requêtes de contrôle :
  permission, appel d'outil MCP du hub) pour répondre en l'absence du hub → couplage aux versions du SDK, à tester à
  chaque mise à jour du CLI ; deux copies des repos ; le maître reste sur le PC : PC fermé, rien de nouveau n'est lancé.

### B. Hub complet sur le VPS, AI Box du PC en client

```
PC                                         VPS
┌───────────────────────────┐   tailnet    ┌──────────────────────────────────────────┐
│ AI Box = interface seule  │◄────────────►│ hub sans tête (Node) : sessions, maître, │
│ (≈90 canaux IPC → réseau) │  WebSocket   │ MCP hub, topics, worktrees, comptes      │
│ mini-hub local : postes   │  authentifié │ workers distants + repos                 │
│ « local » (Blender, Unity)│              └──────────────────────────────────────────┘
└───────────────────────────┘
```

- **Fonctionnement** : le cœur (`SessionManager`, MCP hub, topics, worktrees) tourne en Node sans Electron sur le VPS ;
  l'app du PC n'affiche que l'interface et parle au hub distant. Les postes « local » tournent dans un mini-hub sur le
  PC, rattaché au hub distant comme un nœud. **Le maître vit sur le VPS : PC fermé, il continue d'enchaîner les
  missions.** C'est le seul modèle où le travail ne s'arrête pas au premier rapport.
- **Ce qui change** : `sessions.ts` n'importe pas Electron (`confirmed`), ce qui rend la séparation faisable ; mais il
  faut transporter les ~90 canaux IPC (`src/main/main.ts:254-262`, filtrés aujourd'hui par l'origine de la page) sur un
  canal réseau authentifié, découper `main.ts` (1 400 lignes), dédoubler le hub (distant + mini-hub local, deux
  maîtres ou un maître qui pilote des workers dans deux processus), déplacer la mise à jour, la dictée, les pièces
  jointes, les liens de fichiers, les aperçus. C'est une refonte, et la mise à jour automatique devient double.
- **Sécurité** : plus forte exposition : le hub distant détient tout (comptes, mémoire des sujets, conversations du
  maître) et accepte des commandes réseau ; il faut une authentification de l'app (clé par appareil) en plus de
  Tailscale. Le maître distant lit toutes les conversations, y compris les pro.
- **Coût** : VPS un cran au-dessus (le maître et la mémoire en plus), même ordre de prix.
- **Effort** : 4 à 8 semaines, avec une période où deux architectures coexistent. Risque de régression élevé sur un
  produit poussé sans CI chez tous les utilisateurs.
- **Risques** : refonte lourde ; panne du VPS = plus d'AI Box du tout (sauf mini-hub) ; deux hubs à garder cohérents.

### C. Solution éditeur (cloud Anthropic)

- **Fonctionnement** : déléguer certaines missions à Claude Code sur le web (sessions cloud d'Anthropic sur un repo
  GitHub), ou suivre les sessions locales depuis le téléphone avec Remote Control. Le hub n'héberge rien.
- **Compatibilité avec le hub** : les sessions cloud (VM Anthropic ~4 vCPU / 16 Go, repo GitHub, réseau filtré,
  secrets « réseau » invisibles de la session) se créent en ligne de commande (`claude --cloud "tâche"`, relance par
  `claude -p "msg" --cloud <id> --output-format json`), mais aucune API documentée ne permet d'en suivre le flux. Elles
  ne portent ni le serveur MCP en processus du hub ni la messagerie avec le maître local : pas de `message_master`, pas
  de mémoire des sujets, pas de permissions dans l'app. Les MCP utilisateur (`claude mcp add`) n'y passent pas.
  Remote Control pilote depuis le téléphone une session qui tourne sur la machine : il ne résout pas « PC fermé »
  (il faudrait l'installer sur le VPS, et il exige une connexion claude.ai complète, pas un `setup-token`).
  `needs_validation` : comportement de `--cloud` avec un hub qui l'appelle en boucle.
- **Usage réaliste** : complément, pas architecture : une mission isolée et autonome (« corrige l'issue #12, ouvre une
  PR ») envoyée au cloud d'Anthropic, résultat récupéré par la PR. Effort nul côté code, coût inclus dans l'abonnement
  (`needs_validation` pour les quotas).

### D. Autres options justifiées

- **D1. Garder le PC allumé** (capot fermé sans veille, `powerSaveBlocker` tant qu'un worker travaille, notifications
  téléphone) : 0 €, 1 jour, aucun risque d'architecture. Ne marche pas si le PC part dans un sac. À faire de toute façon :
  c'est aussi le socle des notifications.
- **D2. L'AI Box entière sur le VPS, vue par bureau à distance** (Linux + bureau léger, ou VPS Windows, accès RDP/VNC
  par Tailscale) : zéro ligne de code, mais l'interface passe par une image distante (latence, dictée, liens de
  fichiers), deux AI Box et deux maîtres séparés, et un VPS plus gros (Electron + bureau ≈ +1,5 Go). Utile seulement
  comme test de valeur d'une semaine, pas comme cible.

### Tableau de synthèse

| | A. Runner distant | B. Hub distant | C. Cloud Anthropic | D1. PC allumé |
|---|---|---|---|---|
| PC fermé, travail continue | oui, missions en cours | oui, maître inclus | oui, missions isolées | non (veille) / oui si fixe |
| Même interface | oui | oui (après refonte) | non (PR, web) | oui |
| Postes « local » | même hub, interdiction simple | mini-hub séparé | n/a | n/a |
| Changement du hub | moyen, isolé | refonte | nul | minime |
| Effort | 2–3 sem. (1 jour pour tester) | 4–8 sem. | 0 | 1 jour |
| Coût / mois | VPS 5–20 € | VPS 10–25 € | inclus abonnement | 0 |
| Risque principal | protocole CLI côté runner | régressions, panne unique | pas de hub | aucun |

## 3. Modèle de données et règles

### 3.1 Emplacement par poste (interdiction technique)

```ts
// src/shared/types.ts — TeamRole
/** Where its worker may run. 'local' = this PC only (local MCP: Blender, Unity, the PC's browser, its files). */
placement: 'local' | 'remote-ok' | 'remote';
```

- Défaut `local` pour tout poste existant : rien ne part sur le VPS sans décision explicite.
- Le hub dérive aussi une **contrainte calculée** : un poste dont les dossiers ou les serveurs MCP utilisés (lus par
  `capabilities.ts`) touchent un outil local (blender, unity, playwright MCP, chemins du PC hors repo) est forcé `local`
  et le choix « distant » est grisé avec la raison. Liste de serveurs MCP « locaux » maintenue dans le code, en dur.
- **Barrière dans le lancement, pas dans le prompt** : `SessionManager.launch` refuse une cible `vps` si
  `placement === 'local'` (erreur, pas d'avertissement) ; le runner, de son côté, n'a ni Blender ni Unity installés, et
  reçoit en `deniedMcpServers` toute la liste locale : double verrou. `spawn_worker` du maître hérite de la règle.
- Interface : pastille « PC » / « VPS » sur chaque worker et dans Réglages › Équipe, avec le motif d'un `local` forcé.

### 3.2 Un seul côté écrit dans un repo

- Unité de verrou : la **branche** (pas le repo). Un worker distant travaille toujours dans un worktree du clone VPS,
  sur sa propre branche (`ai-box/<nom>`), comme les instances locales aujourd'hui.
- Le hub tient `leases: { repo, branch, side: 'pc' | 'vps', session }` dans son état. Il refuse : un worktree local
  sur une branche tenue côté VPS, et l'inverse ; un checkout de cette branche par le panneau git.
- `main` n'est jamais écrit par un checkout partagé : on y arrive par `git fetch && git rebase origin/main && git push
  origin HEAD:main`, règle déjà en vigueur. Le rebase échoue proprement s'il y a eu une course : pas de perte.
- À la fermeture d'un worker distant : bail rendu, worktree VPS retiré si poussé (même règle que `retireTree`).

### 3.3 Secrets côté serveur

- Sur le VPS : identifiants Claude (un `setup-token` d'un an, ou une connexion claude.ai si Remote Control est voulu)
  par compte, dans `~aibox/.claude-<compte>` (droits 700) ; un jeton GitHub fine-grained limité aux repos autorisés.
- Jamais sur le VPS : clés service-role Supabase, jetons Cloudflare de déploiement, clés Shopify, `.env` de prod. Les
  missions qui en ont besoin (deploy, migration) sont des postes `local`, ou le worker distant s'arrête au push et le
  maître confie le déploiement à un poste local.
- Le PC n'envoie aucun secret au runner à chaque lancement : les comptes sont installés une fois, par une commande de
  l'AI Box, et désignés ensuite par leur nom.

### 3.4 PC fermé

- Le runner garde les processus ; ce que le hub fait d'habitude, il le fait en mode dégradé :
  - `message_master` / rapport : accepté, mis en file, réponse « rapport enregistré, livré au retour du hub » ;
  - demandes de permission : en attente (le worker bloque) — d'où des postes distants en mode qui n'en pose pas
    (acceptEdits + règles de refus), réglé au lancement ;
  - outils qui exigent le hub (`spawn_worker`, `message_worker`…) : refus explicite « hub hors ligne ».
- Notification téléphone par **ntfy** auto-hébergé sur le VPS (port tailnet seulement) ou Pushover : « worker X a
  fini / est bloqué / a échoué », sans contenu de conversation ni nom de client dans la notification.
- Réouverture : bandeau « pendant votre absence : 3 rapports, 1 blocage », rapports livrés au maître dans l'ordre.

### 3.5 Coupure réseau

- Chaque événement du runner porte un numéro ; le hub mémorise le dernier reçu par session et se ré-attache avec
  `since=N` : rien n'est perdu ni affiché deux fois.
- Messages du PC vers le worker pendant une coupure : gardés dans la file du hub, envoyés à la ré-attache.
- VPS redémarré : le runner relance les sessions avec `resume` (le transcript est sur son disque) ; un tour coupé est
  repris avec `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` (prévu par le CLI, `needs_validation`), sinon signalé « coupé ».
- Indicateur réel dans l'app : « connecté », « détaché (PC fermé) », « VPS injoignable depuis 2 min » — jamais une
  minuterie.

## 4. Sécurité

1. **Réseau** : Tailscale (gratuit en usage perso ; usage professionnel → plan Standard 8 $/utilisateur,
   ou WireGuard à la main). Pare-feu `ufw default deny incoming`, n'autoriser que `tailscale0` (et UDP 41641). Aucun
   port public, pas même 22 : la console du fournisseur sert de secours. ACL Tailscale : seul le PC d'Anil joint le
   VPS, le VPS ne joint pas le PC (sauf tunnel inverse explicite pour les aperçus).
2. **Accès** : Tailscale SSH ou clés ed25519 seulement, `PasswordAuthentication no`, `PermitRootLogin no`, utilisateur
   `aibox` sans sudo pour les workers ; un compte admin distinct pour la maintenance. `unattended-upgrades` actif.
3. **Runner** : écoute sur l'IP tailnet, jeton par session (comme `mcpHub.ts`), comparaison à temps constant ; refuse
   tout binaire autre que le `claude` installé ; arguments en liste, jamais de shell.
4. **Isolation sensible / perso** : un utilisateur Unix par classe (`aibox-perso`, `aibox-pro`) avec HOME,
   comptes Claude, jeton GitHub et repos séparés ; idéalement deux VPS. Données clients pro : hébergeur UE
   soumis au RGPD (OVH, Hetzner) ; **pas Tencent** (groupe soumis au droit chinois) pour ces repos.
5. **Où vivent les jetons** : fichiers 600 dans le HOME de l'utilisateur concerné, jamais dans les logs du runner (il
   masque les variables `*_TOKEN`, `*_KEY`), jamais dans le journal d'événements (il ne stocke que le flux stream-json,
   qui n'en contient pas) ; le PC garde les siens dans `secrets.ts` comme aujourd'hui.
6. **Journalisation** : journal du runner (lancements, ré-attaches, refus) en `journald`, 30 jours ; journal des
   connexions Tailscale. Conversations : transcripts JSONL sur le VPS, chiffrement disque du fournisseur.
7. **Sauvegarde** : rien d'irremplaçable sur le VPS (code sur GitHub, transcripts recopiés côté PC à la ré-attache).
   Pas de snapshot automatique des HOME (ils contiennent des jetons).
8. **Destruction** : révoquer les jetons (GitHub, `setup-token` Claude, nœud Tailscale), puis supprimer le serveur et
   ses snapshots chez le fournisseur ; procédure écrite avant la mise en service.

## 5. Recommandation

**Architecture A**, précédée de D1. Elle garde le hub, l'interface, le maître et les postes locaux exactement là où ils
sont, ajoute un seul composant isolé (le runner) et s'appuie sur une option prévue par le SDK. B apporte un maître
autonome la nuit mais coûte une refonte d'un produit livré sans CI ; à reconsidérer seulement si, après A, le manque
du maître PC fermé est mesuré comme le vrai frein. C sert de complément ponctuel (missions « une PR, sans rapport »).

**VPS** :
- Démarrage : le Tencent Lighthouse 2 vCPU / 2 Go de Francfort **suffit pour la phase 1** (1 worker, repo perso, pas
  de gros build) ; pas au-delà : Anthropic recommande 4 Go minimum, et 2 Go tiennent ~3 CLI sans build ni install.
  Pas de repo pro dessus.
- Cible : 4 vCPU / 8 Go en UE (≈ 4 à 6 workers avec builds) : **OVH VPS-2** (~8,50 $/mois, France, opérateur
  français : le plus simple pour les données pro) ou Hetzner CX33 (8,99 €/mois, actuellement souvent
  indisponible). 8 vCPU / 16 Go (Hetzner CX43 16,49 €, OVH VPS-4 ~23 $) si plus de 6 workers ou des builds Next.js
  en parallèle. Les prix sont à confirmer dans la console le jour de la commande (`needs_validation`).

**Plan** :
1. **Phase 1 — un jour, sans runner, PC allumé** : branche locale ; Tailscale sur le PC et le Tencent ; `claude` + git
   + un `setup-token` sur le VPS ; dans l'adaptateur Claude, `spawnClaudeCodeProcess` qui lance `ssh vps claude …`
   pour un seul poste de test, cwd traduit. Mesures : la mission va au bout, `message_master`, permissions et
   historique marchent, RAM par worker, coupure Wi-Fi volontaire (on attend : session perdue, à corriger en phase 2).
2. **Phase 2 — 2 semaines** : runner systemd avec journal numéroté, détache/ré-attache, file hors ligne, `placement`
   par poste avec refus au lancement, baux de branches, worktrees VPS, indicateurs réels, ntfy. VPS UE 4/8.
3. **Phase 3 — 1 à 2 semaines** : tunnels pour les serveurs de dev, panneau git distant, utilisateur séparé pour
   pro, Codex/Gemini distants si utiles, procédure de rotation et de destruction, notes de version.

**Critères de succès** : (1) une mission lancée, PC fermé 2 h, retrouvée finie avec son rapport au maître à la
réouverture, sans perte ni doublon ; (2) aucun poste `local` lançable sur le VPS, vérifié par test ; (3) coupure réseau
de 5 min sans perte d'événement ; (4) aucun port public sur le VPS (scan externe vide) ; (5) au moins 1 h/jour de
missions terminées hors présence, mesurée sur 2 semaines ; (6) aucun jeton dans les logs (grep).

**Les trois risques principaux** : (1) le runner doit parler une partie du protocole interne du CLI pour remplacer le
hub absent : à chaque mise à jour de Claude Code, un test de bout en bout ; (2) le quota de l'abonnement, pas le VPS,
borne le gain, et un usage massif sans surveillance frôle la limite « usage ordinaire individuel » des conditions ;
(3) un VPS qui détient des jetons GitHub et Claude devient une cible : Tailscale seul, aucun secret de prod, et une
séparation stricte pro / perso.

## Sources (consultées le 2026-11-09)

- Conditions, OAuth et Agent SDK : https://code.claude.com/docs/en/legal-and-compliance ,
  https://code.claude.com/docs/en/agent-sdk/overview , https://www.anthropic.com/legal/consumer-terms
- Limites des abonnements : https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan
- `setup-token` (un an, requêtes modèle seulement) : https://code.claude.com/docs/en/authentication
- Sessions cloud : https://code.claude.com/docs/en/claude-code-on-the-web , https://code.claude.com/docs/en/cloud-environments
- Remote Control : https://code.claude.com/docs/en/remote-control ; tâches planifiées : https://code.claude.com/docs/en/routines
- Prérequis (4 Go+) : https://code.claude.com/docs/en/setup ; retour terrain VPS : https://www.virtua.cloud/learn/en/tutorials/run-claude-code-vps
- Tailscale : https://tailscale.com/pricing
- Prix : https://www.hetzner.com/cloud/cost-optimized/ , https://www.ovhcloud.com/en/vps/ ,
  https://www.tencentcloud.com/document/product/1103/47794
- Notifications : https://ntfy.sh/ , https://pushover.net/pricing
- SDK local : `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (`spawnClaudeCodeProcess`, `SpawnedProcess`, `sessionStore`)
