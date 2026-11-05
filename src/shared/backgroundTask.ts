/**
 * A background task as the list shows it: a short summary and, when the task is a local server, the link to open it.
 * The hub only hears a task's description ("Relaunch calculette layout variant V1 on port 8821"); the port can also
 * come from its command or its output, which the main process reads and passes as `knownPort`. Pure: the list, the
 * worker card and the tests all read it.
 */
export interface TaskView {
  /** The description as the CLI gave it (tooltip). */
  label: string;
  /** What the task does, shortened: no leading verb, no port. */
  summary: string;
  port: number | null;
  /** `http://localhost:<port>`, null for a task that is not a server. */
  url: string | null;
}

const MAX_SUMMARY = 60;

// Most telling first: an address, then the variable or option that sets the port, then the plain words.
const PORT_FORMS = [
  /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})\b/i,
  /\bPORT=(\d{2,5})\b/,
  /--port(?:=|\s+)(\d{2,5})\b/,
  /\b(?:port|porte)\s+(\d{2,5})\b/i,
  /\bport\s*[:=]\s*(\d{2,5})\b/i,
];

const validPort = (n: number) => n >= 80 && n <= 65535;

/** The first port the texts name, in order (the description, the command, then the output). */
export function portOf(...texts: string[]): number | null {
  for (const text of texts) {
    for (const form of PORT_FORMS) {
      const n = Number(form.exec(text)?.[1]);
      if (validPort(n)) return n;
    }
  }
  return null;
}

// The verb that opens a description says how the task started, not what it is.
const VERBS =
  'serve|serving|relaunch|relaunching|restart|restarting|start|starting|launch|launching|run|running|boot|spin up|' +
  'sers|servir|relance|relancer|redémarre|redémarrer|démarre|démarrer|lance|lancer|exécute|exécuter';
const LEADING = new RegExp(`^(?:(?:${VERBS})\\b[\\s:,-]*(?:and|et|the|le|la|les|a|an|un|une)?\\s*)+`, 'i');
const PORT_PHRASE = new RegExp(
  [
    '\\s*(?:on|at|sur|en|via|using)?\\s*(?:the\\s+|le\\s+)?\\b(?:port|porte)\\s*[:=]?\\s*\\d{2,5}\\b',
    '\\s*(?:on|at|sur|via)?\\s*(?:https?:\\/\\/)?(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0):\\d{2,5}\\b\\S*',
    '\\s*\\bPORT=\\d{2,5}\\b',
    '\\s*--port(?:=|\\s+)\\d{2,5}\\b',
  ].join('|'),
  'gi',
);
const DANGLING = /(?:\s+(?:on|at|sur|en|via|using|with|avec|and|et|the|le|la|les|for|pour|:|[-–—]))+$/i;

function shorten(text: string): string {
  if (text.length <= MAX_SUMMARY) return text;
  const cut = text.slice(0, MAX_SUMMARY - 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > MAX_SUMMARY / 2 ? cut.slice(0, at) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

/** "Relaunch calculette layout variant V1 on port 8821" → "calculette layout variant V1". */
export function summarize(label: string): string {
  const flat = label.replace(/\s+/g, ' ').trim();
  const bare = flat.replace(PORT_PHRASE, '').replace(/\s+/g, ' ').trim().replace(DANGLING, '').replace(LEADING, '').trim();
  // A description that was only a verb and a port keeps its words rather than going blank.
  return shorten(bare || flat);
}

export function taskView(label: string, knownPort?: number | null): TaskView {
  const port = portOf(label) ?? knownPort ?? null;
  return { label, summary: summarize(label), port, url: port === null ? null : `http://localhost:${port}` };
}
