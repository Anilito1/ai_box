# Fichiers liés dans les réponses finales

Les réponses restent des messages assistant ordinaires : aucune migration des conversations ni dépendance à un fournisseur.
Le problème initial était l’envoi de tous les liens Markdown à `open-external`, limité à HTTP(S).

## Utilisation

Les fichiers générés doivent être enregistrés dans le workspace de la session, par exemple dans `outputs/`,
puis liés dans la réponse finale : `[Correction](outputs/TD01-correction.md)`. Le Bureau ne doit pas servir
de destination de sortie. Un clic ouvre le fichier local ; Alt-clic le révèle dans le gestionnaire de fichiers.

## Fonctionnement

Le renderer réécrit les destinations locales en ancres internes avant assainissement du Markdown. Une réponse terminée
rend également cliquables les chemins absolus et `./…` ou `../…` en code en ligne ou texte seul. Pour un nom avec
espaces, employer `[rapport](<docs/mon rapport.pdf>)` ou un chemin en code en ligne. Les chemins relatifs des liens
Markdown partent du workspace de la conversation ; le survol et le nom accessible indiquent le chemin complet.
Les suffixes de source `:ligne`, `:ligne:colonne` et `#Lligne` sont retirés. Les blocs de code restent du code.

Un clic ouvre avec l’application par défaut ; Alt-clic révèle l’élément dans le gestionnaire de fichiers.
`session:open-file(sessionId, path, open|reveal)` est un invoke du preload typé, enregistré via le wrapper IPC existant
qui vérifie le webContents et la page émettrice. Le renderer ne fournit jamais la racine autorisée : main la retrouve
dans l’état de la session. Chaque clic refait la validation, sans cache d’autorisation.

Main exige un chemin local, contrôle l’appartenance lexicale puis les chemins réels (racine et cible), et refuse :

- chemins hors workspace, préfixes voisins, liens symboliques sortants ;
- URL, chemins réseau UNC, lecteurs relatifs, caractères de contrôle et encodages ambigus ;
- chemins cachés et noms usuels de secrets, paquets exécutables (`.app`, `.workflow`…), types non autorisés et fichiers spéciaux.

Les documents texte/Markdown/CSV/JSON/PDF, images raster, médias courants et dossiers ordinaires sont autorisés.
HTML, SVG, scripts et raccourcis exécutables restent refusés. Aucun fichier n’est lu, envoyé au renderer ou téléversé.
Les résultats d’erreur sont des codes fixes (invalide, hors périmètre, absent, type refusé, échec d’ouverture) traduits
dans l’interface ; les exceptions et messages système ne traversent pas l’IPC.
Cette règle ne peut pas reconnaître tous les secrets dans un document ordinaire : elle évite les emplacements
sensibles usuels et ne lit jamais le contenu. Elle n’est pas un scanner de documents.

## Vérification et limites

`src/main/localFiles.test.ts` teste les cinq catégories, révélation, disparition, erreurs système, traversées,
préfixes voisins, symlinks sortants, URL, UNC, NUL, secrets et paquets exécutables ; aucun appel shell sur les refus.
`src/renderer/localFiles.test.ts` lance Electron avec profil/HOME temporaires : clics sur les cinq liens, Alt-clic,
chemins avec espaces, code en ligne, chemin absolu, vrais invoke IPC et refus d’émetteur étranger.
Une correction Markdown synthétique dans un dossier `Desktop` vérifie aussi le clic et Alt-clic ; les tests main
acceptent ce même chemin absolu avec le workspace parent ou avec `Desktop` comme workspace. Le lanceur `scripts/ui-entry.cjs` désactive safeStorage avant de charger l’app : aucun accès au trousseau système
n’est nécessaire dans les tests UI (y compris le test de dictée existant et `npm run ui`). Les appels shell
sont espionnés et remplacés ; les fichiers sont des fixtures synthétiques, aucun lecteur externe n’est lancé.

La fixture visuelle est reproductible avec :

```sh
npm run ui -- --config '{"version":2,"workspaces":["/tmp/ai-box-files-fixture"],"claudePath":"/usr/bin/false"}' scripts/ui-fixtures/generated-files.steps.json
```

Elle contrôle les cinq destinations et simule uniquement la réponse « absent » pour le clic. Ce contrôle est isolé,
indépendant du Bureau, des samples réels et de l’application installée.

Sur macOS, révéler utilise Finder ; sous Windows, Explorer ; sous Linux, le gestionnaire installé.
L’ouverture dépend des associations de fichiers et codecs de l’OS ; une erreur d’association reste affichée dans
l’interface. La validation native a été exécutée sur macOS ; Windows/Linux ne sont pas exécutés ici.
Les partages réseau sont volontairement refusés. Les noms contenant `%`, `#`, `?` ou des contrôles sont refusés.
Les artefacts exportés sur le Bureau hors workspace restent refusés : les enregistrer ou les copier dans le
workspace de la session avant de les lier. Aucun accès au Bureau n’est accordé implicitement.
La validation précède immédiatement l’appel shell, mais une application externe reçoit un chemin, pas un descripteur :
un processus local concurrent peut remplacer un fichier après validation (limite TOCTOU de l’API shell Electron).
