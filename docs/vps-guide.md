# Serveur distant : guide pas à pas (expérimental)

Un clic sur « Je m'absente » et les workers au travail continuent sur ton serveur ; « Je suis de retour » les ramène,
dossiers à jour. Désactivé, rien ne change : pas d'écran, pas de connexion. Aucune valeur à toi (adresse, identifiants,
jetons, liste de repos) n'est dans ce repo : tout reste dans les réglages et le trousseau de ton PC.

## Mise en place (une fois, 20 minutes)

1. **Commander** : OVHcloud Public Cloud, instance **d2-8** (4 vCPU / 8 Go, à l'heure), Ubuntu 24.04, région Gravelines ou
   Strasbourg. Un VPS toujours allumé marche aussi (choisis alors « toujours allumé »).
2. **Clé** : Ctrl+K › « Serveur distant (expérimental) » affiche la clé administrateur de ce PC (bouton Copier) :
   colle-la comme clé SSH à la création de l'instance.
3. **Connecter** : adresse IP, utilisateur `ubuntu`, port 22, « Connecter et installer ».
4. **Empreinte** : compare-la avec la console OVH (KVM) : `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`, puis
   « Faire confiance » (une fenêtre te la redemande). L'installation tourne seule (5 à 10 min) : pare-feu, utilisateur
   `aibox` sans sudo, Node, `gh`, Claude Code.
5. **Login Claude** : « Ouvrir la page de connexion », connecte-toi, colle le code affiché, « Envoyer le code ».
6. **Repos et accès** : liste les repos autorisés (un `propriétaire/nom` par ligne), les propriétaires interdits et tes
   organisations. Crée un jeton GitHub *fine-grained* (tes repos seulement : Contents, Pull requests, Workflows en
   écriture, Metadata en lecture, 1 an) et colle-le dans « GH_TOKEN ». Il reste dans le trousseau du PC ; le serveur ne
   le reçoit qu'en mémoire, à chaque lancement. « Revérifier les repos » : l'étape « Enregistré » passe au vert.
7. **Téléphone** : « Créer une adresse », abonne-toi dans l'app ntfy, « Envoyer un test ».
8. **Allumage à l'heure** : sur https://eu.api.ovh.com/createToken/, un jeton limité à l'instance (GET de l'instance,
   POST start, shelve, unshelve) ; colle project id, instance id et les trois clés dans « Alimentation ». Éteinte, elle
   est mise en *shelve* (seul le disque est facturé), jamais simplement arrêtée (toujours facturée chez OVH).
9. **Postes** : rien à régler. Un poste qui pilote Blender, Unity, le navigateur ou plusieurs dossiers reste sur ce PC et
   se met en pause pendant ton absence ; « Tourne sur » (Réglages › Équipe) ne sert qu'aux exceptions.

## Au quotidien

10. **« Je m'absente »** (ou écran verrouillé / 10 min d'inactivité si tu l'actives) : le serveur démarre, chaque worker
    au travail commite et pousse sa branche, puis continue là-bas à partir d'un brief (mission, dernier rapport, branche,
    commit). Le maître et le worker le notent dans leur conversation.
11. Pendant l'absence : les rapports arrivent au maître comme d'habitude tant que l'app est ouverte. PC en veille, le tour
    en cours continue seul sur le serveur jusqu'à sa fin (ou jusqu'à ce qu'il ait besoin du hub), et le téléphone sonne.
12. **« Je suis de retour »** : chaque worker distant pousse, revient dans sa conversation d'ici avec la liste des commits
    et son rapport, ton dossier est mis à jour (pull), et le serveur se met en veille.

## Si ça casse (chaque cas a son message et sa sortie propre)

13. « Le serveur refuse la clé » : ajoute la clé administrateur depuis la console OVH, relance.
14. « L'identité du serveur a changé » : réinstallé ? « Oublier l'ancienne identité ». Sinon, arrête-toi là.
15. Connexion coupée (Wi-Fi, veille) : « connexion coupée » et un bouton Reprendre ; le tour continue seul là-bas.
    « Tourne encore seul sur le serveur » : attends la notification, puis Reprendre.
16. Serveur éteint ou injoignable : « Je m'absente » met les workers en pause ici ; ils reprennent au retour.
17. Branche déjà prise : le message dit qui l'écrit, de quel côté et depuis quand ; ramène (ou ferme) l'autre d'abord.
18. Au retour, « reste sur le serveur » : son travail n'était pas poussé ; rien n'est rapatrié ni effacé. Reprends-le,
    « pousse ta branche », puis « Je suis de retour ». « Conflit » : la branche a bougé des deux côtés, le worker
    réconcilie par rebase. « À relire » : le serveur a touché des fichiers qui lancent des programmes ici (réglages de
    Claude Code, hooks, CI) : rien n'est tiré sans ton accord.
19. Jeton révoqué ou expiré : les repos passent « refusé par GitHub » ; colle un nouveau jeton, « Revérifier les repos ».
20. Tout arrêter : supprime le jeton GitHub, `claude auth logout` sur le serveur (ou supprime l'instance), « Oublier
    l'accès OVH », puis décoche « Workers distants activés » : l'app redevient exactement comme avant.

## Ce qui marche pareil, ce qui diffère

- Pareil : git, `gh` (PR, releases, `gh api`), npm, builds et tests, Playwright sans écran, rapports au maître.
- Différent : pas de serveurs MCP du PC (Blender, Unity, navigateur visible) ; les CLI qui veulent un jeton (Supabase,
  Cloudflare, npm, Vercel) le reçoivent seulement s'il est rangé dans « Repos et accès », par périmètre (perso ou
  organisation) ; une organisation passe par son application GitHub (jeton d'une heure), jamais par ton jeton perso.
- Pas encore (phase 2, un service sur le serveur) : reprendre la main sur un tour détaché sans attendre sa fin, un
  maître qui lance de nouvelles missions PC fermé, et l'extinction du serveur décidée par le serveur lui-même.
