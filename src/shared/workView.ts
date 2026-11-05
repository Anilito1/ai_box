import type { SessionView } from './types';

/**
 * What a session shows as "at work": the turn (animated, it is the model that is thinking or waiting on the user) and
 * the background tasks (static, subagents and shells that outlive the turn). Pure: the line, the cards and the tests
 * all read it.
 */
export interface WorkView {
  /** A turn is running or waits for the user's approval. */
  turn: boolean;
  /** The background tasks still running, one label each; none once the session is closed. */
  tasks: string[];
}

type Seen = Pick<SessionView, 'status' | 'background'>;

export function workView(s: Seen | null | undefined): WorkView {
  if (!s) return { turn: false, tasks: [] };
  return { turn: s.status === 'busy' || s.status === 'attention', tasks: s.status === 'exited' ? [] : s.background };
}
