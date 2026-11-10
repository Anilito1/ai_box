# Console Gaming locale

Le bouton **Gaming** ouvre une console d’essai intégrée à AI Box. Elle utilise uniquement des données fictives embarquées : aucun compte, secret, abonnement ni accès réseau n’est nécessaire.

- **Essai hors ligne** prépare quatre brouillons et 32 manifestes de cartes avec sous-titres et rapports de qualité, sans créer de publication.
- **Activer / désactiver le socle**, puis **Démarrer**, autorise le fonctionnement local. **Arrêter** empêche les cycles suivants ; un cycle en cours termine ses écritures locales.
- La planification est facultative et impose un intervalle entre une minute et 24 heures. Les cycles ne se chevauchent pas. Après chaque redémarrage de l’app, il faut démarrer explicitement le service.

La configuration se trouve dans le sous-dossier `news-bot` des données de l’instance. Le réseau et les publications X/TikTok sont toujours imposés à `false`. Les résultats sont dans `news-bot/dry-run` ; les rapports de qualité indiquent les blocages, notamment l’absence d’outils ou de police autorisée. Aucun média n’obtient de certification de publication.

Le stockage bloque les nouveaux essais au-delà du budget local ; le nettoyage des seuls résultats d’essai reste explicite. Les journaux renvoyés à la console ne contiennent que des codes fixes.

## Vérifications isolées

```sh
node scripts/news-bot.mjs dry-run
node scripts/news-bot.mjs test
npm run typecheck
npm test
npm run build
npm run ui -- press Escape + click '#open-newsbot' + text '.newsbot-dialog'
```

Le harness écrit dans un nouveau dossier temporaire. `npm run ui` utilise des données temporaires isolées, sans ouvrir l’application installée.

FFmpeg, ffprobe et Tesseract sont facultatifs et ne sont jamais installés automatiquement. Sans police choisie explicitement et autorisée, l’essai enregistre les manifestes et les blocages, sans rendre de vidéo. Les connexions de comptes et adaptateurs de publication restent hors de cette fonctionnalité locale.
