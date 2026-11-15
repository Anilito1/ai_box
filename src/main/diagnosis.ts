import type { Lang } from '../shared/i18n';

/** Recent activity lines given to a diagnosis worker: enough to see what the turn did before it fell silent. */
export const DIAG_ACTIVITY = 15;
const CUT = { mission: 600, tool: 300, command: 300, line: 220 };

/** What the hub knows of a worker whose silence is analysed: plain data, read from its session at the click. */
export interface DiagFacts {
  name: string;
  status: string;
  cwd: string;
  mission: string;
  now: number;
  /** Last event that really came from its process; null: none since it started. */
  signalAt: number | null;
  /** Start of the turn in progress, else null. */
  busySince: number | null;
  /** When the user last answered one of its approvals, else null. */
  approvedAt: number | null;
  /** The provider refused the work for now (a plan limit); `resetsAt` in epoch seconds. */
  limit: { resetsAt: number | null } | null;
  retrying: boolean;
  compacting: boolean;
  /** Tool calls not answered yet, oldest first. */
  tools: { name: string; summary: string; since: number }[];
  /** Background tasks: the shell's command and output file when the hub saw them start. */
  background: { label: string; command: string; outputFile: string; since: number | null }[];
  subagents: string[];
  /** Approvals waiting for the user. */
  pending: { tool: string; summary: string }[];
  /** Its last steps, oldest first (already one line each). */
  activity: string[];
  /** Its conversation's transcript file, '' when the hub does not know it. */
  transcript: string;
  /** Its program's process, and the processes that process started (null: not listed, outside Windows or failed). */
  procs: { pid: number; startedAt: number }[];
  children: { pid: number; ppid: number; created: number }[] | null;
}

const cut = (text: string, max: number) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/** "23 min 04 s", "8 s", "2 h 05 min". */
export function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')} min`;
}

/** An instant as the diagnosis worker can compare it with file times: ISO (UTC) and how long ago. */
const when = (at: number, now: number, l: Lang) => `${new Date(at).toISOString()} (${l === 'fr' ? 'il y a ' : ''}${age(now - at)}${l === 'fr' ? '' : ' ago'})`;

const LABELS = {
  fr: {
    head: 'Contexte fourni par le hub sur le worker à analyser (lecture seule : tu ne lui écris pas, tu ne l’arrêtes pas).',
    name: 'Worker', status: 'Statut', cwd: 'Dossier', mission: 'Mission (résumé)',
    signal: 'Dernier signal du process', noSignal: 'aucun depuis le début de ce process',
    turn: 'Tour en cours depuis', noTurn: 'aucun tour en cours',
    approved: 'Dernière validation donnée par l’utilisateur',
    limit: 'Limite du compte atteinte', limitUntil: 'rouvre à', retrying: 'Appel API en échec, nouvel essai en cours', compacting: 'Compaction de la conversation en cours',
    tools: 'Appels d’outil en cours', since: 'depuis', none: 'aucun',
    background: 'Tâches de fond', command: 'commande', output: 'sortie', started: 'lancée',
    subagents: 'Sous-agents', pending: 'Validations en attente de l’utilisateur',
    activity: 'Dernières activités (la plus récente en bas)', transcript: 'Transcript de sa conversation', unknown: 'inconnu',
    procs: 'Process de son programme', children: 'Process enfants (pid, pid parent, créé)', notListed: 'non listés',
  },
  en: {
    head: 'Context the hub gives on the worker to analyse (read-only: you do not write to it, you do not stop it).',
    name: 'Worker', status: 'Status', cwd: 'Folder', mission: 'Mission (summary)',
    signal: 'Last signal from its process', noSignal: 'none since this process started',
    turn: 'Turn in progress since', noTurn: 'no turn in progress',
    approved: 'Last approval the user gave',
    limit: 'Account limit reached', limitUntil: 'opens again at', retrying: 'API call failed, retrying', compacting: 'Conversation being compacted',
    tools: 'Tool calls in progress', since: 'since', none: 'none',
    background: 'Background tasks', command: 'command', output: 'output', started: 'started',
    subagents: 'Subagents', pending: 'Approvals waiting for the user',
    activity: 'Latest activity (most recent last)', transcript: 'Its conversation’s transcript', unknown: 'unknown',
    procs: 'Its program’s process', children: 'Child processes (pid, parent pid, created)', notListed: 'not listed',
  },
} as const;

/** The context block a diagnosis worker gets with its mission: everything the hub knows of the silent worker. */
export function diagContext(f: DiagFacts, l: Lang): string {
  const L = LABELS[l];
  const colon = l === 'fr' ? ' :' : ':';
  const list = (items: string[]) => (items.length > 0 ? items.map((i) => `- ${i}`).join('\n') : `- ${L.none}`);
  const states = [
    f.limit ? `${L.limit}${f.limit.resetsAt ? ` (${L.limitUntil} ${new Date(f.limit.resetsAt * 1000).toISOString()})` : ''}` : '',
    f.retrying ? L.retrying : '',
    f.compacting ? L.compacting : '',
  ].filter(Boolean);
  const lines = [
    L.head,
    `${L.name}${colon} ${f.name}`,
    `${L.status}${colon} ${f.status}`,
    `${L.cwd}${colon} ${f.cwd}`,
    `${L.mission}${colon} ${cut(f.mission, CUT.mission) || L.none}`,
    `${L.signal}${colon} ${f.signalAt === null ? L.noSignal : when(f.signalAt, f.now, l)}`,
    `${L.turn}${colon} ${f.busySince === null ? L.noTurn : when(f.busySince, f.now, l)}`,
    ...(f.approvedAt !== null ? [`${L.approved}${colon} ${when(f.approvedAt, f.now, l)}`] : []),
    ...states,
    `${L.tools}${colon}`,
    list(f.tools.map((x) => `${x.name} ${cut(x.summary, CUT.tool)} — ${L.since} ${when(x.since, f.now, l)}`)),
    `${L.background}${colon}`,
    list(
      f.background.map((b) =>
        [
          cut(b.label, CUT.line),
          b.command ? `${L.command}${colon} ${cut(b.command, CUT.command)}` : '',
          b.outputFile ? `${L.output}${colon} ${b.outputFile}` : '',
          b.since !== null ? `${L.started} ${when(b.since, f.now, l)}` : '',
        ]
          .filter(Boolean)
          .join(' — '),
      ),
    ),
    ...(f.subagents.length > 0 ? [`${L.subagents}${colon}`, list(f.subagents.map((x) => cut(x, CUT.line)))] : []),
    `${L.pending}${colon}`,
    list(f.pending.map((p) => `${p.tool} ${cut(p.summary, CUT.tool)}`)),
    `${L.activity}${colon}`,
    list(f.activity.slice(-DIAG_ACTIVITY).map((x) => cut(x, CUT.line))),
    `${L.transcript}${colon} ${f.transcript || L.unknown}`,
    `${L.procs}${colon} ${f.procs.length > 0 ? f.procs.map((p) => `PID ${p.pid} (${L.started} ${when(p.startedAt, f.now, l)})`).join(', ') : L.unknown}`,
    `${L.children}${colon} ${f.children === null ? L.notListed : f.children.length === 0 ? L.none : f.children.map((c) => `${c.pid} ${c.ppid} ${new Date(c.created).toISOString()}`).join(' ; ')}`,
  ];
  return lines.join('\n');
}

/** The mission line of a diagnosis worker: what its card and list_workers show. */
export const diagMission = (target: string, l: Lang) =>
  l === 'fr' ? `Diagnostic du silence de ${target} : pourquoi aucun signal depuis longtemps ?` : `Diagnosis of ${target}'s silence: why no signal for a long time?`;

/** Added to a diagnosis worker's system prompt, after the usual worker prompt. */
export function diagPrompt(l: Lang): string {
  if (l === 'fr') {
    return `# Mode diagnostic (prioritaire sur les consignes ci-dessus)
Tu es un worker de diagnostic éphémère, lancé par l'utilisateur depuis l'indicateur de signal d'un autre worker (la cible). Ta seule tâche : établir, preuves à l'appui, pourquoi la cible n'a émis aucun signal depuis longtemps. Le hub te donne ce qu'il sait d'elle dans ton premier message.

## Ce que tu vérifies (dans cet ordre, sans t'attarder sur ce qui est déjà tranché)
- Tâche de fond ou commande en cours : son process est-il vivant ? CPU et mémoire (deux mesures espacées de quelques secondes) ? Son fichier de sortie grossit-il (taille et date de modification, deux lectures) ? Retrouve les process enfants depuis les PID donnés (pid parent).
- Transcript de la cible : est-il figé (date de modification, dernières lignes : type d'événement, nom d'outil, horodatage) ? Lis la fin du fichier, jamais tout le fichier.
- Validation en attente de l'utilisateur ? Attente d'un autre worker ou du maître (SendMessage, message_master, worker_report) ? Erreur API, limite de compte, nouvel essai ?
- Un build, un rendu ou des tests longs qui progressent sont normaux : estime la fin si la sortie le permet (compteur, pourcentage, étapes).

## Interdits absolus
- N'écris jamais au worker cible ni à un autre worker, ne l'interromps pas, ne tue et ne suspends aucun process, n'envoie aucune touche.
- Ne modifie aucun fichier, ne lance ni build, ni test, ni installation, ni commande git qui écrit. Commandes de lecture uniquement (Get-Process, Get-CimInstance, Get-Item, Get-Content -Tail, tasklist, ps, ls, tail…).
- N'affiche aucune donnée client brute : seulement la structure, des comptes, des tailles, des noms d'outils ou de l'anonymisé, comme le reste du hub. Pas de contenu de fichier, de message ni de sortie recopié tel quel au-delà d'une courte ligne technique sans donnée personnelle.
- Sois bref : quelques commandes ciblées, pas d'exploration du code.

## Rapport
Termine par UN appel message_master dont le message suit exactement ce format (le hub l'affiche à l'utilisateur sous l'indicateur et le transmet au maître), puis termine ton tour avec le même texte :
Verdict : Normal | À surveiller | Bloqué
Cause : <une phrase>
Preuves :
- <fait mesuré, avec sa valeur>
Estimation de fin : <durée ou heure, ou « inconnue »>
Action recommandée : <une action concrète pour l'utilisateur ou le maître, ou « attendre »>`;
  }
  return `# Diagnosis mode (overrides the instructions above)
You are a short-lived diagnosis worker, started by the user from another worker's signal indicator (the target). Your only task: find out, with evidence, why the target has sent no signal for a long time. The hub gives you what it knows of it in your first message.

## What you check (in this order, without lingering on what is already settled)
- Background task or command in progress: is its process alive? CPU and memory (two readings a few seconds apart)? Does its output file grow (size and modification time, read twice)? Find the child processes from the PIDs given (parent pid).
- The target's transcript: is it frozen (modification time, last lines: event type, tool name, timestamp)? Read the end of the file, never the whole file.
- An approval waiting for the user? Waiting for another worker or the master (SendMessage, message_master, worker_report)? API error, account limit, retry?
- A long build, render or test run that progresses is normal: estimate its end if the output allows (counter, percentage, steps).

## Strictly forbidden
- Never write to the target worker or any other worker, never interrupt it, never kill or suspend a process, never send keys.
- Change no file, run no build, test, install or git command that writes. Reading commands only (Get-Process, Get-CimInstance, Get-Item, Get-Content -Tail, tasklist, ps, ls, tail…).
- Show no raw client data: only structure, counts, sizes, tool names or anonymised data, like the rest of the hub. No file, message or output content copied as is beyond a short technical line without personal data.
- Be brief: a few targeted commands, no exploring of the code.

## Report
End with ONE message_master call whose message follows exactly this format (the hub shows it to the user under the indicator and passes it to the master), then end your turn with the same text:
Verdict: Normal | Watch | Blocked
Cause: <one sentence>
Evidence:
- <measured fact, with its value>
Expected end: <duration or time, or "unknown">
Recommended action: <one concrete action for the user or the master, or "wait">`;
}
