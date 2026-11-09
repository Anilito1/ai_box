# Serveur distant : guide (expérimental)

« Je m'absente » : les workers au travail continuent sur ton serveur ; « Je suis de retour » les ramène, dossiers à jour.
Désactivé, rien ne change. Aucune valeur à toi (adresse, identifiants, jetons, repos) n'est dans ce repo : tout reste
dans les réglages et le trousseau du PC.

Tout se fait dans **Réglages › Serveur distant** : une fiche courte, puis « Installer » ouvre l'assistant, étape par
étape, chacune cochée ✓ ou avec son erreur en clair, relançable à tout moment. « Copier le prompt d'installation » met
dans le presse-papiers un message complet à coller à ton IA (le maître, ou Claude Code) pour qu'elle te guide.

1. **Louer le serveur** : OVHcloud Public Cloud, instance **d2-8** (4 vCPU / 8 Go, à l'heure), Ubuntu 24.04, Gravelines
   ou Strasbourg. À la création, colle la clé administrateur de l'étape 2 (bouton Copier).
2. **Se connecter et installer** : IP, utilisateur `ubuntu`, « Connecter et installer ». Compare l'empreinte avec la
   console OVH (KVM : `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`), « Faire confiance ». Sans console à portée,
   une instance neuve connectée dans la minute de sa création peut être acceptée telle quelle (« première vue ») :
   risque d'interception faible, mais choisi. L'installation tourne seule (10 à 15 min) : pare-feu, utilisateur `aibox`
   sans sudo, Claude Code, le relais (*runner*), puis les outils des skills (gh, ripgrep, jq, ffmpeg, Python et uv,
   Chromium sans écran, playwright-cli, outils des documents PDF et Office). Un outil qui échoue est signalé sans
   bloquer ; relancer réessaie. Une app plus récente réinstalle d'elle-même ce qui a changé au prochain « Relancer ».
3. **Login Claude** : « Ouvrir la page de connexion », connecte-toi, colle le code, « Envoyer le code ».
4. **GitHub** : « Créer le jeton sur GitHub » ouvre la page d'un jeton *fine-grained* déjà remplie (Contents, Pull
   requests, Workflows en écriture, Metadata en lecture, 90 jours) ; choisis tes repos (« Only select repositories »),
   colle le jeton, coche les repos que le serveur peut tenir. Le jeton reste dans le trousseau du PC ; le serveur ne le
   reçoit qu'en mémoire, au lancement de chaque worker.
5. **Réveil et veille** (facultatif) : identifiants du projet et de l'instance, puis « Créer la clé OVHcloud » ouvre
   la page `createToken` limitée à cette instance (lire, démarrer, arrêter, mettre en veille, réveiller). Ensuite
   « Le serveur s'éteint tout seul » : une **seconde** clé, qui ne sait que lire et mettre en veille cette instance,
   part sur le serveur (voir « Garde-fous »).
6. **Téléphone** (facultatif) : « Créer une adresse », abonne-toi dans l'app ntfy. Messages fixes, sans nom ni contenu.
7. **Activer** : « Workers distants activés » ; le bouton « Je m'absente » apparaît en haut.

**Je m'absente** (ou écran verrouillé / 10 min d'inactivité si tu l'actives) : le serveur se réveille (environ 10 min
s'il était en veille), ta configuration y est copiée (une minute au plus), chaque worker au travail enregistre et
pousse sa branche puis repart là-bas d'un brief de reprise ; les postes du PC se mettent en pause. Quand le relais
confirme qu'il tient chaque worker parti, le bouton le dit (« tu peux éteindre le PC ») et le téléphone aussi : tu
fermes l'AI Box et tu éteins. **Je suis de retour** : le serveur est rallumé s'il dort, le hub se reconnecte, les
messages écrits au maître pendant l'absence lui arrivent (une fois chacun, datés), puis au choix : « Les ramener ici »
(chacun pousse, revient avec ses commits, ton dossier est tiré) ou « Les laisser finir sur le serveur » (tes dossiers
sont tirés avec ce qui est déjà poussé ; « Sur le serveur (N) » les ramènera plus tard).

**Coût** : 0,04 € HT l'heure allumée + ~0,55 €/mois de disque en veille. 60 h par mois ≈ 3 € ; toujours allumé, la
d2-8 au mois coûte 20,60 € HT (prix catalogue). Le quota de l'abonnement Claude est le même qu'ici : la nuit consomme
celui du lendemain.

## Comment ça marche

```
PC (AI Box)                         SSH (port 22, clé dédiée)        Serveur (utilisateur aibox, sans sudo)
┌──────────────────────────┐        ┌──────────────────────┐         ┌──────────────────────────────────────────┐
│ maître, hub MCP, écran   │        │ launch.mjs (commande │         │ aibox-runner.service (systemd, runner.mjs)│
│ SDK Agent de Claude ─────┼─stdio─►│ forcée de la clé) :  ├─socket─►│  une session par conversation :           │
│  (lit les lignes         │◄───────┤ vérifie la demande,  │  Unix   │   claude (Claude Code, groupe à lui)      │
│   numérotées, garde le   │        │ joint le runner      │ ~/.aibox│   journal numéroté (journal.jsonl)        │
│   dernier numéro reçu)   │        └──────────────────────┘         │   file pour le maître (outbox.json)       │
│ outils du hub, questions │                                         │   demandes en attente (permissions…)      │
└──────────────────────────┘                                         │ aibox-power (autre utilisateur) : veille  │
          ▲  pull / fetch                                            └───────────────┬──────────────────────────┘
          └────────────────────────────── GitHub ◄── push des branches ──────────────┘
```

- **Hub présent** : chaque ligne passe telle quelle entre le SDK du PC et Claude Code ; le relais numérote les lignes
  de messages (`aibox_seq`) et les garde. Les outils du hub, les permissions et les questions vont au PC comme avant.
- **Hub absent** (PC éteint, AI Box fermée, réseau coupé) : Claude Code continue. Un message au maître, au chef de
  groupe ou à un pair (`message_master`, `message_lead`, `send_message`) est répondu « enregistré » et mis en file ;
  un autre outil du hub répond « hub hors ligne » ; une permission ou une question attend, intacte, et le téléphone
  sonne. Un worker sans rien à faire et sans tâche de fond est arrêté au bout de 15 min (sa conversation reste) ;
  un tour seul plus de 8 h est interrompu.
- **Retour** : le hub se reconnecte avec le dernier numéro reçu ; le relais redonne la réponse d'initialisation de la
  session, les lignes manquées dans l'ordre, chaque message en file à l'endroit où il a été écrit (rejoué comme le même
  appel d'outil, avec « Écrit sur le serveur pendant l'absence, à HH:MM »), puis les demandes en attente. Une session
  arrêtée repart d'elle-même (`--resume`) ; une session au repos dont les réglages ont changé repart avec les nouveaux.
- Sur le PC, un worker du serveur n'a pas `SendMessage` (ses pairs sont ici) : il passe par `send_message` du hub.

Mesuré le 2026-11-09 sur une d2-8 (`scripts/vps/night-e2e.ts`, worker réel sur un repo perso) : « Je m'absente » en
23 s, serveur déjà allumé ; AI Box fermée 21 min 55 s, pendant lesquelles le worker a poussé 5 commits depuis le serveur ;
à la réouverture, son rapport écrit pendant l'absence est arrivé au maître 4 s après la reconnexion, une seule fois ;
« Je suis de retour » en 19 s. Relais : 54 à 69 Mo ; un Claude Code : environ 250 Mo. `scripts/vps/runner-e2e.ts` refait
le cœur du protocole en une minute (le hub part en plein tour, un rapport est écrit pendant son absence, il revient).

Doublons : chaque message au maître, au chef ou à un pair porte l'identifiant de l'appel d'outil que lui donne Claude
Code ; le hub garde les derniers livrés et ne livre jamais deux fois le même, même rejoué après une coupure.

Tour coupé par un arrêt ou un redémarrage du serveur : le relais l'écrit sur disque à chaque changement d'activité ;
au redémarrage il marque la session « interrompue » et prévient le téléphone. À la reconnexion, la conversation le dit,
le maître aussi, et « Reprendre » relance le worker avec sa mission et son dernier message ; « Les laisser finir sur le
serveur » le relance aussitôt.

Jetons : les workers d'un serveur tournent sous le même utilisateur Unix ; chacun pourrait lire l'environnement des
autres (`/proc/<pid>/environ`) ou piéger leurs dossiers. Un fichier d'environnement à 0600 ou un assistant qui ne répond
qu'à un PID ne changeraient rien sous un même utilisateur. Ce qui est garanti : **un serveur ne porte qu'un accès GitHub
à la fois** (tes repos, ou une organisation) ; l'app refuse d'y lancer un worker d'un autre accès tant qu'un worker y
tourne. Les jetons qu'un worker pourrait lire chez un autre sont donc les siens. Une isolation par worker demanderait un
utilisateur Unix par worker (phase 3). L'adresse ntfy est gardée sur le serveur (`~aibox/.aibox`, 700) pour prévenir
le téléphone après un redémarrage, comme dans les réglages du PC.

## Garde-fous

- **Réseau** : rien d'autre que SSH (ufw : 22 seul, fail2ban). Le relais n'écoute que sur une socket Unix dans
  `~aibox/.aibox` (dossier 700) ; la clé des workers ne lance que `launch.mjs`, qui refuse tout dossier hors `~/repos`,
  tout repo non listé, tout drapeau de Claude Code qui lancerait un programme ou lirait un fichier choisi par l'appelant.
- **Extinction** : app ouverte, c'est elle qui met le serveur en veille après le délai sans worker. PC éteint, c'est le
  serveur : le relais écrit l'état (`/run/aibox/idle.json`) et, après le même délai sans rien qui tourne ni hub
  connecté, demande la veille ; `aibox-power.service` (utilisateur `aibox-power`, pas `aibox`) revérifie et appelle
  OVHcloud. Sa clé ne sait que lire et mettre en veille cette instance ; elle est chiffrée par `systemd-creds` avec la
  clé de l'hôte (`/etc/aibox/ovh.cred`, root) et n'existe en clair qu'en mémoire du service. Un worker ne peut pas la
  lire ; au pire il pourrait demander une mise en veille.
- **Plafond** : `max` workers côté app (réglage), et le relais refuse au-delà de ce que la mémoire tient (≈ 700 Mo par
  worker, 16 au plus) ; le service est borné à 92 % de la mémoire (systemd).
- **Arrêt propre** : à l'arrêt du serveur (veille, redémarrage), le relais interrompt les tours en cours (30 s), ferme
  chaque session, puis s'arrête ; journaux et files restent sur disque.
- **Journal** : `journalctl -u aibox-runner` (démarrages, connexions, fins, refus, notifications ; jamais un mot d'une
  conversation, jamais un jeton) ; `~/.aibox/launch.log` pour les requêtes SSH. Rien n'est écrit des jetons : GH_TOKEN
  vit dans la mémoire du processus de chaque session, l'adresse ntfy dans celle du relais.

## Pannes

| Ce qui arrive | Ce que tu vois | Ce qui se passe |
|---|---|---|
| Wi-Fi coupé, PC en veille | « La connexion au serveur a été coupée : le worker continue là-bas » | Le hub se reconnecte seul (20 s, puis toutes les 2 min) et reçoit ce qu'il a manqué. |
| AI Box fermée, PC éteint | rien | Les workers partis continuent ; leurs messages au maître attendent sur le serveur. |
| Le relais redémarre (mise à jour, plantage) | coupure brève | systemd le relance ; les sessions repartent à la reconnexion, depuis leur conversation. Un tour coupé est marqué interrompu : « Reprendre » le relance. |
| Serveur redémarré ou mis en veille | « Serveur en veille », puis « mission interrompue » | Les tours en cours sont interrompus proprement et marqués ; le téléphone est prévenu ; au retour, « Reprendre » relance chaque worker coupé. |
| Un worker d'un autre accès GitHub | « un worker d'un autre accès GitHub tourne déjà sur le serveur » | Il reste en pause ici jusqu'à ce que le serveur soit libre de l'autre accès. |
| Plus de place sur le serveur | « le serveur tient déjà N workers » | Le worker reste en pause ici. |
| Une permission attend pendant l'absence | téléphone : « attend une réponse » | Elle t'est posée à la reconnexion. |
| Serveur injoignable au retour | « le serveur ne répond pas ; il reste là-bas » | Rien n'est perdu ; réessaie « Je suis de retour » une fois le serveur rallumé. |
| « OVHcloud n'a pas rallumé le serveur » | message clair | OVH ne garantit pas de place au réveil ; l'app redemande chaque minute pendant 20 min ; si ça se répète, « Toujours allumé ». |
| Clé refusée, « identité changée » | étape en rouge | Ajoute la clé par la console OVH ; réinstallé ? « Oublier l'ancienne identité », sinon arrête-toi. |
| Jeton GitHub expiré | « refusé par GitHub » | Colle-en un neuf, « Enregistrer et vérifier ». |

Tout arrêter : supprime le jeton, désactive « Le serveur s'éteint tout seul », `claude auth logout` sur le serveur (ou
supprime l'instance), « Oublier l'accès OVH », décoche « Workers distants activés ».

## Ce qui part sur le serveur, ce qui reste

- Jamais : `~/.claude.json` (serveurs MCP du PC), identifiants, `.env`, clés, `.wrangler`, `.cloudflare-profiles`, les
  skills que ton compte Claude synchronise (le serveur les reçoit par sa propre connexion), tout ce qui pilote le PC
  (Blender, Unity, navigateur visible, computer use), tout ce qui nomme l'entreprise (skill ou plugin entier), la
  mémoire d'un repo non autorisé ou d'une organisation.
- CLAUDE.md : une section dont le titre nomme l'entreprise, Cloudflare, Supabase, Windows ou un programme du PC part
  entière ; ailleurs, chaque paragraphe, puce (avec ses sous-puces) ou bloc de code qui en nomme un est retiré. Puis
  tout identifiant que ce fichier donne (comptes, projets) est refusé dans n'importe quel fichier envoyé, et un fichier
  qui contient quelque chose qui ressemble à un secret ne part pas.
- Réglages : modèle, effort, langue, style, et parmi tes plugins seulement ceux d'une liste blanche (sans hooks ni
  serveur MCP : frontend-design, code-review, feature-dev, pr-review-toolkit, claude-md-management, claude-api,
  document-skills, hyperframes). Ni hooks, ni variables, ni programmes d'aide : le serveur les refuse aussi.

## Parité : un worker distant face à un worker du PC

Le test `scripts/vps/parity-e2e.ts` le vérifie de bout en bout : synchro, puis un worker distant lit le CLAUDE.md,
utilise le skill taste, fait une capture avec playwright-cli, pousse un fichier de preuve et fait son rapport.
Mesuré le 2026-11-09 sur une d2-8 : 56 s pour le tout, mémoire utilisée du serveur de 0,7 à 1,4 Go sur 7,7 Go.

| Domaine | Sur le serveur | Pourquoi |
|---|---|---|
| Modèle, effort, langue, style | identique | copiés de tes réglages |
| Skills perso (taste, playwright-cli, hyperframes…, design-md, security-audit, supabase) et agents | identique | copiés tels quels, un skill entier ou rien |
| Skills de ton compte Claude (pdf, docx…) | identique | le serveur les reçoit par sa propre connexion Claude |
| Mémoire des repos | identique pour tes repos autorisés ; exclue pour une organisation | seule la mémoire d'un repo lié à un clone du serveur part |
| Outils du hub (rapport au maître, sujets, questions) | identique, PC allumé ; en file PC éteint | ils passent par la connexion SSH ; hub absent, les messages au maître attendent sur le serveur (voir « Comment ça marche ») |
| CLAUDE.md global | différent | sans les parties PC et entreprise (Windows, Cloudflare, Supabase, comptes), avec une note « version serveur » |
| Plugins | différent | seulement la liste blanche ci-dessus ; hookify, LSP TypeScript, Cloudflare, Supabase et brain restent ici (hooks, programme ou serveur MCP) |
| Navigateur | différent | Chromium sans écran : captures et tests oui, fenêtre visible non ; WebGL en rendu logiciel, pas de WebGPU (une 3D qui l'exige ne s'affiche pas) |
| Système | différent | Linux, utilisateur sans sudo : un worker n'installe rien avec apt (pip et uv dans son dossier) |
| Outils en ligne de commande | identique | git, gh, ripgrep, jq, Python et ses modules des documents, Node, ffmpeg, uv, playwright-cli, poppler, qpdf, pandoc, Tesseract, LibreOffice sans interface ; ImageMagick 6 (`convert`, pas `magick`) |
| Connecteurs de ton compte claude.ai | différent | ils arrivent avec la connexion Claude du serveur, sans être authentifiés ; ne les authentifie pas là-bas |
| Serveurs MCP du PC (Playwright MCP, Blender, MasterTools…) | exclu | `~/.claude.json` ne part jamais ; playwright-cli remplace le Playwright MCP |
| Blender, Unity, computer use, navigateur visible | exclu | ils pilotent ce PC |
| Déploiements (wrangler, CLI Supabase) et leurs comptes | exclu | les déploiements restent sur le PC |
| Hooks, variables, programmes d'aide de tes réglages | exclu | ils lanceraient des programmes là-bas sans tes demandes de permission |
| Jetons | différent | seul GH_TOKEN, en mémoire, à chaque lancement ; `.env`, clés et profils Cloudflare jamais |
| Whisper et ses modèles, Docker | exclu | lourds, ou un accès équivalent à root ; les skills disent ce qui manque |

## Organisation : application GitHub (prête, pas activée)

Un repo d'organisation tourne sur le serveur seulement avec le jeton d'une heure d'une application GitHub installée
sur l'organisation, jamais avec ton jeton perso ; tant qu'elle n'est pas configurée, ses workers restent sur le PC.
Un **propriétaire** de l'organisation la crée : https://github.com/organizations/Coiffissimo-professional/settings/apps/new
- Nom : « AI Box workers » ; URL de la page d'accueil : celle du repo de l'AI Box ; Webhook : décoché.
- Permissions de repo : Contents, Pull requests, Workflows en lecture et écriture ; Metadata en lecture. Rien d'autre.
- « Only on this account », créer, puis « Generate a private key » (un fichier .pem) et « Install » sur les repos voulus.
- Dans « Accès de l'organisation » : colle l'App ID et le contenu du .pem. La clé reste dans le trousseau du PC.
