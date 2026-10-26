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
/** The program that runs an agent: Claude Code (also for Anthropic-compatible and bridged accounts) or Codex. */
export type HarnessId = 'claude' | 'codex';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
import type { FallbackConfig } from './fallback';
import type { ProviderId, ProviderMethod } from './providers';
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
  /** Account its worker runs on (an account id, or "default"); empty = the workers' account. */
  account: string;
  enabled: boolean;
}

/**
 * An account sessions can run on, besides the Claude access of Settings › Claude ("default"). `claude`: a Claude
 * account signed in through Claude Code's own sign-in, in a Claude Code folder of its own; `anthropic-key`: an
 * Anthropic API key; `openai`: an OpenAI API key, or any OpenAI-compatible server, reached through the hub's bridge;
 * `anthropic-compatible`: any server that speaks Anthropic's Messages API (DeepSeek…), reached by Claude Code directly;
 * `codex`: a ChatGPT account signed in through Codex's own sign-in, driven by the Codex program (its own harness).
 */
export type AccountKind = 'claude' | 'anthropic-key' | 'openai' | 'anthropic-compatible' | 'codex';
export const ACCOUNT_KINDS: AccountKind[] = ['claude', 'anthropic-key', 'openai', 'anthropic-compatible', 'codex'];

export interface Account {
  /** "a-" + 8 characters, made by the main process. */
  id: string;
  kind: AccountKind;
  /** What the user calls it ("Perso", "Work"): unique, shown in the menus and given to the master. */
  name: string;
  /** openai and anthropic-compatible: the server's base URL (".../v1"), the model the work runs on, and the one for small background calls. */
  baseUrl: string;
  model: string;
  smallModel: string;
  /** codex only: signed in in a Codex folder of the hub's own (true), or the one the user's Codex already uses (false). */
  isolated: boolean;
}

/** What the composer and the sidebar show of an account. */
export interface AccountBadge {
  id: string;
  name: string;
  kind: AccountKind | 'default';
  /** The provider block it belongs to, empty for an older account none of them stands for. */
  provider: ProviderId | '';
  /** Epoch seconds when the account's limit ends, while it is limited. */
  limitedUntil: number | null;
  /** Its sessions run the account's own model: the model menu has nothing to pick. */
  pinned: boolean;
}

/** An account checked on demand: signed in or not, with what (an email and a plan, a model…). */
export interface AccountStatus {
  ready: boolean;
  /** Who or what it runs as, for the user's eyes. */
  detail: string;
  /** An error code (see the settings' errorText), empty when ready or merely signed out. */
  error: string;
  /** openai: the models the server lists, for the model fields. */
  models: string[];
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
  /** Account it runs on (while running) or will run on at its next launch. */
  account: string;
  /** Gone on another account because its own reached a limit: the account it left, else empty. */
  fallbackFrom: string;
  /** A switch to another account waits for the turn in progress to end. */
  accountPending: boolean;
  /** The user picked its account by hand: the master's choices leave it alone. */
  userAccount: boolean;
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
  /** The models of each account that has a list of its own (Codex), by account id. */
  catalogs: Record<string, ModelOption[]>;
  /** Topics of the master's conversation, most recent activity first. */
  topics: Topic[];
  /** The accounts a session can be switched to, "default" first. */
  accounts: AccountBadge[];
  /** The providers, connected or not, with the models of each. */
  providers: ProviderBadge[];
}

/** What the composer and the post editor show of a provider. */
export interface ProviderBadge {
  id: ProviderId;
  label: string;
  connected: boolean;
  /** The account its sessions run on ("default" for Anthropic), empty when not connected. */
  accountId: string;
  models: ModelOption[];
}

/** One way of connecting a provider, as its block in Settings › Accounts shows it. */
export interface MethodView {
  connected: boolean;
  /** Who it is signed in as, or what the key is. */
  detail: string;
  /** An error code (see the settings' errorText), empty when fine. */
  error: string;
}

/** What a provider action answers: done or why not, and the blocks as they are now. */
export interface ProviderResult {
  ok: boolean;
  error: string;
  field: string;
  views: ProviderView[];
}

/** A provider's block in Settings › Accounts. */
export interface ProviderView {
  id: ProviderId;
  label: string;
  connected: boolean;
  /** The method that is connected (the first when several are), else empty. */
  method: ProviderMethod | '';
  methods: Partial<Record<ProviderMethod, MethodView>>;
  /** The program the sign-in runs in (claude, codex): found on this computer, its version, too old for the hub. */
  cli: { found: boolean; version: string; outdated: boolean } | null;
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
      action?: 'claude-settings' | 'accounts-settings';
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
  /** Codex program to run; empty = the one found on the PATH. */
  codexPath: string;
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
  /** Accounts besides the Claude access above ("default"); changed through their own calls, never a patch. */
  accounts: Account[];
  /** Account the master runs on, and the one workers run on unless their post or the user picks another. */
  masterAccount: string;
  workerAccount: string;
  /** Automatic fallback to another account when one reaches a limit. */
  fallback: FallbackConfig;
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
  /** Accounts whose key is stored (an API key, an OpenAI key), by id. */
  accountKeys: string[];
  githubTokenSet: boolean;
  /** The OS keychain can encrypt secrets (safeStorage); without it no secret is stored. */
  secureStorage: boolean;
  /** A client ID ships with this build, so the device flow works without configuring one. */
  defaultClientId: boolean;
  platform: string;
  version: string;
}

/** Sections the renderer may replace; the main process validates each field. The team changes one post at a time (saveRole). */
export type SettingsPatch = Partial<Omit<HubSettings, 'onboarded' | 'github' | 'claudePath' | 'codexPath' | 'team' | 'accounts'>> & {
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

/** The Codex program, as the accounts section reports it. */
export interface CodexCli {
  found: boolean;
  version: string;
  /** Older than the first version the hub was written against. */
  outdated: boolean;
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
  /** Moves a session to another account (an id, "default"); it restarts on it with its conversation. */
  setAccount(id: string, account: string): void;
  /** Puts a session on a provider (anthropic, openai, deepseek): it moves to the account behind it, if connected. */
  setProvider(id: string, provider: string): void;
  /** One choice: a provider and a model of it, applied together. */
  setProviderModel(id: string, provider: string, model: string): void;
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
  /** The Codex program on this computer: found or not, its version, and whether the hub knows that version. */
  checkCodex(): Promise<CodexCli>;
  /** The providers' blocks in Settings › Accounts, checked now. */
  providers(): Promise<ProviderView[]>;
  /** Connects a provider with an API key (checked with its service, kept in the keychain). */
  connectProvider(provider: ProviderId, method: ProviderMethod, key: string): Promise<ProviderResult>;
  /** Opens the program's own sign-in in a terminal window; false when none could open. */
  loginProvider(provider: ProviderId, method: ProviderMethod): Promise<boolean>;
  disconnectProvider(provider: ProviderId, method: ProviderMethod): Promise<ProviderResult>;
  /**
   * Creates (empty id) or changes an account. `key`: an API key to check and store, null to keep the stored one,
   * '' to remove it. A key is checked with its service first; `field` names the field refused.
   */
  saveAccount(account: Account, key: string | null): Promise<SettingsView & Result & { id: string; field: string; status: AccountStatus | null }>;
  /** Signs it out (a Claude account) and forgets it; its sessions move to their usual account. */
  deleteAccount(id: string): Promise<SettingsView & Result>;
  checkAccount(id: string): Promise<AccountStatus>;
  /** Opens a terminal window with Claude Code's own sign-in, for that Claude account's folder; false when none could open. */
  accountLogin(id: string): Promise<boolean>;
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
