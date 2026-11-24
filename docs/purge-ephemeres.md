# Fichiers éphémères : brouillon des workers et purge par projet

Les agents créent beaucoup de fichiers qui ne servent qu'une fois : captures, frames extraites, planches de contrôle,
rendus d'essai, aperçus vidéo, logs, scripts d'essai. Ils restent ensuite au milieu des vrais livrables et encombrent
la machine. AI Box règle cela en deux temps : il **prévient** (chaque worker a un dossier de brouillon), puis il
**purge** en sécurité, projet par projet, ce qui est déjà éparpillé.

Exigence de départ : ne jamais supprimer le mauvais fichier. Tout le reste en découle : la purge ne fait que
**proposer**, elle ne coche d'avance que ce qui est sûr, elle n'efface jamais définitivement, et elle refuse en bloc
toute une liste de cas (fichier suivi par git, livrable cité, fichier retouché par l'utilisateur…).

## 1. Prévention : un dossier de brouillon par worker

À chaque lancement d'un worker local, le hub crée son dossier de brouillon et le lui donne :

- `<dossier du worker>/.aibox/scratch/<nom de session>/` quand le worker travaille dans un projet ;
- `<données de l'app>/scratch/<nom de session>/` quand son dossier est trop large pour être un projet (dossier
  personnel, racine d'un disque, dossier de travail qui contient les repos, comme le Bureau).

`.aibox/` reçoit un `.gitignore` qui contient `*` : git ignore le brouillon sans qu'on touche au `.gitignore` du
projet ni au réglage global de l'utilisateur. Dans un worktree, le brouillon vit dans le worktree : il part avec lui,
et un fichier ignoré n'empêche pas `git worktree remove`.

Le chemin est donné de trois façons, pour tous les fournisseurs :

1. **Les instructions du worker** (section « Fichiers jetables » de `workerPrompt`). Le hub les passe par le champ
   commun `instructions` de `adapter.start` : `systemPrompt.append` pour Claude Code (et donc DeepSeek, OpenAI et
   les serveurs compatibles, qui passent par Claude Code), `developerInstructions` pour Codex, le préambule du premier
   message pour Gemini (ACP n'a pas de champ système). Un nouveau fournisseur branché sur `adapter.start` l'a d'office.
2. **La variable d'environnement `AIBOX_SCRATCH_DIR`**, pour les scripts et outils qui la liraient.
3. **Les dossiers autorisés** : le brouillon hors du dossier du worker est ajouté à `extraDirs` (dossiers
   additionnels de Claude Code, `writable_roots` du bac à sable Codex, `--include-directories` de Gemini).

La consigne : captures, frames, planches, rendus d'essai, aperçus, logs, scripts d'essai et sorties de debug vont
dans le brouillon, jamais dans le projet, `/tmp` ou le Bureau ; ailleurs, seulement les livrables. Un brouillon qui
devient un livrable est déplacé à sa place définitive, et c'est ce chemin-là que le rapport cite.

Pas de brouillon pour le maître (il ne produit rien) ni pour un worker en lecture seule.

## 2. Purge par projet

### Ce qu'est un projet

La liste à gauche de la vue « Fichiers éphémères » réunit, sans doublon : les repos suivis (`mainRepos`), les
dossiers des sessions du hub (ouvertes, fermées, et celles du journal d'activité), les dossiers ajoutés à la main, et
des **suggestions** : les sous-dossiers directs d'un dossier large (le Bureau) où des agents ont écrit. Un dossier
système, le dossier personnel, la racine d'un disque, les dossiers standard (Bureau, Documents, Téléchargements) et
les données de l'app ne sont jamais un projet. « Brouillons hors projet » regroupe les brouillons rangés dans l'app.

### Sources de vérité

1. **Le brouillon** (`.aibox/scratch/`) : son contenu est jetable par contrat.
2. **La provenance**, lue dans les transcripts des agents par un adaptateur par format :
   - Claude Code : `<config>/projects/**/*.jsonl` (comptes compris) ; `Write` avec résultat `create`, `Edit`,
     `NotebookEdit`, et les commandes `Bash`/`PowerShell` avec leur `cwd`, l'heure d'appel et l'heure du résultat ;
   - Codex : `$CODEX_HOME/sessions/**/rollout-*.jsonl` (et les dossiers de comptes) ; `apply_patch` (`Add File`),
     appels `shell`/`exec_command` avec `workdir` ;
   - Gemini CLI : `<GEMINI_CLI_HOME>/.gemini/tmp/*/chats/*.json` ; `write_file`, `replace`, `run_shell_command` ;
   - **repli générique** pour tout autre fournisseur : le hub journalise lui-même les fenêtres d'activité de chaque
     session (début et fin de chaque tour, dossier, fournisseur), dans `<données>/purge/activity.jsonl`.

   Pour une commande, un fichier est **créé par la commande** si un chemin, un motif (`frame_%04d.png`, `*.png`) ou
   un dossier parent cité dans la commande le désigne et si sa date de création tombe entre l'appel et le résultat
   (redirections `>`, `-o`, `--output`, `Out-File`, `ffmpeg … sortie`, `mkdir`, `screenshot --path`…). Un fichier
   né pendant une commande ou un tour d'agent, sans être cité, est **né pendant une session** : provenance faible.
   C'est le diff d'arborescence sans son coût : la date de création du fichier fait office de photo « avant ».
3. **Git** : `git ls-files` de chaque repo trouvé sous la racine (repos imbriqués compris) ; un repo illisible
   protège tout son contenu.
4. **Les citations** : chemins et noms de fichiers repérés dans les messages de l'utilisateur, les missions du
   maître, les rapports (`message_master`, `SendMessage`) et les réponses des agents. Les commandes et les résultats
   d'outils ne comptent pas (une commande cite forcément ce qu'elle produit).
5. **Les dates** : création et modification du fichier, comparées aux fenêtres d'activité des agents.

L'index des transcripts est lu en flux, ligne par ligne, avec un cache par fichier (taille et date) : seule la
partie nouvelle d'une conversation est relue. L'arborescence est parcourue en asynchrone, sans suivre aucun lien,
avec une limite de fichiers (le résultat dit alors qu'il est partiel).

### Protections dures (jamais proposé)

| Cas | Règle |
| --- | --- |
| Hors de la racine | chemin lexical **et** chemin réel dans la racine ; aucun lien symbolique ni jonction suivi ou proposé |
| Dossiers exclus du scan | `.git`, `node_modules`, `.hg`, `.svn`, environnements Python ; le reste de `.aibox` |
| Suivi par git | tout fichier de `git ls-files` ; repo illisible = tout protégé |
| Cité | un fichier, ou un dossier parent, cité par l'utilisateur, le maître ou un rapport (hors brouillon) |
| Retouché | modifié en dehors de toute fenêtre d'activité d'agent, après sa création par l'agent |
| Livrable | dossier ou nom `final`, `livrable`, `deliverable`, `livraison`, `export`, `release`, `dist`, `rendu final`… |
| Document | `.md`, `.pdf`, `.docx`, `.xlsx`, `.pptx`, `.odt`, `.csv`, archives (`.zip`, `.7z`, `.rar`, `.tar.gz`…) hors brouillon |
| Secret | `.env*`, clés (`.pem`, `.key`, `.p12`, `id_rsa`…), coffres |
| Récent | modifié depuis moins de 10 minutes, ou brouillon d'une session au travail |
| Exclusions | motifs du projet (`renders/final/**`, `*.blend`…), modifiables dans la vue |

### Classement

- **Sûr** (coché d'avance) : tout fichier d'un brouillon `.aibox/scratch` ; ou un fichier créé explicitement par
  un agent (outil d'écriture ou sortie d'une commande qui le nomme), jamais retouché, non cité, non suivi, qui est
  à la fois **un fichier à regarder une fois** (image, vidéo, log, sortie d'outil de test) **et rangé ou nommé comme
  un jetable** (dossier `tmp`, `qc`, `debug`, `_travail`, `frames-…`, `captures`, `test-results`…, nom `capture`,
  `screenshot`, `planche`, `frame`, `dbg`, `apercu`, `essai`…).
- **Probable** (non coché) : créé par un agent dans un dossier jetable mais d'un autre type (un modèle téléchargé,
  un fichier de données) ; né pendant le travail d'un agent avec une allure jetable ; caches d'outils connus
  (`test-results`, `playwright-report`, `coverage`, `__pycache__`…) même sans provenance.
- **À vérifier** (non coché) : image ou vidéo créée par un agent sans autre indice (c'est souvent le rendu
  demandé) ; scripts et données écrits par un agent hors brouillon ; allure jetable sans aucune provenance ;
  fichier de brouillon cité ou retouché.
- **Protégé** : affiché avec sa raison, jamais sélectionnable.

Les heuristiques seules ne donnent jamais « sûr ». Un fichier sans aucun signal n'apparaît pas.

Une citation protège le fichier par son chemin complet, une fin de chemin (`qc/planche.png`) ou son nom ; un dossier
cité ne protège que les fichiers qu'il contient directement, et seulement s'il est nommé par deux niveaux au moins
(`audit/qc/`) ou par son chemin complet sous la racine : un nom seul comme `gen/` ou le nom du projet ne désignent
rien de précis. Les conversations lues sont celles des sessions qui ont travaillé dans le projet ou au-dessus
(le maître), plus tout chemin complet vers le projet cité ailleurs.

### Envoi à la corbeille

- La vue ne transmet que des identifiants de la dernière analyse, jamais un chemin : le processus principal retrouve
  le fichier dans son propre rapport.
- Juste avant de déplacer, tout est revérifié : chemin réel dans la racine, pas de lien, même taille et même date
  qu'à l'analyse, toujours non suivi par git. Un écart = fichier laissé en place et signalé.
- Un dossier entièrement sélectionné (relu sur le disque : rien d'autre dedans) part en un seul élément.
- `shell.trashItem` d'Electron : Corbeille de Windows, Corbeille de macOS, corbeille freedesktop sous Linux. Si elle
  échoue (volume réseau, droits, pas de corbeille), le fichier part en **quarantaine** dans
  `<données>/purge/quarantine/<purge>/`, restaurable d'un clic pendant 30 jours ; ensuite il rejoint la corbeille du
  système. Jamais d'effacement définitif.
- Chaque purge est écrite dans `<données>/purge/log.jsonl` : date, projet, fichiers, tailles, destination.
  L'historique de la vue en découle ; « Restaurer » remet un fichier en quarantaine à sa place (s'il n'y en a pas un
  autre) ; un fichier envoyé à la corbeille se restaure depuis la corbeille du système (« Remettre »).

## 3. Interface

Bouton « Éphémères » de la barre du haut (à côté de MCP et Skills) et commande de la palette. La vue suit le modèle
des vues MCP/Skills : projets à gauche, puis pour le projet choisi :

- « Analyser » : totaux par catégorie (nombre, taille), puis groupes par dossier, avec les sessions d'origine et la
  raison de chaque fichier ;
- cases cochées d'avance pour « Sûr » seulement ; « Vider le brouillon » coche tout le brouillon (hors protégés) ;
- « Envoyer à la corbeille » avec confirmation (nombre et taille) ;
- onglets « Historique » (restauration) et « Règles » (motifs d'exclusion du projet) ;
- une courte aide « Comment ça marche ».

## 4. Multiplateforme

Chemins par `node:path` et `node:os` ; données de l'app par `app.getPath('userData')`. Les comparaisons de chemins
ignorent la casse sous Windows et macOS (systèmes de fichiers insensibles par défaut), pas sous Linux. Sous macOS,
AI Box ne lit que les dossiers des projets et les dossiers de conversations des CLI : pas besoin de l'accès complet
au disque. Les tests simulent les chemins des deux familles (`path.win32`, `path.posix`).

## 5. Inspirations

`git clean -n` (aperçu avant tout), `git clean -X` (seulement l'ignoré), npkill et `cargo clean` (caches connus),
la Corbeille plutôt que `rm`, le dossier `/tmp` par session de Claude Code. Claude Code n'a pas de convention de
dossier de brouillon dans le projet ; ses fichiers internes (`%TEMP%\claude`, `$TMPDIR/claude`) restent hors champ :
ils sont à lui et le système les nettoie.

## 6. Limites

- La date de création n'existe pas sur tous les systèmes de fichiers Linux : la date de modification la remplace,
  ce qui rend la provenance faible plus prudente (moins de fichiers proposés).
- Un fichier que l'utilisateur crée pendant qu'un agent travaille dans le même dossier peut passer pour né pendant
  la session : il ne monte jamais plus haut que « probable », donc jamais coché d'avance.
- Les transcripts d'un fournisseur inconnu ne sont pas lus : seul le journal d'activité du hub sert.
- Un fichier de la corbeille du système se restaure depuis elle : Electron ne sait pas l'en sortir.
- Le brouillon d'un worker distant n'existe pas encore.
