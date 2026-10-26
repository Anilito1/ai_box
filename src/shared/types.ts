import type { TurnRecord } from './costs';
import type { Lang } from './i18n';
import type { KeepReason } from './parallel';
import type { CliCommand } from './slash';
import type { AgentDrop } from './team';
import type { Topic } from './topics';
import type { UpdateChoice, UpdateMode, UpdateState } from './update';

export { APP_NAME } from './brand';

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

export const MENU_MODES: Mode[] = ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'];
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

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

/**
 * A permanent worker with a set post (backend, front, QA…): it keeps its conversation from one mission to the next,
 * sleeps when it has nothing to do, and the master hands it the tasks of its post first.
 */
export interface TeamRole {
  /** Stable id, made by the main process ("r-" + 8 characters). */
  id: string;
  /** Its session is "hub-<name>": lowercase letters, digits and dashes. */
  name: string;
  /** When the master should use it: read by the master to route a task. */
  description: string;
  /** Added to its system prompt. Configuration data: it grants nothing the permission mode does not. */
  instructions: string;
  /** Working folders: the first one is its cwd (its CLAUDE.md), the others are added directories. */
  folders: string[];
  /** Empty = auto: the master picks the model (or effort) of each mission. */
  model: string;
  effort: Effort | '';
  /** Empty = the mode of the other sessions. */
  mode: Mode | '';
  enabled: boolean;
}

/** What the sidebar shows of a permanent worker's post. */
export interface RoleBadge {
  id: string;
  /** Position in the team, as ordered in the settings. */
  order: number;
  description: string;
}

/** An extra instance of a post, started for one parallel job. */
export interface InstanceBadge {
  postId: string;
  post: string;
  /** Its name without "hub-<post>-": the job it was started for. */
  topic: string;
}

/** A worktree the hub made for a worker: named by its branch, never by its path. */
export interface TreeBadge {
  branch: string;
  /** removed: the worker closed and nothing was lost; kept: it closed with work left in it. */
  state: 'active' | 'kept' | 'removed';
  kept: KeepReason[];
  /** The hub is installing its dependencies, or could not. */
  install: '' | 'running' | 'failed';
}

export interface SessionView {
  id: string;
  role: Role;
  /** Set for a permanent worker. */
  post: RoleBadge | null;
  instance: InstanceBadge | null;
  tree: TreeBadge | null;
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
  /** Why its last start or run failed; empty once it runs again. */
  error: string;
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
  /** Its folder was moved or deleted. */
  missing: boolean;
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

/** A refused git action: the kind's sentence, a more precise one in `message` when the hub has it, git's words in `detail`. */
export type RepoActionResult = { ok: true } | { ok: false; kind: RepoErrorKind; message: string; detail: string };

export interface HubSnapshot {
  sessions: SessionView[];
  models: ModelOption[];
  rateLimits: RateLimits | null;
  /** Topics of the master's conversation, most recent activity first. */
  topics: Topic[];
}

/**
 * In the master's conversation: `topic`, the topic the item is filed under (none: only in "All"); `also`, further
 * topics of a request about several jobs.
 */
export type ChatItem = (
  | { kind: 'user'; id: string; text: string; images: string[] }
  | { kind: 'peer'; id: string; from: string; text: string }
  | { kind: 'assistant'; id: string; text: string; live: boolean }
  | { kind: 'thinking'; id: string; text: string }
  | { kind: 'tool'; id: string; name: string; summary: string; detail: string; diff: boolean; result: string | null; isError: boolean }
  | {
      kind: 'permission';
      id: string;
      /** The question in human words, instead of "Permission needed: <tool>". */
      title?: string;
      allowLabel?: string;
      denyLabel?: string;
      /** The detail stays in view (a command, an edit) instead of folding under "Details". */
      showDetail?: boolean;
      tool: string;
      summary: string;
      detail: string;
      diff: boolean;
      reason: string;
      canAlways: boolean;
      state: 'pending' | 'allowed' | 'denied' | 'expired';
    }
  | {
      kind: 'notice';
      id: string;
      /** A short sentence for the user. */
      text: string;
      tone: 'info' | 'error';
      /** A button that opens Settings › Claude. */
      action?: 'claude-settings';
      /** The raw message behind an error, shown folded under "Details". */
      detail?: string;
    }
) & { topic?: string; also?: string[] };

export interface PermissionDecision {
  behavior: 'allow' | 'always' | 'deny';
  message?: string;
}

/** Where sessions get their Claude access. `claude-code`: whatever Claude Code itself is set up with (its own sign-in). */
export type Provider = 'claude-code' | 'api-key';
export const PROVIDERS: Provider[] = ['claude-code', 'api-key'];
/** `oauth`: device flow sign-in; `token`: personal access token; `gh`: the GitHub CLI's own sign-in. */
export type GithubSource = 'none' | 'oauth' | 'token' | 'gh';

export interface HubSettings {
  language: Lang;
  /** False until the first-run setup is finished: the master only starts after it. */
  onboarded: boolean;
  /** Claude Code executable; empty = the binary bundled with the Agent SDK, else `claude` found on the PATH. */
  claudePath: string;
  provider: Provider;
  /** Folders scanned by `list_repos`; the master runs in the first one. */
  workspaces: string[];
  /** Repos the user mainly works on (absolute paths): known to the master, git state shown in the sidebar. */
  mainRepos: string[];
  /** Empty model/effort = exactly like a normal Claude Code session (settings.json: model, effortLevel). */
  master: { model: string; effort: Effort | '' };
  worker: { model: string; effort: Effort | '' };
  /** Models the master may pick for a mission (ad-hoc worker, or permanent one in auto). */
  workerModels: string[];
  /** Highest effort the master may pick for a mission. */
  workerMaxEffort: Effort;
  /** Permanent workers, in the order the settings show them. */
  team: TeamRole[];
  /** Instances of one post at the same time (its own worker included), and workers running at the same time. */
  parallel: { perPost: number; maxWorkers: number };
  /** Permission mode of every session at launch; empty = Claude Code's own default (settings, else auto or manual). */
  permissionMode: Mode | '';
  /** The user's own guidance, appended to the master's system prompt. */
  masterInstructions: string;
  github: {
    /** Client ID of the GitHub OAuth App used for the device flow; empty = the build's default. */
    clientId: string;
    source: GithubSource;
    login: string;
    /** Sessions get this GitHub access for git and gh (a token source puts the token in their environment). */
    shareWithSessions: boolean;
  };
  /** When the hub installs its own updates (a source checkout of the official repository). */
  updates: UpdateMode;
}

/** Settings as the renderer sees them: secrets only as "set or not". */
export interface SettingsView {
  settings: HubSettings;
  apiKeySet: boolean;
  githubTokenSet: boolean;
  /** The OS keychain can encrypt secrets (safeStorage); without it no secret is stored. */
  secureStorage: boolean;
  /** A client ID ships with this build, so the device flow works without configuring one. */
  defaultClientId: boolean;
  platform: string;
  version: string;
}

/** Sections the renderer may replace; the main process validates each field. The team changes one post at a time (saveRole). */
export type SettingsPatch = Partial<Omit<HubSettings, 'onboarded' | 'github' | 'claudePath' | 'team'>> & {
  github?: Partial<Pick<HubSettings['github'], 'clientId' | 'shareWithSessions'>>;
};

/** A Claude Code subagent file (.claude/agents/*.md) offered as a starting point for a post. */
export interface AgentFile {
  /** "user" (~/.claude/agents) or the name of the followed repo it was found in. */
  scope: string;
  path: string;
  role: Omit<TeamRole, 'id'>;
  /** Subagent settings a post does not carry (its tools, a bypass mode…), named so the user knows. */
  ignored: AgentDrop[];
}

export interface ClaudeStatus {
  /** A Claude Code the sessions can run was found (its path stays in the main process). */
  found: boolean;
  /** What Claude Code reports about its credentials once started with the hub's settings; null when it could not start. */
  account: { ready: boolean; provider: string; email: string; plan: string; source: string } | null;
  error: string;
}

export interface GithubDevice {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
}

export interface Result {
  ok: boolean;
  error: string;
}

export interface FoundRepo {
  name: string;
  path: string;
  remote: string;
}

/** A repository of the connected GitHub account. */
export interface GithubRepo {
  /** owner/name */
  slug: string;
  private: boolean;
  description: string;
  pushedAt: number;
}

export interface HubApi {
  onSnapshot(cb: (snapshot: HubSnapshot) => void): void;
  onItems(cb: (sessionId: string, items: ChatItem[], reset: boolean) => void): void;
  onRepo(cb: (status: RepoStatus) => void): void;
  onEvent(cb: (sessionId: string, kind: HubEventKind) => void): void;
  /** Paths of the repos shown in the sidebar, sent at start and whenever the settings change them. */
  onRepos(cb: (paths: string[]) => void): void;
  ready(): void;
  /** The repo calls take the folder of a checkout (main folder or worktree) of a main repo. */
  repoGraph(path: string, filter: GraphFilter, limit: number): Promise<RepoGraph>;
  /** `id`: a commit hash, or "incoming" / "outgoing" for the changes since the merge base with the upstream. */
  repoDetails(path: string, id: string): Promise<CommitDetails>;
  repoBranches(path: string): Promise<RepoBranch[]>;
  repoAction(path: string, action: RepoAction): Promise<RepoActionResult>;
  /** Claude Code's commands and skills for a session's composer (those it runs as typed). */
  sessionCommands(id: string): Promise<CliCommand[]>;
  compact(id: string, instructions: string): void;
  /** Starts the session over in a new, empty conversation. */
  clear(id: string): void;
  /** Deletes one of the master's topics and the history filed under it; the master's own conversation stays. */
  deleteTopic(topic: string): void;
  /** Says the session's cost and tokens in its conversation. */
  showCost(id: string): void;
  /** Turns logged in [from, to), oldest first, and when the log started. */
  costHistory(from: number, to: number): Promise<{ records: TurnRecord[]; since: number }>;
  /** Loads the conversation of a closed session so it can be read without resuming it. */
  open(id: string): void;
  /** `topic`: the master's topic the message is written in, else null. */
  send(id: string, text: string, images: ImageInput[], topic: string | null): void;
  interrupt(id: string): void;
  setModel(id: string, model: string): void;
  setEffort(id: string, effort: Effort): void;
  setMode(id: string, mode: Mode): void;
  decide(id: string, requestId: string, decision: PermissionDecision): void;
  stop(id: string): void;
  resume(id: string): void;
  remove(id: string): void;
  openExternal(url: string): void;
  getSettings(): Promise<SettingsView>;
  saveSettings(patch: SettingsPatch): Promise<SettingsView & Result>;
  /** Stores (or with null, deletes) the Anthropic API key after checking it with the API. */
  setApiKey(key: string | null): Promise<SettingsView & Result>;
  checkClaude(): Promise<ClaudeStatus>;
  /** Opens a terminal window with Claude Code's own sign-in, or Anthropic's installer; false when none could open. */
  claudeTerminal(action: 'login' | 'install'): Promise<boolean>;
  /** The GitHub CLI on this machine: installed or not, and the login it is signed in with (else empty). */
  ghStatus(): Promise<{ installed: boolean; login: string }>;
  /** Opens a terminal window with the GitHub CLI's own sign-in; false when none could open. */
  githubTerminal(): Promise<boolean>;
  githubDeviceStart(): Promise<GithubDevice & Result>;
  /** Resolves once the device flow ends: signed in, denied, expired or cancelled. */
  githubDeviceWait(): Promise<SettingsView & Result>;
  githubCancel(): void;
  githubUseToken(token: string): Promise<SettingsView & Result>;
  githubUseGh(): Promise<SettingsView & Result>;
  githubDisconnect(): Promise<SettingsView>;
  /** Whether the saved GitHub sign-in still works (expired or revoked token, gh signed out). */
  githubCheck(): Promise<Result>;
  pickFolder(): Promise<string | null>;
  scanRepos(roots: string[]): Promise<FoundRepo[]>;
  /** Repositories of the connected GitHub account, most recently pushed first. */
  githubRepos(): Promise<Result & { repos: GithubRepo[] }>;
  /** Clones owner/name into one of the working folders and adds it to the main repos. */
  cloneRepo(slug: string, root: string): Promise<SettingsView & Result>;
  /** Creates a post (empty id) or replaces the one with this id; `field` names the field refused. */
  saveRole(role: TeamRole): Promise<SettingsView & Result & { field: string }>;
  /** `error` is "working" when its worker is in the middle of a turn. */
  deleteRole(id: string): Promise<SettingsView & Result>;
  moveRole(id: string, delta: -1 | 1): Promise<SettingsView>;
  /** Subagent files of ~/.claude/agents and of the followed repos. */
  agentFiles(): Promise<AgentFile[]>;
  /** The team changed outside the settings screen (the master's tools). */
  onTeam(cb: (team: TeamRole[]) => void): void;
  /** Ends the first-run setup and starts the master. */
  finishSetup(): Promise<void>;
  relaunch(): void;
  onUpdate(cb: (state: UpdateState) => void): void;
  updateState(): Promise<UpdateState>;
  /** Asks the official repository now. */
  checkUpdate(): Promise<UpdateState>;
  /**
   * "Update" (or "Realign", after a rewrite of the official history: confirmed in a native dialog). With sessions at
   * work, `ask` gets the state back with `confirm` set, and the window asks: `when-quiet` or `now`.
   */
  installUpdate(choice: UpdateChoice): Promise<UpdateState>;
  /** The answer to a countdown to an unattended restart. */
  answerUpdate(go: boolean): void;
  /** Opens the hub's own folder (local modifications to look at). */
  openUpdateFolder(): void;
}
