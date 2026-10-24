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
  exited: 'fermé',
};

export const MODE_LABEL: Record<Mode, string> = {
  auto: 'Auto',
  default: 'Manuel',
  acceptEdits: 'Édition auto',
  plan: 'Plan',
  bypassPermissions: 'Tout autoriser',
  dontAsk: 'Ne pas demander',
};

export const MODE_HINT: Partial<Record<Mode, string>> = {
  bypassPermissions: 'Aucune demande : commandes, commit, push, deploy, SQL',
  auto: 'Un classifieur valide les actions sûres, bloque les déploiements',
  default: 'Demande avant les modifications et la plupart des commandes',
  acceptEdits: 'Modifie les fichiers sans demander',
  plan: 'Explore et propose un plan, sans rien modifier',
};

export const MENU_MODES: Mode[] = ['bypassPermissions', 'auto', 'default', 'acceptEdits', 'plan'];

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
  /** When it turned idle, else null. */
  idleSince: number | null;
  /** Subagents running, in the foreground or in the background. */
  agents: number;
  /** The CLI is compacting the conversation. */
  compacting: boolean;
  /** An API call failed (overloaded, rate limit) and is being retried. */
  retrying: boolean;
}

/** One-off happenings of a session, sent apart from the snapshot (which only carries levels) so none is lost. */
export type HubEventKind =
  | 'turn_done'
  | 'interrupted'
  | 'tool_error'
  | 'crashed'
  | 'compacting'
  | 'retry'
  | 'message_in'
  | 'message_out'
  | 'idle_closed'
  | 'pushed'
  | 'deployed'
  | 'tests_failed'
  | 'cost_milestone';

export interface RepoFile {
  /** Porcelain XY code: index then worktree status, e.g. "M.", ".M", "??", "UU" for a conflict. */
  code: string;
  path: string;
  /** Former path of a rename or copy, else empty. */
  from: string;
}

/** `upstream` ("origin/feat/x") is the branch's own remote branch, not another one it tracks (a worktree made from origin/main). */
export const ownUpstream = (branch: string, upstream: string) => !!branch && !!upstream && upstream.slice(upstream.indexOf('/') + 1) === branch;

/** Operation left in progress in a checkout (after a conflict), else empty. */
export type RepoState = '' | 'merge' | 'rebase' | 'cherry-pick' | 'revert';

/** One checkout of a repo: its main folder or a linked worktree. */
export interface RepoTree {
  path: string;
  /** Worktree folder without the repo's own prefix ("voice-order"); empty for the main folder. */
  label: string;
  /** Checked-out branch, empty when detached. */
  branch: string;
  /** Full hash of HEAD, empty before the first commit. */
  oid: string;
  /** Tracking branch ("origin/main"), empty when none; ahead/behind are measured against it. */
  upstream: string;
  ahead: number;
  behind: number;
  state: RepoState;
  /** Every change of the working tree (capped), staged and unstaged. */
  files: RepoFile[];
  changes: number;
  conflicts: number;
  error: string;
}

/** Action in flight on one checkout of a repo. */
export interface RepoBusy {
  path: string;
  action: RepoActionKind;
}

/** Live git state of a main repo shown at the bottom of the sidebar, with all its worktrees. */
export interface RepoStatus {
  name: string;
  path: string;
  /** Main folder first, then the linked worktrees. */
  trees: RepoTree[];
  /** Changes whenever a branch, remote branch or tag moves: the graph reloads then. */
  refsKey: string;
  /** Web page of the origin remote (GitHub, GitLab…), empty when unknown. */
  webUrl: string;
  fetching: boolean;
  fetchedAt: number | null;
  fetchError: string;
  busy: RepoBusy | null;
  error: string;
}

export type GitRefKind = 'head' | 'branch' | 'remote' | 'tag';

/** A ref decorating a commit; `id` is the full ref name ("refs/remotes/origin/main"). */
export interface GitRef {
  id: string;
  name: string;
  kind: GitRefKind;
}

export interface GraphCommit {
  id: string;
  parents: string[];
  author: string;
  email: string;
  /** Author date, ms. */
  at: number;
  subject: string;
  /** Full message, subject included. */
  message: string;
  refs: GitRef[];
}

/** A ref the graph is drawn around, and the commit it points at. */
export interface GraphRef {
  id: string;
  name: string;
  revision: string;
}

/** Auto: the current branch, its upstream, the base branch and the branches of the repo's worktrees. All: every branch, remote branch and tag. */
export type GraphFilter = 'auto' | 'all';

export interface RepoGraph {
  commits: GraphCommit[];
  /** Older commits exist beyond the limit. */
  more: boolean;
  /** HEAD: its branch, or the commit itself when detached; null before the first commit. */
  head: GraphRef | null;
  upstream: GraphRef | null;
  base: GraphRef | null;
  /** Common ancestor of HEAD and its upstream, empty when either is missing. */
  mergeBase: string;
  /** Full names of the refs the log was asked for (they get a badge). */
  refs: string[];
}

export interface CommitFile {
  /** A, M, D, R, C, T… */
  status: string;
  path: string;
  from: string;
  /** Lines added and deleted; -1 for a binary file. */
  added: number;
  deleted: number;
}

/** Files changed by a commit (against its first parent), or by the incoming/outgoing changes as a whole. */
export interface CommitDetails {
  files: CommitFile[];
  added: number;
  deleted: number;
}

export interface RepoBranch {
  /** Full ref name: "refs/heads/feat/x" or "refs/remotes/origin/feat/x". */
  ref: string;
  name: string;
  remote: boolean;
  current: boolean;
  upstream: string;
  /** Folder of the worktree that has it checked out, else empty. */
  worktree: string;
  /** Last commit date, ms. */
  at: number;
}

export type RepoAction =
  | { kind: 'fetch' }
  | { kind: 'pull' }
  | { kind: 'push' }
  | { kind: 'sync' }
  | { kind: 'publish' }
  | { kind: 'commit'; message: string }
  | { kind: 'stage'; paths: string[] }
  | { kind: 'unstage'; paths: string[] }
  | { kind: 'stage-all' }
  | { kind: 'unstage-all' }
  | { kind: 'checkout'; ref: string }
  | { kind: 'branch'; name: string }
  | { kind: 'abort' };
export type RepoActionKind = RepoAction['kind'];

/** Why git refused, so the panel can say it plainly and offer the way out. */
export type RepoErrorKind =
  | 'no-upstream'
  | 'rejected'
  | 'diverged'
  | 'conflict'
  | 'local-changes'
  | 'nothing-to-commit'
  | 'auth'
  | 'busy'
  | 'invalid'
  | 'other';

export type RepoActionResult = { ok: true } | { ok: false; kind: RepoErrorKind; message: string; detail: string };

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
  onEvent(cb: (sessionId: string, kind: HubEventKind) => void): void;
  ready(): void;
  /** The repo calls take the folder of a checkout (main folder or worktree) of a main repo. */
  repoGraph(path: string, filter: GraphFilter, limit: number): Promise<RepoGraph>;
  /** `id`: a commit hash, or "incoming" / "outgoing" for the changes since the merge base with the upstream. */
  repoDetails(path: string, id: string): Promise<CommitDetails>;
  repoBranches(path: string): Promise<RepoBranch[]>;
  repoAction(path: string, action: RepoAction): Promise<RepoActionResult>;
  /** Loads the conversation of a closed session so it can be read without resuming it. */
  open(id: string): void;
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
