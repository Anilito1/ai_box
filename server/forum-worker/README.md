# Forum d'idées de l'AI Box (Worker Cloudflare + D1)

En prod : https://ai-box-forum.braunanil.workers.dev, sur le compte perso braunanil (`account_id` épinglé dans `wrangler.toml`).
Les commandes passent par le profil isolé `~/.cloudflare-profiles/ai-box`, jamais par le login global.

1. `npm ci`, puis `npm run cf:login` (une fois par poste) : connexion avec braunanil@gmail.com, puis « Allow ».
2. `npm run deploy` : vérifie le compte (`--guard`), applique les migrations D1, déploie, pose les secrets qui manquent et vérifie l'URL.
   Le premier passage crée la base D1, écrit son id dans `wrangler.toml` et écrit l'URL dans `src/shared/forumEndpoint.ts`. Il refuse de continuer si le nom de la base ou du Worker est déjà pris sur le compte.
3. Clé de modération : générée au premier passage, affichée une seule fois. Elle se colle dans l'app, Réglages › À propos. Pour la changer : `npm run cf:setup -- --rotate-admin-key`.

En local : `npm test` (D1 locale, quotas et accès concurrents), `npm run dev` avec IP_SALT et ADMIN_TOKEN_HASH dans `.dev.vars`.
