# Étude : une version Windows et Linux inspirée de Vorssaint

Statut : étude d'architecture et de portage, aucun code produit. Rédigée le 2026-11-20 par hub-vorssaint-study, à partir
du clone de référence `vorssaint-utils` (commit `faada18` du 2026-11-18, version 3.4.4), lu sans rien exécuter.
Constats marqués `confirmed` (lu dans le code, ou mesuré) ou `needs_validation` (source externe, hypothèse, ou
vérifiable seulement sur le portable). Les chemins Vorssaint sont relatifs à `Sources/Vorssaint/` sauf mention contraire.

**Limite de terrain.** La machine où tournent les workers est un PC de bureau : pas de batterie, pas de capot, veille
S3 (`powercfg /a` : S0 Low Power Idle « non pris en charge par le microprogramme »). Tout ce qui touche la veille
moderne (S0ix), le DAM, le capot et la batterie est donc `needs_validation` tant que l'étape « validation sur
portable » (§ 4.6) n'a pas été faite.

Résumé en cinq lignes :
- Vorssaint est une seule app AppKit/SwiftUI de ~320 000 lignes, organisée en 80 « features » activables à la carte ;
  la quasi-totalité de sa valeur vient d'API propres à macOS (dont beaucoup privées). Il n'y a rien à « porter » au
  sens du code : on peut seulement reprendre des comportements et des cas limites.
- Pour le besoin n°1 (travailler capot fermé en consommant le moins possible), **une seule feature compte vraiment :
  Keep Awake en mode capot fermé**, plus sa coupure de sécurité batterie ; viennent ensuite le moniteur de puissance,
  la coupure Bluetooth à la veille et l'extinction de l'écran.
- Sous Windows, aucune API « garder éveillé » ne résiste à la fermeture du capot : il faut changer l'action du capot
  dans le plan d'alimentation (`LIDACTION`), et restaurer proprement. Sur un portable à veille moderne, il faut en plus
  empêcher la veille par délai sur batterie, sinon le DAM gèle les workers.
- Sous Linux, seul un inhibiteur logind `handle-lid-switch` le fait, sans root pour une session locale active ; KDE
  l'ignore (bug ouvert).
- Recommandation : un module `src/main/energy/` dans AI Box (cœur de décision pur + adaptateurs `win32`/`linux`),
  piloté par l'état « des workers travaillent », avant tout utilitaire autonome.

---

## 1. Architecture réelle de Vorssaint (lue dans le code)

### 1.1 Volumes et couches `confirmed`

| Couche | Fichiers | Lignes | Rôle |
|---|---|---|---|
| `App/` | 9 | 6 477 | Démarrage, `AppDelegate` (2 866 lignes), `FeatureRuntime`, icône de barre des menus, apparence |
| `Core/` | 116 | 68 731 | Modèle pur et textes : `FeatureCatalog`, `Defaults` (clés et migrations), `Permissions`, sauvegarde, localisation |
| `Services/` | 387 | 167 071 | ~49 dossiers de logique par feature : un singleton `*Service` + souvent un `*Support` pur et testable |
| `UI/` | 202 | 77 820 | Vues SwiftUI/AppKit : panneau de menu, réglages, Dynamic Island, onboarding |
| `Support/` | 4 | 1 835 | Outils de diagnostic : `SelfTest`, désinstalleur, sondes de développement |

À côté, six cibles natives dans `Sources/` : `FanControlHelper` (démon root), `CoreAudioTapCompat`, `HIDEventSystem`,
`VMStatisticsCompat`, `RecorderGIFCodec`, `NowPlayingAdapter` (§ 1.5).

- **Démarrage** : `main.swift` est un script : options en ligne de commande d'abord (`--export-settings`,
  `--import-settings`, `--selftest`, `--sensors`, `--uninstall`), puis enregistrement des défauts, lecture d'un
  éventuel fichier de config, puis `NSApplication` + `AppDelegate`. `confirmed`
- **`applicationDidFinishLaunching`** (`App/AppDelegate.swift:72`) : préparation de la disponibilité au premier
  lancement, icône de barre des menus, **récupérations d'état système** (`KeepAwakeManager.recoverIfNeeded`,
  `FanControlService.recoverIfNeeded`), puis `FeatureRuntime.shared.syncAtLaunch()`, puis vérification des mises à
  jour ; abonnements aux changements de permissions qui resynchronisent les features concernées. Un marqueur de
  démarrage saute les fenêtres optionnelles si le lancement précédent n'a pas abouti. `confirmed`
- **`applicationWillTerminate`** (`AppDelegate.swift:323`) arrête les services un par un et **restaure l'état
  système** : raccourcis, écrans, accélération souris, ventilateurs, veille. `confirmed`
- **État** : chaque service est un singleton paresseux (`static let shared`), tout réglage est dans
  `UserDefaults.standard` sous une clé de `DefaultsKey` (`Core/Defaults.swift`), sans injection de dépendances. Les vues
  lisent directement les services. `confirmed`

### 1.2 Le catalogue de features `confirmed`

- `AppFeature` (`Core/FeatureCatalog.swift:15`) : **80 cas** en 8 groupes (fenêtres et Dock 7, souris et clavier 16,
  presse-papiers et fichiers 7, son 5, énergie et écran 4, outils 20, Dynamic Island 13, moniteur 8). La valeur brute
  est persistée : on peut ajouter des cas, jamais les renommer.
- **Disponibilité au-dessus de l'activation** : chaque feature a une clé de disponibilité (`featureAvailable.<id>`) qui
  coiffe ses propres clés d'activation (`enabledKeys`, l.236). Une feature indisponible disparaît des réglages, du
  panneau et de la barre des menus, et son service s'arrête. La rendre à nouveau disponible restitue les choix
  d'activation enregistrés.
- **Rien ne se charge si c'est désinstallé** : `FeatureRuntime.syncAtLaunch()` (`App/FeatureRuntime.swift:214`)
  n'exécute que les liaisons des features disponibles ; ces liaisons sont un dictionnaire de closures, donc nommer
  une feature n'instancie pas son singleton. Désinstaller en cours de session appelle la liaison, qui arrête le
  service ; si du code a déjà été chargé, un bandeau propose de relancer l'app.
- **Première installation** : seule la clé d'activation principale est allumée, et seulement si aucune valeur n'a jamais
  été enregistrée pour cette feature (une réinstallation garde les choix). Une feature dont le matériel est absent est
  refusée (aujourd'hui seulement les ventilateurs).
- **Dépendances** : les 12 extensions de la Dynamic Island dépendent de `notch` ; certaines règles de permission
  croisent la disponibilité d'autres features. Deux features sont « bêta » (ventilateurs, tueur de processus) :
  simple badge, non installées par défaut. Des préréglages (essentiel, fenêtres, batterie) servent au premier lancement.

**À retenir pour nous** : le principe « disponibilité au-dessus de l'activation + aucune instanciation si indisponible
+ arrêt et restauration à la désinstallation » est le bon modèle pour un utilitaire à la carte qui doit coûter zéro
quand une fonction n'est pas utilisée. On reprend l'idée, pas la structure (cf. § 5).

### 1.3 Permissions `confirmed`

- 12 permissions (`AppPermission`, l.46) : accessibilité, enregistrement d'écran, accès complet au disque, fichiers et
  dossiers, notifications, automatisation Finder, automatisation lecture, capture audio, micro, caméra, gestion des
  apps, calendrier.
- Chaque feature déclare ses permissions (`permissions`, l.335) ; `activeFeatures(using:)` (l.508) dit en direct quelles
  features *utilisent* une permission maintenant (disponible + activée + règles par paire). L'onglet Permissions du hub
  (`UI/Settings/FeatureHubSettings.swift:865`) affiche l'état de chaque permission et qui s'en sert : c'est le
  « portail de transparence ».
- **Sondage économe** (`PermissionPollingSupport`, l.51) : pas de minuterie si rien n'en a besoin, 2,5 s tant qu'une
  surface de permission est visible ou qu'une permission requise manque, 60 s sinon ; les outils ponctuels ne sondent
  jamais (commentaire explicite sur les réveils inutiles).
- Onboarding limité à l'accessibilité et à l'enregistrement d'écran.

### 1.4 Le privilégié : démon ventilateurs et règle sudoers `confirmed`

- **`FanControlHelper`** (`Sources/FanControlHelper/main.swift`, 623 lignes) : démon root embarqué dans le bundle,
  enregistré par `SMAppService.daemon` ; l'utilisateur l'approuve dans Réglages › Éléments de connexion. Transport
  XPC (`NSXPCConnection(machServiceName:options:.privileged)`), charge utile JSON. **Vérification de signature dans
  les deux sens** (exigence de code : ancre Apple + équipe + identifiant fixe). Opérations autorisées : état, appliquer
  une configuration validée, battement de cœur, restaurer. **Sûreté** : verrou fichier + marqueur root `0600` dans
  `/var/run`, chien de garde à 1 Hz qui rend le contrôle automatique si le battement de cœur de l'app se tait 7 s, si
  la vérification échoue ou à la déconnexion du client ; récupération au démarrage d'un contrôle abandonné.
- **Keep Awake capot fermé** (`Services/KeepAwakeManager.swift`, 1 314 lignes) : `pmset disablesleep 1|0` exige root.
  Une installation unique écrit, via une invite administrateur AppleScript, une règle `/etc/sudoers.d/…` qui
  n'autorise **que** ces deux commandes exactes, pour l'uid numérique de l'utilisateur (pas son nom : les comptes SSO
  ont des noms en forme d'email), validée par `visudo -c` et retirée si invalide. Chaque bascule appelle ensuite
  `sudo -n` sans invite. Détails au § 3.1.

**Le modèle à retenir** : un privilège **étroit** (deux commandes, ou une API validée), demandé **une fois**, et un
**état restauré par construction** (marqueur écrit avant l'action, récupération au lancement suivant, chien de garde
côté privilégié).

### 1.5 Compatibilité C/ObjC et API privées `confirmed`

| Module | Ce qu'il enveloppe |
|---|---|
| `CoreAudioTapCompat` | En-tête ObjC pour les « process taps » CoreAudio (macOS 14.4+), construits par `NSClassFromString` pour charger sur les premiers Sonoma |
| `HIDEventSystem` | Module map sur des en-têtes IOKit HID privés (`IOHIDEventSystemClient`) — accélération souris |
| `VMStatisticsCompat` | Redéfinition C de `vm_statistics64` rév. 3 (champs macOS 26 absents du SDK Xcode 16) |
| `RecorderGIFCodec` | Enveloppe C d'un encodeur GIF tiers MIT (`cgif`) épinglé |
| `NowPlayingAdapter` | dylib qui ouvre le framework privé MediaRemote ; depuis macOS 15.4 seuls les binaires Apple sont servis, donc chargée dans `/usr/bin/perl` |

Autres API privées par `dlsym` : CGS/SkyLight (espaces, raccourcis système, captures, mode sombre, écran),
DisplayServices et CoreDisplay (luminosité, DDC), `IOBluetoothPreference*` (Bluetooth), `SACLockScreenImmediate`,
`TCCAccessPreflight`, `_AXUIElementGetWindow`, MultitouchSupport. `SelfTest` avertit quand l'une disparaît.

### 1.6 Réglages, localisation, auto-test, build, CI `confirmed`

- **Sauvegarde** : export/import d'une enveloppe plist versionnée (`Core/SettingsBackupSupport.swift`), clés connues
  seulement, types vérifiés, exclusion de tout ce qui est propre à la machine (marque-pages, tailles de fenêtre, caches
  DDC, état des ventilateurs) ; import puis relance. Aussi en ligne de commande, et un fichier de config
  `$XDG_CONFIG_HOME/vorssaint/settings.plist` superposé au lancement (dotfiles).
- **Localisation** : 15 langues (anglais + 14 traductions, `Core/Localization.swift:22`), sous forme de catalogue
  compilé (une structure Swift par langue, pas de `.strings`) ; un test vérifie par réflexion que chaque langue a les
  mêmes champs, sans texte vide et avec les mêmes arguments de format.
- **`SelfTest`** (`Support/SelfTest.swift`, `--selftest`) : test de fumée des sous-systèmes (assertion IOPM créée et
  rendue, mémoire, préférences, rendu des icônes ; SMC, réseau, disque et puissance en simples avertissements) ; lancé
  par la CI après le build. Le démon a son propre `--selftest`.
- **Build** : `build.sh` (955 lignes, zsh) appelle `swiftc` directement (pas SwiftPM), compile le codec C, le démon et
  la dylib, assemble le bundle, signe chaque pièce (Developer ID + runtime durci, sinon identité locale, sinon ad hoc),
  notarise et produit un DMG.
- **CI** (`.github/workflows`) : `ci.yml` build + selftest + tests sur deux versions de macOS/Xcode ; `release.yml` sur
  tag `v*`, réservé au propriétaire, avec contrôle que le commit est vérifié, que la version et le CHANGELOG
  concordent, signature et notarisation dans un environnement protégé, publication par un job sans secrets Apple.
- **Tests** : harnais maison (pas XCTest), 273 fichiers, ~15 300 vérifications, plus des tests de mutation.
- **Mises à jour** : maison (API GitHub Releases, DMG vérifié par `codesign` avant copie), pas de Sparkle. **Aucune
  télémétrie** (`docs/PRIVACY.md`).

### 1.7 Schéma des couches et des flux

```
                         main.swift (CLI: --selftest, --export/--import-settings, --uninstall)
                                   │
                                   ▼
 ┌──────────────────────────── App ─────────────────────────────┐
 │ AppDelegate ── recoverIfNeeded() ──► état système (pmset, SMC) │
 │      │                                                         │
 │      ▼                                                         │
 │ FeatureRuntime.syncAtLaunch() ── pour chaque feature DISPONIBLE│
 │      │                 (clé featureAvailable.<id>)             │
 └──────┼─────────────────────────────────────────────────────────┘
        │ liaison (closure) : démarre / arrête
        ▼
 ┌──────────── Services (singletons) ─────────────┐     ┌──────────── Core ────────────┐
 │ KeepAwakeManager  BluetoothSleep  Brightness    │◄───►│ FeatureCatalog  Permissions   │
 │ SystemMonitor  Mixer  Switcher  Notch  ...      │     │ Defaults (UserDefaults)       │
 │   │ IOKit/IOPM/CoreAudio/AX/CGEvent/SMC/dlsym   │     │ Strings (15 langues)          │
 └───┼───────────────┬─────────────────────────────┘     └──────────────▲────────────────┘
     │               │ XPC signé                                         │
     │               ▼                                                   │
     │      FanControlHelper (root, SMAppService, chien de garde 1 Hz)   │
     │ sudo -n pmset disablesleep 1|0  (règle sudoers à 2 commandes)     │
     ▼                                                                   │
  noyau / powerd                                   UI (SwiftUI/AppKit) ──┘ lit services et Core
```

> **Ce qu'AI Box a déjà (architecture)** : un processus principal Electron qui possède tout l'état
> (`src/main/main.ts`), des réglages en JSON (`config.ts`), une i18n (`i18n.ts`), des tests Vitest et un lancement isolé
> de l'app pour les vérifier (`npm run ui`). Pas de modèle de « features à la carte » : il n'en faut pas pour le seul
> module énergie, mais il en faudra un pour l'utilitaire autonome (§ 4.4).

---

## 2. Matrice de portage, feature par feature

Légende. **Diff** : S (jours), M (1–2 semaines), L (plusieurs semaines), XL (recherche, pilote noyau ou API privée).
**Valeur** pour le besoin n°1 (capot fermé, consommation minimale, machine optimisée) : H haute, M moyenne, F faible.
**Risque** : A = droits administrateur, I = instabilité (API non documentée, crochets bas niveau), S = sécurité/données.
« natif » = Windows ou le bureau Linux le font déjà ; « s.o. » = sans objet. La colonne macOS est `confirmed` (lue
dans le service) ; les colonnes Windows et Linux sont des propositions `needs_validation`.

### 2.1 Fenêtres et Dock (7)

| Feature | Ce qu'elle fait | macOS (lu) | Windows | Linux | Diff | Val. | Risque |
|---|---|---|---|---|---|---|---|
| switcher | Alt-Tab par fenêtre avec vignettes | CGEventTap, AX, ScreenCaptureKit, CGS/SLS privés | Natif (Alt-Tab) ; sinon crochet `WH_KEYBOARD_LL` + `EnumWindows` + vignettes DWM (`DwmRegisterThumbnail`) | X11 : EWMH + XComposite ; Wayland : impossible hors extension du compositeur | L | F | I |
| dockPreview | Survol d'une icône du Dock → aperçus | AX sur le Dock, CGEventTap, `CoreDock*` privé | Natif (vignettes de la barre des tâches) : s.o. | Natif selon le bureau : s.o. | — | F | — |
| dockClick | Clic sur l'icône de l'app active → réduire | CGEventTap, AX | Natif : s.o. | Natif selon le bureau : s.o. | — | F | — |
| windowMaximizer | Bouton vert = agrandir sans plein écran | CGEventTap, AX | Natif (Agrandir) : s.o. | Natif : s.o. | — | F | — |
| windowLayout | Ancrer, paver, zones, raccourcis | CGEventTap, hotkeys Carbon, AX position/taille | Natif (Snap Layouts) ou `SetWindowPos` + `SetWinEventHook` (cf. FancyZones) | X11 : EWMH/wmctrl ; Wayland : script KWin / extension GNOME | L | F | I |
| autoQuit | Quitter l'app à la fermeture de sa dernière fenêtre | AXObserver, NSWorkspace | Comportement par défaut de la plupart des apps : s.o. | s.o. | — | F | — |
| spacesOrder | Empêcher le réordonnancement des Spaces | `CFPreferences` `com.apple.dock mru-spaces` + `killall Dock` | Les bureaux virtuels ne se réordonnent pas : s.o. | s.o. | — | F | — |

### 2.2 Souris et clavier (16)

| Feature | Ce qu'elle fait | macOS (lu) | Windows | Linux | Diff | Val. | Risque |
|---|---|---|---|---|---|---|---|
| scrollInverter | Défilement inversé pour la souris seule | CGEventTap partagé | Registre `FlipFlopWheel` par périphérique (admin) ou crochet `WH_MOUSE_LL` | libinput « natural scrolling » par périphérique (réglages du bureau) | S | F | A/I |
| scrollHorizontal | Modificateur + molette = horizontal | CGEventTap | Maj+molette natif dans beaucoup d'apps ; sinon `WH_MOUSE_LL` + `SendInput` `MOUSEEVENTF_HWHEEL` | X11 : XInput ; Wayland : uinput (groupe input) | S | F | I |
| scrollZoom | Modificateur + molette = zoom | CGEventTap, faux évènements de pincement | Ctrl+molette natif : s.o. | Ctrl+molette natif : s.o. | — | F | — |
| focusFollowsMouse | Le focus suit le pointeur | Moniteur global NSEvent, AX | Natif : `SystemParametersInfo(SPI_SETACTIVEWINDOWTRACKING)` | Natif (mode de focus du gestionnaire de fenêtres) | S | F | — |
| smoothScroll | Défilement molette fluide | CGEventTap + évènements synthétiques | `WH_MOUSE_LL` + `SendInput` en petits pas | Côté app/toolkit ; uinput sinon | M | F | I |
| linearScroll | Pas de défilement constant | CGEventTap | `SPI_SETWHEELSCROLLLINES` (pas fixe) | libinput (KDE : réglage ; GNOME : non) | S | F | — |
| scrollSpeed | Vitesse de défilement | CGEventTap | `SPI_SETWHEELSCROLLLINES` | Selon le bureau | S | F | — |
| mouseAcceleration | Couper l'accélération souris | `IOHIDEventSystemClient` (SPI) | `SPI_SETMOUSE` (« Améliorer la précision du pointeur ») | libinput profil `flat` (gsettings, xinput) | S | F | — |
| mouseNavigation | Boutons latéraux = précédent/suivant | CGEventTap HID | Natif (`XBUTTON1/2`) : s.o. | Natif : s.o. | — | F | — |
| mouseButtonShortcuts | Actions sur boutons de souris | CGEventTap + repost | `WH_MOUSE_LL` + `SendInput` | evdev + uinput (input-remapper) | M | F | I |
| middleClick | Tape à trois doigts = clic milieu | MultitouchSupport privé | Natif (pavé tactile de précision, réglable) : s.o. | libinput tap-button-map | S | F | — |
| mouseClickDebounce | Filtrer les doubles clics d'une souris usée | CGEventTap HID | `WH_MOUSE_LL` qui avale le clic | evdev grab + uinput | M | F | I |
| keyboardDebounce | Filtrer le rebond d'un clavier usé | CGEventTap HID | Natif : Touches filtres (`SPI_SETFILTERKEYS`, BounceTime) | AccessX « bounce keys » (X11/GNOME) | S | F | — |
| textSnippets | Abréviation → texte | CGEventTap + frappe synthétique | `WH_KEYBOARD_LL` + `SendInput` (cf. espanso, AutoHotkey) | X11 : XRecord + XTest ; Wayland : evdev/uinput | M | F | I/S (voit toutes les frappes) |
| superKey | Verr. Maj = touche Hyper | `hidutil`, `IOHIDEventSystemClient` | Registre `Scancode Map` (admin + redémarrage) ou crochet bas niveau | Option xkb `caps:hyper` ; keyd | S | F | A |
| quitWindowProtection | Garde contre Cmd+Q accidentel | CGEventTap | Garde Alt+F4 par `WH_KEYBOARD_LL` | Selon compositeur | S | F | I |

### 2.3 Presse-papiers et fichiers (7)

| Feature | Ce qu'elle fait | macOS (lu) | Windows | Linux | Diff | Val. | Risque |
|---|---|---|---|---|---|---|---|
| clipboardHistory | Historique du presse-papiers | Sondage `NSPasteboard.changeCount`, hotkey | Natif (Win+V) ; sinon `AddClipboardFormatListener` (pas de sondage) | X11 : sélections ; Wayland : `wlr-data-control` (pas sous GNOME) | M | F | S (mots de passe copiés) |
| pastePlain | Coller en texte brut | NSPasteboard, AX | API presse-papiers + `SendInput` Ctrl+V (cf. PowerToys) ; Ctrl+Maj+V natif dans beaucoup d'apps | Idem X11 ; Wayland partiel | S | F | — |
| finderCutPaste | Couper-coller de fichiers dans le Finder | CGEventTap, AX, Apple Events | Natif dans l'Explorateur : s.o. | Natif : s.o. | — | F | — |
| finderRename | Entrée = renommer dans le Finder | CGEventTap, AX | Natif (F2) : s.o. | Natif (F2) : s.o. | — | F | — |
| shelf | Étagère de glisser-déposer | NSPasteboard, promesses de fichiers | Fenêtre Electron + glisser-déposer OLE | Fenêtre + DnD X11/Wayland | M | F | — |
| urlCleaner | Retirer les paramètres de pistage des URL copiées | Sondage du presse-papiers | `AddClipboardFormatListener` + réécriture | Écoute du presse-papiers (limites Wayland) | S | F | — |
| diskImageInstaller | Installer une app depuis un .dmg monté | NSWorkspace, `hdiutil`, `ditto`, `codesign` | s.o. (pas de .dmg) ; l'équivalent utile est winget (§ homebrew) | s.o. | — | F | — |

### 2.4 Son (5)

| Feature | Ce qu'elle fait | macOS (lu) | Windows | Linux | Diff | Val. | Risque |
|---|---|---|---|---|---|---|---|
| mixer | Volume, gain et sortie par app | Process taps CoreAudio, appareil agrégé | Natif (mélangeur du volume) ; API WASAPI `IAudioSessionManager2`/`ISimpleAudioVolume` ; routage par app = interface non documentée (`IAudioPolicyConfig`, cf. EarTrumpet) | PipeWire/PulseAudio : `pactl set-sink-input-volume`, `move-sink-input` | M | F | I |
| soundOutputSwitcher | Raccourci qui fait tourner les sorties | CoreAudio sortie par défaut | `IPolicyConfig::SetDefaultEndpoint` (non documenté) | `pactl set-default-sink` | S | F | I |
| audioPriority | Choisir automatiquement le meilleur appareil | Écouteurs de propriétés CoreAudio | `IMMNotificationClient` + `IPolicyConfig` | Priorités WirePlumber | M | F | I |
| micMute | Couper le micro au raccourci | CoreAudio `kAudioDevicePropertyMute` (entrée) | `IAudioEndpointVolume::SetMute` (documenté) | `pactl set-source-mute` | S | F | — |
| musicBlock | Empêcher Musique de se lancer sur les touches média | NSWorkspace, Apple Events | s.o. (comportement propre à macOS) | s.o. | — | F | — |

### 2.5 Énergie et écran (4)

| Feature | Ce qu'elle fait | macOS (lu) | Windows | Linux | Diff | Val. | Risque |
|---|---|---|---|---|---|---|---|
| keepAwake | Empêcher la veille, minuterie, automatismes, **capot fermé**, coupure batterie, écran éteint capot fermé | Assertions IOPM ; `pmset disablesleep` via sudoers ; `AppleClamshellState` ; `IOPSCopyPowerSourcesInfo` (§ 3.1) | `PowerCreateRequest`/`PowerSetRequest` + **`powercfg` LIDACTION AC/DC** + `RegisterPowerSettingNotification(GUID_LIDSWITCH_STATE_CHANGE)` + batterie (§ 3.2) | Inhibiteur logind `handle-lid-switch` (D-Bus `Inhibit`) + UPower (§ 3.3) | M | **H** | A (selon droits powercfg), S (portable chaud en sac) |
| brightness | Luminosité écrans internes et externes (DDC), gamma | DisplayServices/CoreDisplay privés, I2C DDC, `CGSetDisplayTransferByTable` | Interne : WMI `WmiMonitorBrightnessMethods` ; externes : API Monitor Configuration (`SetMonitorBrightness`, DDC/CI, `dxva2`) ; gamma : `SetDeviceGammaRamp` | Interne : logind `Session.SetBrightness` (sans root) ou `/sys/class/backlight` ; externes : ddcutil (groupe i2c) | M | M | I (DDC capricieux) |
| extraBrightness | Pousser l'écran XDR au-delà du SDR | Surcouche Metal EDR | s.o. (Windows a son propre réglage de luminosité SDR en HDR) | s.o. | — | F | — |
| bluetoothSleep | Couper le Bluetooth à la veille, le rendre au réveil | `IOBluetoothPreference*` privé, notifications veille/réveil (§ 3.1) | WinRT `Windows.Devices.Radios` + `PowerRegisterSuspendResumeNotification` ; utile surtout **capot fermé sans veille** | rfkill (`/dev/rfkill`) ou BlueZ `Adapter.Powered` + logind `PrepareForSleep` | M | M | — |

### 2.6 Outils (20)

| Feature | Ce qu'elle fait | macOS (lu) | Windows | Linux | Diff | Val. | Risque |
|---|---|---|---|---|---|---|---|
| quickLauncher | Grille de tuiles d'outils au raccourci | Hotkey Carbon, NSPanel | Electron `globalShortcut` + fenêtre | Idem ; Wayland : portail GlobalShortcuts | S | F | — |
| quickToggles | Bascules : mode sombre, rétroéclairage clavier, micro, corbeille, tout quitter, éjecter, fichiers cachés, icônes du bureau, verrouiller, **éteindre l'écran**, économiseur | SkyLight privé, `SACLockScreenImmediate`, `pmset displaysleepnow`, `defaults` + `killall Finder`, AppleScript | Registre `AppsUseLightTheme` ; `LockWorkStation` ; `SC_MONITORPOWER` ; `SHEmptyRecycleBin` ; Explorateur `Hidden` ; éjection `CM_Request_Device_Eject` | gsettings `color-scheme` ; `loginctl lock-session` ; DPMS / compositeur ; `gio trash --empty` | M | M (écran éteint) | — |
| quitApps | Quitter toutes les apps (sauf liste) | `NSRunningApplication.terminate()` (jamais forcé) | `EnumWindows` + `WM_CLOSE` (doux) | X11 `_NET_CLOSE_WINDOW` ; Wayland : non générique | S | M (libérer la machine) | S (perte de travail non enregistré) |
| colorPicker | Pipette d'écran | `NSColorSampler` | Capture d'écran + pixel (cf. PowerToys) | X11 `XGetImage` ; Wayland portail `Screenshot.PickColor` | S | F | — |
| screenOCR | Texte d'une zone d'écran, hors ligne | ScreenCaptureKit + Vision | `Windows.Media.Ocr` (WinRT) + capture ; natif dans l'Outil Capture | Portail Screenshot + tesseract | M | F | — |
| cleaningMode | Bloquer clavier et clics pour nettoyer | CGEventTap HID, fenêtre de protection | `WH_KEYBOARD_LL`/`WH_MOUSE_LL` qui avalent tout (Ctrl+Alt+Suppr reste) | X11 : saisie exclusive ; Wayland : non | S | F | I |
| mediaTools | Convertir, compresser images, vidéos, GIF | ImageIO, AVFoundation, `avconvert`, Vision | ffmpeg / sharp (multiplateforme) | Idem | M | F | — |
| cleaner | Débris : restes d'apps, agents orphelins, caches, journaux, débris dev, corbeille, sauvegardes, vieilles captures | `FileManager` → Corbeille, `launchctl bootout` | `%TEMP%`, caches dev (npm, pip, node-gyp…), miniatures, Optimisation de distribution et cache Windows Update (admin), Assistant stockage natif ; toujours vers la Corbeille | `~/.cache`, `journalctl --vacuum-*` (root), caches de paquets (root), flatpak inutilisés | M | M (« optimiser à mort ») | S (suppression) / A |
| uninstaller | Désinstaller une app et ses restes | Spotlight, Corbeille, `brew uninstall` | Clés `…\Uninstall` (HKLM/HKCU) → `UninstallString`, `winget uninstall`, restes `%APPDATA%`/`%LOCALAPPDATA%`/`ProgramData` | Gestionnaire de paquets (PackageKit), flatpak | L | F | S/A |
| homebrew | Interface pour Homebrew | CLI `brew` | winget (CLI ou API COM `Microsoft.Management.Deployment`), scoop | PackageKit D-Bus, flatpak | M | F | A (selon paquets) |
| appUpdates | Liste des apps à mettre à jour | Flux Sparkle, iTunes, API cask | `winget upgrade` | PackageKit `GetUpdates`, fwupd | M | F | — |
| screenshot | Captures zone/fenêtre/défilante + annotation | ScreenCaptureKit | Natif (Outil Capture) ; `Windows.Graphics.Capture` | Portail Screenshot | L | F | — |
| cameraPreview | Miroir webcam flottant | AVCaptureSession | `getUserMedia` (Electron) | Idem | S | F | — |
| radialMenu | Roue d'actions | Hotkey, CGEventTap boutons souris | Fenêtre + raccourci / `WH_MOUSE_LL` | Idem X11 ; Wayland limité | M | F | — |
| scratchpad | Bloc-notes flottant à onglets | NSTextView | Fenêtre Electron | Idem | S | F | — |
| commandBar | Barre de commandes : actions, fichiers, menus de l'app active, calculs | AX (menus), Spotlight, CoreWLAN | UI Automation (menus), Windows Search ; natif : PowerToys Command Palette | AT-SPI, tracker/locate | L | F | — |
| screenRecorder | Vidéo/GIF d'écran avec audio | ScreenCaptureKit, AVAssetWriter, process taps | `Windows.Graphics.Capture` + Media Foundation, ou ffmpeg `ddagrab` ; natif : Game Bar | Portail ScreenCast + PipeWire | L | F | — |
| wallpaper | Choix du fond d'écran | `NSWorkspace.setDesktopImageURL`, plist de WallpaperAgent | `IDesktopWallpaper` (COM) | gsettings / selon le bureau | S | F | — |
| killProcess | Liste des processus, tuer, tuer l'arbre | `proc_*`, `kill`, garde contre réutilisation de PID | `OpenProcess`/`TerminateProcess`, liste par `CreateToolhelp32Snapshot` ; **AI Box a déjà `procTree.ts`/`winJobs.ts`** | `/proc` + `kill` | M | M (processus gourmands) | S (tuer la mauvaise chose) |
| portManager | Ports TCP en écoute et leur processus | `lsof` | `GetExtendedTcpTable` (iphlpapi) ou `Get-NetTCPConnection -State Listen` | `/proc/net/tcp*` ou `ss -ltnp` | S | F | — |

### 2.7 Dynamic Island et extensions (13)

Il n'y a pas d'encoche sur un PC : l'équivalent est une petite pilule flottante en haut de l'écran (fenêtre Electron
transparente « toujours au-dessus »). Sous Wayland, seul `wlr-layer-shell` (wlroots, KDE) ou une extension GNOME le
permet. Aucune de ces features ne sert le besoin n°1, sauf `notchAgents` qui est déjà le métier d'AI Box.

| Feature | Ce qu'elle fait | macOS (lu) | Windows | Linux | Diff | Val. | Risque |
|---|---|---|---|---|---|---|---|
| notch | Île : lecture en cours, widgets | NSPanel niveau bouclier, espaces CGS privés, MediaRemote via perl | Fenêtre Electron flottante + SMTC (`GlobalSystemMediaTransportControlsSessionManager`) | X11 OK ; Wayland : layer-shell / extension GNOME ; MPRIS | L | F | I |
| notchCalendar | Prochains évènements | EventKit | Pas d'API de bureau ouverte : Microsoft Graph / Google Calendar (compte) | Evolution Data Server (D-Bus) | M | F | S (données d'agenda) |
| notchNotifications | Recopier les bannières système | AXObserver sur Notification Center | `UserNotificationListener` (WinRT, consentement ; identité de paquet probablement requise) | Moniteur D-Bus `org.freedesktop.Notifications` | L | F | S |
| notchGestures | Geste deux doigts sur l'île | Défilement NSEvent sur le panneau | Évènements de molette/pavé sur la fenêtre | Idem | S | F | — |
| notchTimer | Minuteur, chrono, pomodoro | Minuteries + son | Trivial | Trivial | S | F | — |
| notchAccessories | Batterie des accessoires Bluetooth | IOBluetooth, échantillonneur de batteries | `Windows.Devices.Bluetooth` + GATT Battery Service / propriété de batterie Bluetooth | UPower (périphériques BlueZ) | M | F | — |
| notchLyrics | Paroles synchronisées | lrclib.net, musicbrainz | Idem (réseau) + SMTC | Idem + MPRIS | S | F | — |
| notchQueue | File de lecture | MediaRemote privé | SMTC n'expose pas la file : s.o. | MPRIS `TrackList` (optionnel, rare) | M | F | — |
| notchLiveEqualizer | Barres de niveau audio de l'app qui joue | Process tap + FFT vDSP | Capture loopback WASAPI par processus (`AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS`, Windows 10 2004+) | Moniteur PipeWire | M | F | — |
| notchDownloads | Progression des téléchargements | `Progress` publié, surveillance de dossier | Surveillance du dossier Téléchargements (`ReadDirectoryChangesW`/`fs.watch`) | inotify | S | F | — |
| notchAgents | Usage, limites, coût et sessions de Claude, Codex, OpenCode, Copilot | Lecture incrémentale des journaux (FSEvents + sondage 2 s des fichiers récents), sqlite en lecture seule, CLI `claude`/`codex app-server` pour les limites | **Déjà dans AI Box** (sessions, `costLog.ts`, limites de débit) | Idem | — | M (déjà là) | — |
| notchWatch | Alerter quand une zone d'écran change | ScreenCaptureKit + diff | `Windows.Graphics.Capture` / `desktopCapturer` + diff | Portail ScreenCast | M | F | — |
| notchMascot | Petit compagnon animé | Dessin | Dessin | Dessin | S | F | — |

### 2.8 Moniteur système (8)

| Feature | Ce qu'elle fait | macOS (lu) | Windows | Linux | Diff | Val. | Risque |
|---|---|---|---|---|---|---|---|
| monitorCPU | Charge, cœurs, température, processus en tête | `host_statistics`, `host_processor_info`, SMC, `proc_pid_rusage` | PDH (`\Processor Information(_Total)\% Processor Utility`), `GetSystemTimes` ; **température : pas d'API publique fiable** (WMI `MSAcpi_ThermalZoneTemperature` admin et souvent faux ; les pilotes noyau type WinRing0 sont bloqués comme vulnérables) | `/proc/stat`, hwmon `/sys/class/hwmon` | M (XL pour la température) | M | A/S (pilote) |
| monitorGPU | Utilisation et température GPU | IOAccelerator `PerformanceStatistics`, SMC | Compteurs PDH `GPU Engine` ; NVML (NVIDIA) pour la température | amdgpu `gpu_busy_percent`, `nvidia-smi` | M | F | — |
| monitorMemory | Mémoire, swap, pression | `HOST_VM_INFO64`, sysctl | `GlobalMemoryStatusEx`, `GetPerformanceInfo`, PDH | `/proc/meminfo`, PSI `/proc/pressure/memory` | S | M | — |
| monitorNetwork | Débit, interfaces, trafic par processus, test de débit | sysctl `NET_RT_IFLIST2`, `nettop` | `GetIfTable2` ; par processus : ETW (admin) | `/proc/net/dev` ; par processus : nethogs (cap_net_raw) | M (L par processus) | F | A |
| monitorDisk | Espace, E/S, éjection | `statfs`, IOBlockStorageDriver, DiskArbitration | `GetDiskFreeSpaceEx`, PDH `PhysicalDisk` | `statvfs`, `/proc/diskstats` | S | F | — |
| monitorPower | Watts système et chargeur, batterie (%, santé, cycles, temps restant, température) | SMC `PSTR`/`PDTR`, `AppleSmartBattery`, `IOPSCopyPowerSourcesInfo`, `system_profiler` (§ 3.1) | Débit de décharge : WMI `root\wmi BatteryStatus` (DischargeRate), `IOCTL_BATTERY_QUERY_STATUS`, WinRT `Windows.Devices.Power.Battery` ; santé : `BatteryFullChargedCapacity`/`BatteryStaticData`, `powercfg /batteryreport` ; **watts système totaux : non** (seulement l'interface EMI sur certaines plateformes) | UPower `EnergyRate`, `/sys/class/power_supply/BAT*` ; RAPL (root) | M | **H** | — |
| connectedDevices | Périphériques USB et batteries des accessoires | IOKit USB/HID, `system_profiler` | SetupAPI / WMI `Win32_PnPEntity` | udev, sysfs USB, UPower | S | F | — |
| fanControl | Lire et piloter les ventilateurs | SMC via démon root XPC | Pas d'API standard : WMI/EC propres au constructeur, ou pilote noyau → **s.o.** | hwmon `pwm*` (root), `thinkpad_acpi`, nbfc-linux | XL | F | A/I/S (surchauffe) |

**Bilan de la matrice** (80 features, toutes présentes). **2 de valeur haute** : `keepAwake`, `monitorPower`.
**9 de valeur moyenne** : `bluetoothSleep`, `brightness` et `quickToggles` (éteindre l'écran), `killProcess`,
`monitorCPU`, `monitorMemory` et `quitApps` (repérer et arrêter ce qui consomme), `cleaner`, `notchAgents` (déjà dans
AI Box). **13 sans objet** ou déjà natives sous Windows (difficulté « — »), et une dizaine d'autres existent déjà sous
Windows sous une autre forme (Touches filtres, focus au survol, Win+V, PowerToys). Les ~57 restantes relèvent d'un
« PowerToys bis » : beaucoup de travail, aucune valeur pour le besoin n°1.

---

## 3. Les mécanismes énergie en détail

### 3.1 Comment Vorssaint fait (lu dans le code) `confirmed`

**Keep Awake** (`Services/KeepAwakeManager.swift`, abrégé KAM)
- *Modes* : minuterie (15 min à 8 h, ou indéfini, ou « jusqu'à telle heure » ; une heure passée ne glisse jamais au
  lendemain), démarrage au lancement, **automatismes** combinables (Tous/Au moins un) : écran externe branché, secteur
  branché, apps choisies lancées (KAM:565-672). Changements d'écran amortis 0,35 s, d'alimentation 0,1 s. Un arrêt
  manuel d'une session automatique la suspend jusqu'à ce que les conditions retombent. Pas de mode « pendant un
  téléchargement ».
- *Pause à l'écran verrouillé* : au verrouillage, tout est rendu (assertions, veille du capot, surveillance batterie) ;
  au déverrouillage, tout est réappliqué, ou la session se termine si sa minuterie a expiré (KAM:415-484).
- *Assertions* : `PreventUserIdleSystemSleep` toujours ; `PreventUserIdleDisplaySleep` sauf si l'utilisateur laisse
  l'écran s'éteindre (KAM:727-767). Pas de `PreventSystemSleep` : le capot passe par pmset.
- *Capot fermé* : `pmset disablesleep 1` (root, via la règle sudoers à deux commandes, § 1.4). Toutes les écritures et
  sondes pmset passent par une file série unique (ordre garanti). La disponibilité se prouve en rejouant la valeur
  courante par `sudo -n`, pas par `sudo -l` qui mentait sur certaines machines (issue #269). Une seule invite admin à
  la fois (issue #63), app ramenée au premier plan avant l'invite (sinon elle s'ouvre derrière).
- *Détection du capot* : propriété `AppleClamshellState` de `IOPMrootDomain`, transitions par notification d'intérêt
  IOKit (pas de sondage) mais relecture et comparaison car la notification tire pour bien d'autres raisons.
- *Restauration* : **marqueur écrit avant l'activation** (un crash pendant l'activation laisse une trace) ; à la
  sortie, désactivation synchrone sur la même file ; au lancement suivant, `pmset -g` puis désactivation silencieuse,
  sinon avec invite ; le marqueur n'est effacé qu'après une désactivation confirmée ; le désinstalleur restaure aussi.
  **Piège #1729** : rétablir la veille ne réévalue pas un capot fermé pendant la session, la machine reste éveillée
  jusqu'à batterie vide ; correctif : demander explicitement la veille (`IOPMSleepSystem`, 10 essais à 0,5 s), sauf
  sur secteur avec écran externe, et sauf si une assertion qui s'applique au capot est active.
- *Coupure batterie* : seuil 0/5/10/15/20 % (défaut 10), seulement sur batterie, contrôle immédiat puis toutes les
  30 s (tolérance 5 s) ; une session automatique refuse de démarrer sous le seuil ; notification à la coupure. Pas de
  coupure thermique.
- *Écran éteint capot fermé* : à la fermeture, mémorise la luminosité du panneau interne et la met à 0 (API privée
  DisplayServices) ; une lecture nulle n'est jamais mémorisée (sinon on « restaure » du noir, issue #370) ; la valeur
  est persistée pour être rendue après un crash ; 6 essais à 0,5 s puis nouvel essai à l'ouverture.
- *Agitation de souris* optionnelle (1 px aller-retour, toutes les 1 à 15 min) pour les apps qui regardent l'activité.

**Bluetooth à la veille** (`Services/Bluetooth/BluetoothSleepService.swift`) : fonctions privées de préférence
Bluetooth, sans droits ; écoute `willSleep`/`didWake` seulement quand la feature est active, aucune minuterie. **Règle :
ne rendre que ce qu'on a pris** : à la veille, si le Bluetooth était allumé, on l'éteint et on note une « dette » ; au
réveil, on le rallume seulement si la dette existe et qu'il est toujours éteint ; un allumage manuel entre-temps annule
la dette. La dette est persistée : un arrêt pendant la veille est remboursé au lancement suivant.

**Moniteur de puissance** (`Services/Metrics/PowerSampler.swift`) : watts système et chargeur par SMC, batterie par
`AppleSmartBattery` (tension × courant signé, capacité, cycles, santé), temps restant, température. **Son propre coût
est maîtrisé** : la minuterie n'existe que si une surface visible, une métrique épinglée ou une alerte en a besoin ;
seules les sections affichées sont lues ; pas de 1 s au premier plan mais 15 s en arrière-plan pour la puissance et
la température ; cadence = PGCD des pas nécessaires ; tolérance de minuterie 15 % ; rafraîchissement immédiat sur
évènement branchement/débranchement plutôt que par sondage ; alertes seulement après 12 s soutenues.

Ni limite de charge (pas de clé SMC de charge), ni mode basse consommation piloté : l'app ne fait que *lire* l'état
Low Power Mode.

### 3.2 Windows 11 portable : faire pareil, avec les vrais pièges

**Ce qui protège quoi** (sources [W1]–[W5]) :

| Mécanisme | Empêche la veille par inactivité | Empêche la veille au capot | Survit à la veille moderne sur batterie |
|---|---|---|---|
| `SetThreadExecutionState(ES_SYSTEM_REQUIRED\|ES_CONTINUOUS)` | oui | **non** : « ne peut pas empêcher l'utilisateur de mettre l'ordinateur en veille… fermer le capot » [W1] | non |
| `PowerSetRequest(PowerRequestSystemRequired / ExecutionRequired)` | oui | **non** : les requêtes sont *terminées* à l'entrée en veille initiée par l'utilisateur (bouton, capot, menu) [W2] | non : sur batterie, terminées 5 min après l'expiration du délai de veille [W2] |
| `PowerRequestAwayModeRequired` | oui | seule exception documentée, **S3 uniquement** ; déconseillé sur portable [W1][W2] | s.o. |
| Electron `powerSaveBlocker('prevent-app-suspension')` | oui (= `PowerCreateRequest` + `ExecutionRequired` dans Chromium) [W6] | non | non |
| **Action du capot = Ne rien faire** (`LIDACTION`=0) | — | **oui** | dépend du délai de veille (ci-dessous) |

**1. Action du capot** `confirmed` (doc) / droits `needs_validation`
- Sous-groupe `SUB_BUTTONS` = `4f971e89-eebd-4455-a8de-9e59040e7347`, réglage `LIDACTION` =
  `5ca83367-6e45-459f-a27b-476b1d01c936` (caché) ; valeurs 0 Ne rien faire, 1 Veille, 2 Veille prolongée, 3 Arrêt [W3].
- Deux valeurs distinctes : `powercfg /setacvalueindex` (secteur) et `/setdcvalueindex` (**batterie, le cas qui
  compte**) ; par schéma (le GUID du schéma est un argument) ; puis `powercfg /setactive <schéma>` pour appliquer [W4].
- Le curseur « Mode d'alimentation » (schémas superposés) ne touche que `SUB_PROCESSOR` et `SUB_GRAPHICS`, jamais le
  capot [W4].
- Une stratégie de groupe (Gestion de l'alimentation › Paramètres des boutons) peut écraser la valeur du schéma : la
  lire avant d'agir. `needs_validation`
- Droits : la doc ne réserve à l'administrateur que `/systemsleepdiagnostics` et `/spr` ; les ACL par défaut laissent
  en général un utilisateur standard modifier son schéma, mais **c'est à mesurer** (un utilisateur non admin, puis un
  administrateur sous UAC non élevé). `needs_validation`
- Lire la valeur courante : `powercfg /q SCHEME_CURRENT SUB_BUTTONS LIDACTION` (indices AC et DC courants).

**2. Veille moderne (S0ix) contre S3** `needs_validation` (portable)
- `powercfg /a` dit lequel des deux ; le modèle ne se change pas dans le BIOS (réinstallation de l'OS) [W5].
- Avec capot = Ne rien faire en veille moderne, le système reste actif jusqu'au délai d'extinction de l'écran, et sur
  batterie la politique DC du capot est réévaluée au débranchement [W7]. Or « un système entre en veille moderne quand
  l'écran s'éteint », y compris par inactivité [W8] : l'écran éteint ouvre la séquence ; les power requests la
  retiennent (phase « No-CS »), **indéfiniment sur secteur, au plus 5 minutes après le délai de veille sur batterie**
  [W2][W8]. Conséquence : **sur batterie, il faut aussi mettre le délai de mise en veille DC (`STANDBYIDLE`) à
  « jamais » pendant les sessions**, et le restaurer après. À valider sur le portable.
- Réseau en veille moderne : par défaut (« Adaptive Connected Standby » depuis Windows 10 2004), le réseau est coupé
  sur batterie [W9] ; pour des agents qui parlent à une API, la machine ne doit donc pas entrer en veille du tout.

**3. Desktop Activity Moderator (DAM)** `confirmed` (doc), impact `needs_validation`
- En veille moderne, le DAM place les processus de session interactive dans un job système suspendu : **tous leurs
  threads sont suspendus** (donc AI Box, `claude.exe`, `node`) ; les services de la session 0 sont bridés (au plus
  1 s d'activité toutes les 30 s, voire plus du tout depuis 24H2) [W10][W8]. Aucune exemption pour une app de bureau :
  on peut seulement être prévenu (`PowerRegisterSuspendResumeNotification`). **La seule parade est de ne jamais
  entrer en veille moderne pendant une session**, d'où le point 2.

**4. Ce qui ne marche pas, et pourquoi** : `SetThreadExecutionState`, `powerSaveBlocker`, l'agitation de souris, le
mode « Présentation » : tous respectent le geste de l'utilisateur (capot). `powercfg /requestsoverride` sert à
*ignorer* des requêtes, pas à en imposer. Le mode Absent (`AwayMode`) n'existe qu'en S3 et Microsoft le déconseille
sur portable [W1].

**5. Économiser pendant que ça tourne**
- *EcoQoS* : `SetProcessInformation(ProcessPowerThrottling, PROCESS_POWER_THROTTLING_EXECUTION_SPEED)` place un
  processus en EcoQoS (fréquence la plus efficace, cœurs efficaces) ; le niveau Eco n'existe que sous Windows 11 ;
  le parent peut l'appliquer à ses enfants avec un handle `PROCESS_SET_INFORMATION` [W11][W12]. Le « mode
  efficacité » du Gestionnaire des tâches = EcoQoS + priorité de base basse [W13]. Gain chiffré : non publié.
  Recommandation : EcoQoS **sur batterie seulement**, pour les processus des workers (pas leurs builds/tests longs
  quand l'utilisateur attend), réversible (`ControlMask` = `StateMask` = 0 rend la main au système). `needs_validation`
- *`IGNORE_TIMER_RESOLUTION`* : ignore les demandes de résolution de minuterie d'un processus (réveils CPU) [W11].
- *Processeur* (sous-groupe `54533251-82be-4824-96c1-47b60b740d00`, caché) : `PERFEPP`
  (`36687f9e-e3a5-4dbf-b1dc-15eb381c6863`, 0–100, n'agit qu'avec CPPC v2 autonome) [W14], `PERFBOOSTMODE`
  (`be337238-0d82-4146-a960-4f3749d470c7`, 0 = désactivé) [W15], `PROCTHROTTLEMAX`
  (`bc5038f7-23e0-4960-96da-33abaf5935ec`). Couper le boost sur batterie est le levier le plus net pour une charge
  « agent » (beaucoup d'attente réseau, rafales courtes). Microsoft déconseille de toucher aux autres réglages
  processeur sans le fabricant [W14].
- *Mode d'alimentation* « Meilleure efficacité énergétique » (`961cc777-2547-4f9d-8174-7d86181b8a7a`) par
  `powercfg /setactiveoverlay` (admin selon une réponse Q&A) ; l'API `PowerSetActiveOverlayScheme` n'est pas
  documentée [W16]. `needs_validation`
- *Économiseur d'énergie* (Windows 11 24H2+, remplace l'économiseur de batterie ; seuil `ESBATTTHRESHOLD`
  `e69653ca-cf7f-4f05-aa73-cb833fa90ad4`) : −30 % de luminosité, transparence coupée, et à batterie faible
  **bloque des apps en arrière-plan et diffère des tâches planifiées** [W17]. Effet sur `claude.exe`/`node` (processus
  Win32 ordinaires) : `needs_validation`.

**6. Écran éteint capot fermé** `needs_validation`
- En veille moderne, l'écran s'éteint dès la fermeture du capot quand celle-ci met en veille [W18] ; avec Ne rien
  faire, rien ne garantit que le panneau interne s'éteigne (dépend du firmware/pilote graphique).
- Leviers : délai `VIDEOIDLE` (`3c0bc021-c8a8-4e07-a973-6b14cbcb2b7e`, secondes) court sur batterie — **mais** en
  veille moderne l'extinction de l'écran déclenche la séquence de veille (point 2), d'où l'importance de
  `STANDBYIDLE` DC = jamais ; ou extinction immédiate par `SendMessage(HWND_BROADCAST, WM_SYSCOMMAND, SC_MONITORPOWER, 2)`
  [W19] à l'évènement « capot fermé ». Lire le capot : `RegisterPowerSettingNotification(GUID_LIDSWITCH_STATE_CHANGE =
  BA3E0F4D-B817-4094-A2D1-D56379E6A0F3)`, 0 = fermé ; notifié seulement une fois le capot détecté [W20]. **Electron
  `powerMonitor` n'a aucun évènement capot** [W21] : il faut une fenêtre native qui reçoit `WM_POWERBROADCAST`
  (module natif ou assistant PowerShell/C# comme `winJobs.ts`).

**7. Radios**
- Wi-Fi : **à garder** (les agents parlent à l'API). Réglage possible : économie d'énergie de la carte sans fil sur
  batterie (sous-groupe « Paramètres de l'adaptateur sans fil »). `needs_validation`
- Bluetooth : `Windows.Devices.Radios.Radio.SetStateAsync` (WinRT, « peut nécessiter le consentement explicite de
  l'utilisateur » ; besoin d'une capacité pour une app non empaquetée : non documenté) [W22]. Capot fermé, la machine
  ne passe plus en veille : la logique Vorssaint « à la veille » devient « **à la fermeture du capot pendant une
  session** », avec la même règle de dette.
- `CONNECTIVITYINSTANDBY` est déprécié depuis Windows 10 2004 [W23].

**8. Sécurité batterie** `confirmed` (doc)
- Capot = Ne rien faire et plus de veille par délai : **plus rien n'arrête la machine avant la batterie vide**, sauf
  l'action critique. Régler `BATACTIONCRIT` (`637ea02f-bbcb-4015-8e2c-a1c7b9c0b546`) à 2 (veille prolongée) et vérifier
  qu'elle est disponible (`powercfg /a`, `powercfg /h on`) ; `BATLEVELCRIT` (`9a66d8d7-4ff7-4ef9-b5a2-5a326ca2a469`)
  ne fait que « contribuer » au déclenchement [W24][W25]. Et couper **soi-même** la session sous un seuil (modèle
  Vorssaint : 10 %, toutes les 30 s, seulement sur batterie), en restaurant les réglages, ce qui rend la veille au
  capot.
- *Piège Vorssaint #1729 transposé* : si on restaure `LIDACTION` alors que le capot est déjà fermé, Windows ne
  réévalue pas forcément l'évènement ; il faut alors demander la veille explicitement (`SetSuspendState`, ou veille
  prolongée si la batterie est basse). `needs_validation`
- *Chaleur* : un portable qui calcule capot fermé dans un sac chauffe ; prévoir une coupure sur évènement thermique si
  disponible et le dire dans l'interface. `needs_validation`

**9. Télémétrie batterie** : `GetSystemPowerStatus` (secteur, %, temps restant, économiseur), `Win32_Battery`,
`root\wmi BatteryStatus` (débit de décharge, `needs_validation`), WinRT `Windows.Devices.Power.Battery`
(`ChargeRateInMilliwatts`), `powercfg /batteryreport` (historique, capacité), `/energy` (60 s d'observation),
`/srumutil` (estimation d'énergie par app), `/sleepstudy` (veille moderne seulement) [W4][W26][W27]. Évènements :
`GUID_ACDC_POWER_SOURCE`, `GUID_BATTERY_PERCENTAGE_REMAINING`, `GUID_POWER_SAVING_STATUS` [W20] ; Electron
`powerMonitor` fournit `on-ac`/`on-battery`, `suspend`/`resume`, `lock-screen` sous Windows [W21].

**Recette Windows proposée pour une session « capot fermé »** (P1) :
1. Au premier worker qui travaille : lire et **journaliser** les valeurs actuelles (LIDACTION AC/DC, STANDBYIDLE DC,
   éventuellement VIDEOIDLE DC et BATACTIONCRIT) dans un fichier de restauration *avant* toute écriture.
2. Écrire LIDACTION AC/DC = 0, STANDBYIDLE DC = 0 (veille moderne seulement), BATACTIONCRIT = 2 si hibernation
   disponible ; `powercfg /setactive SCHEME_CURRENT`. Prendre une power request `ExecutionRequired` (ce que fait déjà
   `powerSaveBlocker`).
3. Pendant la session : écouter capot et alimentation ; capot fermé → écran éteint, Bluetooth coupé (dette), EcoQoS
   sur batterie ; batterie sous le seuil → fin de session.
4. Au dernier worker qui s'arrête (avec un délai de grâce), à la sortie, ou au lancement suivant après un crash :
   restaurer **seulement les valeurs qu'on a changées et que l'utilisateur n'a pas modifiées depuis**, puis demander
   la veille si le capot est fermé.

### 3.3 Linux : la même chose

- **Le capot** : seul un inhibiteur logind `handle-lid-switch` en mode `block` désactive la gestion du capot par
  logind ; `delay` n'est pas accepté pour lui [L1][L2]. Les verrous `sleep`/`idle` **ne suffisent pas** : par défaut
  `LidSwitchIgnoreInhibited=yes`, le capot ignore les inhibiteurs de veille [L3]. D-Bus :
  `org.freedesktop.login1.Manager.Inhibit("handle-lid-switch", qui, pourquoi, "block")` rend un descripteur ; le verrou
  tombe quand le descripteur est fermé, donc **à la mort du processus** : restauration gratuite, sans marqueur [L4].
  Depuis systemd 257, `block` s'applique aussi aux processus privilégiés ; l'ancien comportement s'appelle
  `block-weak` [L4]. `confirmed` (doc)
- **Droits** : politique polkit par défaut `inhibit-handle-lid-switch` = non / oui / oui (quelconque / inactive /
  active) : **sans root pour une session locale active**, refusé hors session (SSH, service système) [L5]. Le cas
  `systemd --user` reste à vérifier. `needs_validation`
- **logind.conf** : `HandleLidSwitch=suspend`, `HandleLidSwitchExternalPower` (hérite si absent),
  `HandleLidSwitchDocked=ignore` ; dépôts dans `/etc/systemd/logind.conf.d/` (root) [L3]. À ne pas modifier : on
  préfère l'inhibiteur, réversible par construction.
- **Bureaux** : GNOME a retiré en 2024 son propre verrou du capot et laisse logind décider [L6] ; **KDE PowerDevil
  tient son propre verrou et ignore ceux des autres applications** (bug 485623, ouvert) [L7] : détecter KDE et
  l'expliquer à l'utilisateur (contournement : action du capot de PowerDevil). `needs_validation`
- **Electron** : `powerSaveBlocker` passe par `org.gnome.SessionManager.Inhibit` (drapeaux 4/8), puis
  `org.freedesktop.PowerManagement`/`ScreenSaver` ; jamais logind : inutile pour le capot [L8].
- **Économie** : power-profiles-daemon `HoldProfile("power-saver", …)` (sans root, libéré à la sortie du processus ou
  si l'utilisateur change de profil) [L9] ; tuned-ppd (Fedora 41+) expose la même API ; TLP est concurrent, ne pas
  le combattre. Enfants : `systemd-run --user --scope -p CPUWeight=idle` (délégation `cpu` dans `user@.service`
  récent) [L10]. EPP/boost en sysfs : root. Pas d'équivalent direct d'EcoQoS.
- **Batterie** : UPower `DisplayDevice` (`Percentage`, `EnergyRate` en W, `TimeToEmpty`, `OnBattery`, `LidIsClosed`)
  [L11]. **Piège** : l'action critique UPower par défaut (Fedora : `HybridSleep`) échoue sans swap suffisant et la
  batterie se vide en silence [L12] : surveiller et couper soi-même, comme sous Windows.
- **Écran** : X11 `xset dpms force off` ; Wayland : `wlr-output-power-management` (Sway, Hyprland…) mais pas KWin ni
  Mutter [L13] ; luminosité sans root par logind `Session.SetBrightness` (ne l'éteint pas) [L4].
- **Radios** : rfkill (`/dev/rfkill`, accès de session à vérifier) ou BlueZ `Adapter.Powered` [L14].
- **Capot** : logind `LidClosed`, UPower `LidIsClosed` ; `/proc/acpi/button/lid/*/state` peu fiable à l'ouverture
  [L15].

> **Ce qu'AI Box a déjà (énergie)** `confirmed`
> - `powerSaveBlocker.start('prevent-app-suspension')` (`src/main/main.ts:365-368`) : **seulement** passé à
>   `RemoteServer`, qui le prend pendant `stepAway`/`comeBack` (`src/main/remoteServer.ts:470-488`), c'est-à-dire le
>   temps de déplacer des workers vers le VPS. **Rien n'empêche aujourd'hui la veille pendant que des workers locaux
>   travaillent**, contrairement à ce qu'on croyait. Et même pris, il ne tient pas au capot (§ 3.2).
> - `powerMonitor` : `getSystemIdleTime` (absence), `lock-screen` → départ automatique vers le VPS, `resume` → relecture
>   des tours laissés au serveur (`main.ts:369`, `1521-1522`). Pas d'écoute `on-battery`/`on-ac`.
> - « Un worker travaille » : `busyReasons()` (`src/main/busy.ts`), utilisé par `SessionManager.isWorking`
>   (`src/main/sessions.ts:3012`, privé). C'est le déclencheur naturel du mode capot fermé.
> - `src/main/power.ts` : mise en sommeil/réveil d'une instance OVHcloud. **Aucun rapport avec l'énergie locale** :
>   le nouveau module ne doit pas s'appeler `power` (`energy` évite la confusion).
> - `src/main/procTree.ts` (arbre des processus d'une session, via un assistant PowerShell persistant) et
>   `src/main/winJobs.ts` (job objects Windows : tout ce qu'une session lance meurt avec le hub) : c'est là qu'on
>   trouve les PID à passer en EcoQoS.
> - `src/main/costLog.ts` : coût par tour, écrit en fin de tour, lu seulement à la demande (« rien ne tourne au
>   repos ») : le même principe vaut pour la télémétrie énergie.
> - Fermer l'app tue les workers : `will-quit` → `manager.killAll()` (`main.ts:1549-1553`), et les job objects le
>   garantissent même en cas de crash. Pour le besoin n°1, il faut donc que **fermer la fenêtre ne quitte pas l'app**
>   tant que des workers travaillent (réduire dans la zone de notification).

---

## 4. Recommandation d'architecture

### 4.1 Principe : un cœur de décision pur, des adaptateurs fins

```
                AI Box (processus principal)
 ┌──────────────────────────────────────────────────────────────────┐
 │ SessionManager ──(des workers travaillent ? busyReasons)──┐       │
 │ réglages utilisateur (seuil batterie, Bluetooth, écran…) ─┤       │
 │                                                           ▼       │
 │ src/main/energy/                                                  │
 │   policy.ts   entrées → état voulu (pur, testé)                   │
 │   journal.ts  ce qu'on a changé + anciennes valeurs (fichier)     │
 │   index.ts    boucle : évènements → policy → adaptateur           │
 │      │ interface EnergyPlatform                                   │
 │      ├── win32.ts   powercfg, PowerRequest, WM_POWERBROADCAST,    │
 │      │              EcoQoS, Radios, batterie                       │
 │      ├── linux.ts   logind Inhibit(fd), UPower, PPD, rfkill        │
 │      └── darwin.ts  « non pris en charge » (Vorssaint existe)      │
 └──────────────────────────────────────────────────────────────────┘
```

- **Entrées du cœur** : des workers travaillent (et depuis quand), secteur/batterie, pourcentage, capot ouvert/fermé,
  verrouillage, réglages. **Sortie** : un état voulu (« garder la machine active capot fermé », « EcoQoS sur ces PID »,
  « Bluetooth coupé », « écran éteint ») ; l'adaptateur le réalise et dit ce qu'il a pu faire (capacités). Le cœur ne
  connaît ni `powercfg` ni D-Bus : il se teste avec des évènements simulés, sur la machine de bureau.
- **Journal de restauration** (l'idée la plus précieuse de Vorssaint) : écrire *avant* d'agir ce qu'on va changer et
  la valeur d'origine ; restaurer à la fin, à la sortie, et **au démarrage suivant** si le journal n'est pas vide ; ne
  restaurer que ce qui vaut encore notre valeur (l'utilisateur a pu changer entre-temps) ; « ne rendre que ce qu'on a
  pris » pour les radios. Sous Linux, le verrou logind se libère seul à la mort du processus.
- **Économe par construction** : aucune minuterie quand aucun worker ne travaille ; évènements plutôt que sondage
  (capot, alimentation) ; batterie lue toutes les 30 s seulement pendant une session sur batterie, avec tolérance.
- **Le contrat réel** (`EnergyPlatform`, noms de fichiers) est celui de `hub-energy-win`, fusionné en premier ;
  `hub-energy-linux` s'y aligne. Ce schéma n'en est qu'une lecture.

### 4.2 Ce qui va dans AI Box, et ce qui n'y va pas

| Dans AI Box (sert ses agents) | Hors d'AI Box (utilitaire autonome, plus tard) |
|---|---|
| Mode « capot fermé » lié aux workers, coupure batterie, restauration | Moniteur système complet (CPU, GPU, réseau, disque, températures) |
| Écran éteint et Bluetooth coupé capot fermé pendant une session | Nettoyeur, désinstalleur, interface winget |
| EcoQoS des processus des workers sur batterie | Réglages souris/clavier, presse-papiers, fenêtres, son |
| Une ligne d'état : « capot fermé autorisé · batterie 64 % · −7,8 W » | Tout ce qui est « PowerToys bis » ou Dynamic Island |
| Réduire dans la zone de notification au lieu de quitter quand des workers travaillent | Optimisations machine permanentes (plan d'alimentation, démarrage) : audit et conseils (`hub-energy-audit`), pas d'agent permanent |

Raison : AI Box est un hub d'agents ; tout ce qu'il embarque tourne pendant les sessions et coûte de la batterie. Un
moniteur complet y serait une seconde app.

### 4.3 Actions privilégiées

**Windows**
1. *D'abord sans élévation* : si `powercfg /setdcvalueindex` sur le schéma actif marche en utilisateur standard (à
   mesurer, § 4.6), aucune élévation n'est nécessaire pour P1.
2. *Sinon, une tâche planifiée créée une fois* (« exécuter avec les privilèges les plus élevés », une seule invite UAC
   à l'installation), qui lance un script **figé** n'acceptant que deux verbes (appliquer / restaurer le capot) et des
   valeurs validées ; l'app la déclenche par `schtasks /run`. C'est l'analogue de la règle sudoers à deux commandes
   de Vorssaint : privilège étroit, demandé une fois, sans mot de passe ensuite. Le script et ses ACL doivent être
   non modifiables par l'utilisateur (sinon élévation de privilège).
3. *Élévation à la demande* (`ShellExecute` verbe `runas`) : une invite UAC à chaque session : acceptable pour des
   réglages rares (BATACTIONCRIT, hibernation), pas pour le capot.
4. *Service Windows* (LocalSystem + tube nommé avec ACL et vérification de l'appelant) : le modèle du démon
   ventilateurs ; trop lourd pour P1, à réserver à l'utilitaire autonome s'il en a vraiment besoin.

**Linux** : polkit. L'inhibiteur `handle-lid-switch` et `HoldProfile` n'en demandent pas pour une session active ; EPP,
seuils de charge, logind.conf demandent root : soit une action polkit dédiée (`pkexec` d'un assistant figé + fichier
`.policy`), soit ne pas le faire et laisser TLP/PPD.

### 4.4 Utilitaire autonome : quel framework

| Option | Pour | Contre |
|---|---|---|
| **Electron** (déjà maîtrisé) | Réutilise `src/main/energy/` tel quel ; même outillage, mêmes tests | ~100–150 Mo de RAM et un moteur Chromium pour une icône de zone de notification : contraire à « consommer le moins possible » |
| **Tauri 2 (Rust)** | Binaire de quelques Mo, WebView2/WebKitGTK système, ~30–50 Mo ; accès Win32 direct (`windows-rs`), D-Bus (`zbus`) ; interface web réutilisable | Les adaptateurs sont à réécrire en Rust (ils sont fins) ; une compétence de plus dans le projet |
| **.NET** (WinForms/WPF, ou Avalonia) | Excellent sur Win32/WinRT (Radios, batterie, notifications de puissance sans pont) | Windows d'abord ; Avalonia pour Linux ; runtime à embarquer ; troisième pile |

Recommandation : **ne pas construire l'utilitaire avant P3**. Le besoin n°1 vit dans AI Box, qui tourne déjà quand les
agents travaillent. Si l'utilitaire se fait, **Tauri 2** est le meilleur compromis pour une app résidente économe ;
le cœur de décision reste petit et spécifié par ses tests, qu'on porte avec lui. Electron reste la voie rapide si la
consommation de l'utilitaire importe peu (décision utilisateur).

### 4.5 Feuille de route

| Phase | Contenu | En parallèle |
|---|---|---|
| **P1 – Capot fermé pour les agents** | Module `energy` : cœur + journal + adaptateur Windows (LIDACTION AC/DC, STANDBYIDLE DC en veille moderne, power request, coupure batterie, restauration au démarrage, veille redemandée si capot fermé) ; réglage dans AI Box ; réduire dans la zone de notification au lieu de quitter quand des workers travaillent ; correction : prendre la power request pendant que des workers travaillent | Adaptateur Linux (inhibiteur logind, UPower) ; audit énergie de la machine (`hub-energy-audit`) |
| **P1-V – Validation sur portable** | L'utilisateur lance les mesures du § 4.6 sur le portable ; on corrige d'après les résultats | — |
| **P2 – Consommer moins pendant la session** | Écran éteint et Bluetooth coupé capot fermé ; EcoQoS des processus des workers sur batterie ; boost CPU coupé sur batterie (si P1-V montre un gain) ; ligne d'état (batterie, watts, temps restant) ; AI Box lui-même silencieux fenêtre cachée | Audit : démarrage, services, tâches planifiées, processus gourmands (conseils, pas d'agent) |
| **P3 – Utilitaire autonome (optionnel)** | Zone de notification : Keep Awake à la minuterie/aux automatismes hors AI Box, moniteur de puissance, tueur de processus, nettoyeur par revue (Corbeille) | Choix du framework (§ 4.4) |
| **P4 – Le reste, à la demande** | Features de la matrice de valeur F, une à une, seulement si PowerToys ou Windows ne le fait pas déjà | — |

### 4.6 Étape « validation sur portable » (à lancer par l'utilisateur)

Rien de ce qui suit n'est vérifiable sur la machine des workers (bureau, S3, sans batterie). Sur le portable, dans un
PowerShell **non élevé** sauf mention :

1. Type de veille : `powercfg /a` (« Veille (S0 faible consommation) » = veille moderne).
2. Valeurs actuelles : `powercfg /q SCHEME_CURRENT SUB_BUTTONS LIDACTION` et
   `powercfg /q SCHEME_CURRENT SUB_SLEEP STANDBYIDLE` (noter les index AC/DC).
3. Droits : rejouer la valeur DC actuelle sans la changer, `powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS
   LIDACTION <valeur lue>` ; si « Accès refusé », il faudra la tâche planifiée (§ 4.3).
4. Session réelle, sur batterie : AI Box en mode capot fermé, un worker qui travaille 30 min, capot fermé, portable sur
   une surface dure. À la réouverture : le worker a-t-il avancé (heures des messages) ? Combien de % perdus ?
5. Veille et DAM : `Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Kernel-Power'}
   -MaxEvents 30` (évènements d'entrée/sortie de veille pendant le test) ; en veille moderne,
   `powercfg /sleepstudy` (admin) montre les sessions de veille et les consommateurs.
6. Consommation : `powercfg /batteryreport` avant/après (capacité, usage) ; si possible, l'outil de mesure de
   `hub-energy-audit` (débit de décharge en mW toutes les minutes) avec et sans EcoQoS / boost coupé.
7. Restauration : quitter AI Box pendant une session, puis tuer son processus pendant une autre ; vérifier au
   relancement que LIDACTION et STANDBYIDLE sont revenus à leurs valeurs (étape 2).
8. Chaleur : noter la température ressentie (ou un capteur constructeur) après 30 min capot fermé.

---

## 5. Cadre légal et provenance

- **Vorssaint est sous GPL-3.0-or-later** (en-tête SPDX de chaque fichier, `LICENSE`), **AI Box est sous MIT**. Copier
  ou traduire du code GPL dans AI Box obligerait à distribuer AI Box sous GPL. La marque, le nom et l'icône
  « Vorssaint » sont en plus protégés (`TRADEMARKS.md`).
- **Règle de travail, sans exception** :
  - on s'inspire des **comportements** et des **cas limites** documentés ici (ex. : marqueur avant action, ne rendre
    que ce qu'on a pris, coupure batterie à 10 %, veille redemandée si le capot est déjà fermé) ;
  - on **ne recopie aucun code**, aucune **traduction ligne à ligne** du Swift, aucune **structure** de fichiers ou de
    types (pas de `FeatureCatalog`/`DefaultsKey` miroirs, pas les mêmes noms de clés, de fichiers sudoers ou de
    marqueurs) ;
  - **aucun nom, icône, texte ou élément de marque** de Vorssaint dans l'interface, la documentation utilisateur ou
    les noms de produit ;
  - les workers qui implémentent travaillent **à partir de ce document et des documentations Microsoft/freedesktop**,
    pas en lisant le Swift ; quand une lecture du code de référence est nécessaire, elle passe par une étude comme
    celle-ci (description en prose, sans code), relue par un autre worker.
- **Traçabilité** : une note de provenance par module, dans `docs/provenance.md`, une ligne par module :

  | Module | Comportements inspirés (références à cette étude) | Sources techniques | Code repris |
  |---|---|---|---|
  | `src/main/energy/journal.ts` | § 3.1 « Restauration » (marqueur avant action, récupération au démarrage) | — | aucun |
  | `src/main/energy/win32.ts` | § 3.1 coupure batterie, § 3.2 | [W1]–[W27] | aucun |

  plus une ligne dans le message de commit (« Behaviour informed by docs/etude-vorssaint-portage.md § x; no code
  copied »). Ce document ne contient lui-même aucun code de Vorssaint : seulement des noms d'API publiques ou privées
  d'Apple, des numéros d'issue et des comportements décrits.

---

## Sources

Windows (Microsoft Learn sauf mention) :
- [W1] SetThreadExecutionState — https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setthreadexecutionstate
- [W2] PowerSetRequest (remarques) — https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-powersetrequest
- [W3] Lid switch close action — https://learn.microsoft.com/en-us/windows-hardware/customize/power-settings/power-button-and-lid-settings-lid-switch-close-action
- [W4] Powercfg command-line options — https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/powercfg-command-line-options
- [W5] Modern Standby — https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/modern-standby
- [W6] Electron powerSaveBlocker — https://www.electronjs.org/docs/latest/api/power-save-blocker ; Chromium `power_save_blocker_win.cc` — https://chromium.googlesource.com/chromium/src/+/refs/heads/main/services/device/wake_lock/power_save_blocker/power_save_blocker_win.cc
- [W7] EnableInputSuppression — https://learn.microsoft.com/en-us/windows-hardware/customize/power-settings/power-controls-enableinputsuppression
- [W8] Prepare software for Modern Standby — https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/prepare-software-for-modern-standby
- [W9] Modern Standby network connectivity — https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/modern-standby-network-connectivity
- [W10] Desktop Activity Moderator — https://learn.microsoft.com/en-us/windows/compatibility/desktop-activity-moderator ; https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/integrating-apps-with-modern-standby
- [W11] SetProcessInformation — https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-setprocessinformation
- [W12] Quality of Service — https://learn.microsoft.com/en-us/windows/win32/procthread/quality-of-service
- [W13] Task Manager Efficiency mode (devblogs) — https://devblogs.microsoft.com/performance-diagnostics/reduce-process-interference-with-task-manager-efficiency-mode/
- [W14] PerfEnergyPreference — https://learn.microsoft.com/en-us/windows-hardware/customize/power-settings/options-for-perf-state-engine-perfenergypreference ; GUID : https://learn.microsoft.com/en-us/answers/questions/3966055/set-processor-performance-energy-preference-policy
- [W15] PerfBoostMode — https://learn.microsoft.com/windows-hardware/customize/power-settings/options-for-perf-state-engine-perfboostmode
- [W16] Overlays (Q&A) — https://learn.microsoft.com/en-us/answers/questions/3919778/changing-overlay-power-mode-with-script
- [W17] Energy Saver — https://learn.microsoft.com/en-us/windows-hardware/design/component-guidelines/energy-saver ; seuil : https://learn.microsoft.com/en-us/windows-hardware/customize/power-settings/battery-threshold
- [W18] Turning off the display — https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/turning-off
- [W19] WM_SYSCOMMAND / SC_MONITORPOWER — https://learn.microsoft.com/en-us/windows/win32/menurc/wm-syscommand
- [W20] Power setting GUIDs — https://learn.microsoft.com/en-us/windows/win32/power/power-setting-guids ; RegisterPowerSettingNotification — https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registerpowersettingnotification
- [W21] Electron powerMonitor — https://www.electronjs.org/docs/latest/api/power-monitor
- [W22] Windows.Devices.Radios.Radio — https://learn.microsoft.com/en-us/uwp/api/windows.devices.radios.radio
- [W23] Allow networking during standby — https://learn.microsoft.com/en-us/windows-hardware/customize/power-settings/no-subgroup-settings-allow-networking-during-standby
- [W24] Critical battery action — https://learn.microsoft.com/en-us/windows-hardware/customize/power-settings/battery-settings-critical-battery-action ; seuil : https://learn.microsoft.com/en-us/windows-hardware/customize/power-settings/battery-settings-critical-battery-threshold
- [W25] Hibernate idle timeout — https://learn.microsoft.com/en-us/windows-hardware/customize/power-settings/sleep-settings-hibernate-idle-timeout ; adaptive hibernate — https://learn.microsoft.com/en-us/windows-hardware/customize/power-settings/adaptive-hibernate
- [W26] GetSystemPowerStatus — https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getsystempowerstatus
- [W27] Win32_Battery — https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-battery

Linux :
- [L1] systemd-inhibit — https://www.freedesktop.org/software/systemd/man/latest/systemd-inhibit.html
- [L2] Inhibitor locks — https://systemd.io/INHIBITOR_LOCKS/
- [L3] logind.conf — https://man7.org/linux/man-pages/man5/logind.conf.5.html ; https://www.freedesktop.org/software/systemd/man/latest/logind.conf.html
- [L4] org.freedesktop.login1 — https://www.freedesktop.org/software/systemd/man/latest/org.freedesktop.login1.html
- [L5] Politique polkit de logind — https://raw.githubusercontent.com/systemd/systemd/main/src/login/org.freedesktop.login1.policy
- [L6] GNOME settings-daemon, MR 349 — https://gitlab.gnome.org/GNOME/gnome-settings-daemon/-/merge_requests/349
- [L7] KDE bug 485623 — https://bugs.kde.org/show_bug.cgi?id=485623
- [L8] Chromium `power_save_blocker_linux.cc` — https://raw.githubusercontent.com/chromium/chromium/main/services/device/wake_lock/power_save_blocker/power_save_blocker_linux.cc
- [L9] power-profiles-daemon D-Bus — https://upower.pages.freedesktop.org/power-profiles-daemon/gdbus-org.freedesktop.UPower.PowerProfiles.html
- [L10] systemd.resource-control — https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html ; cgroup v2 — https://docs.kernel.org/admin-guide/cgroup-v2.html
- [L11] UPower — https://upower.freedesktop.org/docs/UPower.html ; https://upower.freedesktop.org/docs/Device.html
- [L12] Red Hat bug 2435841 (action critique UPower) — https://bugzilla.redhat.com/show_bug.cgi?id=2435841
- [L13] wlr-output-power-management — https://wayland.app/protocols/wlr-output-power-management-unstable-v1
- [L14] rfkill — https://docs.kernel.org/driver-api/rfkill.html ; BlueZ Adapter — https://raw.githubusercontent.com/bluez/bluez/master/doc/org.bluez.Adapter.rst
- [L15] ACPI lid — https://docs.kernel.org/firmware-guide/acpi/acpi-lid.html

Code de référence (lecture seule, rien exécuté) : `C:\Users\braun\ref\vorssaint-utils`, commit `faada18`. Code AI Box :
branche `hub/vorssaint-study`, depuis `8b164a2`.
