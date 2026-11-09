# Mémoire courte par sujet

AI Box conserve un état compact de chaque sujet dans `context-memory.sqlite`, dans le dossier de données propre à l'installation (ou de la fixture UI). Aucun service externe, compte supplémentaire, modèle payant ou index vectoriel n'est nécessaire. Le graphe relationnel est une extension distincte : l'application n'importe aucun module de graphe et ne crée aucune table nodes/edges.

## Comportement intégré

Le maître reçoit l'outil `topic_memory` et des instructions à chaque lancement. Un worker associé à un sujet reçoit aussi cet outil, limité à son sujet. Le maître peut récupérer tout sujet par identifiant explicite ; aucun chargement global n'est proposé.

1. `read` renvoie le dernier état, quelques messages utiles et la pression mémoire. Un sujet inconnu renvoie un paquet nul. La version initiale pour créer un état est `0`.
2. `update` enregistre objectif, résumé court, contraintes, tâches actives, blocages, chemins d'artefacts et prochain pas. `version` doit correspondre à la dernière lecture : une écriture concurrente échoue explicitement.
3. `decision` ajoute une décision attribuée à un message utilisateur par `source`. Une correction utilise `supersedes` : le texte précédent reste conservé. `update` ne peut jamais modifier la liste des décisions.
4. `remember` retient un message utile déjà anonymisé ; ce n'est pas une copie automatique de la conversation.
5. `compact` reçoit un résumé rédigé par le modèle, produit un handoff versionné et garde au plus les quatre derniers messages utiles, moins si nécessaire pour passer sous le seuil de compaction. Une transaction conserve ensemble l'état, le handoff et la suppression des messages courts.

Toutes les écritures demandent `anonymized: true` et une provenance `source` non vide. Exemple synthétique :

```json
{"topic":"audit-local","action":"update","version":0,"anonymized":true,"source":"MESSAGE_001","state":{"objective":"Vérifier TASK_001","tasks":["TASK_001"],"constraints":["Local uniquement"],"nextStep":"Exécuter TEST_001"}}
```

Puis `compact`, avec la version retournée et `text` contenant le handoff. La compaction est guidée par le modèle ; AI Box ne prétend pas pouvoir résumer sémantiquement une conversation sans modèle et n'appelle aucun modèle externe en arrière-plan.

Les messages envoyés dans un sujet connu et les retours de workers routés à un sujet reçoivent un paquet ciblé dans un bloc interne invisible dans la conversation. Les commandes slash restent intactes. Quand un maître au repos change de sujet, AI Box ouvre une nouvelle conversation fournisseur si le sujet précédent dispose d'un résumé enregistré. Au redémarrage, un résumé du sujet de destination autorise ce renouvellement. La liste des sujets et les messages déjà affichés restent conservés pendant l'exécution ; le fournisseur ne reçoit que le nouveau message et le paquet compact, plus les instructions habituelles de l'application. À 90 % de la fenêtre fournisseur, un maître au repos peut aussi repartir avec le résumé enregistré du sujet courant.

Après un redémarrage de l'application, la conversation fournisseur courante et les états compacts sont récupérés. Les anciens transcripts fournisseur ne sont pas effacés, mais cette version ne les agrège pas automatiquement dans l'interface après un renouvellement.

Une session active, une file de messages, une tâche en arrière-plan ou une validation en attente empêchent le renouvellement : aucun travail en cours n'est interrompu pour changer de sujet. Sans résumé, le comportement de conversation existant est conservé. Les handoffs et `freshStart` des workers gardent leur fonctionnement actuel. Les workers reçoivent le paquet ciblé en complément de leur mécanisme de passation existant.

## Modèle et bornes

Schéma SQLite version 1, initialisé paresseusement au démarrage du manager :

| Table | Clé | Contenu |
| --- | --- | --- |
| `states` | topic, version | JSON complet de chaque version de `TopicState` |
| `messages` | séquence ; index topic, séquence | message utile, provenance, date |
| `handoffs` | topic, version du résumé | état compact et taille estimée avant compaction |

`TopicState` contient `topic`, `objective`, `summary`, `decisions`, `constraints`, `tasks`, `blockers`, `artifacts`, `nextStep`, `version`, `summaryVersion`, `createdAt`, `updatedAt`, `provenance`. Chaque décision conserve identifiant, texte, provenance et date, avec éventuellement l'identifiant remplacé. L'historique est append-only ; la lecture d'historique est bornée à 50 versions.

Les limites sont configurables dans le constructeur `TopicMemory`, sans modifier les contrats IPC ou les réglages partagés :

| Limite | Valeur par défaut |
| --- | ---: |
| Warning | 8 000 tokens estimés |
| Compact | 12 000 |
| Hard limit | 16 000 |
| Résumé court | 1 600, maximum configurable 2 000 |
| Paquet ciblé | 4 000 |
| Messages utiles après compaction | 4 |
| Taille maximale d'une écriture | 48 000 octets JSON |

Estimation prudente : octets UTF-8 / 3, arrondis au supérieur ; ce n'est pas le tokenizer exact d'un fournisseur. Warning et compact sont retournés par l'outil ; au hard-limit une nouvelle mémoire est refusée avant insertion. L'état structuré doit tenir sous le budget du paquet et le seuil compact avec une réserve de 256 tokens ; un excès de décisions ou contraintes entraîne une erreur explicite, jamais une suppression silencieuse. Le paquet élimine les messages anciens avant de dépasser son budget et signale la troncature. Les historiques immuables ne sont jamais injectés par défaut.

## Migration, panne et confidentialité

Aucun transcript existant n'est importé, pour éviter de stocker du contenu client brut. Une installation existante démarre avec une mémoire vide, alimentée progressivement par le maître. Les fixtures utilisent leur propre dossier temporaire. La base et les états de sessions sont indépendants : supprimer ou renouveler une conversation n'efface pas les décisions mémorisées. Un identifiant de sujet doit donc rester propre à un chantier ; le maître peut lire explicitement un ancien sujet même après un changement de conversation.

`node:sqlite` est chargé dynamiquement uniquement dans le processus principal. Si SQLite est absent, la base corrompue, inaccessible ou d'une version future, le mode est `unavailable`, une notice est affichée et les sessions habituelles continuent sans mémoire locale. L'outil expose ce mode. Le fichier problématique reste intact ; aucune réparation destructive ou migration implicite n'est tentée. Les erreurs ultérieures de lecture entraînent également un avertissement explicite et aucune injection de mémoire.

La provenance et l'attestation d'anonymisation viennent de l'appelant : elles ne constituent pas une preuve cryptographique d'une décision utilisateur. Un filtre refuse notamment emails, jetons Bearer, clés privées et certaines clés API. Il ne peut reconnaître tous les noms, secrets ou chiffres clients : anonymiser **avant** l'appel reste obligatoire. Aucun transcript n'est automatiquement indexé. Les chemins d'artefacts doivent eux aussi être anonymisés. La base locale n'est pas chiffrée et ses anciennes versions restent sur disque ; rétention, purge et chiffrement sont des extensions futures. Les résumés mémorisés sont enveloppés comme données non fiables, avec échappement des fermetures de blocs internes.

## Pourquoi SQLite, et place du graphe

Le besoin immédiat est une clé de sujet, des versions immuables et des transactions locales. SQLite remplit ce besoin sans service ni module natif additionnel à installer sur les runtimes qui fournissent `node:sqlite`. Une vraie base graphe n'est pas nécessaire pour empêcher la saturation du contexte. Une extension relationnelle locale peut ajouter des liens typés entre sujets, workers, tâches, décisions, artefacts, sources, branches, commits et tests, avec une interface indépendante et des sous-graphes bornés ; elle reste désactivable et hors du chemin critique des sessions.

Si le produit devient multi-utilisateur, Postgres pourra reprendre les clés `(topic, version)`, les documents JSON et les transactions, avec isolation par organisation. Neo4j ne se justifiera que si les traversées et requêtes relationnelles complexes deviennent le besoin principal. Une migration devra être versionnée, sauvegardée, contrôlée et ne devra pas réinjecter l'ensemble des historiques dans les modèles.

## Vérification et relève

Les tests `topicMemory.test.ts` couvrent états, versions, décisions, seuils, compaction, reprise, corruption, SQLite absent et isolation entre sujets. `topicMemoryIntegration.test.ts` exerce le hook réel de session sans fournisseur ni données installées : injection cachée, délimiteurs échappés et renouvellement au repos. Les tests complets existants vérifient les handoffs, sessions et topics historiques.

Suite proposée : rendre les limites réglables dans l'UI, prévoir export/purge et métriques de compaction visibles, puis vérifier la qualité des résumés sur plusieurs missions réelles anonymisées. Une compaction sauvegarde ce que le modèle fournit ; elle ne garantit pas que tous les faits utiles ont été résumés.
