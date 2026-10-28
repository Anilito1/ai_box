# Notes de version

Ce que l'app montre au lancement quand elle a changé depuis le dernier lancement (nouvelle version, ou build après un
`git pull`). Chaque ligne n'est montrée qu'une fois ; celles des builds sautés s'additionnent ; une nouvelle installation
ne montre rien.

Écrire : en haut du fichier, sous `## AAAA-MM-JJ`, des sections `### Ajouté`, `### Modifié`, `### Supprimé`, une ligne
`- …` courte par changement, en français, vue par l'utilisateur (pas de nom de fichier, de commit ni de jargon). Ne pas
réécrire une ligne déjà publiée : modifiée, elle serait montrée à nouveau. Un changement invisible pour l'utilisateur
n'a pas de ligne. `npm run notes` propose un brouillon tiré des commits depuis la dernière modification de ce fichier ;
`npm test` vérifie sa forme.

## 2026-10-28

### Ajouté

- Flèche ↑ / ↓ dans la zone de saisie : retrouver les messages déjà envoyés, comme dans un terminal.
- Les nouveautés s'affichent au lancement après une mise à jour.
- Fournisseurs compatibles OpenAI personnalisés, dans Réglages › Comptes.
- Les workers se regroupent sous un chef d'équipe qui rend compte au maître.
- Connexion en un clic à un serveur MCP depuis le panneau MCP.
- Les postes de l'équipe peuvent tourner sur n'importe quel fournisseur connecté.

### Modifié

- Le compteur d'usage de la barre d'état suit le bon compte, se met à jour tout seul et affiche « inconnu » plutôt qu'un faux 0 %.
- Nouvelle mascotte 3D pour DeepSeek.
- Les commandes propres au terminal ouvrent le panneau de l'app qui les remplace.
- La mise à jour en un clic des CLI fonctionne sous Windows.

### Supprimé

- Le coût par session sur les cartes et dans la zone de saisie.
