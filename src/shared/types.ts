export type Role = 'master' | 'worker';
export type Status = 'starting' | 'busy' | 'idle' | 'attention' | 'exited';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type Mode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions' | 'dontAsk';

/** Image formats the Messages API accepts. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];
/** Images per message, checked by the composer and again by the main process (decoded bytes; the API caps a request near 32 MB). */
export const ATTACH_LIMITS = { count: 10, imageBytes: 2.5 * 1024 * 1024, totalBytes: 20 * 1024 * 1024 } as const;
export const base64Bytes = (data: string) => Math.floor((data.length * 3) / 4);
/** Pasted or dropped image, base64 without the data: prefix. */
export interface ImageInput {
  mediaType: ImageType;
  data: string;
}

export const STATUS_LABEL: Record<Status, string> = {
  starting: 'démarrage',
  busy: 'en cours',
  idle: 'prêt',
  attention: 'attend ta validation',
  exited: 'arrêté',
};

export const MODE_LABEL: Record<Mode, string> = {
  auto: 'Auto',
  default: 'Manuel',
  acceptEdits: 'Édition auto',
  plan: 'Plan',
  bypassPermissions: 'Sans permissions',
  dontAsk: 'Ne pas demander',
};

export const MODE_HINT: Partial<Record<Mode, string>> = {
  auto: 'Un classifieur valide les actions sûres',
  default: 'Demande avant les modifications et la plupart des commandes',
  acceptEdits: 'Modifie les fichiers sans demander',
  plan: 'Explore et propose un plan, sans rien modifier',
};

export const MENU_MODES: Mode[] = ['auto', 'default', 'acceptEdits', 'plan'];

export interface ModelOption {
  value: string;
  label: string;
  description: string;
  efforts: Effort[];
}

export interface Metrics {
  contextTokens: number;
  contextSize: number;
  contextPct: number | null;
  costUsd: number;
}

export interface RateLimits {
  fiveHourPct: number | null;
  fiveHourResetsAt: number | null;
  sevenDayPct: number | null;
  sevenDayResetsAt: number | null;
}

export interface SessionView {
  id: string;
  role: Role;
  name: string;
  mission: string;
  cwd: string;
  model: string;
  modelLabel: string;
  effort: Effort | null;
  mode: Mode | null;
  status: Status;
  lastMessage: string;
  metrics: Metrics | null;
  createdAt: number;
  /** Start of the turn in progress (busy or awaiting a permission), else null. */
  busySince: number | null;
  /** Descriptions of the background tasks (subagents, shells) still running in this session. */
  background: string[];
}

export interface RepoCommit {
  hash: string;
  subject: string;
  author: string;
  at: number;
}

export interface RepoFile {
  /** Porcelain XY code: index then worktree status, e.g. "M ", " M", "??". */
  code: string;
  path: string;
}

/** Live git state of the repo pinned at the bottom of the sidebar. */
export interface RepoStatus {
  name: string;
  path: string;
  branch: string;
  /** Ref compared against: the upstream, else the remote's default branch; empty when there is none. */
  base: string;
  ahead: number;
  behind: number;
  changes: number;
  conflicts: number;
  files: RepoFile[];
  head: RepoCommit | null;
  incoming: RepoCommit[];
  outgoing: RepoCommit[];
  fetching: boolean;
  fetchedAt: number | null;
  fetchError: string;
  error: string;
}

export interface HubSnapshot {
  sessions: SessionView[];
  models: ModelOption[];
  rateLimits: RateLimits | null;
}

export type ChatItem =
  | { kind: 'user'; id: string; text: string; images: string[] }
  | { kind: 'peer'; id: string; from: string; text: string }
  | { kind: 'assistant'; id: string; text: string; live: boolean }
  | { kind: 'thinking'; id: string; text: string }
  | { kind: 'tool'; id: string; name: string; summary: string; detail: string; diff: boolean; result: string | null; isError: boolean }
  | {
      kind: 'permission';
      id: string;
      tool: string;
      summary: string;
      detail: string;
      diff: boolean;
      reason: string;
      canAlways: boolean;
      state: 'pending' | 'allowed' | 'denied' | 'expired';
    }
  | { kind: 'notice'; id: string; text: string; tone: 'info' | 'error' };

export interface PermissionDecision {
  behavior: 'allow' | 'always' | 'deny';
  message?: string;
}

export interface HubApi {
  onSnapshot(cb: (snapshot: HubSnapshot) => void): void;
  onItems(cb: (sessionId: string, items: ChatItem[], reset: boolean) => void): void;
  onRepo(cb: (status: RepoStatus) => void): void;
  ready(): void;
  refreshRepo(): void;
  send(id: string, text: string, images: ImageInput[]): void;
  interrupt(id: string): void;
  setModel(id: string, model: string): void;
  setEffort(id: string, effort: Effort): void;
  setMode(id: string, mode: Mode): void;
  decide(id: string, requestId: string, decision: PermissionDecision): void;
  stop(id: string): void;
  resume(id: string): void;
  remove(id: string): void;
  openExternal(url: string): void;
}
