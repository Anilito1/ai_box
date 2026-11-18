/** What a session's own process still has under way: the one source for "working", /clear and what the user is told. */
export interface BusyState {
  status: string;
  turnOver: boolean;
  background: string[];
  pending: { size: number };
  queued: number;
  agentTasks?: { size: number };
  subagents?: { running: number };
  agents: number;
  compacting: boolean;
  retrying: boolean;
  /** A turn the provider cut waits to be taken up again. */
  faultTimer?: unknown;
  moving: boolean;
  transitioning: boolean;
  installing: unknown;
}

export type BusyReason =
  | { kind: 'starting' | 'turn' | 'compacting' | 'retrying' | 'moving' | 'installing' }
  | { kind: 'approval' | 'queued' | 'agents'; count: number }
  | { kind: 'background'; labels: string[] };

export function busyReasons(s: BusyState): BusyReason[] {
  const why: BusyReason[] = [];
  const approvals = Math.max(s.pending.size, s.status === 'attention' ? 1 : 0);
  const agents = Math.max(s.agentTasks?.size ?? 0, s.subagents?.running ?? 0, s.agents ?? 0);
  if (s.status === 'starting') why.push({ kind: 'starting' });
  if (s.status === 'busy' || s.turnOver === false) why.push({ kind: 'turn' });
  if (approvals > 0) why.push({ kind: 'approval', count: approvals });
  if (s.queued > 0) why.push({ kind: 'queued', count: s.queued });
  if (s.background.length > 0) why.push({ kind: 'background', labels: s.background });
  if (agents > 0) why.push({ kind: 'agents', count: agents });
  if (s.compacting) why.push({ kind: 'compacting' });
  if (s.retrying || s.faultTimer) why.push({ kind: 'retrying' });
  if (s.moving || s.transitioning) why.push({ kind: 'moving' });
  if (s.installing) why.push({ kind: 'installing' });
  return why;
}
