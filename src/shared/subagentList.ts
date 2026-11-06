import type { SubagentView } from './types';

// How a session's subagents are listed (under its card, in its view) and how its "En arrière-plan" block avoids
// showing them a second time. Pure: the sidebar, the view and the tests all read it.

/** Ended subagents shown before they fold into "+n terminés". */
export const ENDED_SHOWN = 2;

export interface SubagentRows {
  shown: SubagentView[];
  /** Ended ones folded away. */
  folded: number;
}

/** Every running subagent, then the latest ended ones up to `endedShown` unless the list is unfolded. */
export function subagentRows(subs: readonly SubagentView[] | undefined, unfolded: boolean, endedShown = ENDED_SHOWN): SubagentRows {
  const list = subs ?? [];
  const running = list.filter((a) => a.status === 'running');
  const ended = list.filter((a) => a.status !== 'running');
  const kept = unfolded ? ended : ended.slice(0, endedShown);
  return { shown: [...running, ...kept], folded: ended.length - kept.length };
}

/** "8 s", "3 min 05 s", "1 h 12 min": how long it ran, or has been running. `short` drops the seconds past a minute. */
export function subagentTime(a: Pick<SubagentView, 'startedAt' | 'endedAt'>, now: number, short = false): string {
  const total = Math.max(0, Math.floor(((a.endedAt ?? now) - a.startedAt) / 1000));
  if (total < 60) return `${total} s`;
  const min = Math.floor(total / 60);
  if (min < 60) return short ? `${min} min` : `${min} min ${String(total % 60).padStart(2, '0')} s`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

export interface BackgroundSplit {
  /** Background tasks that are no subagent of the list (shells, monitors…): shown as they are. */
  tasks: string[];
  /** Those that are a running subagent: shown as a link to its row. */
  linked: { label: string; id: string }[];
}

/** The background tasks, those that are a running subagent apart: each one matches one subagent at most. */
export function splitBackground(background: readonly string[], subs: readonly SubagentView[] | undefined): BackgroundSplit {
  const free = (subs ?? []).filter((a) => a.status === 'running' && a.description);
  const tasks: string[] = [];
  const linked: BackgroundSplit['linked'] = [];
  for (const label of background) {
    const i = free.findIndex((a) => a.description === label);
    if (i < 0) tasks.push(label);
    else linked.push({ label, id: free.splice(i, 1)[0].id });
  }
  return { tasks, linked };
}
