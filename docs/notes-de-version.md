# Notes de version

Ce que l'app montre au lancement quand elle a changé depuis le dernier lancement (nouvelle version, ou build après un
`git pull`). Chaque ligne n'est montrée qu'une fois ; celles des builds sautés s'additionnent ; une nouvelle installation
ne montre rien.

Écrire : en haut du fichier, sous `## AAAA-MM-JJ`, des sections `### Ajouté`, `### Modifié`, `### Supprimé`, une ligne
`- …` courte par changement, en français, vue par l'utilisateur (pas de nom de fichier, de commit ni de jargon). Ne pas
réécrire une ligne déjà publiée : modifiée, elle serait montrée à nouveau. Un changement invisible pour l'utilisateur
n'a pas de ligne. `npm run notes` propose un brouillon tiré des commits depuis la dernière modification de ce fichier ;
`npm test` vérifie sa forme.

## 2026-11-24

### Ajouté

- Réglages › Espace de travail : « Autoriser tous les dossiers sans confirmation » laisse le maître faire travailler ses workers dans n'importe quel dossier de l'ordinateur, sans vous demander votre accord à chaque fois.

### Supprimé

- Le serveur distant et le bouton « Je m'absente » sont retirés, avec leur page des Réglages : vos workers tournent uniquement sur votre ordinateur, et l'app ne se connecte plus à aucun serveur pour eux.

## 2026-11-22

### Ajouté

- Modèles favoris : dans Réglages › Fournisseurs, marquez d'une étoile les modèles que vous utilisez, chez chaque fournisseur. Dans une conversation, l'onglet ★ du menu de modèle (ou Ctrl+Shift+M) les réunit, rangés par fournisseur : tapez quelques lettres, Entrée, et la conversation passe sur ce modèle, même chez un autre fournisseur, sans rien perdre.
- Le maître connaît vos modèles favoris et peut lancer un worker sur l'un d'eux.

### Modifié

- La liste des modèles d'un fournisseur ajouté (Venice…) reste en mémoire : elle s'affiche tout de suite dans ses réglages, avec un champ pour chercher quand elle est longue.
- Le menu de modèle s'élargit pour montrer tous vos fournisseurs, même quand vous en avez ajouté.
- Sous Linux, vos clés et jetons s'enregistrent dans le trousseau du système sur tous les bureaux (Hyprland, Sway…) ; sans trousseau, l'app le dit et n'enregistre rien.
- Sous Linux, « Se connecter » ouvre votre terminal habituel (kitty, foot, alacritty…).
- Sous Linux, fermer une session ou quitter l'app arrête aussi ce qu'elle avait lancé (serveurs, commandes en arrière-plan), comme sous Windows.
- Sous Linux, la fenêtre garde les boutons de votre bureau (réduire, agrandir, fermer) : plus de bouton fermer en double.

## 2026-11-21

### Ajouté

- Vidéos à partir de vos images : joignez-en une ou plusieurs à votre message avec votre demande, le modèle vidéo s'en sert dans l'ordre où vous les avez jointes (citez-les « @Image1 », « @Image2 »… dans votre demande). Une vidéo que vous donnez peut aussi être retravaillée.
- Les images et les vidéos dont parlent les messages s'affichent dans la conversation : la vidéo se lit sur place (pause, avance, plein écran, son), « Télécharger » en enregistre une copie où vous voulez et « Ouvrir le dossier » montre le fichier. Une image ou une vidéo d'un site web ne se charge que si vous cliquez sur « Afficher ici ».
- Coût API, en bas à droite : choisissez en haut « Total » ou un fournisseur (Anthropic, Venice, OpenAI…) pour voir ce que vous avez dépensé chez chacun, calculé à ses propres prix. Les vidéos générées y sont comptées, et un modèle dont le prix n'est pas connu montre ses tokens avec « prix inconnu » au lieu de 0 $.
- « Nouvelle conversation », sous la carte du maître (Ctrl+N) : parlez vous-même à un de vos modèles, dans le dossier de votre choix, sans passer par le maître. Elle s'endort quand elle ne sert plus et reprend avec toute sa conversation à votre message suivant.
- Génération de vidéos avec un fournisseur ajouté (Venice) : ses modèles vidéo sont trouvés tout seuls et listés dans Réglages › Comptes, sous « Vidéo », où vous pouvez aussi en ajouter un à la main. Demandez une vidéo au maître ou à un worker : il annonce le prix, la génère et vous donne un lien pour l'ouvrir ; elle est enregistrée dans votre dossier Vidéos › AI-Box. Ces modèles ne sont jamais proposés pour faire tourner une session.

### Modifié

- Dans les Réglages, la section « Comptes » s'appelle désormais « Fournisseurs ».
- Le panneau « Coût API » est plus compact : fournisseur et période dans un seul en-tête, une ligne par élément, et les longues listes repliées derrière « de plus ».
- Un changement de réseau (Wi-Fi qui tombe, passage au partage de connexion du téléphone, sortie de veille) ne laisse plus une session en panne : le tour coupé est repris tout seul en quelques secondes, dès que le réseau revient.

## 2026-11-20

### Ajouté

- Réglages › Énergie : le PC reste éveillé pendant que des workers travaillent, et peut continuer capot fermé ; une garde batterie le met en veille prolongée avant qu'il ne s'éteigne (avec une notification), et vos réglages d'alimentation reviennent à la fin. La barre d'état indique quand le PC est tenu éveillé.

### Supprimé

- Réglages › Énergie et son indicateur dans la barre d'état : le PC reste de nouveau simplement éveillé pendant que des workers travaillent, comme avant.

## 2026-11-18

### Ajouté

- Quand une livraison échoue, le maître la renvoie au worker et le hub le fait monter d'un cran tout seul : l'effort d'abord, puis le modèle, jusqu'à Fable. Le panneau des coûts compte ces relances après un échec.
- Quand le fournisseur coupe un tour (surcharge, panne passagère), la session le reprend toute seule un peu plus tard, jusqu'à trois fois, au lieu de rester arrêtée en plein travail.
- Les workers ont un outil d'exploration du code : un assistant rapide (Haiku) cherche et lit à leur place et leur répond en quelques lignes, ce qui allège leurs conversations. Son coût compte dans le panneau des coûts.

### Modifié

- Le maître délègue sur les modèles les plus puissants : tout ce qui écrit du code ou des fichiers part au moins en Opus, les gros chantiers en Fable, les recherches et les tests en Sonnet, les petits relevés en Haiku.
- Les renforts d'un poste suivent ce choix, même quand le poste a un modèle fixé.
- En mode « Tout autoriser », une commande en plusieurs parties passe aussi sans carte quand seule une règle de confirmation du projet l'arrêtait. Si l'une de ses parties déclenche un contrôle de sécurité, la carte reste.
- Quand l'un de tes hooks demande une confirmation, la carte s'affiche même en « Tout autoriser » : jusqu'ici, une règle de confirmation du projet sur la même commande la faisait passer sans te demander.
- Sous Windows, ce qu'un worker a lancé (serveur de dev, navigateur de test, calcul sur la carte graphique) s'arrête avec lui, et plus rien ne reste en marche après la fermeture de l'app.
- Une conversation au repos garde son cache plusieurs heures : le premier message après une longue pause coûte bien moins cher. Ces relances discrètes comptent dans le panneau des coûts.
- Les workers ne chargent plus Playwright : ils pilotent un navigateur en ligne de commande quand il le faut, ce qui allège chacun d'eux en mémoire et en tokens.

## 2026-11-17

### Ajouté

- Un avis prévient quand un hook de tes réglages Claude Code échoue sans cesse : jusqu'ici ces échecs ralentissaient les sessions sans que rien ne le dise.
- Le panneau des coûts montre les missions de la période : le worker, son modèle et qui l'a choisi, les relances, les erreurs et le temps de travail.
- Quand un worker annonce un commit poussé, le hub vérifie qu'il est bien sur le dépôt distant et prévient le maître sinon.

### Modifié

- En mode « Tout autoriser », une commande en plusieurs parties (une boucle de déploiements, par exemple) passe elle aussi quand seule une règle de confirmation du projet l'arrêtait.
- Les conversations ne repartent plus à neuf au changement de sujet ni après une heure de pause : le maître et les workers ponctuels ne repartent à neuf qu'à 90 % de leur contexte.
- Les sessions Fable gardent toute leur fenêtre de contexte (1M) : elles ne se compactent plus vers 170 K.
- Le maître confie les analyses et les rapports à des modèles plus économes, et range ses réponses par sujet sans requête de plus.
- Les workers démarrent plus légers : une liste de skills plus courte, et sans MasterTools, qu'ils n'utilisaient pas.
- La liste des workers que lit le maître tient en une ligne par worker ; le détail reste disponible sur demande.
- La mémoire des sujets fonctionne pour les workers : chacun sait à quel sujet il travaille, et ses notes ne sont plus refusées à tort.
- /clear n'est plus refusé à tort quand plusieurs messages sont arrivés pendant un tour. Si la session travaille vraiment, il dit ce qu'elle fait encore et propose « Effacer quand même ».
- En mode « Tout autoriser », les workers ne t'arrêtent plus pour une action qu'une règle d'un projet demande de confirmer (un déploiement, par exemple) : elle passe, et une ligne le signale dans la conversation.

## 2026-11-16

### Modifié

- Les sessions tournent maintenant sur le Claude Code installé sur l'ordinateur quand il est plus récent que celui fourni avec l'app : un nouveau modèle est reconnu tout de suite, avec sa vraie fenêtre de contexte.
- La jauge « ctx » utilise la vraie fenêtre de contexte du modèle qui tourne, telle que l'outil la déclare : plus de pourcentage faux sur les modèles à grande fenêtre. Elle s'affiche avec un « ~ » quand le modèle passe par un autre fournisseur et que la fenêtre n'est qu'une estimation.
- Le bouton « Éphémères » s'appelle maintenant « Fichiers éphémères », et son écran est plus lisible : un récapitulatif sobre par catégorie, une liste aux colonnes alignées (dossier, origine, nombre, taille).

## 2026-11-15

### Ajouté

- Chaque worker range désormais ses captures, rendus d'essai et autres fichiers jetables dans son propre dossier de brouillon, à part des livrables.
- Le bouton « Éphémères » montre, projet par projet, les fichiers jetables laissés par les agents, et les envoie à la corbeille en un clic : seuls les plus sûrs sont cochés d'avance, et les livrables ne sont jamais proposés.
- Au survol de « signal il y a … » d'un worker, un bouton « Analyser » lance un court diagnostic qui explique pourquoi il ne donne plus de signal (tâche longue, validation en attente, process bloqué…) : le verdict s'affiche sous le worker, le détail se déplie, et le maître le reçoit aussi.

## 2026-11-13

### Ajouté

- Sur les abonnements Max et Ultra, la barre du bas affiche aussi l'utilisation hebdomadaire de Fable, avec son heure de réinitialisation.

### Modifié

- Les boutons « Redémarrer » indiquent combien de sessions au travail seront interrompues et redémarrent sans redemander ; la boîte de confirmation à la fermeture s’appelle désormais « AI Box ».
- Sur l'abonnement Ultra, la barre du bas n'affiche plus l'utilisation sur 5 heures : seules les limites hebdomadaires restent.
- La barre du bas n'affiche plus que les limites qui s'appliquent à ton compte et dont la valeur est connue : plus de « inconnu », plus de 5 heures sur un compte qui n'en a pas, et Fable seulement sur les comptes Claude concernés.

## 2026-11-12

### Ajouté

- Un clic sur « Mise à jour disponible » ouvre une fenêtre avec la nouvelle version et ses nouveautés : tu peux mettre à jour tout de suite, ou plus tard.
- Dictée vocale sur Windows : choisis un service de transcription (Groq, OpenAI, xAI ou une autre adresse compatible) et colle sa clé dans Réglages › Comptes › Modèle de dictée ; le bouton micro apparaît alors dans le champ du message.

### Modifié

- La fenêtre de mise à jour indique combien de sessions au travail seront interrompues, et le redémarrage ne redemande plus de confirmation.
- L'assistant du premier lancement suit l'ordre des réglages actuels : comptes, puis sessions, dossiers, GitHub et repos ; le maître démarre sur un fournisseur connecté.
- Les réglages de la dictée vocale sont passés dans Réglages › Comptes ; sur Mac, tu peux garder le modèle d’Apple ou passer par un service en ligne.

## 2026-11-10

### Modifié

- Les sessions reprennent plus sûrement leurs messages et leurs dossiers, et signalent les réglages de permissions refusés.

### Ajouté

- Serveur distant : « propriétaire/* » dans la liste des repos y met tous tes repos d’un compte, et chaque dossier du PC retrouve son repo sur le serveur, même sous un autre nom.
- Serveur distant (expérimental, désactivé par défaut) : un serveur à toi, loué chez un hébergeur, où tes workers continuent leur mission pendant que ton PC est éteint. Il est fait pour tes repos personnels.
- Serveur distant : il s’installe depuis Réglages › Serveur distant › Installer, étape par étape (louer le serveur, coller la clé, se connecter, connecter Claude, donner accès à GitHub), chaque étape cochée ou avec son erreur en clair ; « Copier le prompt d’installation » permet de le faire avec ton IA.
- Serveur distant : « Je m’absente » réveille le serveur si besoin, y copie ta configuration, fait enregistrer leur travail aux workers et les y envoie, puis te dit quand tu peux éteindre le PC.
- Serveur distant : PC éteint, les workers continuent : ils codent, testent, envoient leur travail sur GitHub et écrivent au maître ; ces messages l’attendent sur le serveur et ton téléphone peut te prévenir.
- Serveur distant : « Je suis de retour » rallume le serveur s’il dort, transmet au maître ce qui a été écrit pendant ton absence, met tes dossiers à jour, puis ramène les workers ici ou les laisse finir là-bas, au choix.
- Serveur distant : ce qui pilote ton PC (Blender, Unity, le navigateur que tu vois) n’y part pas : ces workers attendent ton retour. Le maître reste sur ton PC, donc rien de nouveau ne démarre pendant ton absence.
- Serveur distant : si le serveur redémarre pendant le travail d’un worker, sa mission est marquée interrompue, ton téléphone est prévenu, et « Reprendre » la relance à ton retour.
- Serveur distant : un même serveur ne fait tourner qu’un seul accès GitHub à la fois (tes repos, ou une organisation), car ses workers peuvent voir les accès les uns des autres.
- Serveur distant : environ 3 € par mois s’il se met en veille quand il ne sert pas (il peut s’éteindre tout seul, PC éteint), jusqu’à 20 € s’il reste allumé ; le réveiller prend environ 10 minutes.

## 2026-11-09

### Ajouté

- Serveur distant, expérimental et désactivé par défaut : tes workers y continuent pendant ton absence, avec « Je m’absente » et « Je suis de retour » ; il se configure depuis la palette de commandes (Serveur distant).
- Serveur distant : tes skills, plugins, consignes et mémoires y sont copiés pour que ses workers travaillent comme ici, sans ce qui relève de l’entreprise ou de ce PC (bouton « Synchroniser l’environnement », et à chaque absence).
- Serveur distant : ses workers n’utilisent que ton jeton GitHub fine-grained enregistré pour lui ; sans ce jeton, ils ne partent pas et l’app te dit pourquoi.
- Les fichiers et dossiers liés dans les réponses finales s’ouvrent localement, avec un contrôle du périmètre et un message s’ils sont indisponibles.
- Chaque sujet peut garder une mémoire courte pour reprendre le travail sans emporter toute la conversation.
- Un forum d’idées, ouvert par le bouton « Idées » : chacun peut proposer une idée, dire ce qu’il aime ou non, signaler un problème et soutenir les messages des autres d’un +1 ; les brouillons sont gardés sur l’ordinateur.

### Modifié

- Plus de message d’erreur au réveil de l’ordinateur quand un agent OpenAI ou Gemini ne peut pas démarrer.
- Les mascottes animées demandent nettement moins au processeur, surtout quand l’AI Box est en arrière-plan.
- Sous Windows, quand un worker s’arrête, les serveurs, navigateurs de test et outils qu’il avait lancés en arrière-plan s’arrêtent avec lui au lieu de continuer à tourner.

## 2026-11-06

### Ajouté

- Un sous-agent lancé en arrière-plan montre maintenant son activité en direct, et la fenêtre « Activité » se met à jour toute seule en défilant vers le bas ; après un redémarrage, ceux qui travaillent encore réapparaissent.
- Les sous-agents lancés par un worker ou par le maître apparaissent sous sa carte et dans sa conversation, avec leur état et leur dernière action ; un clic montre tout ce qu’ils ont fait.

### Modifié

- Une session dont le dossier a été supprimé ou déplacé le dit clairement, au lieu d'accuser le programme ou le compte.

## 2026-11-05

### Modifié

- Les tâches en arrière-plan s’affichent une par ligne avec un petit résumé ; pour un serveur local, un lien « localhost:8822 » l’ouvre dans le navigateur.
- Quand seules des tâches tournent en arrière-plan, l’animation s’arrête : elles s’affichent en liste fixe sous « En arrière-plan », et l’animation reste réservée à un tour en cours.

## 2026-11-04

### Ajouté

- Une règle « Données clients » tient les données de tes clients loin de Claude : seuls les workers OpenAI les lisent, et ils les anonymisent avant de les transmettre. Elle se voit et se désactive dans Réglages › Sessions.

## 2026-11-03

### Modifié

- L’icône macOS est plus discrète dans le Dock et le Finder, avec des marges mieux équilibrées.
- Les fichiers joints sont conservés dans une copie locale durable ; un plafond de stockage empêche leur accumulation excessive.
- Les coûts Codex et Gemini sont estimés aux tarifs API connus, et Gemini retrouve ses commandes et les consignes à la reprise.
- Le champ de clé API reçoit bien le curseur quand tu choisis ce mode de connexion.
- Les réglages des fournisseurs retrouvent leur fonctionnement précédent.
- Un compte Gemini que Google refuse n’apparaît plus « connecté » : Réglages › Comptes le dit et propose d’utiliser une clé API Gemini à la place.
- Claude reste affiché déconnecté même si ses réglages contiennent une clé API.
- Les postes Claude retrouvent des modèles compatibles par défaut.
- La déconnexion de Claude affiche son état réel et permet de réessayer en cas d’échec.
- La déconnexion de Claude Code retire bien son état connecté, même si le terminal fournit une clé API.
- Les modèles proposés au maître suivent les fournisseurs connectés.

### Ajouté

- Ajoute les consignes d’un fichier Markdown ou texte aux instructions du maître ou d’un poste depuis les réglages.
- Range les postes de l’Équipe dans des dossiers : bouton + à côté de « Équipe », glisser-déposer pour y mettre un poste ou réordonner, clic droit pour renommer, supprimer ou déplacer.
- Joins n’importe quel fichier à un message (PDF, Word, Excel, ZIP, audio, vidéo, photos HEIC…) avec le trombone, en le glissant ou en le collant : la session l’ouvre et le lit.

## 2026-10-30

### Ajouté

- La dictée vocale (bouton micro) est de retour dans le composeur.
- La ligne « Cogitation… » montre si la session vit vraiment : pastille de couleur, tokens reçus, outil en cours, tentatives et limites.

### Modifié

- Un fournisseur ajouté qui fait tourner DeepSeek affiche maintenant la mascotte DeepSeek.
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
