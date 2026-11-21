# Graphe de modèles — POC

Un POC **autonome** (rien n'est branché dans l'app) : enchaîner des modèles appelés par API, chacun avec ses entrées et
sorties typées (texte, image, vidéo, audio), dans un petit graphe qui se présente comme **un seul chatbot**.

```
npm run poc:graph            # construit, démarre le serveur local, ouvre la page
npm run poc:graph -- --no-open
npm run poc:graph:test       # les tests du POC seuls (ils tournent aussi dans npm test)
```

La page s'ouvre sur `http://127.0.0.1:4517` (le port suivant s'il est pris). Tout marche tout de suite en **mode
simulé** : aucune clé, aucun appel réseau.

## Ce qu'on voit

- **À gauche, l'éditeur.** Chaque nœud est une carte : son rôle, son modèle, ses ports (entrées à gauche, sorties à
  droite). Une couleur par type : texte, image, vidéo, audio. On tire un lien d'une sortie vers une entrée ; pendant
  le geste, les entrées compatibles s'allument et les autres s'effacent. Un lien refusé dit pourquoi et propose le nœud
  à insérer quand il existe (« Extraire des images » entre une vidéo et un LLM qui ne lit que des images).
  `＋ Modèle` ajoute un nœud, `×` le supprime, un clic sur un lien puis `Suppr` le retire, `Ranger` réaligne, `JSON`
  montre le format enregistré.
- **À droite, le chat.** Un message traverse tout le graphe. Pendant l'exécution, chaque nœud montre son état (en
  attente, en cours, fait, erreur) et ce qu'il a produit ; la réponse finale (texte, image, vidéo, audio) s'affiche
  dans la conversation, avec le détail des étapes et le coût.
- **Trois exemples** (menu « Exemples… ») : texte → image → vidéo → analyse ; vidéo → images → LLM vision (avec la
  conversion) ; image(s) de référence → image (joindre une image au message).

## Mode simulé, mode réel

Le fournisseur « Simulé » a un modèle par forme (LLM, LLM vision, texte → image, référence → image, image → vidéo…).
Ses réponses sont fabriquées sur place : un paysage dessiné à partir du prompt (PNG), le même paysage animé (un vrai
MP4 H.264 écrit à la main, sans ffmpeg), quelques notes (WAV). Chaque étape dit de quoi elle est partie : on voit la
donnée traverser le graphe. Les modèles simulés ont de faux prix, pour essayer le plafond (mets-le à `0,05`).

Pour le **mode réel**, ajoute un fournisseur compatible OpenAI (adresse `…/v1` + clé) :

- dans la page, bouton **Fournisseurs** : la clé reste dans la mémoire du serveur local, n'est écrite nulle part et ne
  revient jamais dans la page ;
- ou dans `poc/model-graph/.env` (ignoré par git), sur le modèle de `env.example`.

Le POC lit la liste des modèles du fournisseur et en déduit les ports de chacun (voir `ARCHITECTURE.md`). Le bouton
**Réel** remplace alors chaque nœud simulé par le modèle réel le moins cher qui a les mêmes entrées et sorties ; on
peut aussi choisir chaque modèle à la main, ou en déclarer un que la liste ne décrit pas.

| Appel | Fournisseur | État |
| --- | --- | --- |
| LLM (`/chat/completions`, images et vidéo en entrée) | tout compatible OpenAI | testé contre un faux serveur |
| Texte → image | Venice (`/image/generate`), autres (`/images/generations`) | Venice testé contre un faux serveur |
| Image(s) de référence → image | Venice (`/image/edit`, `/image/multi-edit`), autres (`/images/edits`) | idem |
| Vidéo (file + polling + prix) | Venice, par l'adaptateur existant `src/main/video/venice.ts` | idem |
| Voix, transcription | compatible OpenAI | écrit, non testé |
| Lecture de la liste des modèles | Venice | vérifié sur la vraie liste publique (401 modèles reconnus) |

**Aucun appel payant n'a été fait** : le mode réel n'a pas été essayé avec de vraies clés.

## Fichiers

```
shared/   pur TypeScript, ni Node ni DOM : ce qui irait tel quel dans l'app
  capabilities.ts   ports, ModelSpec, formes de modèles
  detect.ts         liste d'un fournisseur → ports ; déclarations à la main
  graph.ts          format JSON v1, nœuds, conversions
  validate.ts       liens permis, ordre d'exécution, cycles, problèmes d'un graphe
  engine.ts         exécution : ordre, parallélisme, file + polling, plafond, événements
server/   le « process main » du POC : fournisseurs et clés, runners simulés et réels, fichiers produits
client/   la page : éditeur (SVG + DOM, sans dépendance), chat, dialogues
examples/ les graphes d'exemple
```
