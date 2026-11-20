// Markdown rendering of the analysis. Everything printed here has already been reduced to names, counts and settings.
import { PLAN_ROWS } from './analyze.mjs';
import { commandsFor } from './catalog.mjs';

const cell = (v) => String(v ?? '—').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const table = (head, rows) =>
  rows.length ? [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n') : '_Rien à signaler._';
const ICON = { bloquant: '⛔', 'à corriger': '🔴', 'à surveiller': '🟠', ok: '🟢', info: 'ℹ️' };
const findingsOf = (a, section) =>
  a.findings.filter((f) => f.section === section).map((f) => `- ${ICON[f.level] ?? ''} ${f.text}${f.fix.length ? ` → ${f.fix.map((id) => `\`${id}\``).join(', ')}` : ''}`).join('\n') || '_Rien à signaler._';

export function renderMarkdown(data, a) {
  const v = a.verdict;
  const ps = data.ps ?? {};
  const sys = ps.system ?? {};
  const b = v.battery;
  const out = [];
  out.push(`# Audit énergie Windows — ${data.generatedAt.slice(0, 10)}`, '');
  out.push(`Lecture seule : rien n’a été modifié. Échantillon des processus sur ${a.processes.seconds} s. ${v.isAdmin ? 'Lancé en administrateur.' : 'Lancé sans droits administrateur (voir la fin pour ce qui en demande).'}`, '');

  out.push('## Verdict', '');
  out.push(`- **Type** : ${v.portable ? 'portable' : 'machine de bureau'} — ${v.batteriesPresent ? 'batterie présente' : 'pas de batterie'}, ${v.lidPresent ? 'capot détecté' : 'pas de capot'}.`);
  out.push(`- **Matériel** : ${[sys.manufacturer, sys.model].filter(Boolean).join(' ')} · ${sys.cpu ?? '?'} (${sys.cores ?? '?'} cœurs / ${sys.logicalProcessors ?? '?'} threads) · ${sys.ramGB ?? '?'} Go · ${(sys.gpus ?? []).map((g) => g.name).join(', ') || '?'} · ${sys.os ?? ''} ${sys.build ?? ''}`);
  out.push(`- **Veille** : ${v.standby === 'S0' ? 'veille moderne S0 (Modern Standby)' : v.standby === 'S3' ? 'veille classique S3 (pas de Modern Standby)' : 'aucune'}.`);
  out.push(`- **Mode de gestion actif** : ${v.scheme?.name ?? '?'}.`);
  if (v.portable) {
    out.push(`- **Capot fermé aujourd’hui** : ${v.lidBlockers.length ? `les workers s’arrêtent — ${v.lidBlockers.join(' ; ')}.` : 'la machine continue de travailler.'}`);
  } else {
    out.push(`- **Capot fermé** : sans objet (pas de capot). ${v.lidBlockers.length ? `À noter : ${v.lidBlockers.join(' ; ')}.` : 'La veille sur inactivité est désactivée : rien n’arrête les workers, mais rien n’économise non plus quand ils ne tournent pas.'}`);
  }
  if (b) {
    out.push(`- **Batterie** : ${b.healthPct !== null ? `santé ${b.healthPct} %` : 'santé inconnue'}${b.cycles !== null ? `, ${b.cycles} cycles` : ''}${b.drain?.activeW ? `, ${b.drain.activeW} W en moyenne sur batterie ≈ ${b.runtimeH ?? '?'} h` : ''}${b.drain?.standbyW ? `, ${b.drain.standbyW} W en veille` : ''}.`);
  } else out.push('- **Batterie** : aucune.');
  out.push('');

  out.push('## Recommandations (rien n’est appliqué)', '');
  out.push(`Classées par gain puis par risque ; les réglages déjà en place sont omis. Annuler = remettre la valeur mesurée ici. Catalogue complet : docs/optimiseur-windows.md (${a.catalogSize} réglages).`, '');
  out.push(table(['#', 'Réglage', 'Gain', 'Risque', 'Droits', 'Id'], a.recommendations.map((r, i) => [i + 1, r.title, r.gain, r.risk, r.rights, `\`${r.id}\``])), '');
  if (a.recommendations.some((r) => r.id === 'plan-balanced')) {
    out.push('Les commandes `SCHEME_CURRENT` portent sur le mode actif : après `plan-balanced`, relancer l’audit, car ce mode a ses propres valeurs (souvent déjà sobres) et les commandes d’annulation changent.', '');
  }
  for (const r of a.recommendations) {
    const c = commandsFor(r, { scheme: v.scheme?.guid, settings: a.settings });
    out.push(`### \`${r.id}\` — ${r.title}`, '', `Constat : ${r.why}`, '', 'Appliquer :', '```', ...c.apply, '```', 'Annuler :', '```', ...c.undo, '```', `Ce que ça change : ${r.breaks}`, '', `Source : ${r.source}`, '');
  }

  out.push('## Batterie', '');
  if (b) {
    out.push(table(['Mesure', 'Valeur'], [
      ['Fabricant', b.manufacturer],
      ['Chimie', b.chemistry],
      ['Capacité d’origine', b.designMWh ? `${(b.designMWh / 1000).toFixed(1)} Wh` : null],
      ['Pleine charge actuelle', b.fullMWh ? `${(b.fullMWh / 1000).toFixed(1)} Wh` : null],
      ['Santé', b.healthPct !== null ? `${b.healthPct} %` : null],
      ['Cycles', b.cycles],
      ['Charge actuelle', b.percent !== null ? `${b.percent} %${b.onAc ? ' (sur secteur)' : ''}` : null],
      ['Débit instantané', b.dischargeW ? `${b.dischargeW} W` : null],
      ['Consommation moyenne allumée, sur batterie', b.drain?.activeW ? `${b.drain.activeW} W sur ${b.drain.activeHours} h mesurées` : null],
      ['Consommation récente allumée', b.drain?.recentActiveW ? `${b.drain.recentActiveW} W` : null],
      ['Perte en veille sur batterie', b.drain?.standbyW ? `${b.drain.standbyW} W sur ${b.drain.standbyHours} h` : null],
      ['Autonomie estimée', b.runtimeH ? `${b.runtimeH} h` : null],
    ]), '');
  }
  if (v.usage) out.push(`Derniers ${Math.round((v.usage.activeH + v.usage.suspendH + v.usage.standbyH + v.usage.hibernateH + v.usage.otherH) / 24)} jours (rapport batterie de Windows) : ${v.usage.activeH} h allumée, ${v.usage.suspendH} h en veille S3, ${v.usage.standbyH} h en veille moderne, ${v.usage.hibernateH} h en veille prolongée.`, '');
  out.push(findingsOf(a, 'batterie'), '');

  out.push('## Veille et réveils', '');
  if (data.sleepStatesText) out.push('`powercfg /a` :', '```', data.sleepStatesText.trim(), '```');
  out.push(`- Dernier réveil (\`powercfg /lastwake\`) : ${data.lastWake?.count ?? '?'} source(s) enregistrée(s)${data.lastWake?.details?.length ? ` — ${data.lastWake.details.join(' ; ')}` : ''}.`);
  out.push(`- Périphériques autorisés à réveiller la machine : ${(data.wakeArmed ?? []).join(', ') || 'aucun'}.`);
  out.push(`- Mises en veille / reprises sur ${ps.wake?.days ?? 14} jours : ${ps.wake?.sleeps ?? '?'} / ${ps.wake?.resumes ?? '?'}${v.standby === 'S0' ? ` ; veille moderne : ${ps.wake?.modernStandbyEnter ?? '?'} entrées` : ''}.`);
  if (a.startup.wakeTasks.length) out.push(`- Tâches planifiées autorisées à réveiller la machine (lisibles sans admin) : ${a.startup.wakeTasks.map((t) => t.name).join(', ')}.`);
  out.push('', findingsOf(a, 'veille'), '');

  out.push('## Mode de gestion de l’alimentation', '');
  out.push(`Actif : **${v.scheme?.name ?? '?'}** (\`${v.scheme?.guid ?? '?'}\`).`, '');
  out.push(table(['Réglage', 'Secteur', 'Batterie'], PLAN_ROWS.filter(([k]) => a.settings[k]).map(([k, label, f]) => [label, f(a.settings[k].ac), f(a.settings[k].dc)])), '');
  const overlay = { '961cc777-2547-4f9d-8174-7d86181b8a7a': 'meilleure efficacité', 'ded574b5-45a0-4f42-8737-46345c09c238': 'meilleures performances', '00000000-0000-0000-0000-000000000000': 'équilibré' };
  if (ps.powerMode?.overlayAc || ps.powerMode?.overlayDc) out.push(`Mode de puissance (Paramètres) : secteur ${overlay[ps.powerMode.overlayAc] ?? 'équilibré'}, batterie ${overlay[ps.powerMode.overlayDc] ?? 'équilibré'}.`, '');
  out.push(`Démarrage rapide : ${ps.powerMode?.hiberbootEnabled === 1 ? 'activé' : 'désactivé'}. Veille prolongée : ${ps.capabilities?.s4 ? 'disponible' : 'indisponible'}.`, '');
  out.push(findingsOf(a, 'plan'), '');
  if (v.portable) {
    out.push('**Pour continuer à travailler capot fermé** (à ne pas appliquer sans décision) : `lid-nothing-ac` ; sur batterie, `lid-nothing-dc` seulement le temps du travail, avec `critical-hibernate` et `cpu-boost-dc`. L’app AI Box doit en plus tenir une demande d’alimentation tant qu’un worker tourne (elle empêche la veille sur inactivité, pas l’action du capot).', '');
  }

  const p = a.processes;
  out.push('## Processus', '');
  out.push(`${p.count} processus, ${p.totalCpu} % du processeur en moyenne pendant l’échantillon (100 % = tous les cœurs). Impact estimé : élevé ≥ 5 % du processeur ou 10 % du GPU ; moyen ≥ 1 % du processeur, 2 % du GPU ou 5 Mo/s d’E/S.`, '');
  const row = (g) => [g.name, g.count, `${g.cpu} %`, `${g.privateMB} Mo`, `${g.ioMBs} Mo/s`, g.gpu ? `${g.gpu} %` : '—', g.impact];
  const head = ['Processus', 'Nb', 'CPU', 'Mémoire privée', 'E/S', 'GPU', 'Impact'];
  out.push('**Processeur**', '', table(head, p.topCpu.map(row)), '');
  out.push('**Mémoire**', '', table(head, p.topMemory.map(row)), '');
  if (p.topIo.length) out.push('**Entrées/sorties**', '', table(head, p.topIo.map(row)), '');
  if (p.topGpu.length) out.push('**GPU**', '', table(head, p.topGpu.map(row)), '');
  out.push('**En arrière-plan sans fenêtre**', '', table(['Application', 'Processus', 'Mémoire', 'CPU', 'Réglage'], p.background.map((g) => [g.label, `${g.names.join(', ')} (${g.count})`, `${g.privateMB} Mo`, `${g.cpu} %`, `\`${g.fix}\``])), '');
  out.push('**AI Box (protégé, jamais arrêté)**', '', table(head, p.hub.map(row)), '');
  out.push(findingsOf(a, 'processus'), '');

  const s = a.startup;
  out.push('## Démarrage', '');
  out.push('**Clés Run et dossier Démarrage**', '', table(['Nom', 'Exécutable', 'Où', 'Actif', 'Tourne', 'Mémoire'], s.commands.map((c) => [c.name, c.exe, c.where, c.enabled ? 'oui' : 'non', c.running ? 'oui' : 'non', c.running ? `${c.privateMB} Mo` : '—'])), '');
  if (s.store.length) out.push('**Applications du Store**', '', table(['Paquet', 'Tâche', 'Actif'], s.store.map((t) => [t.name, t.task, t.enabled ? 'oui' : 'non'])), '');
  out.push('**Tâches planifiées tierces à la connexion ou au démarrage**', '', table(['Tâche', 'Dossier', 'Exécutable', 'Déclencheurs'], s.tasks.map((t) => [t.name, t.path, t.exe, (t.triggers ?? []).join(', ')])), '');
  out.push('**Services tiers en démarrage automatique**', '', table(['Service', 'Éditeur', 'État', 'Différé', 'Mémoire'], s.services.map((x) => [x.display || x.name, x.company || '?', x.state === 'Running' ? 'en marche' : 'arrêté', x.delayed ? 'oui' : 'non', x.running ? `${x.privateMB} Mo` : '—'])), '');
  out.push(findingsOf(a, 'démarrage'), '');

  out.push('## Divers', '');
  const radios = ps.radios ?? [];
  out.push(`- Radios : ${radios.map((r) => `${r.kind} ${r.state === 'On' ? 'allumé' : 'éteint'}`).join(', ') || 'inconnues'}.`);
  out.push(`- Cartes réseau : ${(ps.network ?? []).map((n) => `${n.description} (${n.status === 'Up' ? 'connectée' : 'déconnectée'})`).join(', ') || 'inconnues'}.`);
  out.push(`- Écrans : ${ps.display?.monitors ?? '?'} ; ${(sys.gpus ?? []).map((g) => `${g.width}×${g.height} à ${g.refreshHz} Hz`).join(', ')} ; luminosité ${ps.display?.brightness?.length ? `${ps.display.brightness.join(', ')} %` : 'non pilotable par Windows (écran externe)'} ; transparence ${ps.display?.transparency === 1 ? 'activée' : 'désactivée'}.`);
  out.push(`- Économiseur d’énergie : ${{ Disabled: 'indisponible (sur secteur ou sans batterie)', Off: 'inactif', On: 'actif' }[ps.powerStatus?.energySaver] ?? '?'}.`);
  out.push(`- Applications en arrière-plan : ${ps.background?.globalDisabled === 1 ? 'toutes interdites' : `${(ps.background?.apps ?? 0) - (ps.background?.disabled ?? 0)} autorisées sur ${ps.background?.apps ?? '?'}`}.`);
  out.push(`- Stockage : ${(ps.storage ?? []).map((d) => `${d.drive} ${d.freeGB} Go libres sur ${d.sizeGB} Go`).join(', ')}.`);
  if (data.nvidia?.length) out.push(`- Carte graphique NVIDIA : ${data.nvidia.map((g) => `${g.name}, ${g.powerW ?? '?'} W sur ${g.limitW ?? '?'} W max, état ${g.pstate}, charge ${g.util ?? '?'} %, mémoire à ${g.memMHz ?? '?'} MHz`).join(' ; ')}.`);
  out.push('', findingsOf(a, 'divers'), '');

  out.push('## Ce que l’audit n’a pas pu lire', '');
  const missing = data.adminOnly ?? [];
  out.push(missing.length
    ? `Demande l’administrateur (relancer l’audit depuis un terminal administrateur, toujours en lecture seule) : ${missing.map((c) => `\`${c}\``).join(', ')}.`
    : 'Rien : l’audit a tourné en administrateur.');
  const errors = Object.entries(ps).filter(([, x]) => x && typeof x === 'object' && !Array.isArray(x) && x.error).map(([k, x]) => `${k} (${x.error})`);
  if (errors.length) out.push('', `Sections en erreur : ${errors.join(' ; ')}.`);
  out.push('');
  return out.join('\n');
}
