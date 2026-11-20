# Optimiseur Windows : audit énergie et réglages réversibles

Objectif : savoir ce qui consomme sur une machine Windows 11, ce qui l’empêche de continuer à travailler capot fermé
(workers AI Box en cours), et quels réglages documentés par Microsoft changer pour consommer moins, avec la commande
pour revenir en arrière.

L’audit ne modifie rien. Les réglages du catalogue ne sont jamais appliqués par le script : c’est à l’utilisateur de
décider et de lancer les commandes.

## Lancer l’audit

```
node scripts/energy-audit/run.mjs                       # rapport Markdown dans le terminal
node scripts/energy-audit/run.mjs --json                # même contenu en JSON
node scripts/energy-audit/run.mjs --out rapport.md      # écrit rapport.md et rapport.json
node scripts/energy-audit/run.mjs --sample 10           # échantillon des processus sur 10 s (5 par défaut)
```

- Durée : une vingtaine de secondes (dont l’échantillon des processus).
- Windows uniquement, Node 22 et Windows PowerShell 5.1 (fourni avec Windows). Aucune dépendance à installer.
- Lecture seule : `powercfg` n’est appelé qu’avec des options de lecture (`/qh`, `/a`, `/lastwake`, `/devicequery`,
  `/batteryreport`, et en administrateur `/requests`, `/waketimers`) ; le reste passe par des classes CIM/WMI, le
  registre en lecture, le journal Système et `nvidia-smi` quand il existe. Aucun processus n’est arrêté, aucun réglage
  changé, rien n’est envoyé sur le réseau.
- Fichiers temporaires (sortie du collecteur, rapport batterie de Windows) : dans un dossier du répertoire temporaire,
  supprimé à la fin.
- Sans droits administrateur, quatre informations manquent (dites en fin de rapport) : `powercfg /requests` (qui
  bloque la veille), `powercfg /waketimers`, `powercfg /sleepstudy` et les options de réveil des cartes réseau. Relancer
  la même commande depuis un terminal administrateur les ajoute, toujours en lecture seule.
- Anonymisation : nom du compte, nom de la machine, chemins du profil, SID, adresses e-mail et identifiants propres au
  profil sont remplacés. Le collecteur ne lit ni numéro de série, ni nom de réseau Wi-Fi (SSID), ni ligne de commande
  (seulement « est-ce un processus AI Box ? »).
- `--apply` n’existe pas : l’option est refusée avec un message.

Code : `scripts/energy-audit/` — `collect.ps1` (collecte), `parse.mjs` (lecture de `powercfg`, indépendante de la
langue de Windows), `analyze.mjs` (constats et recommandations), `catalog.mjs` (réglages), `report.mjs` (Markdown),
`run.mjs` (ligne de commande). Tests : `npm test` (fixtures anonymisées dans `scripts/energy-audit/fixtures/`).

## Lire le rapport

Chaque constat porte un niveau : ⛔ bloquant (empêche de travailler capot fermé), 🔴 à corriger (gaspillage net),
🟠 à surveiller, 🟢 correct, ℹ️ information. La flèche `→ id` renvoie au réglage du catalogue qui y répond.

| Section | Ce qui est mesuré | Comment le lire |
|---|---|---|
| Verdict | Portable ou bureau (batterie, capot, type de châssis SMBIOS), veille S0 ou S3 (`GetPwrCapabilities`, indépendant de la langue), mode de gestion actif, ce qui arrête les workers capot fermé, état de la batterie. | Les trois réponses à lire d’abord. |
| Recommandations | Réglages du catalogue qui répondent aux constats, sans ceux déjà en place, classés par gain puis risque, avec les commandes pour appliquer et annuler (valeurs mesurées sur la machine). | Lire « Ce que ça change » avant d’appliquer quoi que ce soit. |
| Batterie | Capacité d’origine et pleine charge (santé), cycles, fabricant, chimie, débit instantané (WMI `BatteryStatus`), consommation moyenne sur batterie et en veille (historique de `powercfg /batteryreport`), autonomie estimée. | Santé sous 80 % : usure visible ; sous 60 % : remplacer la batterie rapporte plus que tout réglage. Perte en veille au-delà d’1 W : quelque chose empêche la veille profonde. |
| Veille et réveils | États disponibles (`powercfg /a`), dernier réveil, périphériques autorisés à réveiller, réveils et mises en veille des 14 derniers jours (journal Système : Power-Troubleshooter 1, Kernel-Power 42/107/506/507/41), tâches planifiées qui peuvent réveiller, demandes d’alimentation (administrateur). | Une carte réseau autorisée à réveiller ou des minuteurs autorisés sur batterie expliquent les réveils dans un sac. Les arrêts non propres (Kernel-Power 41) coupent les workers en plein tour. |
| Mode de gestion | Valeurs secteur et batterie du mode actif (`powercfg /qh`) : capot, bouton, veille, veille prolongée, écran, processeur (min/max, EPP, turbo, parking), refroidissement, PCI Express, USB, Wi-Fi, économiseur, batterie critique ; mode de puissance de Paramètres ; démarrage rapide. | Un état minimal du processeur à 100 % ou une EPP à 0 sur secteur = processeur jamais au repos. |
| Processus | Échantillon de N secondes : temps processeur, mémoire privée, entrées/sorties, charge GPU par processus, regroupés par nom ; applications connues qui tournent sans fenêtre ; processus AI Box mis à part. | Le % processeur est rapporté à toute la machine (100 % = tous les cœurs). Impact estimé : élevé ≥ 5 % du processeur ou 10 % du GPU ; moyen ≥ 1 % du processeur, 2 % du GPU ou 5 Mo/s. C’est une estimation relative : Windows ne donne pas les watts par processus. |
| Démarrage | Clés Run et dossier Démarrage (avec l’état activé/désactivé de Paramètres), tâches de démarrage des applications du Store, tâches planifiées tierces à la connexion, services tiers en démarrage automatique (éditeur lu dans l’exécutable). | « Tourne » et « Mémoire » donnent le poids réel du programme en ce moment. Les services de sécurité, de pilotes et de Claude/AI Box sont listés « à garder ». |
| Divers | Radios (Wi-Fi, Bluetooth), cartes réseau, écrans (nombre, définition, fréquence, luminosité), économiseur d’énergie, applications du Store autorisées en arrière-plan, captures Xbox Game Bar, stockage libre, consommation de la carte NVIDIA (`nvidia-smi`). | Une carte graphique de bureau au repos au-delà de 30 W est souvent bloquée en état P0 par plusieurs écrans ou une haute fréquence d’affichage. |
| Ce que l’audit n’a pas pu lire | Ce qui demande l’administrateur, sections en erreur. | Relancer en administrateur si la question porte sur la veille. |

Les processus AI Box (`claude.exe`, l’app elle-même, et tout ce qu’ils ont lancé : `node`, `bash`, `git`,
`powershell`…) ne sont jamais proposés à l’arrêt ; ils sont listés à part.

## Capot fermé : ce que fait Windows

- **Veille moderne (S0)** : fermer le capot met l’écran en veille et la machine en « veille moderne » ; le réseau peut
  rester actif, mais les applications de bureau (dont les workers) sont gelées. **Veille classique (S3)** : tout
  s’arrête. Dans les deux cas, les workers s’arrêtent si l’action du capot est « Mettre en veille ».
- Une **demande d’alimentation** tenue par une application (`SetThreadExecutionState(ES_SYSTEM_REQUIRED |
  ES_CONTINUOUS)` ou `PowerSetRequest`) empêche la veille sur inactivité, **pas** l’action du capot : seul le réglage
  `LIDACTION` = 0 (« Ne rien faire ») garde la machine éveillée capot fermé.
- Recette sans risque pour un portable branché : `lid-nothing-ac`. Sur batterie : `lid-nothing-dc` seulement le temps
  du travail, avec `critical-hibernate` (veille prolongée à batterie critique) et `cpu-boost-dc` (turbo coupé) ; l’app
  doit tenir une demande d’alimentation tant qu’un worker tourne, et la relâcher ensuite pour que la veille reprenne.
- Capot fermé, l’écran interne s’éteint de lui-même : pas besoin de régler l’écran pour ça.
- Chaleur : une machine allumée capot fermé dans une housse chauffe ; le refroidissement passe par le clavier sur
  beaucoup de portables.

Sources : [action du capot](https://learn.microsoft.com/windows-hardware/customize/power-settings/power-button-and-lid-settings-lid-switch-close-action),
[veille moderne](https://learn.microsoft.com/windows-hardware/design/device-experiences/modern-standby),
[SetThreadExecutionState](https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-setthreadexecutionstate),
[options de powercfg](https://learn.microsoft.com/windows-hardware/design/device-experiences/powercfg-command-line-options),
[SleepStudy](https://learn.microsoft.com/windows-hardware/design/device-experiences/modern-standby-sleepstudy).

## Catalogue de réglages réversibles

Uniquement des réglages documentés par Microsoft, réversibles par la commande inverse. Pas de registre exotique, pas de
suppression de service système, pas de « debloat ». Pour les réglages du mode de gestion (`powercfg … SCHEME_CURRENT`),
l’annulation remet la valeur d’avant : **le rapport écrit la commande d’annulation avec la valeur mesurée sur la
machine** ; sinon, noter la valeur avant de changer (`powercfg /qh SCHEME_CURRENT <sous-groupe> <réglage>`).

Les commandes `powercfg /setacvalueindex` (secteur) et `/setdcvalueindex` (batterie) modifient le mode actif ; elles
prennent effet avec `powercfg /setactive SCHEME_CURRENT`. Elles ne demandent pas l’administrateur sur un poste
personnel. Changer de mode (`plan-balanced`) change aussi toutes les autres valeurs : relancer l’audit après.

| Id | Réglage | Gain | Risque | Droits | Pour |
|---|---|---|---|---|---|
| `lid-nothing-ac` | Capot fermé, branché : ne rien faire | élevé | faible | utilisateur | portable |
| `lid-nothing-dc` | Capot fermé, sur batterie : ne rien faire (le temps d’un travail) | élevé | moyen | utilisateur | portable |
| `plan-balanced` | Mode « Utilisation normale » au lieu de « Haute performance » | élevé | faible | utilisateur | tous |
| `cpu-min-state-ac` | État minimal du processeur sur secteur : 5 % | élevé | faible | utilisateur | tous |
| `cpu-boost-dc` | Sur batterie : turbo du processeur coupé | élevé | faible | utilisateur | portable |
| `sleep-idle-ac` | Veille après 30 min d’inactivité sur secteur | élevé | moyen | utilisateur | bureau |
| `cpu-epp` | Préférence énergie/performance : 33 secteur, 50 batterie | moyen | faible | utilisateur | tous |
| `display-off` | Écran éteint après 5 min (secteur) / 2 min (batterie) | moyen | faible | utilisateur | tous |
| `hibernate-idle-dc` | Sur batterie : veille prolongée après 3 h de veille | moyen | faible | utilisateur | portable |
| `wake-timers-dc` | Sur batterie : minuteurs de réveil interdits | moyen | faible | utilisateur | portable |
| `energy-saver-threshold` | Économiseur d’énergie automatique à 30 % | moyen | faible | utilisateur | portable |
| `power-mode-efficiency` | Mode de puissance « Meilleure efficacité énergétique » sur batterie | moyen | faible | utilisateur | portable |
| `refresh-rate` | Fréquence d’affichage à 60 Hz (ou dynamique) | moyen | faible | utilisateur | tous |
| `startup-apps` | Applications inutiles désactivées au démarrage | moyen | faible | utilisateur | tous |
| `browser-background` | Navigateur arrêté une fois fermé | moyen | faible | utilisateur | tous |
| `aspm` | Économie du lien PCI Express au maximum | moyen | moyen | utilisateur | tous |
| `third-party-service-manual` | Service tiers inutile : démarrage manuel | moyen | moyen | administrateur | tous |
| `critical-hibernate` | Batterie critique : veille prolongée | faible | faible | utilisateur | portable |
| `background-apps` | Applications du Store : arrière-plan « Jamais » | faible | faible | utilisateur | tous |
| `game-captures` | Xbox Game Bar : pas d’enregistrement en arrière-plan | faible | faible | utilisateur | tous |
| `third-party-task-disable` | Tâche planifiée tierce à la connexion désactivée | faible | faible | utilisateur | tous |
| `device-wake-off` | Un périphérique ne réveille plus la machine | faible | faible | administrateur | tous |
| `bluetooth-off` | Radio inutilisée coupée (Bluetooth, Wi-Fi en filaire) | faible | faible | utilisateur | tous |
| `usb-selective-suspend` | Suspension sélective USB sur secteur | faible | moyen | utilisateur | tous |

### Capot et batterie

**`lid-nothing-ac`** — Capot fermé, branché : ne rien faire.
Appliquer : `powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0` puis `powercfg /setactive SCHEME_CURRENT`.
Annuler : même commande avec la valeur d’avant (1 = veille, réglage d’usine habituel).
Casse : fermer le capot ne met plus en veille branché ; passer par Démarrer → Veille. Ne pas ranger la machine allumée.
Source : [Lid switch close action](https://learn.microsoft.com/windows-hardware/customize/power-settings/power-button-and-lid-settings-lid-switch-close-action).

**`lid-nothing-dc`** — Capot fermé, sur batterie : ne rien faire.
Appliquer : `powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0` puis `/setactive SCHEME_CURRENT`.
Annuler : même commande avec la valeur d’avant (1 = veille).
Casse : la machine reste allumée et se vide capot fermé, chauffe dans un sac. Le temps d’un travail seulement, avec
`critical-hibernate`.
Source : [Lid switch close action](https://learn.microsoft.com/windows-hardware/customize/power-settings/power-button-and-lid-settings-lid-switch-close-action).

**`critical-hibernate`** — Batterie critique : veille prolongée.
Appliquer : `powercfg /setdcvalueindex SCHEME_CURRENT SUB_BATTERY BATACTIONCRIT 2` puis `/setactive SCHEME_CURRENT`.
Annuler : valeur d’avant (0 rien, 1 veille, 3 arrêt).
Casse : rien ; demande que la veille prolongée soit activée (`powercfg /hibernate on`, administrateur).
Source : [Critical battery action](https://learn.microsoft.com/windows-hardware/customize/power-settings/battery-settings-critical-battery-action).

**`hibernate-idle-dc`** — Sur batterie, veille prolongée après 3 h de veille (évite de vider la batterie en veille).
Appliquer : `powercfg /setdcvalueindex SCHEME_CURRENT SUB_SLEEP HIBERNATEIDLE 10800` puis `/setactive SCHEME_CURRENT`.
Annuler : valeur d’avant (0 = jamais).
Casse : la reprise après une longue veille prend quelques secondes de plus.
Source : [Hibernate idle timeout](https://learn.microsoft.com/windows-hardware/customize/power-settings/sleep-settings-hibernate-idle-timeout).

**`wake-timers-dc`** — Sur batterie, interdire les minuteurs de réveil.
Appliquer : `powercfg /setdcvalueindex SCHEME_CURRENT SUB_SLEEP RTCWAKE 0` puis `/setactive SCHEME_CURRENT`.
Annuler : valeur d’avant (1 autorisés, 2 importants seulement).
Casse : mises à jour et maintenance planifiées attendent le prochain réveil.
Source : [Automatically wake for tasks](https://learn.microsoft.com/windows-hardware/customize/power-settings/sleep-settings-automatically-wake-for-tasks).

**`energy-saver-threshold`** — Économiseur d’énergie automatique à 30 %.
Appliquer : `powercfg /setdcvalueindex SCHEME_CURRENT SUB_ENERGYSAVER ESBATTTHRESHOLD 30` puis `/setactive SCHEME_CURRENT`
(ou Paramètres → Système → Alimentation et batterie → Économiseur d’énergie).
Annuler : valeur d’avant (0 = jamais).
Casse : sous 30 %, arrière-plan limité, luminosité baissée, synchronisation espacée.
Source : [Battery threshold](https://learn.microsoft.com/windows-hardware/customize/power-settings/battery-threshold),
[Conseils d’économie de batterie](https://support.microsoft.com/en-us/windows/experience/power-battery/battery-saving-tips-for-windows).

### Processeur et mode de gestion

**`plan-balanced`** — Mode « Utilisation normale » (Balanced) au lieu de « Haute performance ».
Appliquer : `powercfg /setactive SCHEME_BALANCED`.
Annuler : `powercfg /setactive <GUID du mode d’avant>` (le rapport l’écrit ; `powercfg /list` les montre tous).
Casse : le processeur redescend au repos ; imperceptible hors jeux et calcul soutenu. Seul ce mode affiche les modes
de puissance de Paramètres.
Source : [Powercfg command-line options](https://learn.microsoft.com/windows-hardware/design/device-experiences/powercfg-command-line-options).

**`cpu-min-state-ac`** — État minimal du processeur sur secteur : 5 %.
Appliquer : `powercfg /setacvalueindex SCHEME_CURRENT SUB_PROCESSOR PROCTHROTTLEMIN 5` puis `/setactive SCHEME_CURRENT`.
Annuler : valeur d’avant (100 dans les modes haute performance).
Casse : rien de visible.
Source : [MinPerformance (PROCTHROTTLEMIN)](https://learn.microsoft.com/windows-hardware/customize/power-settings/options-for-perf-state-engine-minperformance).

**`cpu-boost-dc`** — Sur batterie, turbo coupé.
Appliquer : `powercfg /setdcvalueindex SCHEME_CURRENT SUB_PROCESSOR PERFBOOSTMODE 0` puis `/setactive SCHEME_CURRENT`.
Annuler : valeur d’avant (1 activé, 2 agressif…).
Casse : compilations et tests nettement plus lents sur batterie ; les workers, qui attendent surtout le réseau, le
sentent peu.
Source : [PerfBoostMode](https://learn.microsoft.com/windows-hardware/customize/power-settings/options-for-perf-state-engine-perfboostmode).

**`cpu-epp`** — Préférence énergie/performance : 33 sur secteur, 50 sur batterie (0 = tout pour la performance,
100 = tout pour l’économie).
Appliquer : `powercfg /setacvalueindex SCHEME_CURRENT SUB_PROCESSOR PERFEPP 33`, `powercfg /setdcvalueindex
SCHEME_CURRENT SUB_PROCESSOR PERFEPP 50`, puis `/setactive SCHEME_CURRENT`.
Annuler : valeurs d’avant.
Casse : montée en fréquence un peu moins vive.
Source : [PerfEnergyPreference](https://learn.microsoft.com/windows-hardware/customize/power-settings/options-for-perf-state-engine-perfenergypreference).

**`sleep-idle-ac`** — Machine de bureau : veille après 30 min d’inactivité sur secteur.
Appliquer : `powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 1800` puis `/setactive SCHEME_CURRENT`.
Annuler : valeur d’avant (0 = jamais).
Casse : un travail lancé par une application qui ne tient pas de demande d’alimentation peut être suspendu. Les
workers AI Box ne sont protégés que si l’app tient sa demande pendant qu’ils tournent.
Source : [Sleep idle timeout](https://learn.microsoft.com/windows-hardware/customize/power-settings/sleep-settings-sleep-idle-timeout).

**`display-off`** — Écran éteint après 5 min sur secteur, 2 min sur batterie.
Appliquer : `powercfg /setacvalueindex SCHEME_CURRENT SUB_VIDEO VIDEOIDLE 300`, `powercfg /setdcvalueindex
SCHEME_CURRENT SUB_VIDEO VIDEOIDLE 120`, puis `/setactive SCHEME_CURRENT`.
Annuler : valeurs d’avant (en secondes).
Casse : l’écran s’éteint plus tôt pendant une lecture.
Source : [Display idle timeout](https://learn.microsoft.com/windows-hardware/customize/power-settings/display-settings-display-idle-timeout).

**`power-mode-efficiency`** — Mode de puissance « Meilleure efficacité énergétique » sur batterie.
Appliquer : `start ms-settings:powersleep` → Mode de puissance → Sur batterie.
Annuler : même page, valeur d’avant.
Casse : pointes de performance plus lentes sur batterie. Visible seulement avec le mode « Utilisation normale ».
Source : [Change the power mode](https://support.microsoft.com/windows/change-the-power-mode-for-your-windows-pc-c2aff038-22c9-f46d-5ca0-78696fdf2de8).

### Périphériques et affichage

**`aspm`** — Économie d’énergie du lien PCI Express au maximum.
Appliquer : `powercfg /setacvalueindex SCHEME_CURRENT SUB_PCIEXPRESS ASPM 2`, idem `/setdcvalueindex`, puis
`/setactive SCHEME_CURRENT`.
Annuler : valeurs d’avant (0 coupée, 1 modérée).
Casse : sur certaines cartes mères ou cartes graphiques, micro-saccades ou périphérique PCIe qui décroche ; annuler au
moindre symptôme.
Source : [Link State Power Management](https://learn.microsoft.com/windows-hardware/customize/power-settings/pci-express-settings-link-state-power-management).

**`usb-selective-suspend`** — Suspension sélective USB sur secteur.
Appliquer : `powercfg /setacvalueindex SCHEME_CURRENT 2a737441-1930-4402-8d77-b2bebba308a3
48e6b7a6-50f5-4782-a5d4-53bb8f07e226 1` puis `/setactive SCHEME_CURRENT`.
Annuler : même commande avec 0.
Casse : certains récepteurs sans fil, DAC ou adaptateurs USB se déconnectent ou répondent en retard.
Source : [USB Selective Suspend (Microsoft Learn)](https://learn.microsoft.com/troubleshoot/microsoftteams/teams-rooms-and-devices/usb-selective-suspend-status-unhealthy).

**`refresh-rate`** — Fréquence d’affichage à 60 Hz pendant le travail (ou « Dynamique » sur portable).
Appliquer : `start ms-settings:display-advanced` → Choisir une fréquence d’actualisation.
Annuler : même page, fréquence d’avant (le rapport la donne).
Casse : défilement moins fluide. Sur une carte de bureau avec plusieurs écrans à haute fréquence, c’est souvent ce qui
la garde en état P0 (pleine fréquence mémoire) au repos.
Source : [Change the refresh rate](https://support.microsoft.com/windows/change-the-refresh-rate-on-your-monitor-in-windows-c8ea729e-0678-015c-c415-f806f04aae5a).

**`device-wake-off`** — Un périphérique ne réveille plus la machine (souvent la carte réseau).
Appliquer (administrateur) : `powercfg /devicedisablewake "<nom exact listé par le rapport>"`.
Annuler : `powercfg /deviceenablewake "<même nom>"`.
Casse : ce périphérique ne sort plus la machine de veille ; garder au moins le clavier ou le bouton.
Source : [Powercfg command-line options](https://learn.microsoft.com/windows-hardware/design/device-experiences/powercfg-command-line-options).

**`bluetooth-off`** — Couper une radio inutilisée.
Appliquer : `start ms-settings:bluetooth` (ou `ms-settings:network-wifi` quand on est en filaire).
Annuler : même page.
Casse : appareils Bluetooth ou réseau Wi-Fi indisponibles.
Source : [Turn Bluetooth on or off](https://support.microsoft.com/windows/hardware/bluetooth/turn-bluetooth-on-or-off-in-windows).

### Applications, démarrage, services

**`startup-apps`** — Désactiver au démarrage les applications dont on se passe.
Appliquer : `start ms-settings:startupapps` (ou Gestionnaire des tâches → Applications de démarrage) → Désactivé.
Annuler : même page → Activé.
Casse : l’application ne démarre plus seule (notifications, synchronisation attendent qu’on l’ouvre).
Source : [Configure startup applications](https://support.microsoft.com/windows/configure-startup-applications-in-windows-115a420a-0bff-4a6f-90e0-1934c844e473).

**`background-apps`** — Applications du Store : activité en arrière-plan « Jamais ».
Appliquer : `start ms-settings:appsfeatures` → application → Options avancées → Autorisations des applications en
arrière-plan → Jamais.
Annuler : même chemin → « Optimisé pour l’alimentation ».
Casse : plus de notifications ni de mise à jour tant que l’application est fermée.
Source : [Tips to improve PC performance](https://support.microsoft.com/windows/improve-pc-performance-b3b3ef5b-5953-fb6a-2528-4bbed82fba96).

**`browser-background`** — Le navigateur s’arrête une fois fermé.
Appliquer : Chrome : `chrome://settings/system` → « Continuer à exécuter les applications en arrière-plan après la
fermeture » désactivé. Edge : `edge://settings/system` → « Boost de démarrage » et « Continuer à exécuter les
extensions et applications en arrière-plan » désactivés.
Annuler : mêmes pages.
Casse : ouverture un peu plus lente, extensions arrêtées fenêtre fermée.
Source : [StartupBoostEnabled](https://learn.microsoft.com/deployedge/microsoft-edge-policies/startupboostenabled),
[BackgroundModeEnabled](https://learn.microsoft.com/deployedge/microsoft-edge-policies/backgroundmodeenabled).

**`game-captures`** — Xbox Game Bar : pas d’enregistrement en arrière-plan.
Appliquer : `start ms-settings:gaming-gamedvr` → « Enregistrer ce qui s’est passé » désactivé.
Annuler : même page.
Casse : plus de capture rétroactive des dernières minutes de jeu.
Source : [Adjust capture settings on Windows](https://support.xbox.com/en-US/help/games-apps/game-setup-and-play/adjust-capture-settings-windows-10).

**`third-party-service-manual`** — Service tiers inutile au quotidien : démarrage manuel (utilitaires de carte mère,
d’éclairage, de mise à jour). Jamais un antivirus, un pilote ni un service Windows ; le rapport classe ceux-là « à
garder ».
Appliquer (administrateur) : `sc.exe config "<nom du service>" start= demand`.
Annuler : `sc.exe config "<nom du service>" start= auto` (ou `delayed-auto` s’il était différé).
Casse : l’outil de l’éditeur ne démarre plus seul.
Source : [sc.exe config](https://learn.microsoft.com/windows-server/administration/windows-commands/sc-config).

**`third-party-task-disable`** — Tâche planifiée tierce lancée à la connexion : désactiver.
Appliquer : `schtasks /Change /TN "<dossier\tâche>" /DISABLE`.
Annuler : `schtasks /Change /TN "<dossier\tâche>" /ENABLE`.
Casse : la mise à jour ou l’outil de l’éditeur ne se lance plus à l’ouverture de session. Une tâche créée par un autre
compte demande l’administrateur.
Source : [schtasks change](https://learn.microsoft.com/windows-server/administration/windows-commands/schtasks-change).

### Hors catalogue, volontairement

- Supprimer ou désactiver des services Windows, des applications système, « debloat » : non réversible proprement,
  casse des mises à jour.
- Clés de registre non documentées (afficher des réglages cachés par `powercfg -attributes`, politiques de
  refroidissement, etc.) : pas de source officielle.
- Nettoyage du disque : utile quand il reste moins de 10 % libres (le rapport le signale), mais la suppression n’est
  pas réversible ; à faire soi-même via Paramètres → Stockage
  ([Free up drive space](https://support.microsoft.com/windows/free-up-some-space-on-your-pc-85529ccb-c365-490d-b548-831022bc9b32)).
- Couper la veille prolongée ou le démarrage rapide : n’économise rien et retire le filet de sécurité batterie.

## Exemple : PC de bureau de développement (audit du 2026-11-20)

Machine où tournent le hub et ses workers. Résumé anonymisé du rapport réel (la liste des applications installées
n’est pas reprise ici).

- **Type** : machine de bureau (carte mère MSI B550, Ryzen 7 3700X 8 cœurs, 16 Go, RTX 3060 Ti), **sans batterie ni
  capot** : la question « capot fermé » ne se pose pas ; il faut auditer le portable lui-même.
- **Veille** : S3 classique uniquement (pas de veille moderne S0) ; veille prolongée et démarrage rapide disponibles ;
  veille hybride indisponible (hyperviseur actif).
- **Mode actif** : « AMD Ryzen High Performance » — état minimal du processeur 100 % sur secteur, EPP 0, turbo
  agressif, aucun cœur parqué, PCI Express sans économie, suspension USB coupée, **veille jamais**, écran éteint après
  15 min.
- **Carte graphique** : ~48 W au repos (état P0, mémoire à pleine fréquence, charge 0–1 %) avec deux écrans dont un à
  240 Hz — c’est le premier poste de gaspillage mesuré.
- **Sur 7 jours** : 99 h allumée, 68 h en veille S3 ; 3 réveils en 14 jours, tous par le bouton d’alimentation ;
  19 arrêts non propres (Kernel-Power 41) en 14 jours.
- **Processus** : AI Box (app + 4 `claude.exe` et leurs enfants) mis à part ; l’app elle-même était le premier
  consommateur de processeur pendant un des échantillons (~8 % de la machine, interface en train de défiler) ; une
  dizaine d’utilitaires (périphériques, carte mère, messagerie) tournent sans fenêtre (~500 Mo au total).
- **Démarrage** : 5 applications actives à la connexion, 2 applications du Store, 1 tâche planifiée tierce ; 11
  services tiers automatiques en marche, dont 7 à garder (sécurité, pilotes, Claude).
- **Stockage** : disque système à 7 % libre.

Recommandations dans l’ordre du rapport : `plan-balanced` (ou à défaut `cpu-min-state-ac`), `sleep-idle-ac` une fois
qu’AI Box tient sa demande d’alimentation, `refresh-rate` (60 Hz hors jeu), `display-off`, `startup-apps`, puis `aspm`
et `usb-selective-suspend` à essayer en surveillant la stabilité.

## Limites

- Watts par processus : Windows ne les donne pas ; l’impact affiché est une estimation relative (processeur, GPU,
  entrées/sorties sur l’échantillon). Seules la batterie (débit WMI, historique du rapport batterie) et la carte NVIDIA
  (`nvidia-smi`) donnent des watts mesurés.
- Le rapport batterie de Windows (`/batteryreport`) a été lu sur ce PC de bureau ; la partie portable (capacités,
  consommation sur batterie et en veille) est testée sur une fixture synthétique de même structure, pas encore sur un
  vrai portable.
- `powercfg /sleepstudy` (détail de la veille moderne) n’est pas analysé : le rapport HTML est à générer en
  administrateur et à lire soi-même.
