# Reprise après un changement de réseau

Un Wi-Fi qui tombe, le passage au partage de connexion du téléphone, le retour au Wi-Fi ou une sortie de veille coupent
la requête en cours d'une session. AI Box reprend le tour coupé tout seul :

- une coupure réseau est retentée après 3 s, puis 15 s, 1 min, 3 min et 10 min ; ensuite AI Box abandonne et le dit
  (au maître aussi, pour un worker). Un essai ne compte pas tant que l'ordinateur n'a aucun réseau ;
- pendant qu'une session travaille, AI Box regarde le réseau toutes les 3 s (rien quand aucune session ne travaille).
  Un changement de réseau ou une sortie de veille relance tout de suite les tours en attente ;
- un programme resté accroché à l'ancienne connexion est relancé sur la même conversation : si le modèle ne répond
  plus 90 s après le changement, ou à la deuxième coupure de suite ;
- si l'utilitaire Power Box tourne, sa note de bascule (`%LOCALAPPDATA%\Power Box\network-state.json`) compte aussi
  comme un changement. Il n'est pas nécessaire.

## Tester en réel sur un portable

À faire avec l'app installée, un worker Claude et un téléphone qui partage sa connexion. Donner au worker une tâche
longue qui écrit beaucoup (par exemple : « explique ce dépôt fichier par fichier »), pour avoir le temps de couper en
plein tour.

1. **Wi-Fi → partage du téléphone.** Pendant que le worker écrit, couper le Wi-Fi (ou s'éloigner de la box), puis se
   connecter au partage du téléphone.
2. **Retour au Wi-Fi.** Relancer une tâche longue, puis revenir au Wi-Fi pendant qu'elle tourne.
3. **Sortie de veille.** Relancer une tâche longue, mettre le portable en veille (capot fermé) une minute, puis le
   rouvrir.

## Ce qu'on doit observer

- Dans la conversation du worker, un avis : « La connexion a été coupée pendant ce tour. Il est repris
  automatiquement dans 3 s, ou dès que le réseau revient. » Le worker reste affiché au travail, il n'est ni endormi ni
  signalé silencieux.
- Quelques secondes après la reconnexion, un message du hub demande au worker de reprendre où il en était, et il
  continue dans la même conversation (son historique est intact). Ce message n'arrive qu'une fois.
- Si le programme restait accroché à l'ancienne connexion : au plus 90 s après le changement, l'avis « Le réseau a
  changé et le programme de cette session restait bloqué sur l'ancienne connexion : il a été relancé sur la même
  conversation, et le tour est repris. » Une relance arrête les tâches de fond du worker (un serveur de dev, par
  exemple) : il les relance au besoin.
- Si la coupure tombe avant que le modèle ait fini un premier bloc de réponse, le programme réessaie d'abord lui-même
  (le worker affiche une nouvelle tentative) ; le résultat attendu reste le même.

Signes d'échec à signaler : un worker toujours « au travail » sans rien écrire plus de 2 min après le retour du réseau,
sans aucun des avis ci-dessus ; deux messages de reprise pour une seule coupure ; ou l'avis « n'est plus repris
automatiquement » alors que le réseau marchait.
