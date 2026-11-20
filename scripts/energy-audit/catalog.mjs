// Reversible settings the audit can recommend. Nothing here is ever run by the audit: the report prints the commands,
// the user decides. Plan settings get their undo command from the value measured on the machine.
// Every id is documented in docs/optimiseur-windows.md (checked by catalog.test.mjs).

const LEARN = 'https://learn.microsoft.com/windows-hardware/customize/power-settings/';

/** Plan setting: subgroup and setting are powercfg aliases or GUIDs; ac/dc the recommended values (absent = untouched). */
const plan = (sub, setting, values) => ({ plan: { sub, setting, ...values } });

/** @type {Array<{id: string, title: string, gain: 'élevé'|'moyen'|'faible', risk: 'faible'|'moyen'|'élevé',
 *   rights: 'utilisateur'|'administrateur', scope: 'portable'|'bureau'|'tous', apply?: string[], undo?: string[],
 *   plan?: {sub: string, setting: string, ac?: number, dc?: number}, breaks: string, source: string}>} */
export const CATALOG = [
  {
    id: 'lid-nothing-ac',
    title: 'Capot fermé, branché : ne rien faire (la machine continue de travailler)',
    gain: 'élevé', risk: 'faible', rights: 'utilisateur', scope: 'portable',
    ...plan('SUB_BUTTONS', 'LIDACTION', { ac: 0 }),
    breaks: "Fermer le capot ne met plus en veille quand le chargeur est branché : il faut passer par Démarrer → Veille. Ne pas ranger la machine allumée dans une housse.",
    source: `${LEARN}power-button-and-lid-settings-lid-switch-close-action`,
  },
  {
    id: 'lid-nothing-dc',
    title: 'Capot fermé, sur batterie : ne rien faire (le temps des travaux en cours)',
    gain: 'élevé', risk: 'moyen', rights: 'utilisateur', scope: 'portable',
    ...plan('SUB_BUTTONS', 'LIDACTION', { dc: 0 }),
    breaks: "Sur batterie, capot fermé, la machine reste allumée et se vide ; elle chauffe dans un sac. À n'activer que le temps d'un travail, avec l'action « batterie critique » sur veille prolongée.",
    source: `${LEARN}power-button-and-lid-settings-lid-switch-close-action`,
  },
  {
    id: 'standby-idle-dc-off',
    title: 'Veille moderne (S0), sur batterie : pas de veille sur inactivité (le temps des travaux en cours)',
    gain: 'élevé', risk: 'moyen', rights: 'utilisateur', scope: 'portable',
    ...plan('SUB_SLEEP', 'STANDBYIDLE', { dc: 0 }),
    breaks: "En veille moderne, l’écran éteint suffit à faire entrer la machine en veille, où les applications de bureau (les workers) sont gelées ; à 0, elle reste éveillée sur batterie et se vide. À remettre à la fin du travail.",
    source: `${LEARN}sleep-settings-sleep-idle-timeout`,
  },
  {
    id: 'critical-hibernate',
    title: 'Batterie critique : veille prolongée (rien n’est perdu si la batterie se vide capot fermé)',
    gain: 'faible', risk: 'faible', rights: 'utilisateur', scope: 'portable',
    ...plan('SUB_BATTERY', 'BATACTIONCRIT', { dc: 2 }),
    breaks: 'Rien : la machine hiberne au lieu de s’éteindre brutalement (veille prolongée requise).',
    source: `${LEARN}battery-settings-critical-battery-action`,
  },
  {
    id: 'plan-balanced',
    title: 'Mode de gestion « Utilisation normale » (Balanced) au lieu de « Haute performance »',
    gain: 'élevé', risk: 'faible', rights: 'utilisateur', scope: 'tous',
    apply: ['powercfg /setactive SCHEME_BALANCED'],
    undo: ['powercfg /setactive {scheme}'],
    breaks: 'Le processeur redescend en fréquence au repos et reprend en quelques millisecondes : imperceptible hors jeux et calcul soutenu. Les modes de puissance de Paramètres (efficacité/équilibré/performances) ne s’appliquent qu’à ce mode.',
    source: 'https://learn.microsoft.com/windows-hardware/design/device-experiences/powercfg-command-line-options',
  },
  {
    id: 'cpu-min-state-ac',
    title: 'État minimal du processeur sur secteur : 5 % (au lieu de 100 %)',
    gain: 'élevé', risk: 'faible', rights: 'utilisateur', scope: 'tous',
    ...plan('SUB_PROCESSOR', 'PROCTHROTTLEMIN', { ac: 5 }),
    breaks: 'Rien de visible : le processeur peut à nouveau baisser sa fréquence au repos.',
    source: `${LEARN}options-for-perf-state-engine-minperformance`,
  },
  {
    id: 'cpu-boost-dc',
    title: 'Sur batterie : couper le turbo du processeur',
    gain: 'élevé', risk: 'faible', rights: 'utilisateur', scope: 'portable',
    ...plan('SUB_PROCESSOR', 'PERFBOOSTMODE', { dc: 0 }),
    breaks: 'Les pointes de calcul (compilation, tests) sont nettement plus lentes sur batterie ; les workers, qui attendent surtout le réseau, le sentent peu.',
    source: `${LEARN}options-for-perf-state-engine-perfboostmode`,
  },
  {
    id: 'cpu-epp',
    title: 'Préférence énergie/performance (EPP) : 50 sur batterie, 33 sur secteur',
    gain: 'moyen', risk: 'faible', rights: 'utilisateur', scope: 'tous',
    ...plan('SUB_PROCESSOR', 'PERFEPP', { ac: 33, dc: 50 }),
    breaks: 'Le processeur monte un peu moins vite en fréquence. 0 = tout pour la performance, 100 = tout pour l’économie.',
    source: `${LEARN}options-for-perf-state-engine-perfenergypreference`,
  },
  {
    id: 'sleep-idle-ac',
    title: 'Veille sur inactivité après 30 min sur secteur (AI Box la bloque tant qu’un worker tourne)',
    gain: 'élevé', risk: 'moyen', rights: 'utilisateur', scope: 'bureau',
    ...plan('SUB_SLEEP', 'STANDBYIDLE', { ac: 1800 }),
    breaks: 'Un téléchargement ou un calcul lancé hors d’une application qui le signale à Windows peut être suspendu. Les workers AI Box ne sont protégés que si l’app tient sa demande d’alimentation.',
    source: `${LEARN}sleep-settings-sleep-idle-timeout`,
  },
  {
    id: 'display-off',
    title: 'Éteindre l’écran après 5 min sur secteur, 2 min sur batterie',
    gain: 'moyen', risk: 'faible', rights: 'utilisateur', scope: 'tous',
    ...plan('SUB_VIDEO', 'VIDEOIDLE', { ac: 300, dc: 120 }),
    breaks: 'L’écran s’éteint plus tôt quand on lit sans toucher la souris.',
    source: `${LEARN}display-settings-display-idle-timeout`,
  },
  {
    id: 'hibernate-idle-dc',
    title: 'Sur batterie : veille prolongée après 3 h de veille',
    gain: 'moyen', risk: 'faible', rights: 'utilisateur', scope: 'portable',
    ...plan('SUB_SLEEP', 'HIBERNATEIDLE', { dc: 10800 }),
    breaks: 'La reprise après une longue veille prend quelques secondes de plus. Demande que la veille prolongée soit activée (`powercfg /hibernate on`, administrateur).',
    source: `${LEARN}sleep-settings-hibernate-idle-timeout`,
  },
  {
    id: 'wake-timers-dc',
    title: 'Sur batterie : interdire les minuteurs de réveil',
    gain: 'moyen', risk: 'faible', rights: 'utilisateur', scope: 'portable',
    ...plan('SUB_SLEEP', 'RTCWAKE', { dc: 0 }),
    breaks: 'Les tâches planifiées (mises à jour, maintenance) ne réveillent plus la machine sur batterie : elles attendent le prochain réveil.',
    source: `${LEARN}sleep-settings-automatically-wake-for-tasks`,
  },
  {
    id: 'energy-saver-threshold',
    title: 'Économiseur d’énergie automatique à 30 % de batterie',
    gain: 'moyen', risk: 'faible', rights: 'utilisateur', scope: 'portable',
    ...plan('SUB_ENERGYSAVER', 'ESBATTTHRESHOLD', { dc: 30 }),
    breaks: 'Sous 30 %, Windows limite les applications en arrière-plan, baisse la luminosité et la fréquence de synchronisation.',
    source: `${LEARN}battery-threshold`,
  },
  {
    id: 'aspm',
    title: 'Économie d’énergie du lien PCI Express (ASPM) au maximum',
    gain: 'moyen', risk: 'moyen', rights: 'utilisateur', scope: 'tous',
    ...plan('SUB_PCIEXPRESS', 'ASPM', { ac: 2, dc: 2 }),
    breaks: 'Sur certaines cartes mères ou cartes graphiques : micro-saccades, carte réseau ou SSD qui décroche. Annuler au moindre symptôme.',
    source: `${LEARN}pci-express-settings-link-state-power-management`,
  },
  {
    id: 'usb-selective-suspend',
    title: 'Suspension sélective USB sur secteur',
    gain: 'faible', risk: 'moyen', rights: 'utilisateur', scope: 'tous',
    ...plan('2a737441-1930-4402-8d77-b2bebba308a3', '48e6b7a6-50f5-4782-a5d4-53bb8f07e226', { ac: 1 }),
    breaks: 'Certains périphériques USB (récepteurs sans fil, DAC, adaptateurs réseau USB) se déconnectent ou réagissent avec retard.',
    source: 'https://learn.microsoft.com/troubleshoot/microsoftteams/teams-rooms-and-devices/usb-selective-suspend-status-unhealthy',
  },
  {
    id: 'power-mode-efficiency',
    title: 'Mode de puissance « Meilleure efficacité énergétique » sur batterie',
    gain: 'moyen', risk: 'faible', rights: 'utilisateur', scope: 'portable',
    apply: ['start ms-settings:powersleep   (Mode de puissance → Sur batterie → Meilleure efficacité énergétique)'],
    undo: ['start ms-settings:powersleep   (remettre la valeur précédente)'],
    breaks: 'Pointes de performance plus lentes sur batterie. Ne s’affiche qu’avec le mode « Utilisation normale ».',
    source: 'https://support.microsoft.com/windows/change-the-power-mode-for-your-windows-pc-c2aff038-22c9-f46d-5ca0-78696fdf2de8',
  },
  {
    id: 'refresh-rate',
    title: 'Fréquence d’affichage à 60 Hz pendant le travail (ou fréquence dynamique sur portable)',
    gain: 'moyen', risk: 'faible', rights: 'utilisateur', scope: 'tous',
    apply: ['start ms-settings:display-advanced   (Choisir une fréquence d’actualisation → 60 Hz ou « Dynamique »)'],
    undo: ['start ms-settings:display-advanced   (remettre la fréquence notée dans le rapport)'],
    breaks: 'Défilement moins fluide. Avec plusieurs écrans à haute fréquence, une carte graphique de bureau peut rester à des fréquences mémoire élevées même au repos.',
    source: 'https://support.microsoft.com/windows/change-the-refresh-rate-on-your-monitor-in-windows-c8ea729e-0678-015c-c415-f806f04aae5a',
  },
  {
    id: 'startup-apps',
    title: 'Désactiver les applications inutiles au démarrage',
    gain: 'moyen', risk: 'faible', rights: 'utilisateur', scope: 'tous',
    apply: ['start ms-settings:startupapps   (basculer sur Désactivé les applications citées)'],
    undo: ['start ms-settings:startupapps   (rebasculer sur Activé)'],
    breaks: 'L’application ne se lance plus seule : notifications et synchronisation attendent qu’on l’ouvre.',
    source: 'https://support.microsoft.com/windows/configure-startup-applications-in-windows-115a420a-0bff-4a6f-90e0-1934c844e473',
  },
  {
    id: 'background-apps',
    title: 'Applications du Store : activité en arrière-plan « Jamais »',
    gain: 'faible', risk: 'faible', rights: 'utilisateur', scope: 'tous',
    apply: ['start ms-settings:appsfeatures   (application → Options avancées → Autorisations des applications en arrière-plan → Jamais)'],
    undo: ['start ms-settings:appsfeatures   (même chemin → Optimisé pour l’alimentation)'],
    breaks: 'L’application ne reçoit plus de notifications ni de mises à jour tant qu’elle est fermée.',
    source: 'https://support.microsoft.com/windows/improve-pc-performance-b3b3ef5b-5953-fb6a-2528-4bbed82fba96',
  },
  {
    id: 'browser-background',
    title: 'Navigateur : ne pas tourner en arrière-plan une fois fermé',
    gain: 'moyen', risk: 'faible', rights: 'utilisateur', scope: 'tous',
    apply: [
      'Chrome : chrome://settings/system → « Continuer à exécuter les applications en arrière-plan après la fermeture » désactivé',
      'Edge : edge://settings/system → « Boost de démarrage » et « Continuer à exécuter les extensions et applications en arrière-plan » désactivés',
    ],
    undo: ['Mêmes pages : réactiver les options'],
    breaks: 'Le navigateur met une seconde de plus à s’ouvrir ; les extensions ne tournent plus fenêtre fermée.',
    source: 'https://learn.microsoft.com/deployedge/microsoft-edge-policies/startupboostenabled',
  },
  {
    id: 'game-captures',
    title: 'Xbox Game Bar : couper l’enregistrement en arrière-plan',
    gain: 'faible', risk: 'faible', rights: 'utilisateur', scope: 'tous',
    apply: ['start ms-settings:gaming-gamedvr   (« Enregistrer ce qui s’est passé » → Désactivé)'],
    undo: ['start ms-settings:gaming-gamedvr   (réactiver)'],
    breaks: 'Plus de capture rétroactive des dernières minutes de jeu.',
    source: 'https://support.xbox.com/en-US/help/games-apps/game-setup-and-play/adjust-capture-settings-windows-10',
  },
  {
    id: 'third-party-service-manual',
    title: 'Service tiers inutile en continu : démarrage manuel',
    gain: 'moyen', risk: 'moyen', rights: 'administrateur', scope: 'tous',
    apply: ['sc.exe config "<service>" start= demand'],
    undo: ['sc.exe config "<service>" start= auto        (ou delayed-auto s’il était « différé »)'],
    breaks: 'Le logiciel de l’éditeur (mise à jour, éclairage RGB, utilitaire de carte mère) ne démarre plus seul. Jamais pour un antivirus ni un service Windows.',
    source: 'https://learn.microsoft.com/windows-server/administration/windows-commands/sc-config',
  },
  {
    id: 'third-party-task-disable',
    title: 'Tâche planifiée tierce lancée à la connexion : désactiver',
    gain: 'faible', risk: 'faible', rights: 'utilisateur', scope: 'tous',
    apply: ['schtasks /Change /TN "<chemin\\tâche>" /DISABLE'],
    undo: ['schtasks /Change /TN "<chemin\\tâche>" /ENABLE'],
    breaks: 'La mise à jour ou l’outil de l’éditeur ne se lance plus à l’ouverture de session. Une tâche créée par un autre compte demande l’administrateur.',
    source: 'https://learn.microsoft.com/windows-server/administration/windows-commands/schtasks-change',
  },
  {
    id: 'device-wake-off',
    title: 'Empêcher un périphérique de réveiller la machine',
    gain: 'faible', risk: 'faible', rights: 'administrateur', scope: 'tous',
    apply: ['powercfg /devicedisablewake "<périphérique>"'],
    undo: ['powercfg /deviceenablewake "<périphérique>"'],
    breaks: 'Ce périphérique (souris, carte réseau) ne sort plus la machine de veille ; le bouton d’alimentation et le clavier restent possibles s’ils sont gardés.',
    source: 'https://learn.microsoft.com/windows-hardware/design/device-experiences/powercfg-command-line-options',
  },
  {
    id: 'bluetooth-off',
    title: 'Couper la radio inutilisée (Bluetooth, Wi-Fi quand on est en filaire)',
    gain: 'faible', risk: 'faible', rights: 'utilisateur', scope: 'tous',
    apply: ['start ms-settings:bluetooth   (ou ms-settings:network-wifi)'],
    undo: ['Même page : réactiver'],
    breaks: 'Casques, souris Bluetooth ou réseau Wi-Fi indisponibles tant que la radio est coupée.',
    source: 'https://support.microsoft.com/windows/hardware/bluetooth/turn-bluetooth-on-or-off-in-windows',
  },
];

export const byId = Object.fromEntries(CATALOG.map((c) => [c.id, c]));

const fmtSetting = (p) => `${p.sub} ${p.setting}`;

/** Apply and undo commands for an entry, the undo filled with the values measured on this machine when known.
 *  @param {{ scheme?: string, settings?: Record<string, {ac: number|null, dc: number|null}> }} now */
export function commandsFor(entry, now = {}) {
  if (!entry.plan) {
    const fill = (s) => s.replace('{scheme}', now.scheme ?? '<GUID du mode actuel>');
    return { apply: entry.apply ?? [], undo: (entry.undo ?? []).map(fill) };
  }
  const p = entry.plan;
  const cur = now.settings?.[p.setting] ?? null;
  const apply = [];
  const undo = [];
  for (const side of ['ac', 'dc']) {
    if (p[side] === undefined) continue;
    const verb = side === 'ac' ? '/setacvalueindex' : '/setdcvalueindex';
    apply.push(`powercfg ${verb} SCHEME_CURRENT ${fmtSetting(p)} ${p[side]}`);
    undo.push(`powercfg ${verb} SCHEME_CURRENT ${fmtSetting(p)} ${cur?.[side] ?? '<valeur notée avant>'}`);
  }
  apply.push('powercfg /setactive SCHEME_CURRENT');
  undo.push('powercfg /setactive SCHEME_CURRENT');
  return { apply, undo };
}

/** True when the plan setting already has the recommended values. */
export function alreadyApplied(entry, settings) {
  if (!entry.plan) return false;
  const cur = settings?.[entry.plan.setting];
  if (!cur) return false;
  return ['ac', 'dc'].every((s) => entry.plan[s] === undefined || cur[s] === entry.plan[s]);
}
