# Notes de version

Ce que l'app montre au lancement quand elle a changé depuis le dernier lancement (nouvelle version, ou build après un
`git pull`). Chaque ligne n'est montrée qu'une fois ; celles des builds sautés s'additionnent ; une nouvelle installation
ne montre rien.

Écrire : en haut du fichier, sous `## AAAA-MM-JJ`, des sections `### Ajouté`, `### Modifié`, `### Supprimé`, une ligne
`- …` courte par changement, en français, vue par l'utilisateur (pas de nom de fichier, de commit ni de jargon). Ne pas
réécrire une ligne déjà publiée : modifiée, elle serait montrée à nouveau. Un changement invisible pour l'utilisateur
n'a pas de ligne. `npm run notes` propose un brouillon tiré des commits depuis la dernière modification de ce fichier ;
`npm test` vérifie sa forme.

## 2026-10-30

### Ajouté

- La dictée vocale (bouton micro) est de retour dans le composeur.
- La ligne « Cogitation… » montre si la session vit vraiment : pastille de couleur, tokens reçus, outil en cours, tentatives et limites.

### Modifié

- Le bouton micro n'apparaît plus sur les ordinateurs où la dictée vocale n'existe pas.
- Pendant une dictée, Entrée termine la dictée au lieu d'envoyer un texte incomplet : le texte attend dans le composeur.
- « Semble bloqué » ne s'affiche plus pour un modèle qui réfléchit sans donner de nouvelles (Codex, Gemini, serveurs compatibles) : la ligne dit seulement depuis quand rien n'est arrivé.
- La ligne d'activité reste exacte quand un sous-agent est arrêté par une limite, et après un changement de compte.

## 2026-10-29

### Modifié

- Les workers travaillent par défaut en effort moyen, et en Sonnet pour l'analyse et les rapports, pour économiser du quota.

## 2026-10-28

### Ajouté

- Couleur de fond de l'app au choix, dans Réglages › Général.
- Flèche ↑ / ↓ dans la zone de saisie : retrouver les messages déjà envoyés, comme dans un terminal.
- Les nouveautés s'affichent au lancement après une mise à jour.
- Fournisseurs compatibles OpenAI personnalisés, dans Réglages › Comptes.
- Les workers se regroupent sous un chef d'équipe qui rend compte au maître.
- Connexion en un clic à un serveur MCP depuis le panneau MCP.
- Les postes de l'équipe peuvent tourner sur n'importe quel fournisseur connecté.

### Modifié

- La barre d'état montre le coût API du jour, remis à zéro à minuit ; au clic, le détail se lit par repo.
- Le compteur d'usage de la barre d'état suit le bon compte, se met à jour tout seul et affiche « inconnu » plutôt qu'un faux 0 %.
- Nouvelle mascotte 3D pour DeepSeek.
- Les commandes propres au terminal ouvrent le panneau de l'app qui les remplace.
- La mise à jour en un clic des CLI fonctionne sous Windows.

### Supprimé

- Le coût par session sur les cartes et dans la zone de saisie.
