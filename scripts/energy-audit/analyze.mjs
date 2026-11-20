// Turns the collected facts into findings and recommendations. Pure: no system access, so the tests feed it fixtures.
import { CATALOG, alreadyApplied, byId } from './catalog.mjs';
import { batteryDrain, usageSummary } from './parse.mjs';

// SMBIOS chassis types of portable machines (portable, laptop, notebook, hand held, sub notebook, tablet, convertible,
// detachable...).
const PORTABLE_CHASSIS = new Set([8, 9, 10, 11, 12, 14, 18, 21, 30, 31, 32]);

const LID = { 0: 'ne rien faire', 1: 'veille', 2: 'veille prolongée', 3: 'arrêt', 4: 'éteindre l’écran' };
const secs = (v) => (v === 0 ? 'jamais' : v % 60 ? `${v} s` : `${v / 60} min`);
const pct = (v) => `${v} %`;
const map = (m) => (v) => m[v] ?? String(v);

/** Plan settings shown in the report: [alias or GUID, label, formatter]. */
export const PLAN_ROWS = [
  ['LIDACTION', 'Fermeture du capot', map(LID)],
  ['PBUTTONACTION', 'Bouton d’alimentation', map(LID)],
  ['STANDBYIDLE', 'Veille après inactivité', secs],
  ['HIBERNATEIDLE', 'Veille prolongée après', secs],
  ['HYBRIDSLEEP', 'Veille hybride', map({ 0: 'non', 1: 'oui' })],
  ['UNATTENDSLEEP', 'Veille après réveil sans utilisateur', secs],
  ['RTCWAKE', 'Minuteurs de réveil', map({ 0: 'interdits', 1: 'autorisés', 2: 'importants seulement' })],
  ['VIDEOIDLE', 'Écran éteint après', secs],
  ['PROCTHROTTLEMIN', 'État minimal du processeur', pct],
  ['PROCTHROTTLEMAX', 'État maximal du processeur', pct],
  ['PERFEPP', 'Préférence énergie/perf. (0 = perf.)', String],
  ['PERFBOOSTMODE', 'Turbo du processeur', map({ 0: 'coupé', 1: 'activé', 2: 'agressif', 3: 'efficace', 4: 'efficace agressif', 5: 'agressif garanti', 6: 'efficace agressif garanti' })],
  ['CPMINCORES', 'Cœurs minimum non parqués', pct],
  ['SYSCOOLPOL', 'Refroidissement', map({ 0: 'passif', 1: 'actif' })],
  ['ASPM', 'Économie du lien PCI Express', map({ 0: 'coupée', 1: 'modérée', 2: 'maximale' })],
  ['48e6b7a6-50f5-4782-a5d4-53bb8f07e226', 'Suspension sélective USB', map({ 0: 'coupée', 1: 'activée' })],
  ['12bbebe6-58d6-4636-95bb-3217ef867c1a', 'Wi-Fi : économie d’énergie', map({ 0: 'aucune', 1: 'faible', 2: 'moyenne', 3: 'maximale' })],
  ['ESBATTTHRESHOLD', 'Économiseur auto. sous', (v) => (v === 0 ? 'jamais' : pct(v))],
  ['BATACTIONCRIT', 'Batterie critique', map(LID)],
];

/** Plan settings keyed by alias and by GUID. */
export function settingsIndex(plan) {
  const out = {};
  for (const [guid, s] of Object.entries(plan?.settings ?? {})) {
    out[guid] = s;
    if (s.alias && !out[s.alias]) out[s.alias] = s;
  }
  return out;
}

// Applications that commonly keep running hidden; the hint says where to stop that.
const BACKGROUND_APPS = [
  [/^chrome$/i, 'Google Chrome', 'browser-background'],
  [/^msedge$/i, 'Microsoft Edge', 'browser-background'],
  [/^(ms-)?teams$/i, 'Microsoft Teams', 'startup-apps'],
  [/^onedrive$/i, 'OneDrive', 'startup-apps'],
  [/^dropbox$/i, 'Dropbox', 'startup-apps'],
  [/^googledrivefs$/i, 'Google Drive', 'startup-apps'],
  [/^icloud/i, 'iCloud', 'startup-apps'],
  [/^spotify/i, 'Spotify', 'startup-apps'],
  [/^discord/i, 'Discord', 'startup-apps'],
  [/^steam(webhelper|service)?$/i, 'Steam', 'startup-apps'],
  [/^(epicgameslauncher|epicwebhelper|eosoverlayrenderer|epiconlineservices)/i, 'Epic Games', 'startup-apps'],
  [/^riotclient/i, 'Riot Client', 'startup-apps'],
  [/^battle\.net/i, 'Battle.net', 'startup-apps'],
  [/^lghub/i, 'Logitech G HUB', 'startup-apps'],
  [/^(nvidia overlay|nvidia share)$/i, 'Superposition NVIDIA', 'startup-apps'],
  [/^(slack|zoom|whatsapp|skype|signal|telegram)/i, 'Messagerie', 'startup-apps'],
  [/^(phoneexperiencehost|yourphone)$/i, 'Mobile connecté', 'background-apps'],
  [/^(widgets|widgetservice)$/i, 'Widgets', 'background-apps'],
  [/^(ccxprocess|creative cloud|adobe)/i, 'Adobe Creative Cloud', 'startup-apps'],
  [/^(icue|razer|armourycrate)/i, 'Utilitaire de périphérique', 'startup-apps'],
  [/^msi/i, 'Utilitaire MSI', 'startup-apps'],
];

const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

/** Groups the sampled processes by name; AI Box (claude.exe, the hub and everything they started) is set apart. */
export function analyzeProcesses(ps) {
  const list = ps?.processes?.list ?? [];
  const seconds = ps?.processes?.seconds || 1;
  const logical = ps?.system?.logicalProcessors || 1;
  const children = new Map();
  for (const p of list) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p);
  }
  const hub = new Set();
  const queue = list.filter((p) => p.hubLike);
  while (queue.length) {
    const p = queue.pop();
    if (hub.has(p.pid)) continue;
    hub.add(p.pid);
    for (const c of children.get(p.pid) ?? []) if (c.pid !== p.pid) queue.push(c);
  }
  const groups = new Map();
  const hubGroups = new Map();
  let totalCpu = 0;
  for (const p of list) {
    const cpu = p.cpuSec ? (p.cpuSec / (seconds * logical)) * 100 : 0;
    totalCpu += cpu;
    const target = hub.has(p.pid) ? hubGroups : groups;
    const g = target.get(p.name) ?? { name: p.name, count: 0, cpu: 0, privateMB: 0, ioMBs: 0, gpu: 0, windows: 0, system: true, totalCpuSec: 0 };
    g.count++;
    g.cpu += cpu;
    g.privateMB += p.privateMB ?? 0;
    g.ioMBs += (p.ioBytes ?? 0) / 1048576 / seconds;
    g.gpu = Math.max(g.gpu, p.gpuPct ?? 0);
    g.windows += p.hasWindow ? 1 : 0;
    g.system &&= !!p.system;
    g.totalCpuSec += p.totalCpuSec ?? 0;
    target.set(p.name, g);
  }
  const finish = (g) => ({
    ...g,
    cpu: round(g.cpu, 2),
    privateMB: Math.round(g.privateMB),
    ioMBs: round(g.ioMBs, 2),
    gpu: round(g.gpu),
    impact: g.cpu >= 5 || g.gpu >= 10 ? 'élevé' : g.cpu >= 1 || g.gpu >= 2 || g.ioMBs >= 5 ? 'moyen' : 'faible',
  });
  const all = [...groups.values()].map(finish);
  // Per application: an app counts as hidden when none of its processes has a window.
  const apps = new Map();
  for (const g of all) {
    const known = BACKGROUND_APPS.find(([re]) => re.test(g.name));
    if (!known) continue;
    const app = apps.get(known[1]) ?? { label: known[1], fix: known[2], names: [], count: 0, cpu: 0, privateMB: 0, windows: 0 };
    app.names.push(g.name);
    app.count += g.count;
    app.cpu = round(app.cpu + g.cpu, 2);
    app.privateMB += g.privateMB;
    app.windows += g.windows;
    apps.set(known[1], app);
  }
  const background = [...apps.values()].filter((a) => a.windows === 0);
  return {
    seconds,
    totalCpu: round(totalCpu),
    count: list.length,
    groups: all,
    topCpu: [...all].sort((a, b) => b.cpu - a.cpu).slice(0, 10),
    topMemory: [...all].sort((a, b) => b.privateMB - a.privateMB).slice(0, 10),
    topIo: [...all].filter((g) => g.ioMBs > 0.05).sort((a, b) => b.ioMBs - a.ioMBs).slice(0, 5),
    topGpu: [...all].filter((g) => g.gpu > 0.5).sort((a, b) => b.gpu - a.gpu).slice(0, 5),
    background: background.sort((a, b) => b.privateMB - a.privateMB),
    hub: [...hubGroups.values()].map(finish).sort((a, b) => b.count - a.count),
  };
}

// Third-party services never proposed for manual start: security suites, drivers' containers, Claude/AI Box.
const KEEP_SERVICE = /norton|gen digital|avast|avg|kaspersky|bitdefender|eset|mcafee|malwarebytes|sophos|trend micro|defender|firewall|nvidia|amd|intel|realtek|claude|anthropic|ai box/i;

const stem = (exe) => String(exe ?? '').toLowerCase().replace(/\.(exe|lnk|bat|cmd)$/, '');

/** Startup entries that are on, with what their process weighs right now when it runs. */
export function analyzeStartup(ps, processes) {
  const s = ps?.startup ?? {};
  const running = new Map(processes.groups.map((g) => [g.name.toLowerCase(), g]));
  const weigh = (exe) => {
    const g = running.get(stem(exe));
    return g ? { running: true, privateMB: g.privateMB, cpu: g.cpu } : { running: false };
  };
  const where = { run: 'clé Run', runonce: 'clé RunOnce', 'startup-folder': 'dossier Démarrage' };
  return {
    commands: (s.commands ?? []).map((c) => ({ ...c, where: `${where[c.where] ?? c.where} (${c.scope === 'machine' ? 'tous les comptes' : 'ce compte'})`, ...weigh(c.exe) })),
    store: s.store ?? [],
    tasks: (s.tasks ?? []).filter((t) => t.thirdParty && (t.triggers ?? []).some((k) => k === 'Logon' || k === 'Boot')),
    wakeTasks: (s.tasks ?? []).filter((t) => t.wakeToRun),
    services: (s.services ?? []).map((v) => ({ ...v, keep: KEEP_SERVICE.test(`${v.name} ${v.display} ${v.company}`), ...weigh(v.exe) })),
  };
}

/** Everything the report needs, plus the verdict and the ordered recommendations. */
export function analyze(data) {
  const ps = data.ps ?? {};
  const caps = ps.capabilities ?? {};
  const sys = ps.system ?? {};
  const settings = settingsIndex(data.plan);
  const val = (k, side) => settings[k]?.[side] ?? null;
  const findings = [];
  const recs = new Map();
  const add = (section, level, text, ...fix) => {
    findings.push({ section, level, text, fix });
    for (const id of fix) if (byId[id]) recs.set(id, [...(recs.get(id) ?? []), text]);
  };

  // Verdict.
  const chassis = sys.chassisTypes ?? [];
  const portable = !!(caps.batteriesPresent || caps.lidPresent || chassis.some((c) => PORTABLE_CHASSIS.has(c)));
  const standby = caps.aoac ? 'S0' : caps.s3 ? 'S3' : 'aucune';
  const report = data.batteryReport;
  const batteries = (ps.battery?.length ? ps.battery : null) ?? [];
  const fromReport = report?.batteries ?? [];
  const battery = batteries.length || fromReport.length
    ? (() => {
        const r = fromReport[0] ?? {};
        const c = batteries[0] ?? {};
        const design = c.designMWh || r.designMWh || null;
        const full = c.fullMWh || r.fullMWh || null;
        return {
          manufacturer: c.manufacturer || r.manufacturer || null,
          chemistry: r.chemistry ?? null,
          designMWh: design,
          fullMWh: full,
          healthPct: design && full ? Math.round((full / design) * 100) : null,
          cycles: c.cycles ?? r.cycles ?? null,
          percent: c.percent ?? ps.powerStatus?.percent ?? null,
          onAc: c.onAc ?? null,
          dischargeW: c.dischargeMW ? round(c.dischargeMW / 1000) : null,
          drain: report ? batteryDrain(report) : null,
        };
      })()
    : null;
  if (battery?.drain?.activeW && battery.fullMWh) battery.runtimeH = round(battery.fullMWh / 1000 / battery.drain.activeW);
  const usage = report ? usageSummary(report) : null;

  const lidBlockers = [];
  if (caps.lidPresent) {
    if (val('LIDACTION', 'ac') !== 0) lidBlockers.push(`branché, fermer le capot déclenche « ${LID[val('LIDACTION', 'ac')] ?? '?'} »`);
    if (val('LIDACTION', 'dc') !== 0) lidBlockers.push(`sur batterie, fermer le capot déclenche « ${LID[val('LIDACTION', 'dc')] ?? '?'} »`);
  }
  for (const side of ['ac', 'dc']) {
    const v = val('STANDBYIDLE', side);
    if (v) lidBlockers.push(`${side === 'ac' ? 'branché' : 'sur batterie'}, veille après ${secs(v)} sans clavier ni souris (une demande d’alimentation de l’app l’empêche ; sans elle les workers s’arrêtent)`);
  }

  // Battery.
  if (!portable) add('batterie', 'info', 'Machine de bureau : pas de batterie ni de capot. La question « capot fermé » ne se pose pas ici ; l’équivalent est « écran éteint, veille bloquée tant que des workers tournent ».');
  if (battery) {
    if (battery.healthPct !== null) {
      const lvl = battery.healthPct < 60 ? 'à corriger' : battery.healthPct < 80 ? 'à surveiller' : 'ok';
      add('batterie', lvl, `Santé ${battery.healthPct} % (${round(battery.fullMWh / 1000)} Wh pleine charge sur ${round(battery.designMWh / 1000)} Wh d’origine)${battery.healthPct < 60 ? ' : la batterie est usée, son remplacement rendrait plus que tout réglage' : ''}.`);
    }
    if (battery.drain?.activeW) add('batterie', 'info', `Consommation moyenne sur batterie, machine allumée : ${battery.drain.activeW} W, soit environ ${battery.runtimeH ?? '?'} h d’autonomie à pleine charge.`);
    if (battery.drain?.standbyW) add('batterie', battery.drain.standbyW > 1 ? 'à corriger' : 'ok', `Perte en veille sur batterie : ${battery.drain.standbyW} W en moyenne${battery.drain.standbyW > 1 ? ' (au-delà d’1 W, quelque chose empêche la veille profonde : voir la section Veille)' : ''}.`, ...(battery.drain.standbyW > 1 ? ['hibernate-idle-dc', 'wake-timers-dc'] : []));
  }

  // Standby.
  add('veille', 'info', standby === 'S0'
    ? 'Veille moderne (S0) : en veille, le réseau et certaines tâches continuent ; capot fermé, la machine entre dans cette veille et les applications de bureau, dont les workers, sont gelées.'
    : standby === 'S3'
      ? 'Veille classique (S3) : en veille, tout s’arrête (processeur, réseau, workers) jusqu’au réveil.'
      : 'Aucun état de veille disponible.');
  if (caps.lidPresent && val('LIDACTION', 'ac') !== 0) add('veille', 'bloquant', 'Branché, fermer le capot met la machine en veille : les workers s’arrêtent.', 'lid-nothing-ac');
  if (caps.lidPresent && val('LIDACTION', 'dc') !== 0) add('veille', 'à surveiller', 'Sur batterie, fermer le capot met la machine en veille. Pour continuer à travailler sur batterie capot fermé, ne changer ce réglage que le temps du travail.', 'lid-nothing-dc', 'critical-hibernate', 'cpu-boost-dc');
  if (caps.aoac && caps.lidPresent && val('STANDBYIDLE', 'dc')) add('veille', 'à surveiller', `Veille moderne : sur batterie, la machine entre en veille ${secs(val('STANDBYIDLE', 'dc'))} après la dernière action, écran éteint, et les workers y sont gelés même capot ouvert ou réglé sur « ne rien faire ».`, 'standby-idle-dc-off');
  if (portable && val('BATACTIONCRIT', 'dc') !== null && val('BATACTIONCRIT', 'dc') !== 2) add('veille', 'à surveiller', `Batterie critique : « ${LID[val('BATACTIONCRIT', 'dc')]} ». Avec le capot fermé longtemps, mieux vaut la veille prolongée.`, 'critical-hibernate');
  if (!portable && val('STANDBYIDLE', 'ac') === 0) add('veille', 'à corriger', 'La machine ne se met jamais en veille seule : elle consomme à plein même la nuit sans worker actif. Avec une app qui tient une demande d’alimentation pendant les travaux, une veille après 30 min est sans risque.', 'sleep-idle-ac');
  if (portable && val('STANDBYIDLE', 'dc') === 0) add('veille', 'à surveiller', 'Sur batterie, la veille sur inactivité est désactivée.');
  if (caps.hiberFilePresent === false && portable) add('veille', 'à surveiller', 'Veille prolongée désactivée : une batterie vide capot fermé coupe tout sans sauvegarde (`powercfg /hibernate on`, administrateur).');
  if (sys.hypervisorPresent) add('veille', 'info', 'Hyperviseur actif (WSL 2, Hyper-V, sandbox ou sécurité basée sur la virtualisation) : la veille hybride est indisponible ; c’est attendu.');
  if (data.requests) {
    const blocking = Object.entries(data.requests).flatMap(([cat, list]) => list.map((e) => `${cat} : ${e.what}${e.reason ? ` (${e.reason})` : ''}`));
    add('veille', blocking.length ? 'à surveiller' : 'ok', blocking.length ? `Demandes d’alimentation actives : ${blocking.join(' ; ')}.` : 'Aucune demande d’alimentation active.');
  }
  const armed = data.wakeArmed ?? [];
  const netWake = armed.filter((d) => /ethernet|gbe|network|réseau|wi-?fi|wireless|802\.11|wlan/i.test(d));
  if (netWake.length) add('veille', 'à surveiller', `La carte réseau peut réveiller la machine (${netWake.join(', ')}) : réveils intempestifs possibles par le réseau.`, 'device-wake-off');
  if (val('RTCWAKE', 'dc') === 1 && portable) add('veille', 'à surveiller', 'Sur batterie, les minuteurs de réveil sont autorisés : une tâche planifiée peut réveiller la machine dans un sac.', 'wake-timers-dc');
  const wakes = ps.wake?.wakes ?? [];
  if (wakes.length) {
    const bySource = {};
    for (const w of wakes) bySource[w.message || w.source || `type ${w.sourceType}`] = (bySource[w.message || w.source || `type ${w.sourceType}`] ?? 0) + 1;
    add('veille', 'info', `${wakes.length} réveil(s) sur ${ps.wake.days} jours : ${Object.entries(bySource).map(([k, n]) => `${k} ×${n}`).join(', ')}.`);
  }
  if (ps.wake?.unexpectedShutdowns > 2) add('veille', 'à surveiller', `${ps.wake.unexpectedShutdowns} arrêts non propres en ${ps.wake.days} jours (Kernel-Power 41 : coupure, appui long, plantage). Un worker coupé ainsi perd son tour en cours.`);

  // Plan.
  const scheme = data.plan?.scheme;
  if (val('PROCTHROTTLEMIN', 'ac') >= 50) add('plan', 'à corriger', `Sur secteur, le processeur ne descend jamais sous ${val('PROCTHROTTLEMIN', 'ac')} % : il chauffe et consomme même au repos.`, 'plan-balanced', 'cpu-min-state-ac');
  else if (/high|haute|performance|ultimate|optimales/i.test(scheme?.name ?? '')) add('plan', 'à surveiller', `Mode « ${scheme.name} » actif.`, 'plan-balanced');
  if (val('PERFEPP', 'ac') === 0 && val('PERFEPP', 'dc') === 0) add('plan', 'à surveiller', 'Préférence énergie/performance à 0 (tout pour la performance), y compris sur batterie.', 'cpu-epp');
  if (portable && (val('PERFBOOSTMODE', 'dc') ?? 0) > 0) add('plan', 'à surveiller', 'Sur batterie, le turbo du processeur reste actif : c’est le premier poste de dépense sous charge.', 'cpu-boost-dc');
  if (val('CPMINCORES', 'ac') === 100) add('plan', 'info', 'Aucun cœur n’est mis en sommeil (parking à 100 %) : réglage typique des modes haute performance.', 'plan-balanced');
  if (val('ASPM', 'ac') === 0) add('plan', 'info', 'Économie d’énergie du lien PCI Express coupée sur secteur (carte graphique, SSD, réseau toujours à pleine puissance de lien).', 'aspm');
  if (val('48e6b7a6-50f5-4782-a5d4-53bb8f07e226', 'ac') === 0) add('plan', 'info', 'Suspension sélective USB coupée sur secteur.', 'usb-selective-suspend');
  const vAc = val('VIDEOIDLE', 'ac');
  if (vAc === 0 || vAc > 600) add('plan', 'à surveiller', `Écran éteint après ${secs(vAc)} sur secteur.`, 'display-off');
  if (portable && val('ESBATTTHRESHOLD', 'dc') === 0) add('plan', 'à surveiller', 'L’économiseur d’énergie ne s’active jamais seul sur batterie.', 'energy-saver-threshold');
  if (portable && caps.lidPresent && !ps.powerMode?.overlayDc && /balanced|normale|équilibr/i.test(scheme?.name ?? '')) add('plan', 'info', 'Mode de puissance sur batterie : équilibré.', 'power-mode-efficiency');

  // Processes.
  const processes = analyzeProcesses(ps);
  for (const g of processes.background.slice(0, 10)) add('processus', g.cpu >= 1 ? 'à corriger' : 'à surveiller', `${g.label} tourne sans fenêtre (${g.count} processus, ${g.privateMB} Mo, ${g.cpu} % du processeur).`, g.fix);
  if (processes.hub.length) add('processus', 'info', `AI Box : ${processes.hub.map((g) => `${g.name} ×${g.count}`).join(', ')} — à ne jamais arrêter (workers en cours).`);

  // Startup.
  const startup = analyzeStartup(ps, processes);
  const onAtLogin = startup.commands.filter((c) => c.enabled);
  if (onAtLogin.length) add('démarrage', 'à surveiller', `${onAtLogin.length} application(s) lancée(s) à l’ouverture de session : ${onAtLogin.map((c) => c.name).join(', ')}.`, 'startup-apps');
  const storeOn = startup.store.filter((s) => s.enabled);
  if (storeOn.length) add('démarrage', 'info', `Applications du Store lancées à l’ouverture de session : ${storeOn.map((s) => s.name).join(', ')}.`, 'startup-apps');
  if (startup.tasks.length) add('démarrage', 'info', `${startup.tasks.length} tâche(s) planifiée(s) tierce(s) à la connexion ou au démarrage.`, 'third-party-task-disable');
  const svcRunning = startup.services.filter((s) => s.state === 'Running');
  const keep = svcRunning.filter((s) => s.keep);
  const optional = svcRunning.filter((s) => !s.keep);
  if (optional.length) add('démarrage', 'à surveiller', `${optional.length} service(s) tiers en démarrage automatique et en marche dont on peut parfois se passer : ${optional.map((s) => s.display || s.name).join(', ')}. N’y toucher que pour les utilitaires inutiles au quotidien.`, 'third-party-service-manual');
  if (keep.length) add('démarrage', 'info', `À garder tels quels (sécurité, pilotes, AI Box/Claude) : ${keep.map((s) => s.display || s.name).join(', ')}.`);

  // Misc.
  const radios = ps.radios ?? [];
  const bt = radios.find((r) => /bluetooth/i.test(r.kind));
  const net = ps.network ?? [];
  const wiredUp = net.some((n) => /802\.3/.test(n.media) && n.status === 'Up');
  const wifi = radios.find((r) => /wifi/i.test(r.kind));
  if (bt?.state === 'On') add('divers', 'info', 'Bluetooth allumé.', 'bluetooth-off');
  if (wiredUp && wifi?.state === 'On') add('divers', 'info', 'Wi-Fi allumé alors que le réseau filaire est connecté.', 'bluetooth-off');
  const fast = (sys.gpus ?? []).filter((g) => g.refreshHz > 75);
  if (fast.length) add('divers', 'à surveiller', `Affichage à ${fast.map((g) => `${g.refreshHz} Hz`).join(', ')}${(ps.display?.monitors ?? 0) > 1 ? ` avec ${ps.display.monitors} écrans` : ''} : la carte graphique reste plus active au repos.`, 'refresh-rate');
  for (const g of data.nvidia ?? []) {
    if (g.powerW !== null) add('divers', g.powerW > 30 && (g.util ?? 0) < 10 ? 'à surveiller' : 'info', `${g.name} : ${g.powerW} W (état ${g.pstate}, charge ${g.util} %, ${g.tempC} °C)${g.powerW > 30 && (g.util ?? 0) < 10 ? ' — consommation élevée pour une carte presque au repos (souvent : plusieurs écrans ou haute fréquence)' : ''}.`, ...(g.powerW > 30 && (g.util ?? 0) < 10 ? ['refresh-rate'] : []));
  }
  const bg = ps.background ?? {};
  if (bg.globalDisabled !== 1 && bg.apps) add('divers', 'info', `${bg.apps - (bg.disabled ?? 0)} application(s) du Store sur ${bg.apps} autorisée(s) en arrière-plan.`, 'background-apps');
  if (bg.gameDvr === 1) add('divers', 'info', 'Captures de jeu Xbox Game Bar activées.', 'game-captures');
  if (ps.powerStatus?.energySaver && ps.powerStatus.energySaver !== 'Disabled') add('divers', 'info', `Économiseur d’énergie : ${ps.powerStatus.energySaver === 'On' ? 'actif' : 'inactif'}.`);
  for (const d of ps.storage ?? []) {
    const free = d.sizeGB ? Math.round((d.freeGB / d.sizeGB) * 100) : null;
    if (free !== null && free < 10) add('divers', 'à surveiller', `${d.drive} : ${d.freeGB} Go libres (${free} %) — sous 10 %, l’indexation, les mises à jour et la mémoire virtuelle peinent. Nettoyer via Paramètres → Stockage (suppression non réversible : choisir soi-même).`);
  }

  // Recommendations, best gain and lowest risk first; those already in place are dropped.
  const gain = { élevé: 0, moyen: 1, faible: 2 };
  const risk = { faible: 0, moyen: 1, élevé: 2 };
  const recommendations = [...recs.entries()]
    .map(([id, why]) => ({ ...byId[id], why: why.length > 3 ? `${why.slice(0, 3).join(' ')} (et ${why.length - 3} autre(s) constat(s))` : why.join(' ') }))
    .filter((c) => c.scope === 'tous' || c.scope === (portable ? 'portable' : 'bureau'))
    .filter((c) => !alreadyApplied(c, settings))
    .sort((a, b) => gain[a.gain] - gain[b.gain] || risk[a.risk] - risk[b.risk]);

  return {
    verdict: {
      portable,
      standby,
      batteriesPresent: !!caps.batteriesPresent,
      lidPresent: !!caps.lidPresent,
      lidBlockers,
      battery,
      usage,
      scheme,
      isAdmin: !!sys.isAdmin,
    },
    settings,
    findings,
    recommendations,
    processes,
    startup,
    catalogSize: CATALOG.length,
  };
}
