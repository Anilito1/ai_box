# Serveur distant : guide (expérimental)

« Je m'absente » : les workers au travail continuent sur ton serveur ; « Je suis de retour » les ramène, dossiers à jour.
Désactivé, rien ne change. Aucune valeur à toi (adresse, identifiants, jetons, repos) n'est dans ce repo : tout reste
dans les réglages et le trousseau du PC.

1. **Commander** : OVHcloud Public Cloud, instance **d2-8** (4 vCPU / 8 Go, à l'heure), Ubuntu 24.04, Gravelines ou
   Strasbourg. À la création, colle la clé administrateur que montre Ctrl+K › « Serveur distant » (bouton Copier).
2. **Assistant** : IP, utilisateur `ubuntu`, « Connecter et installer ». Compare l'empreinte avec la console OVH (KVM :
   `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`), « Faire confiance ». L'installation tourne seule (10 à 15 min) :
   pare-feu, utilisateur `aibox` sans sudo, Claude Code, puis les outils des skills (gh, ripgrep, jq, ffmpeg, Python et
   uv, Chromium sans écran, playwright-cli). Un outil qui échoue est signalé sans bloquer ; relancer réessaie.
3. **Login Claude** : « Ouvrir la page de connexion », connecte-toi, colle le code, « Envoyer le code ».
4. **Jetons** (« Repos et accès ») : repos autorisés (`propriétaire/nom`), propriétaires interdits, organisations. Un
   jeton GitHub *fine-grained* sur tes repos (Contents, Pull requests, Workflows en écriture, Metadata en lecture) dans
   « GH_TOKEN ». Il reste dans le trousseau ; le serveur ne le reçoit qu'en mémoire, à chaque lancement.
5. **Environnement** : « Synchroniser l'environnement » (Réglages › Serveur distant) copie tes skills, tes agents, la
   bibliothèque design-md, tes plugins, ton CLAUDE.md global et la mémoire de tes repos autorisés. Seuls les fichiers
   modifiés repartent ; rien ne revient du serveur. « Je m'absente » le fait aussi (une minute au plus, sinon on part
   sans). « Détails » liste ce qui est resté sur le PC.
6. **Je m'absente** (ou écran verrouillé / 10 min d'inactivité si tu l'actives) : le serveur démarre, chaque worker
   pousse sa branche et continue là-bas. PC en veille, le tour en cours va au bout et le téléphone (ntfy) sonne.
   **Je suis de retour** : chaque worker pousse, revient ici avec ses commits, ton dossier est tiré, le serveur se met
   en veille (*shelve* : seul le disque est facturé).
7. **Coût** : 0,04 € HT l'heure allumée + ~0,55 €/mois de disque en veille. 60 h par mois ≈ 3 € ; toujours allumé ≈ 29 €.
   Le quota de l'abonnement Claude est le même qu'ici : la nuit consomme celui du lendemain.
8. **Si ça casse** : clé refusée → ajoute la clé admin par la console OVH ; « identité changée » → réinstallé ?
   « Oublier l'ancienne identité », sinon arrête-toi ; serveur injoignable → les workers restent en pause ici ;
   synchronisation « n'a pas abouti » → relance une fois le serveur allumé ; jeton expiré → colle-en un neuf,
   « Revérifier les repos ». Tout arrêter : supprime le jeton, `claude auth logout` sur le serveur (ou l'instance),
   « Oublier l'accès OVH », décoche « Workers distants activés ».

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

## Organisation : application GitHub (prête, pas activée)

Un repo d'organisation tourne sur le serveur seulement avec le jeton d'une heure d'une application GitHub installée
sur l'organisation, jamais avec ton jeton perso ; tant qu'elle n'est pas configurée, ses workers restent sur le PC.
Un **propriétaire** de l'organisation la crée : https://github.com/organizations/Coiffissimo-professional/settings/apps/new
- Nom : « AI Box workers » ; URL de la page d'accueil : celle du repo de l'AI Box ; Webhook : décoché.
- Permissions de repo : Contents, Pull requests, Workflows en lecture et écriture ; Metadata en lecture. Rien d'autre.
- « Only on this account », créer, puis « Generate a private key » (un fichier .pem) et « Install » sur les repos voulus.
- Dans « Accès de l'organisation » : colle l'App ID et le contenu du .pem. La clé reste dans le trousseau du PC.
