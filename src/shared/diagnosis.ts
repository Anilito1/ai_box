/** What a diagnosis worker concluded of a silent worker, from the first line of its fixed report. */
export type Verdict = 'normal' | 'watch' | 'blocked';

/**
 * The analysis of a worker's silence, as its working line shows it. `running` from the click until the diagnosis
 * worker reports; `done` with its report; `failed` when it could not start or ended without one.
 */
export interface DiagnosisView {
  state: 'running' | 'done' | 'failed';
  /** The diagnosis worker's session name ('' before it exists): its conversation stays readable in the list. */
  by: string;
  startedAt: number;
  endedAt: number | null;
  verdict: Verdict | null;
  /** The report's "Cause" line, or why it failed. */
  cause: string;
  /** The whole report (or the error), shown folded. */
  text: string;
}

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/** "**Verdict** : À surveiller" → "À surveiller": a report line's value, markdown and list marks off. */
function valueOf(line: string, label: RegExp): string | null {
  const clean = line.replace(/[*_`#>]/g, '').replace(/^\s*[-•·]\s*/, '').trim();
  const m = label.exec(fold(clean));
  return m ? clean.slice(m[0].length).trim() : null;
}

const VERDICT = /^verdict\s*:\s*/;
const CAUSE = /^cause\s*:\s*/;

/** The verdict and cause of a report in the fixed format (French or English); null/'' when it does not follow it. */
export function readReport(text: string): { verdict: Verdict | null; cause: string } {
  let verdict: Verdict | null = null;
  let cause = '';
  for (const line of text.split(/\r?\n/)) {
    const v = verdict ? null : valueOf(line, VERDICT);
    if (v !== null) {
      const f = fold(v);
      verdict = /^(bloque|blocked|stuck)/.test(f) ? 'blocked' : /^(a surveiller|surveiller|to watch|watch)/.test(f) ? 'watch' : /^normal/.test(f) ? 'normal' : null;
      continue;
    }
    const c = cause ? null : valueOf(line, CAUSE);
    if (c) cause = c.slice(0, 300);
  }
  return { verdict, cause };
}
