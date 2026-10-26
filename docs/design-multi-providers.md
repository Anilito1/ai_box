# Conception : un hub agnostique du fournisseur d'IA

Statut : proposition, **rien n'est implémenté**. Auteur : worker `hub-providers-design`, 2026-10-26.
Branche de départ : `feature/multi-comptes`. Versions mesurées : Claude Code 2.1.287, Agent SDK 0.3.308, `codex-cli` 0.163.0.

Ce qui est **vérifié** (commande lancée, sonde exécutée, code lu) est séparé de ce qui est **supposé** ou rapporté par des sources secondaires. Les sondes sont listées en [annexe A](#annexe-a--sondes-exécutées).

---

## 1. État des lieux

### 1.1 Ce que contient déjà `feature/multi-comptes`

La branche n'a **aucun commit d'avance sur `main`** : tout le travail est dans l'arbre de travail non commité (16 fichiers modifiés, 8 nouveaux, ~1 050 lignes ajoutées). `tsc --noEmit` passe et les 92 tests passent. Recommandation : le commiter (en 2 ou 3 commits) avant la phase 1, il n'est protégé par rien.

Il apporte les « comptes » **à l'intérieur de l'harnais Claude Code** :

| Élément | Fichier | Rôle |
|---|---|---|
| `Account` (`claude` / `anthropic-key` / `openai`), `ACCOUNT_KINDS`, `AccountStatus`, `AccountBadge` | `src/shared/types.ts`, `src/shared/accounts.ts` | modèle et validation (nom unique, `default` réservé, 20 comptes max) |
| Compte `claude` = dossier `CLAUDE_CONFIG_DIR` par compte, liens symboliques vers le dossier de l'utilisateur (projects, settings, skills…) sauf login | `src/main/accounts.ts` | plusieurs abonnements Claude, conversations partagées |
| Compte `openai` = **pont** Anthropic Messages → Chat Completions sur `127.0.0.1`, jeton par exécution | `src/main/bridge.ts`, `bridgeFormat.ts` | OpenAI et serveurs compatibles (OpenRouter, DeepSeek-chat, LM Studio, Ollama), via Claude Code |
| Secrets `account:<id>` chiffrés `safeStorage` | `src/main/secrets.ts` | clés API (Keychain macOS pour la clé de chiffrement) |
| `masterAccount`, `workerAccount`, `TeamRole.account`, `Session.accountId/runAccount/switchPending/userAccount` | `config.ts`, `team.ts`, `sessions.ts` | choix par session, par poste, par défaut |
| `setAccount` / `relaunch` / `switchIfDone` : bascule d'un compte à l'autre avec **la même conversation** (Claude→Claude), au repos ou après le tour | `sessions.ts` | précurseur du repli |
| Limites 5 h / 7 j **par compte** (`rateLimits: Map`) | `sessions.ts` | |
| Outil `account` de `spawn_worker` / `message_worker`, texte « Comptes » du prompt du maître | `sessions.ts`, `prompts.ts` | |
| Section Réglages › Comptes (liste, état, connexion, édition, suppression) ; login via terminal avec `env` | `renderer/setup.ts`, `main.ts`, `terminal.ts` | |

Ce que la branche **ne fait pas** : aucun autre harnais que Claude Code (Codex impossible), pas de modèle/fournisseur par worker au-delà du compte, pas de repli, `runsClaude(kind)` est le seul embryon d'abstraction (`kind !== 'openai'`).

### 1.2 Où le code est couplé à `claude`

Tout passe par `@anthropic-ai/claude-agent-sdk` (`query()`), importé dans **deux fichiers seulement** (`sessions.ts`, `claude.ts`). Mais `sessions.ts` (2 991 lignes) mélange logique du hub et protocole Claude :

| Couplage | Où (≈ lignes de `sessions.ts`) | Détail |
|---|---|---|
| Lancement | `start()` ~932-1026 | `Options` du SDK : `cwd`, `model`, `effort`, `permissionMode`, `systemPrompt: {preset:'claude_code', append}`, `extraArgs: {name, 'replay-user-messages'}`, `disallowedTools`, `allowedTools`, `pathToClaudeCodeExecutable`, `env` |
| Entrée | classe `Inbox` ~99-128 | `AsyncIterable<SDKUserMessage>` : mode streaming-input, file de messages poussés |
| Flux sortant | `consume()` / `onMessage()` ~1028-1270 | `SDKMessage` : `system/init`, `compact_boundary`, `api_retry`, `task_*`, `stream_event` (deltas), `assistant` (blocs Anthropic), `user` (replay, `origin.kind === 'peer'`), `result` (coût, `modelUsage`), `rate_limit_event` |
| Permissions | `askPermission` ~1424, `answerElicitation` ~1468 | callbacks `canUseTool` / `onElicitation`, `PermissionUpdate` suggérées, modes `default/acceptEdits/plan/auto/bypassPermissions/dontAsk` |
| MCP du hub | `hubServer()` ~1863-2012 | `createSdkMcpServer` **en processus** (`tool()` + zod) : 12 outils fermés sur `this` et sur la session `s` |
| Reprise | `start()`, `readHistory()` ~1590 | `getSessionInfo`, `getSessionMessages` (transcripts disque de Claude), `sessionId` choisi par le hub |
| Modèles / effort | `modelOptions`, `applyModel`, `onReady` | `initializationResult().models`, alias `opus/sonnet`, `[1m]` ; `Effort = low…max` ; `team.ts` (`capEffort`, `resolveChoice`) |
| Contexte / usage | `refreshContext`, `refreshUsage`, `usageTotals` | `getContextUsage`, `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` (limites 5 h/7 j, coût cumulé) |
| Commandes « / » | `commands()`, `shared/slash.ts` | commandes et skills du CLI ; seuls `compact/clear/model/effort/mode/cost/help` sont du hub |
| Coût | `countTurn`, `shared/costs.ts` | `total_cost_usd` + `modelUsage` : suppose des **USD** et des modèles Claude |
| Statut / connexion | `claude.ts` | `accountInfo()`, détection de l'exécutable, `claude auth login` |
| Erreurs | `errors.ts`, `assistantError` | codes `SDKAssistantMessageError` |
| Messages entre sessions | `OUTGOING`, `peer`, `prompts.ts` | `SendMessage` natif de Claude Code (voir 1.3) |
| Transcript | `transcript.ts` (`blocksOf`, `assistantItems`) | blocs de contenu Anthropic (`text`, `tool_use`, `tool_result`, `thinking`) → `ChatItem` |
| Build | `build.mjs` | SDK en `external`, binaire Claude résolu à l'exécution |

Ce qui est **déjà indépendant** et à garder tel quel : `ChatItem`, worktrees, postes/rôles, sujets (`topics`), nettoyage des sessions inactives, passation des postes permanents (`handoffRequest`/`handoffBlock`), journal de coûts (hors hypothèse USD), toute l'UI.

### 1.3 Couplages dans `prompts.ts` et dans les types

- `prompts.ts` : « sessions **Claude Code** » dans le prompt du maître (l.222, 277) ; **`SendMessage`** cité aux l.20, 252, 307, 360, 362, 380, 382, 425, 438 (prompts maître, worker, instance). Un worker non-Claude n'a pas cet outil : le texte doit dépendre du fournisseur.
- `rosterKey`/`allowedText` : `workerModels` (`opus, sonnet`) et `workerMaxEffort` sont globaux et ne valent que pour Claude.
- `shared/types.ts` : `Effort` (`low…max`), `Mode` (modes de permission Claude), `Provider = 'claude-code' | 'api-key'` (réglage « Claude »), `ModelOption`, `RateLimits {fiveHourPct, sevenDayPct…}` (forme Claude), `AccountKind`, `SessionView.account`, `TeamRole.model` (texte libre validé par `MODEL`), `Persisted.sessionId` (un seul identifiant de conversation, fourni par le hub), `ClaudeStatus`.
- `shared/costs.ts` : `Usage.cost` en USD, noms de modèles Claude (`modelName`).

---

## 2. Capacités réelles des CLI

### 2.1 Machine d'essai

Installés : `claude` 2.1.287, `codex` 0.163.0 (connecté « Logged in using ChatGPT », plan *business*). **Absents** : `gemini`, `opencode`, `qwen`, `deepseek`, `kimi`, `aider`, `goose`, `amp`, `ollama`. Rien d'autre n'a donc pu être vérifié localement.

### 2.2 Codex (OpenAI)

**Connexion par compte ChatGPT : confirmée possible, sans clé API.**
`codex login` (navigateur par défaut ; `--device-auth` ; `--with-api-key` et `--with-access-token` existent mais ne servent pas ici), `codex login status` → `Logged in using ChatGPT`, `codex logout`. Les identifiants sont dans `$CODEX_HOME/auth.json` (`~/.codex` par défaut ; le binaire contient `cli_auth_credentials_store = "file"` et un mode trousseau). `CODEX_HOME` isole un compte, comme `CLAUDE_CONFIG_DIR` : `--ignore-user-config` précise « auth still uses `CODEX_HOME` ».

**Trois interfaces programmables :**

1. `codex exec --json [resume <id>]` : un tour par processus, événements JSONL. Sonde réelle :
   ```
   {"type":"thread.started","thread_id":"01a1787d-…"}
   {"type":"turn.started"}
   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}
   {"type":"turn.completed","usage":{"input_tokens":18602,"cached_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}
   ```
   Options utiles : `-m`, `-s read-only|workspace-write|danger-full-access`, `-C`, `--add-dir`, `--ephemeral`, `--output-schema`, `-c clé=valeur`. **Pas** d'approbation interactive, pas d'envoi en cours de tour, interruption = tuer le processus. Utilisable en mode dégradé seulement.
2. **`codex app-server`** (`--listen stdio://`, JSONL, une requête `{id, method, params}` par ligne ; `initialize` puis notification `initialized`). C'est l'interface de la vraie intégration. `codex app-server generate-ts|generate-json-schema [--experimental]` produit le protocole **exact de la version installée** (96 fichiers + 652 types v2 générés pour 0.163.0). La doc OpenAI le dit « experimental and aren't supported for production workloads ».
3. `codex mcp` : Codex en client MCP uniquement (voir 2.2.2) ; le mode serveur MCP n'est pas utile ici.

#### 2.2.1 Protocole app-server (extraits vérifiés dans les types générés)

| Besoin du hub | Requête / notification |
|---|---|
| Lancer / reprendre | `thread/start {model, cwd, approvalPolicy, sandbox, config, baseInstructions, developerInstructions, ephemeral, dynamicTools*}`, `thread/resume {threadId…}`, `thread/fork` |
| Message | `turn/start {threadId, input:[{type:'text'\|'image'\|'localImage'…}], model, effort, cwd, approvalPolicy, sandboxPolicy, outputSchema}` ; **`turn/steer {expectedTurnId, input}`** pour écrire en cours de tour |
| Interrompre | `turn/interrupt {threadId, turnId}` |
| Compacter | `thread/compact/start` (équivalent de `/compact`) |
| Flux | `item/started`, `item/completed` (types : `userMessage`, `agentMessage`, `reasoning`, `commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall`, `webSearch`, `plan`, `contextCompaction`…), `item/agentMessage/delta`, `item/reasoning/*Delta`, `item/commandExecution/outputDelta`, `turn/started`, `turn/completed {status: completed\|interrupted\|failed}`, `thread/status/changed` |
| Approbations (requêtes **du serveur vers le client**, réponse `{decision}`) | `item/commandExecution/requestApproval` (`accept`, `acceptForSession`, `decline`, `cancel`, amendements execpolicy), `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request` |
| Politiques | `approvalPolicy`: `untrusted`, `on-request`, `granular{…}`, `never` ; `sandbox`: `read-only`, `workspace-write`, `danger-full-access` ; `approvalsReviewer`: `user`, `auto_review`, `guardian_subagent` |
| Modèles | `model/list` → `{id, supportedReasoningEfforts[], defaultReasoningEffort, inputModalities, isDefault}` |
| Compte | `account/read`, `account/login/start` (`chatgpt`, `chatgptDeviceCode`, `apiKey`…), `account/logout`, notification `account/updated` |
| Limites | `account/rateLimits/read`, notification `account/rateLimits/updated` (voir 2.2.3) |
| Contexte | `thread/tokenUsage/updated {total, last, modelContextWindow}` |
| Historique | `thread/read`, `thread/turns/list`, `thread/items/list` |
| MCP | `mcpServerStatus/list`, `config/mcpServer/reload`, notification `mcpServer/startupStatus/updated` |
| Erreurs | notification `error {error:{message, codexErrorInfo}, willRetry, threadId, turnId}` |

`*dynamicTools` n'existe qu'avec `--experimental` : le hub pourrait déclarer ses outils directement et recevoir `item/tool/call` (requête serveur), sans serveur MCP HTTP. Non testé, expérimental : écarté (voir 3.3).

**Efforts mesurés** (`model/list`) : `gpt-6.1-sol`, `gpt-6-sol`, `gpt-5.6-sol` : `low/medium/high/xhigh/max/ultra` ; `gpt-6-luna`, `gpt-5.6-luna` : `low…max`. `Effort` du hub (`low…max`) se projette directement ; `ultra` n'existe pas côté hub. Les niveaux dépendent du **modèle** : la liste doit venir de l'adaptateur.

#### 2.2.2 MCP : les workers Codex peuvent utiliser les outils du hub (vérifié de bout en bout)

Le serveur MCP du hub est aujourd'hui **en processus** (`createSdkMcpServer`) : inaccessible à Codex. Sonde `mcp-e2e` : serveur MCP *streamable HTTP* sur `127.0.0.1:<port>`, jeton `Bearer` aléatoire, un outil `ping` ; `thread/start` avec

```
config: { 'mcp_servers.hub.url': '<url>', 'mcp_servers.hub.bearer_token_env_var': 'HUB_TOKEN',
          'mcp_servers.hub.default_tools_approval_mode': 'approve' }
```

et `HUB_TOKEN` dans l'environnement du processus app-server. Résultat : `mcpServer/startupStatus` du serveur `hub` → `ready`, `item/started mcpToolCall {server:'hub', tool:'ping'}` → `completed`, le modèle a répondu exactement le mot secret, **1 appel reçu, 0 refus d'authentification**.

Piège trouvé : sans `default_tools_approval_mode = 'approve'` et avec `approvalPolicy: 'never'`, l'appel échoue (`MCP tool call requires approval, but approval policy is never`) : il faut approuver les outils du hub explicitement (ils sont déjà « autorisés » côté Claude via `allowedTools`).

Autre constat : **les serveurs MCP personnels de `~/.codex/config.toml` se chargent aussi** (`node_repl`, `google-apps-script`, `cua_repl`, `codex_apps`…) : démarrage plus lent et ~18 600 tokens d'entrée pour répondre « OK ». Un `CODEX_HOME` dédié au hub (config minimale écrite par le hub) règle cela ; c'est un point de spike (3.2).

#### 2.2.3 Limites et quota (vérifié)

- `account/rateLimits/read` sur ce compte *business* : `primary: null`, `secondary: null`, mais `individualLimit {limit:"4000", used:"222.3", remainingPercent:94, resetsAt:<epoch>}`, `credits {hasCredits:true, unlimited:false}`, `spendControlReached:false`, `rateLimitReachedType:null`, `ordinaryUsageAllowed:null`. La **forme varie selon le plan** (fenêtres `primary/secondary` avec `usedPercent`, `windowDurationMins`, `resetsAt` pour Plus/Pro ; crédits/plafond pour les plans entreprise). Il ne faut donc pas modéliser « 5 h / 7 j » en dur.
- `RateLimitReachedType` : `rate_limit_reached`, `workspace_owner_credits_depleted`, `workspace_member_credits_depleted`, `workspace_owner_usage_limit_reached`, `workspace_member_usage_limit_reached`.
- Erreurs en cours de tour : `CodexErrorInfo` ∈ `usageLimitExceeded`, `rateLimitExceeded`, `serverOverloaded`, `unauthorized`, `contextWindowExceeded`, `sessionBudgetExceeded`, `httpConnectionFailed{httpStatusCode}`… avec `willRetry`.
- Les notifications `account/rateLimits/updated` arrivent pendant les tours (3 reçues dans la sonde).

#### 2.2.4 Ce qui manque à un worker Codex (par rapport à Claude Code)

| Absent côté Codex | Remède |
|---|---|
| **`SendMessage`** (messages worker↔worker, worker→maître) | outil hub `send_message` (même HTTP MCP) ; `message_master` existe déjà pour les workers |
| Instructions « Claude Code » (`systemPrompt preset`, CLAUDE.md) | `developerInstructions`/`baseInstructions` à `thread/start` ; Codex lit `AGENTS.md` |
| Commandes « / » et skills du CLI Claude | seules les commandes du hub (`/compact` → `thread/compact/start`, `/model`, `/effort`, `/mode`, `/cost`, `/clear`, `/help`) ; liste de commandes du CLI vide |
| Hooks Claude de l'utilisateur, `settings.json` | Codex a ses propres hooks/config ; le hub **n'utilise aucun hook** (grep vide) : pas de régression pour lui, mais ceux de l'utilisateur ne s'appliquent pas |
| Sous-agents `Task`, tâches de fond, `AskUserQuestion` | `collabAgentToolCall`/`subAgentActivity` existent côté Codex ; à mapper plus tard, non bloquant |
| Coût en USD | **uniquement des tokens** (`thread/tokenUsage/updated`, `turn.completed.usage`) ; un abonnement n'a pas de prix par token |
| Contexte `[1m]`, alias `opus/sonnet` | catalogue `model/list` |
| `effort` identique | existe (`turn/start.effort`) mais liste par modèle |
| `permissionMode` | à traduire en `approvalPolicy` + `sandbox` (4.4) |
| `disallowedTools: Edit/Write` (worker en lecture seule) | `sandbox: 'read-only'` |
| Reprise par identifiant choisi par le hub | l'identifiant (`threadId`) est **attribué par Codex** : le hub le stocke |
| Lecture du transcript par le hub | `thread/read` / `thread/turns/list` ; ou le hub garde ses propres `ChatItem` |

Non testé (à faire en spike, phase 2) : flux d'approbation réel d'une commande/édition, `turn/interrupt`, `turn/steer`, `thread/resume` après redémarrage du processus, `account/login/start`, Windows.

### 2.3 DeepSeek

- **Pas de CLI officiel DeepSeek** à ce jour (recherche web, sources secondaires : `DeepSeek-TUI` est un projet communautaire non affilié). Non installé ici, non vérifié.
- **Endpoint compatible Anthropic officiel** `https://api.deepseek.com/anthropic` (doc DeepSeek, lue) : Claude Code fonctionne avec `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_MODEL`. Noms `claude-opus*` → `deepseek-v4-pro`, `claude-sonnet*`/`claude-haiku*` → modèle flash. Pris en charge : streaming, `system`, outils et `tool_choice`, `thinking` (`budget_tokens` ignoré), images, `output_config.effort`. **Ignorés** : `mcp_servers`, `cache_control`, `top_k`, `container` ; non pris en charge : blocs `document`, `redacted_thinking`, `mcp_tool_use/result`. Le MCP *côté client* de Claude Code reste de toute façon opérationnel (les outils du hub arrivent comme des outils ordinaires).
- Conséquence importante : **DeepSeek se branche sans pont ni adaptateur**, avec l'harnais Claude Code et donc `SendMessage`, MCP du hub, permissions et commandes. Le pont `openai` de la branche reste utile pour OpenAI par clé API, OpenRouter, serveurs locaux.
- Les noms de modèles exacts doivent être lus via `GET /models` à l'exécution (les sources divergent entre `deepseek-v4-flash` et `deepseek-flash`).
- Codex ne peut **pas** servir de harnais pour ces API : la chaîne `` `wire_api = "chat"` is no longer supported `` est dans le binaire (seul `responses` est accepté).

### 2.4 Autres

Gemini CLI : d'après des sources secondaires, mode headless `--output-format stream-json` (événements `init`, `message`, `tool_use`, `tool_result`, `error`, `result`), `--resume`, MCP. **Non installé, non vérifié.** Les autres CLI (opencode, qwen…) ne sont pas étudiés. L'interface proposée (3.1) les accueillerait ; pas dans le périmètre.

### 2.5 Synthèse

| | Claude Code | Codex app-server | DeepSeek (via Claude Code) |
|---|---|---|---|
| Flux bidirectionnel JSON | oui (SDK) | oui (JSONL, expérimental) | idem Claude |
| Reprise | `resume`, id choisi par le hub | `thread/resume`, id attribué | idem Claude |
| Interruption / message en cours de tour | `interrupt()` / file `Inbox` | `turn/interrupt` / `turn/steer` (non testés) | idem Claude |
| MCP du hub | en processus (SDK) | HTTP + jeton (**vérifié**) | idem Claude |
| Approbations | `canUseTool` | requêtes serveur + politiques | idem Claude |
| Effort | `effort` | `effort` par modèle | `output_config.effort` |
| Coût USD | oui | non (tokens) | à calculer |
| Limites | `rate_limit_event`, API usage | `account/rateLimits/*`, `error` | erreurs HTTP |
| Messages entre sessions | `SendMessage` | **non** → outil hub | `SendMessage` |
| Login | `claude auth login` (terminal) | `codex login` (terminal ou `account/login/start`) | clé API (safeStorage) |

---

## 3. Architecture proposée

### 3.1 Fournisseur = harnais × backend

Deux niveaux, qui évitent de tout réécrire :

- **Harnais** (le programme qui fait tourner l'agent) : `claude` (Claude Code via SDK) ou `codex` (app-server). Un adaptateur par harnais.
- **Backend** (qui fournit le modèle) : pour `claude` : Anthropic (abonnement ou clé), Anthropic-compatible (DeepSeek…), pont OpenAI (déjà fait). Pour `codex` : compte ChatGPT.

Un **compte** (`Account`) = harnais + backend + identifiants. Un worker / poste = `{account, model, effort}`. Le fournisseur affiché à l'utilisateur est le compte.

### 3.2 Interface d'adaptateur

Nouveau dossier `src/main/providers/`. `SessionManager` ne connaît plus que ces types (esquisse, à affiner en phase 1) :

```ts
type HarnessId = 'claude' | 'codex';

interface Capabilities {
  steer: boolean;            // message en cours de tour
  nativePeerMessages: boolean; // SendMessage natif
  cliCommands: boolean;      // commandes/skills du CLI
  costUsd: boolean;          // sinon tokens seulement
  efforts: Effort[];         // par modèle, voir ModelInfo
  resumeById: boolean;       // le hub choisit l'id (Claude) ou le reçoit (Codex)
}

interface ProviderAdapter {
  readonly harness: HarnessId;
  capabilities(account: Account): Capabilities;
  auth: {                    // état, connexion, déconnexion : le CLI garde les jetons
    status(account: Account): Promise<AccountStatus>;
    login(account: Account): TerminalCommand;   // ouvert dans un terminal, comme aujourd'hui
    logout(account: Account): Promise<void>;
  };
  models(account: Account): Promise<ModelInfo[]>;   // {id, label, efforts[], contextWindow?}
  limits(account: Account): Promise<LimitSnapshot | null>;
  start(spec: LaunchSpec): AgentProcess;
}

interface LaunchSpec {
  session: { id: string; name: string; cwd: string; extraDirs: string[]; readOnly: boolean };
  conversation: ConversationRef | null;   // reprise : { harness, account, id }
  model: string; effort: Effort | null; mode: Mode | null;
  instructions: string;                   // prompt rendu par prompts.ts pour ce harnais
  tools: HubTool[];                       // outils du hub, neutres
  env: Record<string, string>;
}

interface AgentProcess {
  events: AsyncIterable<AgentEvent>;
  send(prompt: Prompt): void;
  interrupt(): Promise<void>;
  respond(requestId: string, decision: PermissionDecision | null): void;
  compact(instructions: string): Promise<void>;
  setModel(m: string): Promise<void>; setEffort(e: Effort): Promise<void>; setMode(m: Mode): Promise<void>;
  context(): Promise<{ tokens: number; size: number } | null>;
  history(): Promise<ChatItem[]>;         // reprise : relit la conversation du harnais
  close(): void;
}
```

`AgentEvent` (normalisé, tout ce que `onMessage` lit aujourd'hui) :

`ready {models, commands}` · `conversation {id, model, effort, mode}` · `text.delta` · `item {ChatItem}` (assistant / thinking / tool, résultats compris) · `permission {id, tool, summary, detail, canAlways}` · `peer {from, text}` · `status {compacting, retrying, background[], agents}` · `turn.done {ok, interrupted, text, usage: Usage, context}` · `limit {signal: LimitSignal}` · `error {code, message}`.

Le coût devient `Usage {tokens…, costUsd: number | null}` : le journal de coûts accepte `null` (Codex) et l'UI affiche des tokens.

`LimitSignal {account, kind: 'rate' | 'quota' | 'overloaded' | 'auth', resetsAt?: number, hard: boolean, source}` est le **contrat du repli** (4.5). Chaque adaptateur traduit ses signaux dedans.

Principe : **toute la logique du hub reste dans `SessionManager`** (sujets, worktrees, postes, passation, coûts, nettoyage). L'adaptateur Claude est le code de `start/consume/onMessage/onReady/refresh*/askPermission` déplacé, sans changement de comportement.

### 3.3 Outils du hub : neutres, exposés par un serveur MCP HTTP local

- `hubServer()` devient `hubTools(session): HubTool[]` (`{name, description, schema zod, handler}`), sans dépendance au SDK.
- Adaptateur Claude : enveloppe `tool()` + `createSdkMcpServer` (inchangé).
- Adaptateur Codex : **un serveur MCP streamable-HTTP unique sur `127.0.0.1`**, un jeton `Bearer` par session et par lancement (le jeton identifie la session, donc les outils restent fermés sur elle), passé via `bearer_token_env_var` ; `default_tools_approval_mode = 'approve'`. Même schéma de sécurité que le pont existant (loopback, jeton d'exécution, comparaison à temps constant). Dépendance : `@modelcontextprotocol/sdk` (déjà présent en 1.32.1 comme transitive du SDK Claude, à déclarer en direct ; la sonde a tourné avec zod 4).
- Outil `send_message(to, message)` ajouté pour les harnais sans `SendMessage` ; les prompts le citent selon `capabilities.nativePeerMessages`.
- Alternative écartée : `dynamicTools` de l'app-server (expérimental, non testé, spécifique à Codex).

### 3.4 Comptes, authentification, secrets

- **Les jetons des abonnements ne sont jamais lus par le hub** (règle déjà documentée dans le README pour Claude). Claude : `claude auth login` dans un terminal avec `CLAUDE_CONFIG_DIR` du compte (existant). Codex : `codex login` (ou `--device-auth`) dans un terminal avec `CODEX_HOME=<données>/accounts/<id>` ; état par `account/read` (+ `rateLimits/read`) via un app-server éphémère ; déconnexion `codex logout` puis suppression du dossier. Le hub ne copie jamais `auth.json`.
- Compte Codex « habituel » : option de réutiliser `~/.codex` (comme `default` pour Claude). Mais ses MCP personnels se chargent (2.2.2) : par défaut, `CODEX_HOME` dédié avec une `config.toml` écrite par le hub, sans les serveurs de l'utilisateur.
- Clés API (Anthropic, pont OpenAI, Anthropic-compatible) : `safeStorage` comme aujourd'hui (`account:<id>` dans `secrets.json`, chiffré avec une clé gardée par le **Keychain macOS** ; DPAPI sur Windows, libsecret sur Linux). Jamais en clair ; refus de stocker si `safeStorage` indisponible (déjà le cas).
- `Account` évolue : `kind: 'claude' | 'anthropic-key' | 'openai' | 'anthropic-compatible' | 'codex'` ; `harness` et `auth` en découlent (`login: 'terminal' | 'key'`). Nouveaux champs : `baseUrl`, `model(s)` pour `anthropic-compatible` ; rien pour `codex` (le modèle se choisit par worker, catalogue `model/list`).

### 3.5 Modèle de données worker / poste

- `TeamRole {account, model, effort}` existe presque (`account` et `model` ajoutés/présents). Changements : `model` n'est plus une chaîne libre validée par `MODEL` mais **validé contre le catalogue de son compte** ; `effort` validé contre les efforts du modèle.
- `cfg.workerModels` / `workerMaxEffort` (globaux, Claude) deviennent des **règles par compte** (`Account.allowedModels`, `Account.maxEffort`), avec migration depuis les valeurs actuelles pour le compte `default`.
- `Session` : `accountId` (choix), `runAccount` (en cours) existent. Ajout : `convs: Record<accountId, ConversationRef>` (une conversation par compte : permet de revenir à l'ancienne, 4.5), remplaçant `sessionId` unique (migration : `convs[default] = {harness:'claude', id: sessionId}`) ; `home: accountId` (cible d'origine) ; `fallback: {from, reason, since, resetsAt} | null`. `state.json` migré à la lecture.
- Outils du maître : `spawn_worker`/`message_worker` gardent `account`, `model`, `effort`, validés contre le catalogue ; le prompt du maître reçoit un tableau « compte → modèles → efforts » plutôt que `workerModels`.

### 3.6 Interface

- **Réglages › Comptes** (existe) : ajouter les types « Codex (ChatGPT) » et « Compatible Anthropic (DeepSeek…) » ; par ligne : pastille d'état, identité (e-mail · plan), jauge de limite (générale, pas « 5 h/7 j » en dur), boutons **Se connecter** (ouvre le terminal), **Se déconnecter**, **Vérifier**, **Supprimer** ; pour un compte en cooldown : « limite atteinte jusqu'à 17:40 ».
- **Par poste** (éditeur d'équipe) et **par worker** (en-tête de session / menu modèle du composeur) : liste de comptes puis modèles du compte (groupés), puis effort filtré par le modèle.
- **Réglages › Sessions** : éditeur de **chaîne de repli** (liste ordonnée de `{compte, modèle?, effort?}`, case « facturé au token : confirmer »), politique de retour, option de bascule préventive.
- Badges « en repli sur Codex » dans la barre latérale ; notices dans la conversation.
- i18n FR/EN dans les deux fichiers existants (`main/i18n.ts`, `renderer/i18n.ts`).

### 3.7 Mécanisme de repli (phase 4, prévu dès la phase 1)

**Détection.** Chaque adaptateur émet `limit {LimitSignal}` :

| Source | Signal | Dur / transitoire |
|---|---|---|
| Claude | `rate_limit_event.rate_limit_info.status === 'rejected'` (`rateLimitType`, `resetsAt`, `overageStatus`) ; `assistant.error ∈ {rate_limit, billing_error}` ; `overloaded` | dur si `resetsAt` − maintenant > seuil (2 min) ; sinon le CLI réessaie seul (aujourd'hui `retrying`) |
| Codex | `error.codexErrorInfo ∈ {usageLimitExceeded, rateLimitExceeded}` avec `willRetry: false` ; `account/rateLimits/updated.rateLimitReachedType` non nul ; `ordinaryUsageAllowed === false` | dur ; `serverOverloaded` = transitoire |
| Pont / API | HTTP 429 (`rate`) ; `insufficient_quota` / 402 (`quota`, déjà distingué dans `bridge.ts`) | quota = dur |

Un `LimitTracker` tient un **cooldown par compte** (`limitedUntil`, issu de `resetsAt` sinon sonde périodique) ; il alimente aussi l'UI. Bascule préventive optionnelle à X % d'utilisation (réglage, désactivé par défaut).

**Choix de la cible.** Chaîne configurable (globale, surchargeable par poste) : premier compte non limité, autorisé (les étapes facturées au token demandent un consentement explicite), dont le modèle équivalent existe (`ChainStep.model` sinon modèle « de même rang » : table de correspondance simple Opus→modèle le plus fort, Sonnet→moyen…).

**Transfert du contexte.** La conversation du harnais précédent n'est pas lisible par le suivant, et le fournisseur limité ne peut pas rédiger sa propre note. Le **hub construit lui-même une note de passation déterministe** (nouveau `src/main/passation.ts`, fonctions pures testables) : mission d'origine ; instructions du poste ; derniers N éléments de la conversation condensés (messages, outils, résultats, tronqués) depuis les `ChatItem` du hub ; état du dépôt (`git status --short`, `git diff --stat` du worktree) ; question en attente ; cadre « tu reprends le travail d'un autre agent interrompu par une limite, vérifie l'état du dépôt avant d'agir ». Plafond ~10 000 tokens. Le mécanisme `handoffBlock` des postes permanents sert de modèle d'injection (premier message de la nouvelle conversation).

**Exécution.** Généralisation de `relaunch()` : interrompre, fermer le processus, lancer une **nouvelle conversation** sur le compte cible (même worktree, même nom, même fil d'`items` côté UI) avec la note ; notice « Basculé de Claude vers Codex (limite atteinte, reprise à 17:40) » ; le maître est prévenu. Même harnais et même compte historique : `resume` classique.

**Retour au fournisseur d'origine.** Quand `limitedUntil` est dépassé (minuteur à `resetsAt` + vérification), au prochain moment sûr (session au repos, jamais en plein tour) selon la politique : *prochain message* (défaut) / *prochaine mission* / *jamais*. On **reprend l'ancienne conversation** `convs[home]` (elle existe encore) et on lui injecte un résumé « ce qui s'est passé pendant ton absence » (même module de passation, entre l'ancien point et maintenant).

**Maître.** Même mécanisme (ses sujets sont côté hub) ; à traiter en dernier de la phase 4.

---

## 4. Plan d'implémentation

Pré-requis **0** : commiter l'état de `feature/multi-comptes` (bridge, comptes Claude, UI). Rien de ce qui suit n'est lancé avant le go du maître.

### Phase 1 — Abstraction, Claude sans régression

| Chantier | Fichiers | Parallélisable ? |
|---|---|---|
| 1a. Types `AgentEvent`, `AgentProcess`, `ProviderAdapter`, `LimitSignal`, `HubTool` | `src/main/providers/types.ts` (nouveau) | à faire en premier |
| 1b. `ClaudeAdapter` : déplacer `Inbox`, `start/consume/onMessage/onReady/refreshContext/refreshUsage/usageTotals/askPermission/answerElicitation/readHistory` ; `claude.ts` → `providers/claude/` | `providers/claude/*.ts`, `sessions.ts` | **sur le chemin critique**, un seul worker (touche `sessions.ts`) avec 1e |
| 1c. `hubTools()` neutre extrait de `hubServer()` + enveloppe SDK Claude | `src/main/hubTools.ts`, `sessions.ts` | après 1b/1e (même zone de `sessions.ts`) |
| 1d. Modèle de données : `Account` généralisé, `convs`, `Usage.costUsd: number\|null`, `LimitSnapshot` générique, migration `state.json`/`config.json` | `shared/types.ts`, `shared/accounts.ts`, `shared/costs.ts`, `config.ts`, `costLog.ts` | oui (fichiers disjoints de 1b), avec 1a figé |
| 1e. `SessionManager` consomme `AgentEvent` (plus d'import du SDK) | `sessions.ts` | avec 1b |
| 1f. Prompts selon capacités (`SendMessage` vs `send_message`, « Claude Code » neutre), tableau comptes→modèles | `prompts.ts`, `main/i18n.ts` | oui |
| 1g. Tests : rejouer des suites `SDKMessage` enregistrées → `AgentEvent` attendus ; migration d'état | `*.test.ts` | oui (après 1a) |
| Hors phase, **parallélisable dès maintenant** (fichiers nouveaux, fonctions pures) | `shared/fallback.ts` (chaîne, cooldown), `main/passation.ts` + tests | oui |

Critère de sortie : `npm run typecheck`, `npm test` verts, **comportement identique** vérifié à la main (master + 2 workers, permissions, reprise, bascule de compte Claude→Claude, sujets). Aucun import du SDK hors `providers/claude`.

### Phase 2 — Codex, UI Comptes, choix par worker

| Chantier | Fichiers | Parallélisable ? |
|---|---|---|
| 2a. Spike (1 jour) : approbation réelle, `interrupt`, `steer`, `resume`, `CODEX_HOME` dédié sans MCP perso, coût au démarrage, Windows | script jetable | d'abord |
| 2b. Client JSON-RPC stdio app-server + types minimaux **figés** (sous-ensemble écrit à la main depuis `generate-ts` ; contrôle de version minimale 0.163) | `providers/codex/client.ts`, `protocol.ts` | oui |
| 2c. `CodexAdapter` : notifications → `AgentEvent`, approbations, traduction des modes (4.4 ci-dessous), historique, compactage | `providers/codex/adapter.ts` | après 2b |
| 2d. Serveur MCP HTTP loopback + jetons de session | `src/main/mcpHttp.ts`, `package.json` (`@modelcontextprotocol/sdk` en direct) | oui |
| 2e. Auth Codex : statut, login terminal, logout, `model/list`, `rateLimits/read` | `providers/codex/auth.ts`, `terminal.ts`, `main.ts` | oui |
| 2f. UI Comptes (type Codex, état, jauge générique), choix compte/modèle/effort par poste et par worker | `renderer/setup.ts`, `chat.ts`, `dom.ts`, `styles.css`, `renderer/i18n.ts`, `preload.ts`, `shared/types.ts` (IPC) | **oui, côté renderer, contrat = types + IPC figés après 1d** |
| 2g. Coût en tokens dans le popover de coût | `shared/costs.ts`, `renderer/cost.ts` | oui |

Traduction des modes (2c) : `default` → `on-request` + `workspace-write` ; `acceptEdits` → `on-request` + `workspace-write` avec édition auto ; `plan` → `read-only` ; `auto` → `approvalsReviewer: auto_review` ; `dontAsk` → `never` + `workspace-write` ; `bypassPermissions` → `never` + `danger-full-access` (avertissement existant) ; `readOnly` → `read-only`. `additionalDirectories` → `--add-dir` / racines d'écriture.

Plan B si l'app-server se montre instable : `codex exec --json` par tour (sans approbation interactive ni `steer`), restreint à `never` + bac à sable ; l'interface d'adaptateur le permet.

### Phase 3 — Fournisseurs API

| Chantier | Fichiers |
|---|---|
| 3a. Type `anthropic-compatible` (DeepSeek en préréglage : URL, clé, modèles lus via `/models`) : **uniquement de l'environnement** pour Claude Code | `shared/accounts.ts`, `main/accounts.ts`, `renderer/setup.ts`, i18n |
| 3b. Durcir le pont `openai` (comptage de tokens, effort, erreurs de quota → `LimitSignal`) | `bridge.ts`, `bridgeFormat.ts` |
| 3c. (Optionnel, sur demande) adaptateur CLI générique pour Gemini CLI ou autre (exec par tour) | `providers/<nom>/` |

3a et 3b sont parallélisables (fichiers disjoints).

### Phase 4 — Repli automatique

| Chantier | Fichiers | Parallélisable ? |
|---|---|---|
| 4a. `LimitTracker` (cooldowns, sondes, bascule préventive) | `src/main/limits.ts` | oui |
| 4b. Sélection de cible + chaîne (pur, déjà écrit hors phase) | `shared/fallback.ts` | — |
| 4c. Note de passation + digest de retour (pur, déjà écrit hors phase) | `main/passation.ts` | — |
| 4d. `switchProvider()` (généralise `relaunch/applyAccount`), retour à l'origine, états persistés | `sessions.ts` | non (chemin critique) |
| 4e. UI : éditeur de chaîne, badges, notices, consentement des étapes payantes | `renderer/setup.ts`, `app.ts`, `chat.ts`, i18n | oui (après 4b) |
| 4f. Texte du maître sur les replis ; le maître lui-même | `prompts.ts`, `sessions.ts` | en dernier |

---

## 5. Risques et blocages

1. **App-server Codex expérimental** : protocole versionné par binaire, « non supporté en production ». Parades : types figés + contrôle de version minimale, spike de la phase 2, plan B `exec --json`.
2. **Conditions d'utilisation** : l'équivalent pour Claude est strict (README). Pour OpenAI, la doc d'app-server dit de contacter OpenAI pour une intégration d'entreprise ; des sources secondaires indiquent que l'usage de l'abonnement ChatGPT dans des outils tiers est autorisé pour des partenaires. **Non vérifié sur les CGU officielles.** Parade : le hub ne touche aucun jeton, `codex login` s'exécute dans un terminal, comme pour Claude.
3. **MCP perso de l'utilisateur chargés par Codex** (lenteur, ~18 k tokens d'entrée de base) : `CODEX_HOME` dédié ; à valider en spike.
4. **Parité fonctionnelle réduite** pour Codex : pas de `SendMessage` natif (outil hub), pas de commandes/skills Claude, coût en tokens seulement. Le maître doit savoir ce que chaque compte sait faire (`capabilities`).
5. **`sessions.ts` est un point chaud de 3 000 lignes** : la phase 1 est le risque de régression principal et serialise le travail ; d'où les tests de rejeu.
6. **Qualité d'un repli** : une note de passation ne remplace pas la conversation (travail interrompu au milieu d'un outil). Parade : cadre « vérifie le dépôt », état git injecté, bascule aux frontières de tour quand c'est possible.
7. **Coûts cachés** : replier sur un compte facturé au token sans le dire coûte de l'argent : consentement par étape.
8. **Limites hétérogènes** (plans Codex différents, fenêtres absentes) : `LimitSnapshot` générique, jamais 5 h/7 j en dur.
9. **Mesures consommées** : mes sondes ont fait 3 appels de modèle sur le compte Codex de l'utilisateur (≈ 200 k tokens au total, dont ~18 k de base par tour, modèle `gpt-5.6-luna`, `--ephemeral`). Aucune connexion ni déconnexion n'a été lancée.

## 6. Questions produit ouvertes

| # | Question | Recommandation |
|---|---|---|
| 1 | Connexion Codex : terminal `codex login` ou OAuth piloté par le hub (`account/login/start`) ? | **Terminal**, comme Claude : cohérent avec le README, le hub ne voit aucun jeton. |
| 2 | Le repli est-il automatique ou demande-t-il confirmation ? | **Automatique dans la chaîne**, avec notice ; les étapes facturées au token sont **désactivées tant que l'utilisateur ne les a pas cochées**. |
| 3 | Chaîne par défaut ? | Une chaîne globale (Claude → Codex → DeepSeek si configurés), **surchargeable par poste** ; vide par défaut (rien ne change sans configuration). |
| 4 | Quand revenir au fournisseur d'origine ? | **Au prochain message à une session au repos** après la réinitialisation, en reprenant l'ancienne conversation avec un résumé. Options : prochaine mission, jamais. |
| 5 | Le maître bascule-t-il aussi ? | Oui, **en dernier** (phase 4f), activé par défaut une fois testé sur les workers. |
| 6 | Bascule préventive à X % d'usage ? | Option, **désactivée par défaut** (les jauges Codex varient selon le plan). |
| 7 | Coût des comptes sans prix (abonnements) ? | Afficher des **tokens** et « abonnement », pas des dollars estimés ; table de prix éventuelle plus tard. |
| 8 | Messages worker↔worker avec un worker Codex ? | Outil hub `send_message` pour les harnais sans `SendMessage` ; les workers Claude gardent `SendMessage`. Unifier plus tard si utile. |
| 9 | Réutiliser `~/.codex` ou un `CODEX_HOME` dédié ? | **Dédié** par défaut (démarrage rapide, pas de MCP perso), « utiliser mon installation Codex » en option avancée. |
| 10 | Stockage des secrets : `safeStorage` ou éléments Keychain directs ? | **`safeStorage`** (déjà en place, clé dans le Keychain macOS, portable Windows/Linux). |
| 11 | Gemini et autres CLI ? | **Hors périmètre** tant qu'ils ne sont pas demandés ; l'interface les accueille (phase 3c). |
| 12 | Que devient le pont `openai` ? | Le **garder** (clé API OpenAI, OpenRouter, local) ; DeepSeek passe par l'endpoint Anthropic natif. |
| 13 | CGU OpenAI pour l'abonnement ChatGPT depuis une app tierce | **À faire valider par l'utilisateur** avant la phase 2 ; je ne l'ai pas vérifié sur les pages officielles. |

---

## Annexe A — Sondes exécutées

Toutes en lecture ou en tour éphémère ; aucune connexion, aucune déconnexion, aucune modification de `~/.codex` ni de l'app installée. Scripts jetables dans `/tmp/codex-probe/`, protocole généré dans `/tmp/codex-proto/` (non commités).

| Sonde | Commande / méthode | Résultat |
|---|---|---|
| Versions | `claude --version`, `codex --version`, `command -v` de 16 CLI | 2.1.287 ; 0.163.0 ; les autres absents |
| Aide | `codex --help`, `exec --help`, `exec resume --help`, `app-server --help`, `mcp add --help`, `login --help` | options citées en 2.2 |
| Connexion | `codex login status` | `Logged in using ChatGPT` |
| Protocole | `codex app-server generate-ts [--experimental]`, `generate-json-schema` | méthodes, notifications, requêtes serveur, types listés en 2.2.1 |
| Sonde app-server | `initialize` → `account/read`, `account/rateLimits/read`, `model/list` | plan *business*, `individualLimit`, modèles et efforts (2.2.1, 2.2.3) |
| MCP bout en bout | serveur MCP HTTP local + jeton, `thread/start` avec `config` `mcp_servers.hub.*`, `turn/start` | 1er essai : refus d'approbation (`never`) ; 2e essai avec `default_tools_approval_mode: 'approve'` : outil appelé, réponse exacte, 0 refus d'auth |
| `exec --json` | `codex exec --json --ephemeral -s read-only -m gpt-5.6-luna` | 4 événements JSONL (2.2) |
| Binaire | `strings` sur le binaire Codex | `cli_auth_credentials_store`, clés MCP (`bearer_token_env_var`, `default_tools_approval_mode`, `enabled_tools`…), `wire_api = "chat"` refusé |
| Code du hub | lecture de `sessions.ts`, `claude.ts`, `main.ts`, `accounts.ts`, `bridge.ts`, `types.ts`, `prompts.ts`, diff de la branche ; `npm run typecheck`, `npm test` | état de la branche, couplages (92 tests verts) |
| SDK | `sdk.d.ts` : `SDKRateLimitInfo`, `SDKAssistantMessageError` | statuts et codes de 3.7 |
| Web (secondaire) | doc DeepSeek (endpoint Anthropic), doc app-server OpenAI, recherches Gemini CLI, CLI DeepSeek | 2.3, 2.4, risque 2 |
