import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { z, type ZodRawShape } from 'zod';
import { addUsage, sumUsage, turnDelta, ZERO, type CostRole, type Totals } from '../shared/costs';
import { capReached, isSafeBranch, topicOf, type KeepReason } from '../shared/parallel';
import { resolveTopicRepo } from '../shared/topicGroups';
import { isPostRef, leads, ledBy, memberOf, refName, refsOf, withoutPosts } from '../shared/groups';
import { parseTopicCall, TopicTracker, workerName, type ReplayStep, type TopicInput } from '../shared/topics';
import { parseSlash, visibleCli, type CliCommand } from '../shared/slash';
import { canonAccount, DEFAULT_ACCOUNT, findAccount, firstAccount, harnessOf, isBuiltinAccount, OWN_ACCOUNT, pinsModel, runsClaude } from '../shared/accounts';
import { effortsFor } from '../shared/models';
import { NO_NEWS, type ProviderNews } from '../shared/news';
import { DEEPSEEK_MODELS, deepseekAlias, isCustomAccount, isProviderId, PROVIDER_DEFS, providerOfAccount, resolveProvider, type ProviderId, type ProviderState } from '../shared/providers';
import { Cooldowns, isPaid, pickTarget, returnDue, type FallbackStep } from '../shared/fallback';
import { buildHandoff, staleNote } from '../shared/passation';
import { USAGE_MIN_GAP_MS, USAGE_POLL_MS, usageAccount, usageFailed, usageRead, usageState, type UsageRecord } from '../shared/usage';
import { ultracodeAccess, type UltracodeAccess } from '../shared/ultracode';
import {
  capEffort,
  freshStartDue,
  fromTemplate,
  needsFreshStart,
  resolveChoice,
  roleKey,
  sessionNameOf,
  slugify,
  TEMPLATE_IDS,
  workTokens,
  type ChoiceNote,
  type ContextBase,
  type RoleError,
} from '../shared/team';
import {
  EFFORTS,
  type AccountBadge,
  type AccountKind,
  type ChatItem,
  type Effort,
  type HarnessId,
  type HubEventKind,
  type HubSnapshot,
  type ImageInput,
  type Metrics,
  type Mode,
  type ModelOption,
  type ProviderBadge,
  type PermissionDecision,
  type RateLimits,
  type Role,
  type SessionView,
  type TeamGroup,
  type TeamRole,
} from '../shared/types';
import { mainRepoPath, masterCwd, prepareGroup, prepareRole, type GroupCheck, type HubConfig } from './config';
import type { CostLog } from './costLog';
import { assistantError, humanError } from './errors';
import { lang, t, tn } from './i18n';
import {
  defaultMasterName,
  groupInfo,
  groupsText,
  handoffBlock,
  handoffRequest,
  IDLE_CLOSE_MIN,
  inside,
  masterName,
  masterPrompt,
  missionNote,
  PERMANENT_SLEEP_MIN,
  postProvider,
  postUpdate,
  rosterBlock,
  rosterKey,
  setMasterName,
  setProviderLines,
  tags,
  workerPrompt,
  type InstanceInfo,
} from './prompts';
import { findRepos, realPath, repoOf, samePath } from './repos';
import {
  assistantItems,
  capturedLine,
  commandOutcome,
  resultText,
  taggedSender,
  toolDetail,
  toolLabel,
  toolSummary,
  userTextItem,
  visibleText,
} from './transcript';
import { frameSteps, replayInput, spawnedName, TOPIC_TOOL, topicAnswer, topicBlock, topicErrors, topicToolSpec } from './topics';
import { installPlan, makeTree, planText, retireTree, runInstall, type InstallPlan, type NewTree, type WorkTree } from './worktrees';
import { adapterFor } from './providers';
import { claudeLimit } from './providers/claude/events';
import { Inbox } from './providers/inbox';
import type { McpHub, McpLease } from './mcpHub';
import type {
  ProviderAdapter,
  AgentCommand,
  AgentEvent,
  AgentInput,
  AgentModel,
  AgentProcess,
  ElicitationAnswer,
  ElicitationRequest,
  HubTool,
  LimitSignal,
  PermissionAnswer,
  PermissionRequest,
} from './providers/types';

interface Session extends Omit<SessionView, 'idleSince' | 'post' | 'instance' | 'group' | 'leads' | 'tree' | 'account' | 'accountPending' | 'fallbackFrom' | 'ultracodeAccess'> {
  sessionId: string;
  /** Account picked for it (by the user, or the master at its start); empty = its post's, else the usual one. */
  accountId: string;
  /** Account its running process was started on; empty when closed. */
  runAccount: string;
  /** The account "default" stood for when that process started, i.e. whose plan limits its readings are; empty when closed. */
  usageAccount: string;
  /** Ultracode was on when its running process started: a worker's Workflow tool is there only then (see the adapter). */
  runUltracode: boolean;
  /** Its account changed during a turn: it restarts on the new one (`pendingTo`) once the turn is over. */
  switchPending: boolean;
  /** A worker asked for Ultracode during a turn: it restarts once the turn is over, to get the Workflow tool. */
  ultracodePending: boolean;
  pendingTo: string;
  /** Gone on another account because its own reached a limit: the account pick it left (may be empty), else null. */
  home: string | null;
  /** When it left, how many items its conversation held then, and the model its fallback step names. */
  fallbackAt: number;
  fallbackMark: number;
  fallbackModel: string;
  /** The conversation of each account it ran on, to take up again when it goes back. */
  convs: Record<string, string>;
  /** A limit was hit during a turn: it goes on with this step once the turn is over. */
  fallbackPending: { step: FallbackStep; signal: LimitSignal } | null;
  /** What happened on the account it was away on, told with its next message once it is back. */
  backNote: string;
  /** The hub's tools served over HTTP to its running process (programs that cannot take them in-process), else null. */
  mcpLease: McpLease | null;
  /** True once the conversation exists on disk, i.e. it can be resumed. */
  started: boolean;
  items: Map<string, ChatItem>;
  query: AgentProcess | null;
  inbox: Inbox<AgentInput> | null;
  /** Approval cards waiting for the user; null = withdrawn by the CLI. */
  pending: Map<string, (decision: PermissionDecision | null) => void>;
  liveId: string | null;
  liveText: string;
  /** Transcript read into `items`; already settled for a conversation that started live in this run. */
  historyLoad: Promise<void> | null;
  /** Prompts pushed but not yet taken by the CLI (it replays each one as it consumes it). */
  queued: number;
  /** Explicit choices (config, master's spawn args, composer): the only model/effort passed at launch. Empty = settings.json. */
  fixedModel: string;
  fixedEffort: Effort | null;
  /** The inherited effort was already resolved for the current model. */
  effortResolved: boolean;
  /** The master wrote to this worker and has not heard back yet. */
  owesReport: boolean;
  /** Session id of the group lead whose message it works on: its report and its silence go there. Null: the master. */
  reportTo: string | null;
  /** The master closed it mid-turn: it closes once the turn and its background tasks are over. */
  closeWhenDone: boolean;
  /** Last message, turn or prompt: the idle timer runs from here. */
  activeAt: number;
  /** Ids of the subagent tasks still running (task_started until their notification). */
  agentTasks: Set<string>;
  /** When it last turned idle; unlike activeAt, frames arriving meanwhile (tasks, limits) leave it alone. */
  idleAt: number;
  /** Id of the post of a permanent worker, else null. */
  roleId: string | null;
  /** Handoff note a permanent worker wrote before its context was renewed: its next sessions start with it. */
  note: string;
  /** The note was written after the last work of this conversation: closing it now starts the next one afresh. */
  noteFresh: boolean;
  /** Its context at the first reading of this conversation: what grew past it is work. */
  contextBase: ContextBase | null;
  /** Writing its handoff note; work that arrives meanwhile makes the note stale. */
  handoff: boolean;
  handoffStale: boolean;
  /** Asked for a note since its last work: asked once, even when the answer was unusable. */
  handoffDone: boolean;
  /** What it was last told of its post (permanent) or of the team (master): a change is added to its next message. */
  seen: string;
  /** The user picked its model or effort by hand: the master's choices leave them alone. */
  userModel: boolean;
  userEffort: boolean;
  /** The user chose its Ultracode by hand: the master's choices leave it alone. */
  userUltracode: boolean;
  /** The conversation that got the handoff note with its first message: each new one gets it once. */
  noteSentTo: string;
  /** The note is on its way with a first message: until the conversation exists, it is not added again. */
  noteSending: boolean;
  /** The conversation opened on a slash command, which carried no note: its first real message still does. */
  noteDue: boolean;
  /** Id of the post an extra instance works for, else null (the post's own worker has roleId instead). */
  instanceOf: string | null;
  /** The worktree the hub made for it, else null. */
  tree: WorkTree | null;
  /** Shares another worker's folder to read it: Edit and Write are off. */
  readOnly: boolean;
  /** The hub installing its worktree's dependencies. */
  installing: { kill: () => void; done: Promise<unknown>; command: string } | null;
  installFailed: boolean;
  /** Its worktree being checked, and removed if nothing is lost, after a close: a launch waits for the outcome. */
  retiring: Promise<string> | null;
  /** Ends with its Claude Code process's stream. */
  exit: Promise<void> | null;
  /**
   * Running totals its Claude Code process started from (a resumed conversation carries its earlier turns), and the
   * last ones a result reported: each turn's spending is the difference.
   */
  usageBase: Promise<Totals | null | 'unknown'>;
  usageSeen: Totals | null;
  /** Commands and skills its Claude Code process offers. */
  commands: AgentCommand[];
}

type Persisted = {
  /** What to do at the next start: deliver a mission never received, or resume work cut by the close. */
  resume?: 'mission' | 'work';
} & Pick<
  Session,
  | 'id'
  | 'role'
  | 'name'
  | 'mission'
  | 'cwd'
  | 'model'
  | 'modelLabel'
  | 'effort'
  | 'lastMessage'
  | 'metrics'
  | 'createdAt'
  | 'sessionId'
  | 'started'
  | 'fixedModel'
  | 'fixedEffort'
  | 'roleId'
  | 'note'
  | 'noteFresh'
  | 'contextBase'
  | 'activeAt'
  | 'noteSentTo'
  | 'userModel'
  | 'userEffort'
  | 'userUltracode'
  | 'ultracode'
  | 'instanceOf'
  | 'reportTo'
  | 'tree'
  | 'readOnly'
  | 'accountId'
  | 'userAccount'
  | 'home'
  | 'fallbackAt'
  | 'fallbackMark'
  | 'fallbackModel'
  | 'convs'
>;

export interface ManagerOptions {
  /** Live settings: changes made in the settings screen apply at the next launch of each session. */
  cfg: HubConfig;
  dataDir: string;
  /** Claude Code executable to run; empty = the SDK's default. */
  executable(): string;
  /** Codex executable to run; empty = none found. */
  codexExecutable(): string;
  /** Gemini CLI executable to run; empty = none found. */
  geminiExecutable(): string;
  /** Where the hub's tools are served to programs that reach them over HTTP. */
  mcpHub: McpHub;
  /** Variables added to (set) or removed from (unset) the environment of a session on this account: its access, GitHub. */
  sessionEnv(account: string, model?: string): { set: Record<string, string>; unset: string[] };
  /** Writes the settings: the master's tools change the team. */
  persist(): void;
  /** Where each turn's cost goes. */
  costLog: CostLog;
  /** The MCP servers and skills installed, as list_capabilities gives them. */
  capabilities(): Promise<string>;
}

/** `notes`: the master's changes that a choice the user made by hand kept from applying. */
export type RoleSave = { role: TeamRole; before: TeamRole | null; notes: ChoiceNote[] } | { error: RoleError | 'working' };

type PermissionItem = Extract<ChatItem, { kind: 'permission' }>;

const MASTER_ID = 'master';
/** Effort of a worker when nobody fixed one: the user's own default (settings.json) is for their own sessions. */
const WORKER_EFFORT: Effort = 'medium';
/** A handoff note longer than this is cut: it goes into every later prompt of the post. */
const NOTE_MAX = 6000;
const ITEMS_MAX = 1500;
const ITEMS_TRIM = 300;
const HISTORY_MAX = 400;
const REPORT_ITEMS = 12;
// A queued message starts its turn within this delay; only a worker still idle after it has really stopped.
const SILENCE_MS = 5_000;
const ATTACHMENTS_MAX_AGE = 30 * 86_400_000;
// Session costs (USD) the mascot celebrates when a turn crosses them.
const COST_MILESTONES = [5, 10, 25, 50, 100, 250, 500, 1000];
const IMAGE_EXT: Record<ImageInput['mediaType'], string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
// Exported by a parent Claude Code session (e.g. when the hub is started from one); children must not inherit them.
const PARENT_SESSION_VARS =
  /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(CHILD_SESSION|SESSION_ID|MESSAGING_SOCKET|MESSAGING_TOKEN|SESSION_ATTENDED|ENTRYPOINT|EXECPATH))$/;

interface Prompt {
  text: string;
  images: ImageInput[];
  /** Shown in the conversation as a message from this sender instead of a user bubble. */
  from?: string;
  /** Text shown in the user bubble when it differs from what the model receives. */
  shown?: string;
  /** The hub asking a permanent worker for its handoff note. */
  handoff?: boolean;
  /** A slash command: Claude Code reads the text as typed, so nothing (handoff note, news of the team) is added to it. */
  command?: boolean;
  /** For the master: the topic it is filed under (the one the user wrote in, the worker's a hub message is about). */
  topic?: string;
}

/** Tools whose input a permission card shows as it is: the command to run, the edit to make. */
const SHOWN_INPUT = /^(Bash|PowerShell|Edit|MultiEdit|Write|NotebookEdit)$/;

/** A worker's name as the user reads it: without its "hub-" prefix. */
const displayName = (s: { name: string }) => s.name.replace(/^hub-/, '');

/** A model as the interface names it: Claude Code's name, its "default" choice said in the user's language. */
const modelLabel = (value: string, label: string) => (value === 'default' ? t('model.default') : label.replace(/\s*\(recommended\)\s*$/i, ''));

/** One line on what a model is for, in the user's language (Claude Code's own description is English). */
function modelHint(value: string, label: string): string {
  const name = `${value} ${label}`;
  const family = value === 'default' ? 'default' : (['fable', 'opus', 'sonnet', 'haiku'].find((f) => new RegExp(f, 'i').test(name)) ?? '');
  if (!family) return '';
  const hint = t(`model.hint.${family}` as Parameters<typeof t>[0]);
  return /\[1m\]/i.test(value) ? `${hint} ${t('model.hint.long')}` : hint;
}

// Tool calls that send a message to another session (worker ↔ worker, worker → master, master → worker).
const OUTGOING = /^(SendMessage|mcp__hub__(message_worker|spawn_worker|message_master))$/;

const AFFIRMATIVE = /^(yes|oui|ok|confirm(ed)?|accept(ed)?|approve(d)?|proceed|continue)$/i;
const CONFIRM_FIELD = /confirm|proceed|accept|approve|continue|agree/i;

/**
 * Answers of a pure confirmation: no field at all (Supabase's case), or only fields that are themselves a "confirm" —
 * a boolean named like one, or a choice with an affirmative option. Anything else (free text, a dry-run flag, a
 * credential) means the form is not a confirmation: null, and it is declined.
 */
function confirmationAnswers(schema: Record<string, unknown> | undefined): Record<string, boolean | string> | null {
  if (!schema) return null;
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const content: Record<string, boolean | string> = {};
  for (const [key, prop] of Object.entries(props)) {
    const label = `${key} ${String(prop.title ?? '')} ${String(prop.description ?? '')}`;
    const choices = Array.isArray(prop.enum)
      ? prop.enum
      : Array.isArray(prop.oneOf)
        ? (prop.oneOf as Record<string, unknown>[]).map((o) => o.const)
        : [];
    const yes = choices.find((c): c is string => typeof c === 'string' && AFFIRMATIVE.test(c));
    if (prop.type === 'boolean' && CONFIRM_FIELD.test(label)) content[key] = true;
    else if (yes) content[key] = yes;
    else return null;
  }
  return content;
}

/** An item with its topics (its own first), or as it is without any. */
const withTopics = (item: ChatItem, topics: string[] = []): ChatItem => {
  const [topic, ...also] = topics;
  return topic ? { ...item, topic, ...(also.length > 0 ? { also } : {}) } : item;
};
const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const KEEP_REASONS: KeepReason[] = ['changes', 'unpushed', 'operation', 'locked', 'inUse', 'unknown'];
/** A worktree read back from state.json, as makeTree() makes them. */
const validTree = (t: WorkTree): boolean =>
  [t.repo, t.source, t.path].every((p) => typeof p === 'string' && isAbsolute(p)) &&
  // Next to the repo's main folder, as makeTree() puts them.
  samePath(dirname(t.path), dirname(t.repo)) &&
  !samePath(t.path, t.repo) &&
  typeof t.branch === 'string' &&
  isSafeBranch(t.branch) &&
  /^[0-9a-f]{40,64}$/.test(t.base) &&
  typeof t.baseRef === 'string' &&
  ['active', 'kept', 'removed'].includes(t.state) &&
  Array.isArray(t.kept) &&
  t.kept.every((k) => KEEP_REASONS.includes(k));
const minutesSince = (at: number) => Math.max(1, Math.round((Date.now() - at) / 60_000));
/** A tag no text can guess: what sits between two of them is data the hub wrapped, never the hub's own words. */
const randomTag = () => randomUUID().replace(/-/g, '');
/** A folder as a question names it: its parent and its name. */
const shortPath = (dir: string) => dir.split(/[\\/]/).filter(Boolean).slice(-2).join('/') || dir;
/** A path on another computer (UNC, device): the master's paths never go there. */
const isNetworkPath = (dir: string) => /^[\\/]{2}/.test(dir.trim());
/** "51.7K" / "51,7 k": a token count in the user's language. */
const tokens = (n: number) => new Intl.NumberFormat(lang(), { notation: 'compact', maximumFractionDigits: 1 }).format(n);

export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, Session>();
  private modelInfos: AgentModel[] = [];
  /** The models of each Codex account, as Codex lists them. */
  private readonly catalogs = new Map<string, AgentModel[]>();
  /** Commands of the last session that started: offered to one that has not run yet. */
  private lastCommands: AgentCommand[] = [];
  /** Plan limits by account (the account a process was started on), and when each was last asked. */
  private readonly usage = new Map<string, UsageRecord>();
  private readonly usageCheckedAt = new Map<string, number>();
  private readonly usageAsking = new Set<string>();
  /** Which providers are connected, as the main process last checked them. */
  private providerStates: Record<string, ProviderState> = {};
  /** What is new at each provider (models, program version), as the main process read it. */
  private providerNews: Partial<Record<ProviderId, ProviderNews>> = {};
  private plans = new Map<string, string>();
  /** The version of the Claude Code installed, empty when unknown. */
  private claudeVersion = '';
  /** Accounts that reached a limit, and until when. */
  private readonly cooldowns = new Cooldowns();
  private reposCache: { at: number; text: string } | null = null;
  private readonly pendingItems = new Map<string, Map<string, ChatItem>>();
  private emitTimer: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private itemsTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private quitting = false;
  private readonly stateFile: string;
  private readonly attachDir: string;
  /** Posts whose worker the sidebar shows: one coming back from a disabled post gets its conversation sent again. */
  private readonly shownPosts = new Set<string>();
  /** Workers to relaunch at start, from the state saved when the hub last closed. */
  private readonly resumeOnStart = new Map<string, 'mission' | 'work'>();
  private spawnQueue: Promise<unknown> = Promise.resolve();
  /** Topics of the master's conversation; items a later call settles are filed again with theirs. */
  private readonly topics = new TopicTracker((ids, topic, also) => this.refile(ids, topic, also));

  constructor(private readonly opts: ManagerOptions) {
    super();
    this.stateFile = join(opts.dataDir, 'state.json');
    this.attachDir = join(opts.dataDir, 'attachments');
    this.restore();
    this.syncTeam();
    // The figure follows the user's other uses of the account too (a terminal, claude.ai): asked now and then, turn or not.
    setInterval(() => this.pollUsage(), USAGE_POLL_MS).unref();
  }

  // ---------- lifecycle ----------

  startMaster(): void {
    const { cfg } = this.opts;
    const master =
      this.sessions.get(MASTER_ID) ??
      this.create(MASTER_ID, 'master', defaultMasterName(), '', masterCwd(cfg), cfg.master.model, cfg.master.effort || null);
    setMasterName(master.name);
    void this.launch(master, master.started);
    // Idle workers stay closed: a message resumes them on demand. Only cut work is picked up again.
    for (const [id, why] of this.resumeOnStart) {
      const s = this.sessions.get(id);
      if (!s) continue;
      s.owesReport = true;
      if (why === 'mission' || !s.started) void this.launch(s, false, this.missionPrompt(s));
      else
        void this.launch(s, true, {
          text: `${tags().master}\n${t('hub.restarted')}`,
          images: [],
          from: masterName(),
        });
    }
    this.resumeOnStart.clear();
    this.sweepTimer = setInterval(() => {
      this.closeIdle();
      this.returnIdle();
    }, 60_000);
    this.pruneAttachments();
    void this.retireLeftovers();
  }

  /** Worktrees of workers the hub closed when it quit, idle: checked one at a time, removed if nothing is lost. */
  private async retireLeftovers(): Promise<void> {
    for (const s of [...this.sessions.values()]) {
      if (s.tree?.state === 'active' && !s.inbox && !this.quitting) await this.retire(s);
    }
  }

  /**
   * The master's settings changed: its model and effort apply now when given (else at its next launch, from
   * settings.json), and a new folder starts a new conversation there (a conversation belongs to its folder).
   */
  updateMaster(): void {
    const { cfg } = this.opts;
    const s = this.sessions.get(MASTER_ID);
    if (!s) return;
    if (cfg.master.model !== s.fixedModel) {
      if (cfg.master.model) this.setModel(s.id, cfg.master.model, false);
      else s.fixedModel = '';
    }
    const effort = cfg.master.effort || null;
    if (effort !== s.fixedEffort) {
      if (effort) this.setEffort(s.id, effort, false);
      else s.fixedEffort = null;
    }
    const cwd = masterCwd(cfg);
    if (resolve(cwd).toLowerCase() === resolve(s.cwd).toLowerCase()) return this.changed();
    const running = !!s.inbox;
    if (running) this.stop(s.id);
    Object.assign(s, { cwd, sessionId: randomUUID(), started: false, historyLoad: null, metrics: null, lastMessage: '' });
    s.items.clear();
    this.topics.reset();
    this.emit('items', s.id, [], true);
    if (running) void this.launch(s, false);
    this.changed();
  }

  /** A message the main process could not accept: kept visible in the conversation so its text is not lost. */
  refuse(id: string, text: string, reason: string): void {
    const s = this.sessions.get(id);
    if (s) this.notice(s, t('notice.refused', { reason, text: text.trim() ? ` : « ${oneLine(text, 300)} »` : '' }), 'error');
  }

  /** A message typed by the user in a session's composer; `topic`: the master's topic it is written in. */
  send(id: string, text: string, images: ImageInput[] = [], topic: string | null = null): void {
    const s = this.sessions.get(id);
    const shown = text.trim();
    if (!s || (!shown && images.length === 0)) return;
    if (this.ended(s)) return this.refuse(id, text, t('refuse.ended'));
    if (!s.inbox && this.orphan(s)) return this.refuse(id, text, t('refuse.orphan'));
    // Saved images get their path in the text, so the master can hand them to a worker (which opens them with Read).
    let paths: string[] = [];
    try {
      paths = this.saveImages(images);
    } catch (err) {
      this.notice(s, t('notice.imagesNotSaved'), 'error', errorText(err));
    }
    const command = parseSlash(shown) !== null;
    // Written in one of the master's topics: the master is told which, the user does not see it.
    // A command goes as typed: it is only filed.
    const filed = s.id === MASTER_ID && topic ? this.topics.get(topic) : undefined;
    const textForModel = [shown, ...paths.map(capturedLine), filed && !command ? topicBlock(filed, 'user') : ''].filter(Boolean).join('\n');
    // The user took the worker over: its turn no longer answers the master, and it stays open.
    s.owesReport = false;
    s.closeWhenDone = false;
    this.deliver(s, { text: textForModel, images, shown, command, ...(filed ? { topic: filed.id } : {}) });
  }

  interrupt(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.owesReport = false; // Stopped by the user on purpose: nothing for the master to chase.
    s.query?.interrupt().catch(() => undefined);
  }

  /**
   * Also works while the session is still launching: launch() sees its inbox gone and gives up. A worker with a
   * worktree of the hub's gets it checked, and removed if nothing would be lost (`retiring` holds the outcome).
   */
  stop(id: string): void {
    const s = this.sessions.get(id);
    if (!s?.inbox) return;
    const q = s.query;
    s.inbox.close();
    this.teardown(s);
    q?.close();
    s.installing?.kill();
    this.changed();
    if (s.tree && !this.quitting) void this.retire(s);
  }

  /** A worker whose worktree was removed: its job is over, its conversation can still be read. */
  private ended(s: Session): boolean {
    return !s.inbox && s.tree?.state === 'removed';
  }

  /** A worker that wrote its handoff note: its next launch is a new conversation, seeded with the note. */
  private freshStart(s: Session): void {
    Object.assign(s, { sessionId: randomUUID(), started: false, historyLoad: null, noteFresh: false });
    if (s.metrics) s.metrics = { ...s.metrics, contextTokens: 0, contextPct: 0 };
    this.notice(s, t('notice.freshStart'), 'info');
  }

  resume(id: string): void {
    const s = this.sessions.get(id);
    if (!s || s.inbox || this.ended(s) || this.orphan(s)) return;
    this.renewStale(s);
    void this.launch(s, s.started);
  }

  /** Shows the conversation of a closed session without resuming it. */
  open(id: string): void {
    const s = this.sessions.get(id);
    if (s && !s.inbox && s.started) void this.loadHistory(s);
  }

  /** Only an ad-hoc worker or an instance: a permanent one goes with its post (Settings › Team). A worktree kept stays. */
  remove(id: string): void {
    const s = this.sessions.get(id);
    if (!s || s.role !== 'worker' || s.roleId || s.inbox) return;
    this.sessions.delete(id);
    if (!s.instanceOf) this.dropFromGroups(s.name);
    this.changed();
    // Its work may have been pushed since it closed: removed now if nothing would be lost. Kept, the master's
    // conversation says which branch stays on disk (the git panel shows its worktree).
    const tree = s.tree;
    if (!tree || tree.state === 'removed') return;
    void this.retire(s).then(() => {
      const master = this.sessions.get(MASTER_ID);
      if (tree.state !== 'kept' || !master) return;
      const reasons = tree.kept.map((w) => t(`tree.why.${w}`)).join(' · ');
      this.notice(master, t('notice.treeLeftBehind', { name: displayName(s), branch: tree.branch, reasons }), 'info');
    });
  }

  killAll(): void {
    this.quitting = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    try {
      this.save();
    } catch {
      // State not saved (disk full, file locked): the sessions must still be closed.
    }
    for (const s of this.sessions.values()) {
      s.inbox?.close();
      s.query?.close();
      s.installing?.kill();
    }
  }

  /** The models an account offers, once known (a Codex account's own list; Claude's for the others). */
  setCatalog(account: string, models: AgentModel[]): void {
    if (models.length === 0) return;
    this.catalogs.set(account, models);
    this.changed();
  }

  /** The plan limits of an account, as its program last told them. */
  setLimits(account: string, limits: RateLimits): void {
    this.usage.set(this.canon(account), usageRead(limits, Date.now()));
    this.changed();
  }

  /** A session running on this account is in the middle of something. */
  workingOn(account: string): boolean {
    return [...this.sessions.values()].some((s) => s.query && s.runAccount === account && this.isWorking(s));
  }

  /** Sessions whose work a close would cut: a turn in progress, or background tasks left running after one. */
  busySessions(): number {
    return [...this.sessions.values()].filter((s) => s.query && this.isWorking(s)).length;
  }

  /** Sessions whose process runs this program: they keep the version they started with until they start again. */
  runningOn(harness: HarnessId): number {
    return [...this.sessions.values()].filter((s) => s.query && s.runAccount && harnessOf(this.kindOf(s.runAccount)) === harness).length;
  }

  // ---------- live controls (composer) ----------

  /** `byUser`: picked by hand in the composer, so the master's later choices leave it alone. */
  setModel(id: string, model: string, byUser = true): void {
    const s = this.sessions.get(id);
    if (!s) return;
    if (byUser) s.userModel = true;
    s.fixedModel = model;
    s.model = model;
    const own = s.runAccount && this.ownCatalog(s.runAccount) ? this.catalogOf(s.runAccount).find((m) => m.value === model) : undefined;
    s.modelLabel = own?.displayName ?? this.labelFor(model, model);
    if (!s.fixedEffort) {
      // An inherited effort is per model (modelSettings): resolve it again for the new one.
      s.effort = null;
      s.effortResolved = false;
    }
    s.query
      ?.setModel(model)
      .then(() => (s.query ? this.refreshContext(s, s.query) : undefined))
      .catch((err: unknown) => this.notice(s, t('notice.modelRefused'), 'error', errorText(err)));
    this.changed();
  }

  setEffort(id: string, effort: Effort, byUser = true): void {
    const s = this.sessions.get(id);
    if (!s) return;
    if (byUser) s.userEffort = true;
    s.fixedEffort = effort;
    s.effort = effort;
    s.query?.setEffort(effort, s.ultracode && s.runUltracode).catch((err: unknown) => this.notice(s, t('notice.effortRefused'), 'error', errorText(err)));
    this.changed();
  }

  /**
   * Ultracode on or off (Claude Code's standing workflow mode). Refused where the account's plan does not allow it.
   * On a running process it applies now; a worker launched without the Workflow tool restarts on its conversation to
   * get it: now if it is idle, else once its turn is over. Returns what the master is told.
   */
  setUltracode(id: string, on: boolean, byUser = true): string {
    const s = this.sessions.get(id);
    if (!s) return '';
    if (on && this.ultracodeAccessOf(s.runAccount || this.accountOf(s)) !== 'allowed') {
      const why = t('notice.ultracodeUnavailable');
      this.notice(s, why, 'error');
      return why;
    }
    if (s.ultracode === on) return t(on ? 'ultracode.already' : 'ultracode.alreadyOff', { name: s.name });
    s.ultracode = on;
    if (byUser) s.userUltracode = true;
    if (s.query) {
      s.query.setUltracode(on).catch((err: unknown) => {
        // Not taken (the model has no xhigh effort, workflows are off in Claude Code's own settings): the choice goes back.
        s.ultracode = !on;
        this.notice(s, t('notice.ultracodeRefused'), 'error', errorText(err));
        this.changed();
      });
      if (on && s.role === 'worker' && !s.runUltracode) this.restartForUltracode(s);
    }
    this.changed();
    return t(on ? 'ultracode.on' : 'ultracode.off', { name: s.name });
  }

  /** Ultracode for a worker that has not started yet: its launch picks it up. Said when the account's plan does not allow it. */
  private startUltracode(s: Session, asked: boolean): string {
    if (this.ultracodeAccessOf(this.accountOf(s)) !== 'allowed') return asked ? t('notice.ultracodeUnavailable') : '';
    s.ultracode = true;
    return t('ultracode.on', { name: s.name });
  }

  /** A worker's Workflow tool is fixed when its process starts: one that did not have it restarts, when no turn is in the way. */
  private restartForUltracode(s: Session): void {
    if (!this.settled(s)) {
      s.ultracodePending = true;
      this.notice(s, t('notice.ultracodeAfterTurn'), 'info');
      if (s.query) this.switchIfDone(s, s.query);
      return;
    }
    this.relaunch(s, 'notice.ultracodeRestarted');
  }

  setMode(id: string, mode: Mode): void {
    const s = this.sessions.get(id);
    if (!s) return;
    // Claude Code holds a cross-session message whose sender runs in another permission class (bypass vs prompting).
    const bypasses = (m: Mode | null) => m === 'bypassPermissions';
    if (bypasses(mode) !== bypasses(this.hubMode())) this.notice(s, t('notice.modeMismatch'), 'info');
    s.mode = mode;
    s.query?.setMode(mode).catch((err: unknown) => this.notice(s, t('notice.modeRefused'), 'error', errorText(err)));
    this.changed();
  }

  decide(id: string, requestId: string, decision: PermissionDecision): void {
    this.sessions.get(id)?.pending.get(requestId)?.(decision);
  }

  // ---------- accounts ----------

  /**
   * Moves a session to an account ("default", an account id; empty: back to its post's or the usual one). Picked by
   * the user, the master's later choices leave it alone. It restarts on the new account with its conversation, now if
   * it is idle, else once its turn is over. Returns what the master is told.
   */
  setAccount(id: string, account: string, byUser = true): string {
    const s = this.sessions.get(id);
    if (!s) return '';
    if (account && !isBuiltinAccount(account) && !this.opts.cfg.accounts.some((a) => a.id === account)) return '';
    s.accountId = account;
    if (byUser) s.userAccount = account !== '';
    // Moved by hand (or by the master): it is no longer "away" from anywhere.
    Object.assign(s, { home: null, fallbackPending: null, fallbackModel: '', backNote: '' });
    // A model the new account does not have (Claude's on Codex) is dropped; the account's own default applies.
    if (s.fixedModel && !this.modelFits(this.accountOf(s), s.fixedModel)) Object.assign(s, { fixedModel: '', model: '', modelLabel: '', userModel: false });
    return this.applyAccount(s);
  }

  // ---------- providers ----------

  /** The providers' connection, as the main process checked it: the composer, the roster and the tools follow. */
  setProviderStates(states: Record<string, ProviderState>): void {
    this.providerStates = states;
    this.syncProviderLines();
    this.changed();
  }

  setProviderNews(news: Partial<Record<ProviderId, ProviderNews>>): void {
    this.providerNews = news;
    this.changed();
  }

  /** The models each provider offers now (the menu's, without the default), for the news to compare with what was seen. */
  providerOffers(): Partial<Record<ProviderId, { value: string; label: string }[]>> {
    // A provider the user added lists the models they chose: nothing there is news to them.
    const builtin = this.providerBadges().filter((p) => isProviderId(p.id));
    return Object.fromEntries(builtin.map((p) => [p.id, p.models.filter((m) => m.value !== 'default').map((m) => ({ value: m.value, label: m.label }))]));
  }

  /** The master reads which providers are connected and what models each has. */
  private syncProviderLines(): void {
    setProviderLines(
      this.providerBadges().map((p) => ({
        id: p.id,
        label: p.label,
        connected: p.connected,
        models: p.id === 'anthropic' ? this.opts.cfg.workerModels : p.models.map((m) => m.value).filter((m) => m !== 'default'),
      })),
    );
  }

  /** The built-in providers, then the ones the user added (by their id, under the name they gave). */
  private providerBadges(): ProviderBadge[] {
    const defs = [...PROVIDER_DEFS.map((d) => ({ id: d.id as string, label: d.label })), ...this.opts.cfg.accounts.filter(isCustomAccount).map((a) => ({ id: a.slug, label: a.name }))];
    return defs.map((def) => {
      const r = resolveProvider(this.providerStates, def.id);
      const account = 'account' in r ? r.account : '';
      const models = account ? (isBuiltinAccount(account) ? this.modelOptions() : this.optionsOf(this.catalogOf(account))) : [];
      const plan = def.id === 'anthropic' && account ? this.planOf(account) : undefined;
      const news = account && isProviderId(def.id) ? (this.providerNews[def.id] ?? NO_NEWS) : NO_NEWS;
      return { id: def.id, label: def.label, connected: account !== '', accountId: account, models, news, ...(plan !== undefined ? { plan, ultracodeAccess: this.ultracodeAccessOf(account) } : {}) };
    });
  }

  /** One choice of the composer: a provider and a model of it, applied together. */
  setProviderModel(id: string, provider: string, model: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    const r = resolveProvider(this.providerStates, provider);
    if ('error' in r) return this.notice(s, t('provider.notConnected', { name: provider }), 'error');
    if (r.account === (s.runAccount || this.accountOf(s))) return this.setModel(id, model);
    // Another provider: the model goes first (the move keeps it if the new account has it), then the session moves.
    Object.assign(s, { fixedModel: model, model, userModel: true });
    this.setAccount(id, r.account);
  }

  /** The user picked a provider for a session (composer): it moves to the account behind it. */
  setProvider(id: string, provider: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    const r = resolveProvider(this.providerStates, provider);
    if ('error' in r) return this.notice(s, t('provider.notConnected', { name: provider }), 'error');
    this.setAccount(id, r.account);
  }

  /** A provider as the master writes it ("deepseek"): the account it runs on, else an error that says what to do. */
  private providerRef(ref: string): string {
    const r = resolveProvider(this.providerStates, ref);
    if ('account' in r) return r.account;
    const list = this.providerBadges().map((p) => `${p.id}${p.connected ? '' : ` (${t('provider.off')})`}`).join(', ');
    throw new Error(t(r.error === 'unknown' ? 'provider.unknown' : 'provider.notConnected', { name: ref, list }));
  }

  /** The plan of each Claude account ("own", an account id) as its program told it: Ultracode is offered by it. */
  setPlans(plans: Record<string, string>, claudeVersion: string): void {
    this.plans = new Map(Object.entries(plans));
    this.claudeVersion = claudeVersion;
    this.changed();
  }

  private planOf(account: string): string {
    return this.plans.get(this.canon(account)) ?? '';
  }

  /**
   * What an account allows of Ultracode: a Claude Code sign-in by its plan; an API key has no plan to read (shown, off);
   * another server, Codex and Gemini do not have it.
   */
  private ultracodeAccessOf(account: string): UltracodeAccess {
    const kind = this.kindOf(this.canon(account));
    if (kind === 'anthropic-key') return 'unknown';
    return kind === 'default' || kind === 'claude' ? ultracodeAccess(this.planOf(account), this.claudeVersion) : 'hidden';
  }

  /** The settings changed an account, a default or a post: each running session goes where it now belongs. */
  accountsChanged(): void {
    const { cfg } = this.opts;
    for (const s of this.sessions.values()) {
      if (s.accountId && !isBuiltinAccount(s.accountId) && !cfg.accounts.some((a) => a.id === s.accountId)) Object.assign(s, { accountId: '', userAccount: false });
      if (s.query) this.applyAccount(s);
    }
    this.changed();
  }

  /** The account a session runs on: its own pick, else its post's (or the master's setting), else the workers'. */
  private accountOf(s: Session, pick = s.accountId): string {
    const { cfg } = this.opts;
    return s.role === 'master'
      ? firstAccount(cfg.accounts, pick, cfg.masterAccount)
      : firstAccount(cfg.accounts, pick, this.postOf(s)?.account, cfg.workerAccount);
  }

  /** The account's sessions run one model of its own (an OpenAI account's, or a named one of an Anthropic-compatible server). */
  private pinned(account: string): boolean {
    const a = this.opts.cfg.accounts.find((x) => x.id === account);
    // An OpenAI account whose models are known lets each session pick its own.
    return !!a && pinsModel(a) && !(a.kind === 'openai' && (this.catalogs.get(account)?.length ?? 0) > 0);
  }

  private kindOf(account: string): AccountKind | 'default' {
    return this.opts.cfg.accounts.find((a) => a.id === account)?.kind ?? 'default';
  }

  /** The adapter of the program a session runs on (or will, once launched). */
  private adapterOf(s: Session) {
    return adapterFor(harnessOf(this.kindOf(s.runAccount || this.accountOf(s))));
  }

  /** A failed start that means the program is not there: for Claude, no executable was found either. */
  private missingProgram(s: Session, failure: string): boolean {
    const adapter = this.adapterOf(s);
    return adapter.isMissingProgram(failure) || !this.executableOf(adapter.harness);
  }

  /** The account behind a name: "default" is whichever Anthropic account is active ("own" when it is the user's own). */
  private canon(account: string): string {
    return canonAccount(account, this.opts.cfg.anthropicActive);
  }

  private accountName(account: string): string {
    const id = this.canon(account);
    return this.opts.cfg.accounts.find((a) => a.id === id)?.name ?? t(id === OWN_ACCOUNT && this.opts.cfg.accounts.some((a) => a.kind === 'claude') ? 'account.own' : 'account.default');
  }

  private accountBadges(): AccountBadge[] {
    const claudeAccounts = this.opts.cfg.accounts.some((a) => a.kind === 'claude');
    return [{ id: DEFAULT_ACCOUNT, name: this.accountName(DEFAULT_ACCOUNT), kind: 'default' as const, provider: 'anthropic' as const, pinned: false, limitedUntil: this.limitedSeconds(DEFAULT_ACCOUNT) }, ...(claudeAccounts ? [{ id: OWN_ACCOUNT, name: t('account.own'), kind: 'default' as const, provider: 'anthropic' as const, pinned: false, limitedUntil: this.limitedSeconds(OWN_ACCOUNT) }] : []), ...this.opts.cfg.accounts.map((a) => ({ id: a.id, name: a.name, kind: a.kind, provider: providerOfAccount(a) ?? ('' as const), pinned: this.pinned(a.id), limitedUntil: this.limitedSeconds(a.id) }))];
  }

  /** An account as the master writes it (a name, an id, "default"), else an error naming the accounts there are. */
  private accountRef(ref: string): string {
    const found = findAccount(this.opts.cfg.accounts, ref);
    if (!found) throw new Error(t('account.notFound', { name: ref, list: this.accountBadges().map((a) => a.name).join(', ') }));
    return typeof found === 'string' ? found : found.id;
  }

  private applyAccount(s: Session): string {
    const want = this.accountOf(s);
    const name = this.accountName(want);
    if (!s.query || s.runAccount === want) {
      s.switchPending = false;
      this.changed();
      return t(s.query ? 'account.already' : 'account.next', { name: s.name, account: name });
    }
    if (!this.settled(s)) {
      // Said once per switch: the settings call this again at each save.
      if (!s.switchPending || s.pendingTo !== want) this.notice(s, t('notice.accountAfterTurn', { account: name }), 'info');
      s.switchPending = true;
      s.pendingTo = want;
      this.changed();
      return t('account.afterTurn', { name: s.name, account: name });
    }
    this.relaunch(s);
    return t('account.now', { name: s.name, account: name });
  }

  /** A new process on the same conversation. Unlike stop(), its worktree stays as it is: the work goes on. */
  private relaunch(s: Session, note?: Parameters<typeof t>[0]): void {
    const q = s.query;
    s.inbox?.close();
    this.teardown(s);
    q?.close();
    this.notice(s, note ? t(note) : t('notice.accountSwitched', { account: this.accountName(this.accountOf(s)) }), 'info');
    void this.launch(s, s.started);
    this.changed();
  }

  /** The turn that held a switch is over (with its background tasks): the session restarts on its new account. */
  private switchIfDone(s: Session, q: AgentProcess): void {
    if (s.query !== q || !(s.switchPending || s.ultracodePending)) return;
    if (!this.settled(s) || Date.now() - s.activeAt < SILENCE_MS) {
      setTimeout(() => this.switchIfDone(s, q), SILENCE_MS);
      return;
    }
    if (s.runAccount !== this.accountOf(s)) this.relaunch(s);
    else if (s.ultracodePending && s.ultracode && !s.runUltracode) this.relaunch(s, 'notice.ultracodeRestarted');
    s.switchPending = false;
    s.ultracodePending = false;
    this.changed();
  }

  // ---------- fallback ----------

  private limitedSeconds(account: string): number | null {
    const at = this.cooldowns.limitedUntil(this.canon(account), Date.now());
    return at ? Math.ceil(at / 1000) : null;
  }

  /** An account the chain may send a session to: it exists, its program is there, and a paid one has the user's word. */
  private usableFallback(account: string): boolean {
    const { cfg } = this.opts;
    if (!isBuiltinAccount(account) && !cfg.accounts.some((a) => a.id === account)) return false;
    const paid = isBuiltinAccount(account) ? cfg.provider === 'api-key' : isPaid(this.kindOf(account));
    if (paid && !cfg.fallback.paidOk.includes(account)) return false;
    return !!this.executableOf(harnessOf(this.kindOf(account)));
  }

  private nextStep(from: string): FallbackStep | null {
    const { fallback } = this.opts.cfg;
    if (!fallback.enabled) return null;
    return pickTarget({ chain: fallback.chain, from, limited: (a) => this.limitedSeconds(a) !== null, usable: (a) => this.usableFallback(a) });
  }

  /** An account reached a limit: it rests until it opens again, and a session of it goes on with the chain's next account. */
  private onLimit(s: Session, q: AgentProcess, signal: LimitSignal): void {
    const account = s.runAccount || this.accountOf(s);
    this.cooldowns.set(this.canon(account), signal, Date.now());
    this.save();
    this.changed();
    if (s.fallbackPending || !this.opts.cfg.fallback.enabled) return;
    const step = this.nextStep(account);
    if (!step) {
      this.notice(s, t('notice.fallbackNone', { from: this.accountName(account) }), 'error');
      return;
    }
    s.fallbackPending = { step, signal };
    // Stuck on a request the account refuses: the turn is cut, and the session moves once it ends.
    if (this.settled(s)) void this.runFallback(s, q);
    else q.interrupt().catch(() => undefined);
  }

  private fallbackIfDone(s: Session, q: AgentProcess): void {
    if (s.query !== q || !s.fallbackPending) return;
    if (!this.settled(s)) {
      setTimeout(() => this.fallbackIfDone(s, q), SILENCE_MS);
      return;
    }
    void this.runFallback(s, q);
  }

  /** `git status` and the size of the changes in its folder, for the summary; empty when it is no repository. */
  private gitState(cwd: string): Promise<string> {
    const run = (args: string[]) => new Promise<string>((resolve) => execFile('git', args, { cwd, timeout: 5000, windowsHide: true, maxBuffer: 1 << 20 }, (err, out) => resolve(err ? '' : out)));
    return Promise.all([run(['status', '--short']), run(['diff', '--stat'])]).then(([status, stat]) => [status.trim(), stat.trim()].filter(Boolean).join('\n'));
  }

  private async handoffNote(s: Session, kind: 'away' | 'back', from: string, to: string, reason: 'rate' | 'quota' | 'auth' | 'ready'): Promise<string> {
    const items = [...s.items.values()];
    const opens = this.cooldowns.limitedUntil(this.canon(from), Date.now());
    return buildHandoff({
      lang: lang(),
      kind,
      fromName: this.accountName(from),
      toName: this.accountName(to),
      reason,
      opensAt: kind === 'away' ? opens : null,
      mission: s.mission,
      items: kind === 'back' ? items.slice(s.fallbackMark) : items,
      git: await this.gitState(s.cwd),
      now: Date.now(),
    });
  }

  /** The session leaves the account that is limited, for the step's: a new conversation there, with a summary. */
  private async runFallback(s: Session, q: AgentProcess): Promise<void> {
    const pending = s.fallbackPending;
    if (!pending || s.query !== q) return;
    s.fallbackPending = null;
    const from = s.runAccount || this.accountOf(s);
    // The target may have been limited itself while the turn ended.
    const step = this.limitedSeconds(pending.step.account) === null ? pending.step : this.nextStep(from);
    if (!step) return this.notice(s, t('notice.fallbackNone', { from: this.accountName(from) }), 'error');
    const reason = pending.signal.kind === 'overloaded' ? 'rate' : pending.signal.kind;
    const note = await this.handoffNote(s, 'away', from, step.account, reason);
    if (s.query !== q) return; // Closed while the summary was written.
    this.moveAway(s, step, reason, { text: note, images: [], from: 'hub', shown: t('fallback.shown', { from: this.accountName(from), to: this.accountName(step.account) }) });
  }

  /** A new process on another account, in a new conversation (away) or the old one (back). */
  private switchProcess(s: Session, to: string, conversation: string | null, prompt?: Prompt): void {
    const q = s.query;
    const from = s.runAccount || this.accountOf(s);
    if (s.started) s.convs[from] = s.sessionId;
    s.inbox?.close();
    if (q) this.teardown(s);
    q?.close();
    s.accountId = to;
    s.sessionId = conversation ?? randomUUID();
    s.started = conversation !== null;
    this.changed();
    void this.launch(s, conversation !== null, prompt);
  }

  private moveAway(s: Session, step: FallbackStep, reason: string, prompt: Prompt): void {
    const from = s.runAccount || this.accountOf(s);
    if (s.home === null) Object.assign(s, { home: s.accountId, fallbackAt: Date.now(), fallbackMark: s.items.size });
    s.fallbackModel = step.model;
    const opens = this.cooldowns.limitedUntil(this.canon(from), Date.now());
    const when = opens ? ` ${t('fallback.until', { time: new Date(opens).toLocaleTimeString(lang(), { hour: '2-digit', minute: '2-digit' }) })}` : '';
    this.notice(s, t('notice.fallbackAway', { from: this.accountName(from), to: this.accountName(step.account), when }), 'info');
    if (s.role === 'worker') this.notifyMaster(t('hub.fallback', { name: displayName(s), from: this.accountName(from), to: this.accountName(step.account) }), t('hub.fallback.note', { reason }), s);
    // The account it was asked for is kept in `home`; while away, the step's account is the pick.
    this.switchProcess(s, step.account, null, prompt);
  }

  /** On its own account again: its old conversation, and what happened meanwhile. */
  private async goHome(s: Session, prompt?: Prompt): Promise<void> {
    if (s.home === null) return;
    const home = s.home;
    const target = this.accountOf(s, home);
    const current = s.runAccount || this.accountOf(s);
    const note = await this.handoffNote(s, 'back', current, target, 'ready');
    const conversation = s.convs[target] ?? null;
    Object.assign(s, { home: null, fallbackAt: 0, fallbackModel: '', fallbackPending: null });
    this.notice(s, t('notice.fallbackBack', { to: this.accountName(target) }), 'info');
    if (s.role === 'worker') this.notifyMaster(t('hub.fallbackBack', { name: displayName(s), to: this.accountName(target) }), t('hub.fallbackBack.note'), s);
    if (prompt) prompt = { ...prompt, text: `${note}\n\n${prompt.text}` };
    else s.backNote = note;
    // The pick it had before it left (maybe empty: its post's or the usual one) applies again.
    this.switchProcess(s, home, conversation, prompt);
  }

  /** Whether a message goes through the fallback first: back home, or away from an account limited right now. */
  private fallbackRoute(s: Session, prompt: Prompt): boolean {
    const { cfg } = this.opts;
    if (s.home !== null && !s.fallbackPending) {
      const homeAccount = this.accountOf(s, s.home);
      const due = returnDue({ back: cfg.fallback.back, homeLimited: this.limitedSeconds(homeAccount) !== null, settled: !s.query || this.settled(s), message: true });
      if (due === 'now') {
        void this.goHome(s, prompt);
        return true;
      }
    }
    if (!s.inbox && cfg.fallback.enabled) {
      const account = this.accountOf(s);
      if (this.limitedSeconds(account) !== null) {
        const step = this.nextStep(account);
        // Away, and the chain now leads home: that is a return, not a second departure.
        if (step && s.home !== null && step.account === this.accountOf(s, s.home)) {
          void this.goHome(s, prompt);
          return true;
        }
        if (step) {
          void this.handoffNote(s, 'away', account, step.account, this.cooldowns.kindOf(this.canon(account)) === 'quota' ? 'quota' : 'rate').then((note) => {
            this.moveAway(s, step, 'rate', { ...prompt, text: `${note}\n\n${prompt.text}` });
          });
          return true;
        }
      }
    }
    return false;
  }

  /** `idle` policy: a session away, with nothing to do, goes home as soon as its account is open. */
  private returnIdle(): void {
    const { cfg } = this.opts;
    if (cfg.fallback.back !== 'idle') return;
    for (const s of this.sessions.values()) {
      if (s.home === null || s.fallbackPending || !s.query) continue;
      const due = returnDue({ back: 'idle', homeLimited: this.limitedSeconds(this.accountOf(s, s.home)) !== null, settled: this.settled(s), message: false });
      if (due === 'now') void this.goHome(s);
    }
  }

  // ---------- slash commands (composer) ----------

  /** Claude Code's commands and skills for a session's composer; one that has not run yet gets those of the last that did. */
  commands(id: string): CliCommand[] {
    const s = this.sessions.get(id);
    const list = s?.commands.length ? s.commands : this.lastCommands;
    return list.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint, aliases: c.aliases ?? [] })).filter(visibleCli);
  }

  /** /compact: Claude Code summarizes the conversation so far; the conversation shows it compacting, then what is left. */
  compact(id: string, instructions: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    if (!s.started) return this.notice(s, t('notice.nothingToCompact'), 'info');
    this.send(id, `/compact ${instructions}`.trim());
  }

  /**
   * The user deleted one of the master's topics and its history: the items filed only under it leave the conversation
   * shown (and stay out at the next start), those of other topics too just leave it, an approval still waiting stays.
   * The master's own conversation (Claude Code's transcript) is untouched.
   */
  deleteTopic(topic: string): void {
    const master = this.sessions.get(MASTER_ID);
    if (!master || !this.topics.has(topic)) return;
    const ids = [...master.items.values()].filter((i) => i.topic === topic || i.also?.includes(topic)).map((i) => i.id);
    this.topics.remove(topic, ids);
    for (const id of ids) {
      const item = master.items.get(id) as ChatItem;
      const kept = this.kept(item);
      if (kept) master.items.set(id, kept);
      else master.items.delete(id);
    }
    for (const id of ids) this.pendingItems.get(MASTER_ID)?.delete(id);
    this.emit('items', MASTER_ID, [...master.items.values()], true);
    this.changed();
  }

  /** Where a worker works: the main folder of its repo (a worktree counts as its origin repo), or null. Cached a few seconds. */
  private repoCache = new Map<string, { at: number; main: string | null }>();
  private repoOfWorker(name: string): string | null {
    const cwd = [...this.sessions.values()].find((x) => x.name === name)?.cwd;
    return cwd ? this.repoOfDir(cwd) : null;
  }

  private repoOfDir(cwd: string): string | null {
    const hit = this.repoCache.get(cwd);
    if (hit && Date.now() - hit.at < 10_000) return hit.main;
    const main = repoOf(cwd)?.main ?? null;
    this.repoCache.set(cwd, { at: Date.now(), main });
    return main;
  }

  /** Remembers the repo of each topic from its workers (the last one's), so it stays once they are closed. */
  private fileTopicsByRepo(): void {
    let changed = false;
    for (const topic of this.topics.list()) {
      if (this.topics.setRepo(topic.id, resolveTopicRepo(topic.workers, (w) => this.repoOfWorker(w), topic.repo))) changed = true;
    }
    if (changed) this.changed();
  }

  /** The user dragged a topic to a group (a repo's main folder, "" for General); undefined: back to its own repo. */
  moveTopic(id: string, group: string | undefined): void {
    const topic = this.topics.get(id);
    if (topic && this.topics.setMoved(id, group === (topic.repo ?? '') ? undefined : group)) this.changed();
  }

  /** An item of the master without the topics the user deleted; null when it was only theirs (a waiting approval stays). */
  private kept(item: ChatItem): ChatItem | null {
    if (!this.topics.wasRemoved(item.id)) return item;
    const topics = this.topics.without(item.id, [item.topic, ...(item.also ?? [])].filter((x): x is string => !!x));
    if (topics.length === 0 && !(item.kind === 'permission' && item.state === 'pending')) return null;
    const bare = { ...item };
    delete bare.topic;
    delete bare.also;
    return withTopics(bare, topics);
  }

  /**
   * /clear: the session goes on in a new, empty conversation (the last one stays in Claude Code's history). A post's
   * handoff note goes with the first message of the new one, as after any renewal. Its worktree, if any, stays.
   */
  clear(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    if (this.ended(s)) return this.refuse(id, '/clear', t('refuse.ended'));
    if (s.query && this.isWorking(s)) return this.notice(s, t('notice.clearBusy'), 'info');
    const running = !!s.inbox;
    if (running) {
      const q = s.query;
      s.noteFresh = false; // Not the renewal teardown() would announce: this one is said below.
      s.inbox?.close();
      this.teardown(s);
      q?.close();
    }
    Object.assign(s, { sessionId: randomUUID(), started: false, historyLoad: null, lastMessage: '', noteFresh: false, handoffDone: false, error: '' });
    if (s.metrics) s.metrics = { ...s.metrics, contextTokens: 0, contextPct: 0 };
    s.items.clear();
    if (s.id === MASTER_ID) this.topics.reset();
    this.pendingItems.delete(s.id);
    this.emit('items', s.id, [], true);
    this.notice(s, t(s.note ? 'notice.clearedNote' : 'notice.cleared'), 'info');
    if (running && !this.orphan(s)) void this.launch(s, false);
    this.changed();
  }

  /** The repo of a session still known, for the turns logged before their repo was kept; null when it is gone. */
  costRepoOf(id: string): string | null {
    const s = this.sessions.get(id);
    return s ? (this.repoOfDir(s.cwd) ?? '') : null;
  }

  /** /cost: what the session spent, its tokens from the turns the log has, said in its conversation. */
  async showCost(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    const { costLog } = this.opts;
    const mine = (await costLog.read(s.createdAt, Date.now() + 1)).filter((r) => r.id === id);
    const used = mine.reduce((sum, r) => addUsage(sum, sumUsage(r.models)), ZERO);
    const lines = [t('notice.cost', { cost: `$${(s.metrics?.costUsd ?? 0).toFixed(2)}` })];
    if (mine.length > 0) {
      lines.push(
        tn('notice.costTokens', mine.length, {
          input: tokens(used.input),
          output: tokens(used.output),
          read: tokens(used.cacheRead),
          write: tokens(used.cacheWrite),
        }),
      );
    }
    if (s.createdAt < costLog.since) lines.push(t('notice.costSince', { date: new Date(costLog.since).toLocaleDateString(lang(), { day: 'numeric', month: 'long' }) }));
    this.notice(s, lines.join(' · '), 'info');
  }

  // ---------- views ----------

  snapshot(): HubSnapshot {
    const { team } = this.opts.cfg;
    const sessions = this.visible()
      .sort((a, b) => (a.role === b.role ? a.createdAt - b.createdAt : a.role === 'master' ? -1 : 1))
      .map((s): SessionView => ({
        id: s.id,
        role: s.role,
        post: s.roleId ? { id: s.roleId, order: team.findIndex((r) => r.id === s.roleId), description: this.roleOf(s)?.description ?? '' } : null,
        instance: s.instanceOf ? { postId: s.instanceOf, post: this.postOf(s)?.name ?? '', topic: this.topicOf(s) } : null,
        ...this.groupBadges(s),
        tree: s.tree ? { branch: s.tree.branch, state: s.tree.state, kept: s.tree.kept, install: s.installing ? 'running' : s.installFailed ? 'failed' : '' } : null,
        name: s.name,
        mission: s.mission,
        cwd: s.cwd,
        model: s.model,
        modelLabel: s.modelLabel,
        effort: s.effort,
        mode: s.mode,
        status: s.status,
        lastMessage: s.lastMessage,
        metrics: s.metrics,
        createdAt: s.createdAt,
        busySince: s.busySince,
        background: s.background,
        idleSince: s.status === 'idle' ? s.idleAt : null,
        agents: s.agents,
        compacting: s.compacting,
        retrying: s.retrying,
        error: s.error,
        account: s.runAccount || this.accountOf(s),
        fallbackFrom: s.home === null ? '' : this.accountOf(s, s.home),
        accountPending: s.switchPending,
        userAccount: s.userAccount,
        ultracode: s.ultracode,
        ultracodeAccess: this.ultracodeAccessOf(s.runAccount || this.accountOf(s)),
      }));
    // The status bar shows the limits of the master's account.
    const shown = this.shownUsageAccount();
    const catalogs: Record<string, ModelOption[]> = {};
    for (const a of this.opts.cfg.accounts) if (this.ownCatalog(a.id)) catalogs[a.id] = this.optionsOf(this.catalogOf(a.id));
    this.fileTopicsByRepo();
    return { sessions, costToday: this.opts.costLog.today(), models: this.modelOptions(), catalogs, usage: this.kindOf(shown) === 'openai' || this.kindOf(shown) === 'anthropic-compatible' ? null : usageState(this.usage.get(shown)), topics: this.topics.list(), accounts: this.accountBadges(), providers: this.providerBadges() };
  }

  allItems(): [string, ChatItem[]][] {
    return this.visible().map((s) => [s.id, [...s.items.values()]]);
  }

  /** Sessions shown and reachable: the master, ad-hoc workers and the permanent workers of enabled posts. */
  private visible(): Session[] {
    return [...this.sessions.values()].filter((s) => !s.roleId || this.roleOf(s)?.enabled);
  }

  private roleOf(s: Session): TeamRole | null {
    return s.roleId ? (this.opts.cfg.team.find((r) => r.id === s.roleId) ?? null) : null;
  }

  /** The post a worker works for: its own (a permanent worker) or the one it is an extra instance of. */
  private postOf(s: Session): TeamRole | null {
    const id = s.roleId ?? s.instanceOf;
    return id ? (this.opts.cfg.team.find((r) => r.id === id) ?? null) : null;
  }

  /** An instance's job: its name without "hub-<post>-". */
  private topicOf(s: Session): string {
    const name = displayName(s);
    const post = this.postOf(s)?.name;
    return post && name.startsWith(`${post}-`) ? name.slice(post.length + 1) : name;
  }

  /** Extra instances of a post, running or not. */
  private instances(postId: string): Session[] {
    return [...this.sessions.values()].filter((s) => s.instanceOf === postId);
  }

  private instancesBusy(postId: string): boolean {
    return this.instances(postId).some((s) => s.inbox && !this.settled(s));
  }

  private running(): Session[] {
    return [...this.sessions.values()].filter((s) => s.role === 'worker' && s.inbox);
  }

  /** The limits of Settings › Team for one more running worker (of `postId`, for an instance): the refusal, or ''. */
  private overCap(postId: string | null): string {
    const { perPost, maxWorkers } = this.opts.cfg.parallel;
    const running = this.running();
    // The post's own worker counts, asleep or not: a message may wake it at any time.
    const instances = postId ? 1 + this.instances(postId).filter((s) => s.inbox).length : undefined;
    const cap = capReached({ maxWorkers, running: running.length, ...(postId ? { perPost, instances } : {}) });
    if (cap === 'workers') return t('cap.workers', { max: maxWorkers, list: running.map((s) => s.name).join(', ') });
    if (cap === 'post') return t('cap.post', { name: this.opts.cfg.team.find((r) => r.id === postId)?.name ?? '', max: perPost });
    return '';
  }

  // ---------- SDK session ----------

  private async launch(s: Session, resume: boolean, firstPrompt?: Prompt): Promise<void> {
    try {
      await this.start(s, resume, firstPrompt);
    } catch (err) {
      // Claude Code could not be started (missing executable, broken install): nothing else would report it.
      if (s.query) return; // Started: consume() reports what happens next.
      this.teardown(s);
      this.failed(s, errorText(err), this.missingProgram(s, errorText(err)), this.adapterOf(s).harness);
      this.changed();
    }
  }

  private async start(s: Session, resume: boolean, firstPrompt?: Prompt): Promise<void> {
    const { cfg } = this.opts;
    // Claimed synchronously: a send() or resume() during the awaits below queues into this inbox instead of launching twice.
    const inbox = new Inbox<AgentInput>();
    s.inbox = inbox;
    s.status = 'starting';
    s.liveId = null;
    this.resetActivity(s); // Tracked per CLI process: the new one reports its own.
    s.activeAt = Date.now();
    s.closeWhenDone = false;
    s.queued = 0;
    this.changed();

    // A close just checked its worktree: the outcome decides whether it can start there again.
    if (s.retiring) await s.retiring;
    if (this.quitting || s.inbox !== inbox) return;
    if (s.tree?.state === 'removed') {
      this.teardown(s);
      this.notice(s, t('notice.ended'), 'info');
      this.changed();
      return;
    }
    if (s.tree?.state === 'kept') Object.assign(s.tree, { state: 'active', kept: [] });

    const account = this.accountOf(s);
    const harness = harnessOf(this.kindOf(account));
    const adapter = adapterFor(harness);
    const executable = this.executableOf(harness);
    // Resume only a conversation still on disk; an unreadable check keeps the id rather than dropping the link to it.
    if (resume && !(await adapter.hasConversation(s.sessionId, s.cwd, { executable, env: this.environment(account) }))) {
      resume = false;
      s.sessionId = randomUUID();
      if (s.id === MASTER_ID) this.topics.reset(); // Its conversation is gone, and its topics with it.
    }
    if (resume) await this.loadHistory(s);
    // Everything of a conversation started now is already in `items`: reading its transcript later would duplicate it.
    else s.historyLoad ??= Promise.resolve();
    if (this.quitting || s.inbox !== inbox) return; // Hub closing, or the session was closed while launching.

    const isMaster = s.role === 'master';
    const post = this.postOf(s);
    // Every launch starts in the configured mode (a composer change lasts as long as the process). None configured:
    // the program picks its own default, which its first event reports.
    const mode = this.modeOf(s);
    s.mode = mode ?? (await adapter.defaultMode(s.cwd));
    if (this.quitting || s.inbox !== inbox) return;
    // The account is fixed for the life of the process: a switch starts another one on the same conversation.
    s.runAccount = account;
    s.usageAccount = this.canon(account);
    s.switchPending = false;
    s.ultracodePending = false;
    // The master's and a post's prompts change between launches (team, post, handoff note): rendered at each launch,
    // never the copy recorded with the conversation. Changes made while they run come with their next message.
    s.seen = isMaster ? rosterKey(cfg) : post ? roleKey(post) : '';
    const base = isMaster
      ? masterPrompt(cfg)
      : workerPrompt(cfg, post ?? undefined, post && s.instanceOf ? this.instanceInfo(s, post) : undefined, groupInfo(cfg, this.groupsLed(s), this.groupOf(s)));
    // A program without Claude Code's SendMessage writes to the others through the hub's tool of the same job.
    const append = harness === 'claude' ? base : base.replace(/SendMessage/g, 'send_message');
    // What the session asked for, if its account has it (a fallback step's own model first).
    const picked = s.home !== null && s.fallbackModel ? s.fallbackModel : this.modelFits(account, s.fixedModel) ? s.fixedModel : '';
    const tools = this.hubTools(s, harness);
    // Ultracode where the program and the plan have it; a choice the plan no longer allows stays asked, but off.
    const ultracode = s.ultracode && harness === 'claude' && this.ultracodeAccessOf(account) === 'allowed';
    s.runUltracode = ultracode;
    s.mcpLease = harness === 'claude' ? null : this.opts.mcpHub.register(tools);

    // Shown (and queued) before the program starts: a start that fails still leaves the message visible.
    if (firstPrompt) this.pushUser(s, this.withNote(s, firstPrompt));
    const q = adapter.start({
      role: s.role,
      name: s.name,
      cwd: s.cwd,
      extraDirs: post && post.folders.length > 1 ? post.folders.slice(1) : [],
      readOnly: s.readOnly,
      // No model/effort = the program resolves them from its settings, exactly like a normal session. On a bridged
      // account the model is the account's (ANTHROPIC_MODEL): a Claude name, or its 1M variant, would mean nothing there.
      model: this.launchModel(account, picked),
      // A worker never inherits the user's own effort from settings.json: unset, it runs at the hub's default.
      effort: s.fixedEffort ?? (isMaster ? null : this.workerEffort()),
      ultracode,
      mode,
      instructions: append,
      stableInstructions: isMaster || !!post,
      tools,
      mcp: s.mcpLease ? { url: s.mcpLease.url, token: s.mcpLease.token } : null,
      executable,
      env: this.environment(account, this.kindOf(account) === 'openai' ? picked : undefined),
      conversation: { id: s.sessionId, resume },
      input: inbox,
      onPermission: (req) => this.askPermission(s, req),
      onElicitation: (req, signal) => this.answerElicitation(s, req, signal),
    });
    s.query = q;
    s.usageSeen = null;
    // A resumed conversation's results carry the totals it saved: its turns count from there. A new one starts at zero.
    s.usageBase = resume ? this.usageTotals(q) : Promise.resolve(null);
    this.changed();
    void this.onReady(s, q);
    s.exit = this.consume(s, q, (f) => adapter.isMissingProgram(f) || !executable, adapter);
    await s.exit;
  }

  private async consume(s: Session, q: AgentProcess, isMissing: (failure: string) => boolean, adapter: ProviderAdapter): Promise<void> {
    let failure = '';
    try {
      for await (const ev of q.events) this.onEvent(s, q, ev);
    } catch (err) {
      failure = errorText(err);
    }
    if (s.query !== q) return; // stop() already tore the session down.
    this.teardown(s);
    if (failure && !this.quitting) this.failed(s, failure, isMissing(failure), adapter.harness);
    this.changed();
  }

  /** A session that stopped on an error: its card and conversation say why; the master hears about a worker. */
  private failed(s: Session, failure: string, noProgram: boolean, harness: HarnessId): void {
    if (this.quitting) return;
    // The program is missing: the fix is in the settings, not in the conversation.
    const noClaude = noProgram && harness === 'claude';
    const noOther = noProgram && harness !== 'claude';
    s.error = noClaude ? t('error.noClaude') : noOther ? t(harness === 'gemini' ? 'error.noGemini' : 'error.noCodex') : humanError(failure);
    this.event(s, 'crashed');
    if (noClaude) this.upsert(s, { kind: 'notice', id: `notice-${randomUUID()}`, text: t('notice.noClaude'), tone: 'error', action: 'accounts-settings' });
    else if (noOther) this.upsert(s, { kind: 'notice', id: `notice-${randomUUID()}`, text: t(harness === 'gemini' ? 'notice.noGemini' : 'notice.noCodex'), tone: 'error', action: 'accounts-settings' });
    else this.notice(s, t('notice.stopped', { error: s.error }), 'error', failure);
    if (s.role === 'worker') this.notifyMaster(t('hub.crashed', { name: displayName(s), error: s.error }), t('hub.crashed.note', { error: oneLine(failure, 400) }), s);
  }

  private teardown(s: Session): void {
    // Its process is gone with the prompts it had not taken: the turn ends there.
    if (s.id === MASTER_ID && s.inbox) this.topics.end(true);
    s.query = null;
    s.inbox = null;
    s.mcpLease?.dispose();
    s.mcpLease = null;
    s.liveId = null;
    s.queued = 0;
    s.runAccount = '';
    s.usageAccount = '';
    s.switchPending = false;
    s.ultracodePending = false;
    // Withdrawn, not refused: nobody answered them.
    for (const finish of [...s.pending.values()]) finish(null);
    s.status = 'exited';
    s.busySince = null;
    s.handoff = false;
    s.noteSending = false;
    this.resetActivity(s);
    if (s.noteFresh && !this.quitting) this.freshStart(s);
  }

  /** Background tasks, subagents, compaction and retries belong to one CLI process. */
  private resetActivity(s: Session): void {
    s.background = [];
    s.agentTasks.clear();
    s.agents = 0;
    s.compacting = false;
    s.retrying = false;
  }

  private event(s: Session, kind: HubEventKind): void {
    if (!this.quitting) this.emit('event', s.id, kind);
  }

  private trackAgent(s: Session, taskId: string, running: boolean): void {
    if (running) s.agentTasks.add(taskId);
    else s.agentTasks.delete(taskId);
    s.agents = s.agentTasks.size;
  }

  /** A subagent ended; its update and its notification both say so, only the first one counts. */
  private endAgent(s: Session, taskId: string, failed: boolean): void {
    if (failed && s.agentTasks.has(taskId)) this.event(s, 'tool_error');
    this.trackAgent(s, taskId, false);
  }

  private onEvent(s: Session, q: AgentProcess, ev: AgentEvent): void {
    s.activeAt = Date.now();
    switch (ev.type) {
      case 'conversation':
        s.started = true;
        // The note is in this conversation now: its later prompts never carry it again.
        if (s.noteSending) Object.assign(s, { noteSentTo: ev.id, noteSending: false });
        // Another conversation in the same process: its totals start again from zero.
        if (s.usageSeen && ev.id !== s.sessionId) Object.assign(s, { usageSeen: null, usageBase: Promise.resolve(null) });
        // Its first reading may predate the id the program gives the conversation: it stays this conversation's.
        if (s.contextBase?.id === s.sessionId) s.contextBase.id = ev.id;
        s.sessionId = ev.id;
        s.mode = ev.mode;
        if (ev.effort) s.effort = ev.effort;
        this.applyModel(s, ev.model);
        break;
      case 'compacted':
        s.compacting = false;
        // What was compacted was work, even when the context is now below its first reading.
        if (s.contextBase) s.contextBase.tokens = 0;
        this.compacted(s, ev.before, ev.after);
        break;
      case 'commands':
        s.commands = this.lastCommands = ev.commands;
        break;
      case 'compacting':
        if (ev.on && !s.compacting) this.event(s, 'compacting');
        s.compacting = ev.on;
        break;
      case 'retry':
        s.retrying = true;
        this.event(s, 'retry');
        break;
      case 'background':
        s.background = ev.tasks;
        if (s.closeWhenDone && s.background.length === 0) setTimeout(() => this.closeIfDone(s, q), SILENCE_MS);
        break;
      case 'agentTask':
        if (ev.state === 'start') this.trackAgent(s, ev.id, true);
        else this.endAgent(s, ev.id, ev.state === 'failed');
        break;
      case 'limit':
        // Refused by a plan limit: the program waits or gives up; either way the session is stuck until the next frame.
        s.retrying = true;
        this.event(s, 'retry');
        this.onLimit(s, q, ev.signal);
        break;
      case 'stream': {
        const before = s.status;
        const retried = s.retrying;
        s.retrying = false; // A frame came through: the retry worked.
        this.markBusy(s);
        if (ev.textStart) {
          s.liveId = `live-${randomUUID()}`;
          s.liveText = '';
        } else if (ev.delta && s.liveId) {
          s.liveText += ev.delta;
          this.upsert(s, { kind: 'assistant', id: s.liveId, text: s.liveText, live: true });
        }
        // Deltas travel on the items channel; the snapshot only needs a refresh when the status flips.
        if (s.status !== before || retried) this.changed();
        return;
      }
      case 'assistant': {
        s.retrying = false;
        this.markBusy(s);
        // A frame carrying an error has the program's own wording as its text ("Invalid API key · Fix external API
        // key"): neither shown nor kept as the last message; the notice below says it for the user.
        const all = ev.blocks.filter((b) => !ev.error || b.type !== 'text');
        const master = s.id === MASTER_ID;
        // The master's topic calls are the hub's filing, not a step worth reading.
        const blocks = master ? all.filter((b) => b.name !== TOPIC_TOOL) : all;
        const hasText = blocks.some((b) => b.type === 'text');
        if (ev.error && s.liveId) {
          this.drop(s, s.liveId);
          s.liveId = null;
        }
        const items = assistantItems(blocks, ev.id, hasText ? (s.liveId ?? undefined) : undefined);
        const filed = master ? this.fileFrame(all, items) : null;
        for (const item of items) this.upsert(s, withTopics(item, filed?.get(item.id)));
        if (hasText) s.liveId = null;
        if (blocks.some((b) => b.type === 'tool_use' && b.name === 'SendMessage' && (b.input as { to?: unknown })?.to === masterName())) {
          s.owesReport = false;
        }
        if (blocks.some((b) => b.type === 'tool_use' && OUTGOING.test(String(b.name)))) this.event(s, 'message_out');
        if (ev.error) this.notice(s, assistantError(ev.error), 'error', ev.error);
        // Claude Code says its limits by the error of a reply; Codex's come as limit events of their own.
        const limit = ev.error && this.adapterOf(s).harness === 'claude' ? claudeLimit(ev.error) : null;
        if (limit) this.onLimit(s, q, limit);
        if (ev.contextTokens > 0) this.setContext(s, ev.contextTokens, s.metrics?.contextSize ?? 0);
        break;
      }
      case 'promptTaken':
        // One of our prompts reached the model: it is no longer waiting in the queue.
        s.queued = Math.max(0, s.queued - 1);
        if (s.id === MASTER_ID) this.topics.taken(ev.text);
        this.markBusy(s);
        break;
      case 'peer': {
        const text = ev.body ?? userTextItem(ev.blocks, '')?.text ?? '';
        const id = `peer-${ev.id ?? randomUUID()}`;
        // A worker writing to the master directly: filed under its topic, part of the turn it starts.
        const topic = s.id === MASTER_ID ? this.topics.shown(id, { worker: workerName(ev.from) || null }, false) : null;
        this.upsert(s, { kind: 'peer', id, from: ev.from, text, ...(topic ? { topic } : {}) });
        this.event(s, 'message_in');
        break;
      }
      case 'toolResults':
        for (const b of ev.blocks) {
          const item = s.items.get(String(b.tool_use_id));
          if (item?.kind !== 'tool') continue;
          const result = resultText(b.content);
          const isError = b.is_error === true;
          this.upsert(s, { ...item, result, isError });
          const outcome = item.name === 'Bash' || item.name === 'PowerShell' ? commandOutcome(item.detail, isError, result) : null;
          if (outcome) this.event(s, outcome);
          else if (isError) this.event(s, 'tool_error');
        }
        break;
      case 'turn': {
        s.liveId = null;
        // A local command (/context, /usage…) is never replayed: the program's own count says what still waits.
        if (ev.queued !== null) s.queued = Math.min(s.queued, ev.queued);
        if (s.id === MASTER_ID) this.topics.end(s.queued === 0);
        s.retrying = false;
        s.compacting = false;
        s.status = s.pending.size > 0 ? 'attention' : 'idle';
        if (s.status === 'idle') {
          s.busySince = null;
          s.idleAt = Date.now();
        }
        // The handoff note, kept for the next conversation. Work that came in while it was written may share its
        // turn: then the result answers that work, and goes where any result goes.
        const handoff = s.handoff && !s.handoffStale;
        s.handoff = false;
        // A turn that ended on an error carries the program's error text, not a note.
        const ok = ev.subtype === 'success' && !ev.isError;
        if (handoff) {
          const note = ok ? ev.result.trim().slice(0, NOTE_MAX) : '';
          if (note) Object.assign(s, { note, noteFresh: true });
          // Not written: the worker keeps its conversation as it is, and a note is asked again at its next sleep after work.
          else this.notice(s, t('notice.noteFailed'), 'info', ok ? '' : ev.subtype === 'success' ? ev.result.trim() : ev.subtype);
        } else if (ev.subtype === 'success') {
          // A turn that ended on an error carries the program's wording as its result: the notice already said it, and
          // the previous turn's text would pass for this one's.
          if (ev.isError) s.lastMessage = '';
          else if (ev.result.trim()) s.lastMessage = ev.result;
          this.event(s, 'turn_done');
        } else {
          this.notice(s, t('notice.interrupted'), 'info');
          this.event(s, 'interrupted');
        }
        const size = Math.max(s.metrics?.contextSize ?? 0, ...ev.contextWindows);
        this.setContext(s, s.metrics?.contextTokens ?? 0, size);
        this.countTurn(s, ev.usage);
        if (s.role === 'worker' && s.owesReport) setTimeout(() => this.chaseSilence(s, q), SILENCE_MS);
        if (s.closeWhenDone) setTimeout(() => this.closeIfDone(s, q), SILENCE_MS);
        if (s.switchPending || s.ultracodePending) setTimeout(() => this.switchIfDone(s, q), SILENCE_MS);
        if (s.fallbackPending) setTimeout(() => this.fallbackIfDone(s, q), SILENCE_MS);
        void this.refreshContext(s, q);
        void this.refreshUsage(s, q);
        break;
      }
      case 'context':
        this.setContext(s, ev.tokens, ev.size);
        break;
      case 'activity':
        break;
    }
    this.changed();
  }

  private hubMode(): Mode | null {
    return this.opts.cfg.permissionMode || null;
  }

  /** A post's own mode (for its worker and its instances), else the hub's. */
  private modeOf(s: Session): Mode | null {
    return this.postOf(s)?.mode || this.hubMode();
  }

  private markBusy(s: Session): void {
    if (s.status === 'attention') return;
    if (s.status !== 'busy') s.busySince = Date.now();
    s.status = 'busy';
  }

  /** Nothing running and nothing on the way: no turn, no background task, no prompt waiting in the queue. */
  private settled(s: Session): boolean {
    return s.status === 'idle' && s.background.length === 0 && s.pending.size === 0 && s.queued === 0;
  }

  private isWorking(s: Session): boolean {
    return s.status === 'busy' || s.status === 'attention' || s.background.length > 0;
  }

  /** The CLI answers `initialize` at spawn, before any turn: the session is usable from then on. */
  private async onReady(s: Session, q: AgentProcess): Promise<void> {
    try {
      const init = await q.ready();
      // A bridged session lists Claude's models mapped onto its account's: only a Claude access names them truly.
      if (init.models.length > 0 && runsClaude(this.kindOf(s.runAccount)) && !this.pinned(s.runAccount)) this.modelInfos = init.models;
      else if (init.models.length > 0 && harnessOf(this.kindOf(s.runAccount)) !== 'claude') this.setCatalog(s.runAccount, init.models);
      if (s.query === q && init.commands.length > 0) s.commands = this.lastCommands = init.commands;
    } catch {
      return; // The session failed to start: consume() reports it.
    }
    if (s.query !== q) return;
    s.error = '';
    if (s.status === 'starting') {
      s.status = 'idle';
      s.idleAt = Date.now();
    }
    await this.refreshContext(s, q);
    void this.refreshUsage(s, q);
    this.changed();
  }

  private async refreshContext(s: Session, q: AgentProcess): Promise<void> {
    try {
      const usage = await q.context();
      this.setContext(s, usage.tokens, usage.size);
      // Before the first turn this is the only source of the inherited model.
      this.applyModel(s, usage.model);
      await this.inheritEffort(s, usage.model);
      this.changed();
    } catch {
      // Session closed meanwhile.
    }
  }

  private setContext(s: Session, tokens: number, size: number): void {
    const metrics: Metrics = s.metrics ?? { contextTokens: 0, contextSize: 0, contextPct: null, costUsd: 0 };
    metrics.contextTokens = tokens;
    metrics.contextSize = size || metrics.contextSize;
    metrics.contextPct = metrics.contextSize ? (tokens / metrics.contextSize) * 100 : null;
    s.metrics = metrics;
    if (tokens > 0 && s.contextBase?.id !== s.sessionId) s.contextBase = { id: s.sessionId, tokens };
  }

  /** The running totals a resumed conversation starts from, read before its first turn ends. */
  private usageTotals(q: AgentProcess): Promise<Totals | 'unknown'> {
    return q.totals().then(
      (totals) => totals,
      () => 'unknown' as const, // API unavailable: the first result only sets the base, later turns count.
    );
  }

  private costRole(s: Session): CostRole {
    return s.role === 'master' ? 'master' : s.roleId ? 'post' : s.instanceOf ? 'instance' : 'worker';
  }

  /** A result's running totals: what the turn spent goes to the cost log and to the session's cost (card, status bar). */
  private countTurn(s: Session, totals: Totals): void {
    const prev = s.usageSeen;
    // A zeroed result (a crash) or one below the last: the next real one carries the totals.
    if (Object.keys(totals.models).length === 0 || (prev && totals.cost + 1e-9 < prev.cost)) return;
    s.usageSeen = totals;
    const at = Date.now();
    const role = this.costRole(s);
    void (prev ? Promise.resolve(prev) : s.usageBase).then((before) => {
      if (before === 'unknown') return;
      const models = turnDelta(before, totals);
      if (!models) return;
      this.opts.costLog.append({ at, id: s.id, name: s.name, role, models, repo: this.repoOfDir(s.cwd) ?? '' });
      if (!s.metrics) return;
      const costBefore = s.metrics.costUsd;
      s.metrics.costUsd += sumUsage(models).cost;
      if (COST_MILESTONES.some((m) => costBefore < m && (s.metrics?.costUsd ?? 0) >= m)) this.event(s, 'cost_milestone');
      this.changed();
    });
  }

  /** After a compaction, the context it left: in the meter at once, and said in the conversation. */
  private compacted(s: Session, before: number, after: number | undefined): void {
    const size = s.metrics?.contextSize ?? 0;
    if (after === undefined || !size) return this.notice(s, t('notice.compacted'), 'info');
    this.setContext(s, after, size);
    this.notice(s, t('notice.compactedTo', { before: tokens(before), after: tokens(after), pct: Math.max(1, Math.round((after / size) * 100)) }), 'info');
  }

  /** The account whose plan limits the status bar shows: the master's. */
  private shownUsageAccount(): string {
    const master = this.sessions.get(MASTER_ID);
    return usageAccount(master?.usageAccount ?? '', master ? this.accountOf(master) : DEFAULT_ACCOUNT, this.opts.cfg.anthropicActive);
  }

  /**
   * Plan limits (5 h / 7 days) of the account a session's process runs on, from the program's own /usage answer. Asked at
   * a start, after each turn, and every few minutes (pollUsage); once per account at a time, at most every 20 s. A failed
   * reading keeps the last good one with its date and says it failed: the status bar then reads "unknown", never zero.
   */
  private async refreshUsage(s: Session, q: AgentProcess, force = false): Promise<void> {
    const account = s.usageAccount || this.canon(s.runAccount || DEFAULT_ACCOUNT);
    const kind = this.kindOf(account);
    if (kind === 'openai' || kind === 'anthropic-compatible' || this.usageAsking.has(account)) return;
    if (!force && Date.now() - (this.usageCheckedAt.get(account) ?? 0) < USAGE_MIN_GAP_MS) return;
    this.usageAsking.add(account);
    this.usageCheckedAt.set(account, Date.now());
    try {
      this.usage.set(account, usageRead(await q.rateLimits(), Date.now()));
    } catch {
      // Experimental API unavailable, signed out, offline: the status bar says the figure is unknown.
      this.usage.set(account, usageFailed(this.usage.get(account)));
    } finally {
      this.usageAsking.delete(account);
    }
    this.changed();
  }

  /** Reads the displayed account again through one of its live sessions. */
  private pollUsage(): void {
    if (this.quitting) return;
    const shown = this.shownUsageAccount();
    const s = [...this.sessions.values()].find((x) => x.query && x.status !== 'starting' && x.usageAccount === shown);
    if (s?.query) void this.refreshUsage(s, s.query, true);
  }

  private askPermission(s: Session, req: PermissionRequest): Promise<PermissionAnswer> {
    if (req.signal.aborted) return Promise.resolve({ behavior: 'deny', message: t('perm.cancelled') });
    const item: PermissionItem = {
      kind: 'permission',
      id: `perm-${randomUUID()}`,
      tool: toolLabel(req.tool),
      summary: toolSummary(req.tool, req.input),
      ...toolDetail(req.tool, req.input),
      // A command or an edit stays in view (it is what is being allowed); any other input is raw data.
      showDetail: SHOWN_INPUT.test(req.tool),
      reason: req.reason,
      canAlways: req.canAlways,
      state: 'pending',
    };
    return this.ask(s, item, req.signal).then((d): PermissionAnswer => {
      if (!d) return { behavior: 'deny', message: t('perm.cancelled') };
      if (d.behavior === 'deny') return { behavior: 'deny', message: d.message?.trim() || t('perm.denied') };
      return { behavior: 'allow', always: d.behavior === 'always' };
    });
  }

  /** Shows an approval card and waits for the user's answer; null once the CLI withdraws the request. */
  private ask(s: Session, item: PermissionItem, signal: AbortSignal): Promise<PermissionDecision | null> {
    this.upsert(s, item);
    s.status = 'attention';
    this.emit('attention', s.id);
    this.changed();
    return new Promise((resolve) => {
      const settle = (d: PermissionDecision | null) => {
        if (!s.pending.delete(item.id)) return;
        this.upsert(s, { ...item, state: !d ? 'expired' : d.behavior === 'deny' ? 'denied' : 'allowed' });
        if (s.status === 'attention' && s.pending.size === 0) s.status = 'busy';
        this.changed();
        resolve(d);
      };
      s.pending.set(item.id, settle);
      signal.addEventListener('abort', () => settle(null), { once: true });
    });
  }

  /**
   * MCP confirmations (a database server may ask one before a DROP or a DELETE): in bypass mode nothing waits for a
   * validation, so they are accepted; in any other mode the user answers them like a permission. A form that needs
   * real input, or a browser sign-in, is declined and shown.
   */
  private answerElicitation(s: Session, req: ElicitationRequest, signal: AbortSignal): Promise<ElicitationAnswer> {
    const content = req.mode === 'url' ? null : confirmationAnswers(req.requestedSchema);
    const message = oneLine(req.message, 300);
    if (!content) {
      this.notice(s, t('notice.formDeclined', { server: req.serverName, message }), 'error');
      return Promise.resolve({ action: 'decline' });
    }
    if (s.mode === 'bypassPermissions') {
      this.notice(s, t('notice.confirmAccepted', { server: req.serverName, message }), 'info');
      return Promise.resolve({ action: 'accept', content });
    }
    const item: PermissionItem = {
      kind: 'permission',
      id: `perm-${randomUUID()}`,
      tool: `${req.serverName} · ${t('perm.confirm')}`,
      summary: message,
      detail: '',
      diff: false,
      reason: '',
      canAlways: false,
      state: 'pending',
    };
    return this.ask(s, item, signal).then((d): ElicitationAnswer => (d && d.behavior !== 'deny' ? { action: 'accept', content } : { action: 'decline' }));
  }

  /** Into the running session, or resumes a closed one with its conversation. */
  private deliver(s: Session, prompt: Prompt): void {
    // Away on another account: back on its own as soon as it is open again and the policy says so. Or its account is
    // limited at this very moment: it goes on elsewhere, with a summary.
    if (!prompt.command && !prompt.handoff && this.fallbackRoute(s, prompt)) return;
    if (!prompt.command) this.renewStale(s);
    if (s.backNote && s.inbox) {
      prompt = { ...prompt, text: `${s.backNote}\n\n${prompt.text}` };
      s.backNote = '';
    }
    prompt = this.withNote(s, prompt);
    if (s.inbox) return this.pushUser(s, this.withNews(s, prompt));
    // A worker closed before its CLI took the mission gets it back, ahead of the new message (a post's missions come one by one).
    const lostMission = s.role === 'worker' && !s.roleId && !s.started && s.mission;
    void this.launch(s, s.started, lostMission ? { ...prompt, command: false, text:`${this.missionPrompt(s).text}\n\n${prompt.text}` } : prompt);
  }

  /** The first message of a worker's conversation after a context renewal carries its handoff note. */
  private withNote(s: Session, prompt: Prompt): Prompt {
    if (!s.note || (s.started && !s.noteDue) || prompt.handoff || s.noteSending || s.noteSentTo === s.sessionId) return prompt;
    if (prompt.command) {
      s.noteDue = true;
      return prompt;
    }
    Object.assign(s, { noteSending: true, noteDue: false });
    return { ...prompt, text: `${prompt.text}\n\n${handoffBlock(s.note)}` };
  }

  /**
   * A running master whose team changed, or a permanent worker whose post changed, learns it with its next message.
   * (A launch renders its prompt afresh: start() marks it up to date.)
   */
  private withNews(s: Session, prompt: Prompt): Prompt {
    const { cfg } = this.opts;
    const post = this.postOf(s);
    const key = s.role === 'master' ? rosterKey(cfg) : post ? roleKey(post) : '';
    if (prompt.command || key === s.seen || !s.query) return prompt;
    s.seen = key;
    const news = s.role === 'master' ? rosterBlock(cfg) : post ? postUpdate(post, undefined, !!s.instanceOf) : '';
    return { ...prompt, text: `${prompt.text}\n\n${news}` };
  }

  private pushUser(s: Session, { text, images, from, shown, handoff, topic }: Prompt): void {
    const content =
      images.length === 0
        ? text
        : [
            ...images.map((img) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: img.mediaType, data: img.data } })),
            ...(text ? [{ type: 'text' as const, text }] : []),
          ];
    // Work after the handoff note makes it stale: the conversation goes on, the note waits for the next sleep.
    if (handoff) Object.assign(s, { handoff: true, handoffStale: false, handoffDone: true });
    else Object.assign(s, { noteFresh: false, handoffDone: false, handoffStale: s.handoff });
    const id = `${from ? 'peer' : 'user'}-${randomUUID()}`;
    // In the master's conversation: filed now if its topic is known, part of the turn that takes it.
    const input: TopicInput = { topic: topic ?? null, worker: from && from !== 'hub' ? from : null, user: !from };
    const filed = s.id === MASTER_ID ? this.topics.shown(id, input, true, text) : null;
    const tag = filed ? { topic: filed } : {};
    if (from) {
      this.upsert(s, { kind: 'peer', id, from, text: shown ?? taggedSender(text)?.text ?? visibleText(text), ...tag });
    } else {
      const urls = images.map((img) => `data:${img.mediaType};base64,${img.data}`);
      this.upsert(s, { kind: 'user', id, text: shown ?? text, images: urls, ...tag });
    }
    s.inbox?.push({ content });
    s.queued++;
    s.activeAt = Date.now();
    this.markBusy(s);
    this.event(s, 'message_in');
    this.changed();
  }

  /** Images of a user message kept on disk (decoded bytes), each under a fresh random name. */
  private saveImages(images: ImageInput[]): string[] {
    if (images.length === 0) return [];
    mkdirSync(this.attachDir, { recursive: true });
    return images.map((img) => {
      const path = join(this.attachDir, `capture-${randomUUID()}.${IMAGE_EXT[img.mediaType]}`);
      writeFileSync(path, Buffer.from(img.data, 'base64'));
      return path;
    });
  }

  private pruneAttachments(): void {
    let names: string[];
    try {
      names = readdirSync(this.attachDir);
    } catch {
      return; // No attachments yet.
    }
    for (const name of names) {
      try {
        const path = join(this.attachDir, name);
        if (Date.now() - statSync(path).mtimeMs > ATTACHMENTS_MAX_AGE) unlinkSync(path);
      } catch {
        // In use or not a file: next start.
      }
    }
  }

  /** Once per session: concurrent callers share the same read, and a failed read is retried next time. */
  private loadHistory(s: Session): Promise<void> {
    return (s.historyLoad ??= this.readHistory(s));
  }

  private async readHistory(s: Session): Promise<void> {
    const history = new Map<string, ChatItem>();
    const master = s.id === MASTER_ID;
    // The master's conversation is filed by topic again, from its own calls (shared/topics.ts).
    const steps: ReplayStep[] = [];
    try {
      const account = s.runAccount || this.accountOf(s);
      const harness = harnessOf(this.kindOf(account));
      const ctx = { executable: this.executableOf(harness), env: this.environment(account) };
      const messages = (await this.adapterOf(s).history(s.sessionId, s.cwd, ctx)).slice(-HISTORY_MAX);
      for (const m of messages) {
        const { blocks } = m;
        if (m.role === 'assistant') {
          const items = assistantItems(master ? blocks.filter((b) => b.name !== TOPIC_TOOL) : blocks, m.id);
          for (const item of items) history.set(item.id, item);
          if (master) steps.push(...frameSteps(blocks, items.filter((i) => i.kind !== 'tool')));
        } else {
          for (const b of blocks) {
            if (b.type !== 'tool_result') continue;
            const item = history.get(String(b.tool_use_id));
            if (item?.kind === 'tool') history.set(item.id, { ...item, result: resultText(b.content), isError: b.is_error === true });
          }
          const text = userTextItem(blocks, m.id);
          if (!text) continue;
          history.set(text.id, text);
          if (master) {
            const raw = blocks.map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n');
            steps.push({ kind: 'input', id: text.id, input: replayInput(text.kind, text.kind === 'peer' ? text.from : '', raw) });
          }
        }
      }
    } catch {
      s.historyLoad = null; // Unreadable transcript (locked, missing): the view stays as is until the next try.
      return;
    }
    if (master) {
      for (const [id, topics] of this.topics.replay(steps)) {
        const item = history.get(id);
        // [] : only in topics the user deleted.
        if (item && topics.length === 0) history.delete(id);
        else if (item) history.set(id, withTopics(item, topics));
      }
      this.changed();
    }
    // History goes first; anything sent while it was loading stays after it.
    s.items = new Map([...history, ...s.items]);
    this.emit('items', s.id, [...s.items.values()], true);
  }

  // ---------- chat items ----------

  /** Takes an item out of the conversation (a streamed reply that turned out to be an error's wording). */
  private drop(s: Session, id: string): void {
    if (!s.items.delete(id)) return;
    this.pendingItems.get(s.id)?.delete(id);
    this.emit('items', s.id, [...s.items.values()], true);
  }

  private upsert(s: Session, item: ChatItem): void {
    if (s.id === MASTER_ID) {
      // Part of a topic the user deleted (a reply still streaming, a tool's result): it stays out.
      const kept = this.kept(this.fileItem(s, item));
      if (!kept) return;
      item = kept;
    }
    s.items.set(item.id, item);
    if (s.items.size > ITEMS_MAX) {
      for (const key of [...s.items.keys()].slice(0, ITEMS_TRIM)) s.items.delete(key);
      this.pendingItems.delete(s.id);
      this.emit('items', s.id, [...s.items.values()], true);
      return;
    }
    let batch = this.pendingItems.get(s.id);
    if (!batch) this.pendingItems.set(s.id, (batch = new Map()));
    batch.set(item.id, item);
    this.itemsTimer ??= setTimeout(() => {
      this.itemsTimer = null;
      for (const [sid, b] of this.pendingItems) this.emit('items', sid, [...b.values()], false);
      this.pendingItems.clear();
    }, 40);
  }

  /**
   * An item of the master's conversation with its topic: the one it already had (a streamed reply, a tool's result),
   * else the topic of the reply it belongs to. Messages to the master come filed (pushUser), or wait for their turn.
   */
  private fileItem(s: Session, item: ChatItem): ChatItem {
    if (item.topic) return item;
    const before = s.items.get(item.id);
    if (before) return before.topic ? { ...item, topic: before.topic, ...(before.also ? { also: before.also } : {}) } : item;
    if (item.kind === 'user' || item.kind === 'peer') return item;
    if (item.kind !== 'notice' && item.kind !== 'permission') return withTopics(item, this.topics.reply(item.id, item.kind === 'assistant'));
    const topic = this.topics.note();
    return topic ? { ...item, topic } : item;
  }

  /** Items of the master that a later call filed (the reply named its topic, or fell back on a worker's). */
  private refile(ids: string[], topic: string, also = false): void {
    const master = this.sessions.get(MASTER_ID);
    if (!master) return;
    for (const id of ids) {
      const item = master.items.get(id);
      if (!item) continue;
      if (also && !item.also?.includes(topic)) this.upsert(master, { ...item, also: [...(item.also ?? []), topic] });
      else if (!also && item.topic !== topic) this.upsert(master, { ...item, topic });
    }
    this.changed();
  }

  /** `detail`: the raw message behind it (an error), folded under "Details" in the conversation. */
  private notice(s: Session, text: string, tone: 'info' | 'error', detail = ''): void {
    this.upsert(s, { kind: 'notice', id: `notice-${randomUUID()}`, text, tone, ...(detail ? { detail } : {}) });
    this.changed();
  }

  // ---------- master supervision ----------

  /** Wakes the master with a hub message about a worker it would otherwise wait on forever. */
  /** `shown`: the short line the user reads; `note`: what the model alone needs (visibleText() hides it). */
  private notifyMaster(shown: string, note: string, about?: Session): void {
    const master = this.sessions.get(MASTER_ID);
    if (!master || this.quitting) return;
    const topic = this.workerTopic(about);
    this.deliver(master, {
      text: `${tags().hub} ${shown}\n<hub-note>\n${note}\n</hub-note>${topic ? `\n${topicBlock(topic, 'hub')}` : ''}`,
      images: [],
      from: 'hub',
      ...(topic ? { topic: topic.id } : {}),
    });
  }

  /** The master's topic a worker works on, if it has one. */
  private workerTopic(s: Session | undefined) {
    const id = s ? this.topics.linkOf(s.name) : undefined;
    return id ? this.topics.get(id) : undefined;
  }

  /** A worker the master wrote to ended its turn without answering: the master hears it from the hub. */
  private chaseSilence(s: Session, q: AgentProcess): void {
    if (s.query !== q || !s.owesReport || !this.settled(s)) return;
    if (Date.now() - s.activeAt < SILENCE_MS) {
      setTimeout(() => this.chaseSilence(s, q), SILENCE_MS); // Something moved meanwhile: look again once it is quiet.
      return;
    }
    s.owesReport = false;
    // A random tag the worker's text cannot guess: nothing inside it can pass for the hub's own words.
    const tag = `worker-output-${randomTag()}`;
    const last = s.lastMessage ? inside(s.lastMessage.slice(0, 3000)) : t('hub.noText');
    // Set to work by its lead: the lead hears it, as the master would.
    const lead = this.reportLead(s);
    if (lead) {
      const note = t('hub.silentLead.note', { name: s.name, tag, last });
      this.deliver(lead, { text: `${tags().hub} ${t('hub.silent', { name: s.name })}\n<hub-note>\n${note}\n</hub-note>`, images: [], from: 'hub' });
      return;
    }
    this.notifyMaster(t('hub.silent', { name: displayName(s) }), t('hub.silent.note', { name: s.name, tag, last }), s);
  }

  /** End of the turn (and of its background tasks) of a worker the master closed while it was finishing. */
  private closeIfDone(s: Session, q: AgentProcess): void {
    if (s.query !== q || !s.closeWhenDone || !this.settled(s)) return;
    if (Date.now() - s.activeAt < SILENCE_MS) {
      setTimeout(() => this.closeIfDone(s, q), SILENCE_MS);
      return;
    }
    if (s.roleId) {
      this.sleep(s);
      return;
    }
    this.stop(s.id);
    // A note is only asked of a worker closed for idleness: one the master closes has ended its job.
    this.notice(s, s.handoffDone ? t('notice.closedIdle', { min: IDLE_CLOSE_MIN }) : t('notice.closedByMaster'), 'info');
    this.tellKept(s);
  }

  /**
   * The running sessions that have an MCP server connect to it again, without a restart: how many have it now, how
   * many could not (they get it at their next start). A session that has no such server, or answers too late, is left out.
   */
  async reconnectMcp(name: string): Promise<{ reached: number; missed: number }> {
    const live = [...this.sessions.values()].flatMap((s) => (s.query?.reconnectMcp ? [s.query.reconnectMcp(name)] : []));
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<null>((r) => (timer = setTimeout(() => r(null), 60_000)));
    const ends = await Promise.all(live.map((p) => Promise.race([p.catch(() => false), late])));
    clearTimeout(timer);
    return { reached: ends.filter((e) => e === true).length, missed: ends.filter((e) => e === false).length };
  }

  /** Idle workers are closed, permanent ones sooner: their conversation stays on disk and the next message resumes them. */
  private closeIdle(): void {
    for (const s of this.sessions.values()) {
      if (s.role !== 'worker' || !s.query || !this.settled(s)) continue;
      if (Date.now() - s.activeAt < (s.roleId ? PERMANENT_SLEEP_MIN : IDLE_CLOSE_MIN) * 60_000) continue;
      if (s.roleId) {
        this.sleep(s, PERMANENT_SLEEP_MIN);
        continue;
      }
      if (this.askHandoff(s)) continue;
      this.event(s, 'idle_closed');
      this.stop(s.id);
      this.notice(s, t('notice.closedIdle', { min: IDLE_CLOSE_MIN }), 'info');
      this.tellKept(s);
    }
  }

  // ---------- worktrees ----------

  /**
   * Checks a closed worker's worktree once its install is stopped, and removes it if nothing would be lost; a launch
   * meanwhile keeps it. Resolves to the outcome as the master reads it; the conversation shows it too.
   */
  private retire(s: Session): Promise<string> {
    const tree = s.tree;
    if (!tree || tree.state === 'removed') return Promise.resolve('');
    let skipped = false;
    s.retiring ??= (async () => {
      // Its Claude Code process, then its install, let go of the folder first.
      await Promise.race([s.exit, new Promise((r) => setTimeout(r, 10_000))]);
      await s.installing?.done;
      const r = await retireTree(tree, () => !s.inbox);
      // Started again before git touched anything (a kept worktree always has a reason): it works there.
      skipped = !r.removed && r.why.length === 0;
      if (skipped) return '';
      // Removed while a launch waited: start() sees it, and the worker does not start in a deleted folder.
      const leftover = r.removed && r.why.includes('inUse');
      Object.assign(tree, { state: r.removed ? 'removed' : 'kept', kept: r.removed ? [] : r.why });
      const reasons = r.why.map((w) => t(`tree.why.${w}`)).join(' · ');
      if (this.sessions.get(s.id) === s) {
        this.notice(s, leftover ? t('notice.treeLeftover') : r.removed ? t('notice.treeRemoved') : t('notice.treeKept', { reasons }), 'info');
      }
      this.changed();
      if (leftover) return t('tree.leftover', { name: s.name, path: tree.path });
      return r.removed ? t('tree.removed', { name: s.name }) : t('tree.kept', { name: s.name, path: tree.path, branch: tree.branch, reasons });
    })().finally(() => {
      s.retiring = null;
      // Closed again while that check ran: checked once more.
      if (skipped && !s.inbox && !this.quitting) void this.retire(s);
    });
    return s.retiring;
  }

  /** An instance whose post was switched off or deleted: it does not run without it. */
  private orphan(s: Session): boolean {
    return !!s.instanceOf && !this.postOf(s)?.enabled;
  }

  /** A worktree kept on a close the master did not ask for (idle, end of its turn): the master hears why. */
  private tellKept(s: Session): void {
    void s.retiring?.then((text) => {
      if (s.tree?.state === 'kept' && text) this.notifyMaster(t('hub.treeKept', { name: displayName(s) }), text, s);
    });
  }

  /** Installs a new worktree's dependencies in the background; the worker hears when they are in. */
  private install(s: Session, plan: InstallPlan): void {
    const tree = s.tree;
    if (!tree) return;
    const command = planText(plan);
    const run = { ...runInstall(tree, plan, this.toolEnv()), command };
    s.installing = run;
    s.installFailed = false;
    void run.done.then((r) => {
      if (s.installing !== run) return;
      s.installing = null;
      s.installFailed = !r.ok;
      this.changed();
      if (this.quitting || !s.inbox) return;
      const line = r.ok ? t('install.done', { secs: Math.round(r.ms / 1000) }) : t('install.failed');
      const tag = `install-output-${randomTag()}`;
      const note = r.ok ? t('install.done.note', { command }) : t('install.failed.note', { command, tag, output: inside(r.output.slice(-1500)) });
      // Only while the worker may still need them: an idle one that has reported is not woken for this.
      if (this.isWorking(s) || s.owesReport || s.status === 'starting') {
        this.pushUser(s, { text: `${tags().hub} ${line}\n<hub-note>\n${note}\n</hub-note>`, images: [], from: 'hub' });
      } else this.notice(s, line, r.ok ? 'info' : 'error', r.ok ? '' : r.output);
    });
  }

  /**
   * A settled permanent worker goes to sleep. After real work it first writes its handoff note: the hub
   * asks for it once, closes the worker when the note is in, and its next mission starts in a fresh conversation
   * seeded with the note. False while it writes the note. `idleMin`: it falls asleep for lack of work.
   */
  private sleep(s: Session, idleMin?: number): boolean {
    if (this.askHandoff(s)) return false;
    this.event(s, 'idle_closed');
    this.stop(s.id);
    this.notice(s, idleMin ? t('notice.asleepIdle', { min: idleMin }) : t('notice.asleep'), 'info');
    return true;
  }

  private worked(s: Session): number {
    return workTokens(s.metrics, s.contextBase, s.sessionId);
  }

  /**
   * A permanent worker woken after its prompt cache expired, still in a conversation that grew: it starts afresh, with
   * a note the hub writes from its last note and steps (asking the model would reread the whole conversation).
   */
  private renewStale(s: Session): void {
    if (s.inbox || !s.roleId || !s.started || s.noteFresh) return;
    if (!freshStartDue({ working: false, worked: this.worked(s), idleMs: Date.now() - s.activeAt })) return;
    s.note = staleNote(s.note, [...s.items.values()], lang()).slice(0, NOTE_MAX);
    this.freshStart(s);
  }

  /** A worker closing after real work first writes its handoff note, then closes. True while it writes it. */
  private askHandoff(s: Session): boolean {
    if (!s.query || s.handoffDone) return false;
    // A permanent worker after real work; an ad-hoc one only with a well-filled context: it rarely gets another mission.
    const due = s.roleId ? freshStartDue({ working: !this.settled(s), worked: this.worked(s) }) : needsFreshStart(s.metrics);
    if (!due) return false;
    s.owesReport = false;
    s.closeWhenDone = true;
    this.pushUser(s, { text: handoffRequest(), images: [], from: 'hub', handoff: true });
    return true;
  }

  // ---------- hub tools (in-process MCP server) ----------

  /**
   * Master: workers, posts and repos. Workers: read-only list_workers + list_repos to coordinate, and message_master:
   * a session name is shared by every Claude Code session of the machine (another hub may run a "hub-maitre"), the
   * hub's own channel always reaches this hub's master.
   */
  private hubTools(s: Session, harness: HarnessId = 'claude'): HubTool[] {
    const role = s.role;
    const { cfg } = this.opts;
    const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
    const tool = (name: string, description: string, shape: ZodRawShape, handler: HubTool['handler']): HubTool => ({ name, description, shape, handler });
    const run = async (fn: () => string | Promise<string>) => {
      try {
        return text(await fn());
      } catch (err) {
        return { ...text(errorText(err)), isError: true };
      }
    };
    const byName = z.string().describe(t('tool.byName'));
    const listWorkers = tool('list_workers', t('tool.listWorkers'), {}, () => run(() => this.listWorkers()));
    const listRepos = tool('list_repos', t('tool.listRepos', { roots: cfg.workspaces.join(', ') }), {}, () => run(() => this.listRepos()));
    const listCapabilities = tool('list_capabilities', t('tool.listCapabilities'), {}, () => run(() => this.opts.capabilities()));
    if (role === 'worker') {
      const toMaster = tool('message_master', t('tool.messageMaster'), { message: z.string().describe(t('tool.messageMaster.message')) }, ({ message }) =>
        run(() => this.messageMaster(s, message)),
      );
      // A program without Claude Code's SendMessage gets the hub's own tool for the same job.
      const sendMessage = tool(
        'send_message',
        t('tool.sendMessage'),
        { to: z.string().describe(t('tool.sendMessage.to')), message: z.string().describe(t('tool.sendMessage.message')) },
        ({ to, message }) => run(() => this.sendPeer(s, String(to), String(message))),
      );
      // A group's lead drives its members with the master's tools, limited to them; a member reports to its lead.
      // Given at launch: a change of the groups puts the idle ones to sleep, the next message starts them with it.
      const lead = this.groupsLed(s).length > 0;
      const leadTools = lead
        ? [
            tool('list_workers', t('tool.lead.listWorkers'), {}, () => run(() => this.listWorkers(s))),
            tool(
              'message_worker',
              t('tool.lead.message'),
              {
                name: byName,
                message: z.string().describe(t('tool.message.message')),
                interrupt: z.boolean().nullish().describe(t('tool.message.interrupt')),
              },
              (args) => run(() => this.messageWorker(args, s)),
            ),
            tool('worker_report', t('tool.lead.report'), { name: byName }, ({ name }) => run(() => this.workerReport(name, s))),
          ]
        : [listWorkers];
      const toLead = this.groupOf(s)
        ? [tool('message_lead', t('tool.messageLead'), { message: z.string().describe(t('tool.messageLead.message')) }, ({ message }) => run(() => this.messageLead(s, message)))]
        : [];
      return [...leadTools, listRepos, listCapabilities, toMaster, ...toLead, ...(harness === 'claude' ? [] : [sendMessage])];
    }
    const signalOf = (extra: unknown) => (extra as { signal?: AbortSignal } | undefined)?.signal ?? new AbortController().signal;

    // Models and effort are checked against the settings at each call (they may change while the master runs).
    // nullish: models often send null for an optional field they mean to leave out.
    const model = z.string().nullish().describe(t('tool.model'));
    const effort = z
      .enum(EFFORTS as [Effort, ...Effort[]])
      .nullish()
      .describe(t('tool.effort'));
    const ultracode = z.boolean().nullish().describe(t('tool.ultracode'));
    const account = z.string().nullish().describe(t('tool.account', { list: this.accountBadges().map((a) => a.name).join(', ') }));
    const provider = z.string().nullish().describe(t('tool.provider', { list: this.providerBadges().map((p) => `${p.id}${p.connected ? '' : ` (${t('provider.off')})`}`).join(', ') }));
    const byPost = z.string().describe(t('tool.role.byName'));
    const topicSpec = topicToolSpec();
    const postFields = {
      description: z.string().nullish().describe(t('tool.role.description')),
      instructions: z.string().nullish().describe(t('tool.role.instructions')),
      folders: z.array(z.string()).nullish().describe(t('tool.role.folders')),
      provider: z.string().nullish().describe(t('tool.role.provider', { list: this.providerBadges().map((p) => `${p.id}${p.connected ? '' : ` (${t('provider.off')})`}`).join(', ') })),
      account: z.string().nullish().describe(t('tool.role.account', { list: this.accountBadges().map((a) => a.name).join(', ') })),
      model: z.string().nullish().describe(t('tool.role.model')),
      effort: z
        .enum(['auto', ...EFFORTS] as [string, ...string[]])
        .nullish()
        .describe(t('tool.role.effort')),
      ultracode: z.boolean().nullish().describe(t('tool.role.ultracode')),
      enabled: z.boolean().nullish().describe(t('tool.role.enabled')),
    };
    return [
        tool(
          'spawn_worker',
          t('tool.spawn'),
          {
            name: z.string().describe(t('tool.spawn.name')),
            mission: z.string().describe(t('tool.spawn.mission')),
            cwd: z.string().nullish().describe(t('tool.spawn.cwd', { cwd: masterCwd(cfg) })),
            role: z.string().nullish().describe(t('tool.spawn.role')),
            worktree: z.boolean().nullish().describe(t('tool.spawn.worktree')),
            read_only: z.boolean().nullish().describe(t('tool.spawn.readOnly')),
            model,
            effort,
            ultracode,
            provider,
            account,
          },
          (args, extra) =>
            run(async () => {
              // Asked before queuing: the user's answer may take a while, other spawns go on meanwhile.
              const refused = await this.allowCwd(args, signalOf(extra));
              if (refused) return refused;
              // One at a time: two parallel calls would pick the same names and both pass the limits.
              const job = this.spawnQueue.then(() => this.spawnWorker(args));
              this.spawnQueue = job.catch(() => undefined);
              return job;
            }),
        ),
        tool(
          'message_worker',
          t('tool.message'),
          {
            name: byName,
            message: z.string().describe(t('tool.message.message')),
            interrupt: z.boolean().nullish().describe(t('tool.message.interrupt')),
            model,
            effort,
            ultracode,
            provider,
            account,
          },
          (args) => run(() => this.messageWorker(args)),
        ),
        listWorkers,
        listRepos,
        listCapabilities,
        tool('worker_report', t('tool.report'), { name: byName }, ({ name }) => run(() => this.workerReport(name))),
        tool(
          'close_worker',
          t('tool.close'),
          { name: byName, force: z.boolean().nullish().describe(t('tool.close.force')) },
          ({ name, force }) =>
            run(async () => {
              const s = this.findWorker(name);
              if (!s.query) {
                const tree = s.retiring ? await s.retiring : '';
                return tree || t(s.roleId ? 'close.alreadyAsleep' : this.ended(s) ? 'close.alreadyEnded' : 'close.already', { name: s.name });
              }
              if (this.isWorking(s) && !force) {
                s.closeWhenDone = true;
                const what = s.background.length > 0 ? t('close.tasks', { list: s.background.join(' ; ') }) : t('close.turn');
                return t('close.later', { name: s.name, what });
              }
              if (s.roleId && !force) return t(this.sleep(s) ? 'close.asleep' : 'close.note', { name: s.name });
              this.stop(s.id);
              if (s.roleId) return t('close.asleep', { name: s.name });
              // Its worktree's outcome replaces "restarts with its conversation": a removed one ends the job.
              const tree = s.retiring ? await s.retiring : '';
              return tree || t('close.done', { name: s.name });
            }),
        ),
        tool('list_roles', t('tool.listRoles'), {}, () => run(() => this.listRoles())),
        tool(
          'create_role',
          t('tool.createRole'),
          { name: z.string().describe(t('tool.role.name')), template: z.enum(TEMPLATE_IDS).nullish().describe(t('tool.role.template')), ...postFields },
          (args, extra) => run(() => this.createRole(args, signalOf(extra))),
        ),
        tool(
          'update_role',
          t('tool.updateRole'),
          {
            name: byPost,
            new_name: z.string().nullish().describe(t('tool.role.newName')),
            append_instructions: z.string().nullish().describe(t('tool.role.append')),
            ...postFields,
          },
          (args, extra) => run(() => this.updateRole(args, signalOf(extra))),
        ),
        tool('delete_role', t('tool.deleteRole'), { name: byPost }, ({ name }, extra) => run(() => this.deleteAsked(name, signalOf(extra)))),
        tool('list_groups', t('tool.listGroups'), {}, () => run(() => this.listGroups())),
        tool(
          'create_group',
          t('tool.createGroup'),
          {
            name: z.string().describe(t('tool.group.name')),
            lead: z.string().describe(t('tool.group.lead')),
            members: z.array(z.string()).describe(t('tool.group.members')),
          },
          (args) => run(() => this.groupAsked(null, args)),
        ),
        tool(
          'update_group',
          t('tool.updateGroup'),
          {
            name: z.string().describe(t('tool.group.name')),
            new_name: z.string().nullish().describe(t('tool.group.newName')),
            lead: z.string().nullish().describe(t('tool.group.lead')),
            members: z.array(z.string()).nullish().describe(t('tool.group.members')),
          },
          (args) => run(() => this.groupAsked(this.findGroup(args.name), { name: args.new_name ?? undefined, lead: args.lead, members: args.members })),
        ),
        tool('delete_group', t('tool.deleteGroup'), { name: z.string().describe(t('tool.group.name')) }, ({ name }) =>
          run(() => {
            const g = this.findGroup(name);
            const known = rosterKey(this.opts.cfg);
            this.deleteGroup(g.id);
            this.masterSaw(known);
            return t('group.deleted', { name: g.name });
          }),
        ),
        tool(
          'topic',
          topicSpec.description,
          {
            id: z.string().describe(topicSpec.fields.id),
            title: z.string().nullish().describe(topicSpec.fields.title),
            awaiting_user: z.boolean().nullish().describe(topicSpec.fields.awaiting_user),
            question: z.string().nullish().describe(topicSpec.fields.question),
            workers: z.array(z.string()).nullish().describe(topicSpec.fields.workers),
          },
          (args) => run(() => this.declareTopic(args)),
        ),
    ];
  }

  /**
   * The master names the topic of its reply. The call is filed from the reply itself (fileFrame), as it is again from
   * the transcript at the next start: the tool only checks it and answers.
   */
  private declareTopic(raw: unknown): string {
    const call = parseTopicCall(raw);
    const errors = topicErrors();
    if (!call) throw new Error(errors.id);
    const topic = this.topics.get(call.id);
    if (!topic && !call.title) throw new Error(errors.title);
    const shown = { ...(topic ?? { id: call.id, workers: call.workers, at: 0 }), title: call.title || (topic?.title ?? ''), awaiting: call.awaiting, question: call.question };
    return topicAnswer(shown, !topic || this.topics.createdNow(call.id), this.topics.list().filter((o) => o.id !== call.id));
  }

  /** A frame of the master's reply: its topic calls and the workers it writes to, then the topics of its items. */
  private fileFrame(blocks: Record<string, unknown>[], items: ChatItem[]): Map<string, string[]> {
    const filed = new Map<string, string[]>();
    for (const step of frameSteps(blocks, items.filter((i) => i.kind !== 'tool'))) {
      if (step.kind === 'topic') {
        if (this.topics.declare(step.call)) this.changed();
      } else if (step.kind === 'wrote') {
        // A name another worker already has: the new worker starts as "<name>-2", the other one keeps its topic.
        if (step.spawn && [...this.sessions.values()].some((x) => x.name === step.worker)) this.topics.expect(step.worker);
        else this.topics.wrote(step.worker);
      } else if (step.kind === 'item') {
        filed.set(step.id, step.tool ? this.topics.tool(step.id, step.worker) : this.topics.reply(step.id, step.text));
      }
    }
    return filed;
  }

  /**
   * An ad-hoc worker, or with `role` one more instance of a post (its prompt, folders and model rule). A worker that
   * would write in a checkout another one writes in (or a post holds) gets its own worktree, so does every instance;
   * `read_only` shares the folder with Edit and Write off instead.
   */
  private async spawnWorker(args: {
    name: string;
    mission: string;
    cwd?: string | null;
    role?: string | null;
    worktree?: boolean | null;
    read_only?: boolean | null;
    model?: string | null;
    effort?: Effort | null;
    ultracode?: boolean | null;
    account?: string | null;
    provider?: string | null;
  }): Promise<string> {
    const { cfg } = this.opts;
    const mission = args.mission.trim();
    if (!mission) throw new Error(t('spawn.empty'));
    // A provider is how the master names where a worker runs; an account name still works.
    const accountId = args.provider?.trim() ? this.providerRef(args.provider) : args.account?.trim() ? this.accountRef(args.account) : '';
    const post = args.role?.trim() ? this.findRole(args.role) : null;
    if (post && !post.enabled) throw new Error(t('instance.off', { name: post.name }));
    const folder = post ? post.folders[0] : args.cwd?.trim() || masterCwd(cfg);
    if (isNetworkPath(folder) || !isAbsolute(folder) || !existsSync(folder) || !statSync(folder).isDirectory()) throw new Error(t('spawn.badDir', { cwd: folder }));
    const over = this.overCap(post?.id ?? null);
    if (over) throw new Error(over);
    const choice = this.choose(null, args, post, accountId || firstAccount(cfg.accounts, post?.account, cfg.workerAccount));
    const model = choice.model ?? (post?.model || cfg.worker.model);
    const effort = choice.effort ?? (post?.effort || cfg.worker.effort || null);
    const readOnly = !!args.read_only;
    const where = repoOf(folder);
    const writers = where ? this.writersIn(where.checkout) : [];
    const isolate = !readOnly && (!!post || !!args.worktree || writers.length > 0);
    if (isolate && !where && (post || args.worktree)) throw new Error(t(post ? 'instance.noRepo' : 'spawn.noRepoTree', { name: post?.name ?? '', cwd: folder }));

    const topic = topicOf(args.name, post?.name ?? '');
    let made: NewTree | null = null;
    if (isolate && where) {
      try {
        made = await makeTree(folder, post?.name ?? '', topic);
      } catch (err) {
        throw new Error(t('tree.failed', { error: errorText(err) }));
      }
    }
    const cwd = made?.cwd ?? folder;
    // The limits again, right before the worker exists: a message_worker may have woken one meanwhile.
    const overNow = this.overCap(post?.id ?? null);
    if (overNow) {
      if (made) void retireTree(made.tree, () => true);
      throw new Error(overNow);
    }
    const name = post ? this.uniqueName(`${post.name}-${topic || 'work'}`, 48) : this.uniqueName(args.name);
    const s = this.create(`w-${randomUUID().slice(0, 8)}`, 'worker', name, mission, cwd, model, effort);
    Object.assign(s, { instanceOf: post?.id ?? null, tree: made?.tree ?? null, readOnly, owesReport: true, accountId });
    // Asked by the master or held by the post; refused (and said) where the account's plan does not have it.
    const ultracodeNote = args.ultracode ?? post?.ultracode ? this.startUltracode(s, args.ultracode === true) : '';
    this.topics.alias(spawnedName(args), s.name);
    const plan = s.tree ? installPlan(s.tree) : null;
    // Only where nothing waits for an approval: an install runs the packages' own scripts.
    const byHub = !!plan && this.modeOf(s) === 'bypassPermissions';
    if (plan && byHub) this.install(s, plan);
    void this.launch(s, false, this.missionPrompt(s, made?.stale));

    // Other workers of the same repo, in any of its checkouts: worth naming in the briefs.
    const repoKey = (dir: string) => (repoOf(dir)?.main ?? resolve(dir)).toLowerCase();
    const notes = this.choiceNotes(choice.notes);
    const sameRepo = this.visible()
      .filter((w) => w !== s && w.role === 'worker' && w.inbox && repoKey(w.cwd) === repoKey(folder))
      .map((w) => w.name);
    if (sameRepo.length > 0) notes.push(t(made || readOnly ? 'spawn.sameRepoApart' : 'spawn.sameRepo', { names: sameRepo.join(', ') }));
    // A post that works in this repo, or bears this name, is the one to hand the task to.
    const slug = slugify(args.name, 28);
    const posts = post
      ? []
      : cfg.team.filter((r) => r.enabled && (r.folders.some((f) => repoKey(f) === repoKey(folder)) || r.name === slug)).map(sessionNameOf);
    if (posts.length > 0) notes.push(t('spawn.post', { names: posts.join(', ') }));
    if (!where) notes.push(t('spawn.noRepo', { cwd: folder }));
    const others = post ? this.instances(post.id).filter((w) => w !== s && w.inbox).map((w) => w.name) : [];
    return [
      t('spawn.started', { name: s.name, model: model || t('spawn.usualModel'), effort: effort ?? t('spawn.usualEffort'), cwd }),
      ...(cfg.accounts.length > 0 ? [t('spawn.account', { account: this.accountName(this.accountOf(s)) })] : []),
      ...(post ? [t('instance.started', { post: post.name, main: sessionNameOf(post), others: others.join(', ') || t('report.none') })] : []),
      ...(made ? [t('tree.made', { branch: made.tree.branch, base: made.tree.baseRef || 'HEAD', sha: made.tree.base.slice(0, 8) }), ...(made.stale ? [t('tree.stale')] : [])] : []),
      ...(plan ? [t(byHub ? 'install.byHub' : 'install.byWorker', { command: planText(plan) })] : []),
      ...(readOnly ? [t('spawn.readOnly')] : []),
      ...(ultracodeNote ? [ultracodeNote] : []),
      ...notes,
      t('spawn.howTo', { name: s.name }),
    ].join('\n');
  }

  /** Workers that write in a checkout: posts with a folder in it (asleep or not), running workers working in it. */
  private writersIn(checkout: string): string[] {
    const key = checkout.toLowerCase();
    const inIt = (dir: string) => (repoOf(dir)?.checkout ?? resolve(dir)).toLowerCase() === key;
    return this.visible()
      .filter((w) => w.role === 'worker' && !w.readOnly && (w.roleId ? !!this.roleOf(w)?.folders.some(inIt) : !!w.inbox && inIt(w.cwd)))
      .map((w) => w.name);
  }

  /** What an instance is told of its post's other workers when it starts. */
  private instanceInfo(s: Session, post: TeamRole): InstanceInfo {
    const others = this.instances(post.id).filter((w) => w !== s && w.inbox && !this.ended(w));
    return { name: s.name, main: sessionNameOf(post), others: others.map((w) => w.name), readOnly: s.readOnly };
  }

  private async messageWorker(args: {
    name: string;
    message: string;
    interrupt?: boolean | null;
    model?: string | null;
    effort?: Effort | null;
    ultracode?: boolean | null;
    account?: string | null;
    provider?: string | null;
  }, by?: Session): Promise<string> {
    // From a group's lead: one of its members only, with what the lead may give (no model, account or Ultracode).
    const s = by ? this.memberNamed(by, args.name) : this.findWorker(args.name);
    const message = args.message.trim();
    if (!message) throw new Error(t('message.empty'));
    const accountId = args.provider?.trim() ? this.providerRef(args.provider) : args.account?.trim() ? this.accountRef(args.account) : null;
    if (s.retiring) await s.retiring;
    if (this.ended(s)) throw new Error(t('instance.ended', { name: s.name }));
    if (!s.inbox && this.orphan(s)) throw new Error(t('instance.orphan', { name: s.name }));
    if (!s.inbox) {
      const over = this.overCap(s.instanceOf);
      if (over) throw new Error(over);
    }
    const choice = this.choose(s, args, undefined, accountId ?? undefined);
    const wasClosed = !s.inbox;
    const wasWorking = !wasClosed && this.isWorking(s);
    // A permanent worker handed work while it had none starts a new mission: its card and list_workers show it, and
    // the mission's first line gives it its name (it may be a fresh conversation).
    const newMission = !!s.roleId && !wasWorking && !s.owesReport;
    if (newMission) s.mission = message;
    if (choice.model && choice.model !== s.fixedModel) this.setModel(s.id, choice.model, false);
    if (choice.effort && choice.effort !== s.fixedEffort) this.setEffort(s.id, choice.effort, false);
    let ultracodeNote = '';
    if (args.ultracode != null && args.ultracode !== s.ultracode) {
      ultracodeNote = s.userUltracode ? t('ultracode.locked', { name: s.name }) : this.setUltracode(s.id, args.ultracode, false);
    }
    if (args.interrupt && s.query && wasWorking) await s.query.interrupt().catch(() => undefined);
    // Before the message: an idle worker restarts on the new account right away, and the message goes to that process.
    const accountNote =
      accountId === null || accountId === this.accountOf(s)
        ? ''
        : s.userAccount
          ? t('account.locked', { name: s.name, account: this.accountName(this.accountOf(s)) })
          : this.setAccount(s.id, accountId, false);
    s.owesReport = true;
    // Its report goes to whoever wrote last: the lead, or the master (who may reach a member directly).
    s.reportTo = by?.id ?? null;
    s.closeWhenDone = false;
    const head = by ? (newMission ? tags().leadMission(by.name, s.name) : tags().lead(by.name)) : newMission ? tags().mission(s.name) : tags().master;
    this.deliver(s, { text: `${head}\n${message}`, images: [], from: by?.name ?? masterName() });
    const state = wasClosed
      ? t(s.roleId ? 'message.woken' : 'message.wasClosed', { name: s.name })
      : args.interrupt && wasWorking
        ? t('message.interrupted', { name: s.name })
        : t(wasWorking ? 'message.queued' : 'message.delivered', { name: s.name });
    const runs = choice.model || choice.effort ? [t('message.runs', { model: s.modelLabel || s.model || t('spawn.usualModel'), effort: s.effort ?? t('spawn.usualEffort') })] : [];
    return [state, ...runs, ...(ultracodeNote ? [ultracodeNote] : []), ...(accountNote ? [accountNote] : []), ...this.choiceNotes(choice.notes)].join('\n');
  }

  /** A mission, with what the model alone needs of its worktree, its install or the folder it reads. */
  private missionPrompt(s: Session, stale = false): Prompt {
    const tree = s.tree;
    const plan = tree && !s.installing ? installPlan(tree) : null;
    const note = missionNote({
      tree: tree ? { path: tree.path, cwd: s.cwd, branch: tree.branch, baseRef: tree.baseRef, base: tree.base, stale } : undefined,
      install: s.installing ? { by: 'hub', command: s.installing.command } : plan ? { by: 'worker', command: planText(plan) } : undefined,
      sharedWith: s.readOnly ? this.writersIn(repoOf(s.cwd)?.checkout ?? s.cwd).filter((n) => n !== s.name) : undefined,
    });
    return { text: `${tags().mission(s.name)}\n${s.mission}${note ? `\n\n${note}` : ''}`, images: [], from: masterName() };
  }

  /** The model and effort a mission asked by the master runs with (shared/team.ts decides). */
  private choose(s: Session | null, requested: { model?: string | null; effort?: Effort | null }, post = s ? this.postOf(s) : null, account = s ? this.accountOf(s) : DEFAULT_ACCOUNT) {
    const { cfg } = this.opts;
    const { allowed, model } = this.modelsFor(account, requested.model ?? '');
    if (requested.model) requested = { ...requested, model };
    const choice = resolveChoice({
      requested,
      post: post ? { model: post.model, effort: post.effort } : null,
      locked: { model: !!s?.userModel, effort: !!s?.userEffort },
      allowed,
      maxEffort: cfg.workerMaxEffort,
    });
    if ('error' in choice) throw new Error(t('choice.badModel', { model: requested.model ?? '', allowed: allowed.join(', ') }));
    return choice;
  }

  /** The models a worker on this account may run, and the one asked as that list spells it (if it has it). */
  private modelsFor(account: string, asked: string): { allowed: string[]; model: string; listed: boolean } {
    // A Codex account offers the models Codex lists for it; the names the user allows are Claude's.
    const own = this.ownCatalog(account);
    const listed = this.catalogOf(account).map((m) => m.value);
    const wanted = asked.trim();
    const allowed = own ? (listed.length > 0 ? listed : this.kindOf(account) === 'codex' && wanted ? [wanted] : []) : this.opts.cfg.workerModels;
    const lower = wanted.toLowerCase();
    // The master may say "pro" or "flash" for DeepSeek's models.
    const hit = allowed.find((m) => m.toLowerCase() === lower) ?? (own && lower ? allowed.find((m) => m.toLowerCase().endsWith(`-${lower}`)) : undefined);
    return { allowed, model: hit ?? wanted, listed: !!hit };
  }

  private choiceNotes(notes: ChoiceNote[]): string[] {
    return notes.map((n) => t(`choice.${n}`, { max: this.opts.cfg.workerMaxEffort }));
  }

  // ---------- team ----------

  /**
   * Sessions follow the team: one per post, created asleep; a post removed takes its session along. Its name and
   * folders change while it sleeps (saveRole makes sure of it); a disabled post's worker is closed and hidden.
   */
  private syncTeam(): void {
    const { cfg } = this.opts;
    for (const s of [...this.sessions.values()]) {
      // An instance stops with its post (switched off or deleted); its conversation stays readable.
      if (s.instanceOf && s.inbox && !this.postOf(s)?.enabled) this.stop(s.id);
      if (!s.roleId) continue;
      const role = this.roleOf(s);
      if (!role || !role.enabled) {
        if (s.inbox) this.stop(s.id);
        this.shownPosts.delete(s.id);
        if (!role) this.sessions.delete(s.id);
        continue;
      }
      // Hidden while its post was off: its conversation is sent again.
      if (!this.shownPosts.has(s.id)) {
        this.shownPosts.add(s.id);
        this.emit('items', s.id, [...s.items.values()], true);
      }
      if (!s.inbox) {
        s.name = sessionNameOf(role);
        // A conversation belongs to its folder: a new main folder starts a new one (the handoff note goes along).
        if (!samePath(s.cwd, role.folders[0])) Object.assign(s, { cwd: role.folders[0], sessionId: randomUUID(), started: false, historyLoad: null });
      }
    }
    for (const role of cfg.team) {
      if (this.sessions.has(role.id)) continue;
      // A post in auto starts with the usual worker model and effort, until the master picks some.
      const s = this.create(role.id, 'worker', sessionNameOf(role), '', role.folders[0], role.model || cfg.worker.model, role.effort || cfg.worker.effort || null);
      Object.assign(s, { roleId: role.id, status: 'exited', ultracode: role.ultracode });
      if (role.enabled) this.shownPosts.add(s.id);
    }
    this.changed();
  }

  /**
   * Creates (no known id) or replaces a post. The master's tools cannot change a post's permission mode, nor the
   * folders of a post that has a mode of its own (that would carry its permissions elsewhere). A post's name, folders
   * and switching it off apply while its worker sleeps (they are fixed at launch): an idle one is put to sleep, one
   * at work refuses ("working").
   */
  saveRole(raw: unknown, by: 'user' | 'master'): RoleSave {
    const check = this.checkRole(raw, by);
    if ('error' in check) return check;
    const { role, before } = check;
    const s = before ? this.sessions.get(before.id) : undefined;
    if (check.structural && s?.inbox) this.stop(s.id);
    const { cfg } = this.opts;
    cfg.team = before ? cfg.team.map((r) => (r.id === role.id ? role : r)) : [...cfg.team, role];
    const notes = s && before ? this.applyRun(s, before, role, by) : [];
    if (before && before.account !== role.account) {
      // Changed by the user, the post's account replaces one picked by hand on its workers; by the master, all but those.
      for (const w of [s, ...this.instances(role.id)]) if (w && (by === 'user' || !w.userAccount)) Object.assign(w, { accountId: '', userAccount: false });
      this.accountsChanged();
    }
    this.teamChanged();
    return { role, before, notes };
  }

  /** Every check of saveRole, nothing changed: the master's tools ask the user what needs it before saving. */
  private checkRole(raw: unknown, by: 'user' | 'master'): { role: TeamRole; before: TeamRole | null; structural: boolean } | { error: RoleError | 'working' } {
    const { cfg } = this.opts;
    const check = prepareRole(cfg, raw);
    if ('error' in check) return check;
    const role = check.role;
    const before = cfg.team.find((r) => r.id === role.id) ?? null;
    const moved = !!before && before.folders.map((f) => f.toLowerCase()).join('\n') !== role.folders.map((f) => f.toLowerCase()).join('\n');
    if (by === 'master') {
      role.mode = before?.mode ?? '';
      if (moved && before?.mode) return { error: { field: 'folders', problem: 'locked' } };
      // Nor turn such a post back on once the user switched it off.
      if (before?.mode && !before.enabled && role.enabled) return { error: { field: 'enabled', problem: 'locked' } };
    }
    const name = sessionNameOf(role);
    if ([...this.sessions.values()].some((s) => s.name === name && s.roleId !== role.id)) return { error: { field: 'name', problem: 'taken' } };
    const s = before ? this.sessions.get(before.id) : undefined;
    const structural = !!before && (before.name !== role.name || moved || (before.enabled && !role.enabled));
    if (structural && s?.inbox && !this.settled(s)) return { error: 'working' };
    // Switched off, its instances stop too: not in the middle of their work.
    if (before?.enabled && !role.enabled && this.instancesBusy(role.id)) return { error: 'working' };
    return { role, before, structural };
  }

  /**
   * A post's model, effort or mode changed: its worker takes the new value now. Changed by the user (settings), it
   * replaces a value picked by hand before; changed by the master, a value the user picked by hand stays. Back to
   * auto, the worker takes the usual worker values at its next launch, until the master picks some.
   */
  private applyRun(s: Session, before: TeamRole, role: TeamRole, by: 'user' | 'master'): ChoiceNote[] {
    const { cfg } = this.opts;
    const notes: ChoiceNote[] = [];
    if (role.model !== before.model) {
      if (by === 'master' && s.userModel) notes.push('modelLocked');
      else {
        s.userModel = false;
        if (role.model) this.setModel(s.id, role.model, false);
        else s.fixedModel = cfg.worker.model;
      }
    }
    if (role.effort !== before.effort) {
      if (by === 'master' && s.userEffort) notes.push('effortLocked');
      else {
        s.userEffort = false;
        if (role.effort) this.setEffort(s.id, role.effort, false);
        else s.fixedEffort = cfg.worker.effort || null;
      }
    }
    if (role.ultracode !== before.ultracode) {
      if (by === 'master' && s.userUltracode) notes.push('ultracodeLocked');
      else {
        s.userUltracode = false;
        if (s.query) this.setUltracode(s.id, role.ultracode, false);
        else s.ultracode = role.ultracode && this.ultracodeAccessOf(this.accountOf(s)) === 'allowed';
      }
    }
    const mode = role.mode || this.hubMode();
    if (role.mode !== before.mode && s.query && mode) this.setMode(s.id, mode);
    return notes;
  }

  /** False when its worker is in the middle of something. */
  deleteRole(id: string): boolean {
    const { cfg } = this.opts;
    const s = this.sessions.get(id);
    if ((s?.inbox && !this.settled(s)) || this.instancesBusy(id)) return false;
    if (s?.inbox) this.stop(id);
    cfg.team = cfg.team.filter((r) => r.id !== id);
    this.teamChanged();
    this.dropFromGroups(id);
    return true;
  }

  moveRole(id: string, delta: -1 | 1): void {
    const team = [...this.opts.cfg.team];
    const i = team.findIndex((r) => r.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= team.length) return;
    [team[i], team[j]] = [team[j], team[i]];
    this.opts.cfg.team = team;
    this.teamChanged();
  }

  private teamChanged(): void {
    this.opts.persist();
    this.syncTeam();
    this.emit('team', this.opts.cfg.team);
  }

  private findRole(name: string): TeamRole {
    const wanted = slugify(name, 40);
    const role = this.opts.cfg.team.find((r) => r.name === wanted);
    if (!role) throw new Error(t('role.notFound', { name }));
    return role;
  }

  private roleErrorText(error: RoleError | 'working', name: string): string {
    if (error === 'working') return t('role.working', { name });
    return t('role.invalid', { field: error.field, problem: t(`role.problem.${error.problem}`) });
  }

  /** A post as the master reads it: every field, the instructions between tags. */
  private roleText(r: TeamRole): string {
    const s = this.sessions.get(r.id);
    const state = !r.enabled ? t('role.off') : s?.query ? t(`status.${s.status}`) : t('status.asleep');
    return [
      `- ${r.name} (${sessionNameOf(r)}) · ${state}`,
      t('role.line.description', { text: r.description }),
      t('role.line.folders', { list: r.folders.join(', ') }),
      t('role.line.run', { provider: postProvider(this.opts.cfg, r), model: r.model || 'auto', effort: r.effort || 'auto', mode: (r.mode || t('role.hubMode')) + (r.ultracode ? ' · ultracode' : '') }),
      t('role.line.instructions', { text: inside(r.instructions) || t('report.none') }),
    ].join('\n');
  }

  private listRoles(): string {
    const { team } = this.opts.cfg;
    return team.length === 0 ? t('role.none') : team.map((r) => this.roleText(r)).join('\n\n');
  }

  /**
   * The master's fields for a post: "auto" (or empty) leaves the choice to it. A provider (or an account) puts the post
   * on it; a model must be one of the provider the post runs on (the allowed models for Anthropic). A post moved to a
   * provider without the model it had goes back to auto; an effort its model does not take is left out.
   */
  private postValues(
    args: { provider?: string | null; account?: string | null; model?: string | null; effort?: string | null; ultracode?: boolean | null },
    before: Pick<TeamRole, 'account' | 'model'> | null,
  ): Partial<TeamRole> {
    const { cfg } = this.opts;
    const out: Partial<TeamRole> = {};
    const moved = args.provider?.trim() ? this.providerRef(args.provider) : args.account?.trim() ? this.accountRef(args.account) : null;
    if (moved !== null) out.account = moved;
    const account = firstAccount(cfg.accounts, moved ?? before?.account, cfg.workerAccount);
    const asked = args.model?.trim() ?? '';
    if (asked && asked.toLowerCase() !== 'auto') {
      const { allowed, model, listed } = this.modelsFor(account, asked);
      if (!listed) {
        // A model of another connected provider: the master forgot to name it.
        const other = moved === null ? this.providerBadges().find((p) => p.connected && p.models.some((m) => m.value.toLowerCase() === asked.toLowerCase())) : undefined;
        throw new Error(t('choice.badModel', { model: asked, allowed: allowed.join(', ') }) + (other ? ` ${t('role.modelOf', { provider: other.id })}` : ''));
      }
      out.model = model;
    } else if (args.model != null) out.model = '';
    else if (moved !== null && before?.model && !this.modelFits(account, before.model)) out.model = '';
    const model = out.model ?? before?.model ?? '';
    if (args.effort != null) {
      const effort = args.effort === 'auto' ? '' : capEffort(args.effort as Effort, cfg.workerMaxEffort);
      out.effort = effort && model && effortsFor(this.optionsOf(this.catalogOf(account)), model).length === 0 ? '' : effort;
    }
    if (args.ultracode != null) out.ultracode = args.ultracode;
    return out;
  }

  private async createRole(
    args: {
      name: string;
      template?: (typeof TEMPLATE_IDS)[number] | null;
      description?: string | null;
      instructions?: string | null;
      folders?: string[] | null;
      provider?: string | null;
      account?: string | null;
      model?: string | null;
      effort?: string | null;
      ultracode?: boolean | null;
      enabled?: boolean | null;
    },
    signal: AbortSignal,
  ): Promise<string> {
    const known = rosterKey(this.opts.cfg);
    const folders = args.folders ?? [];
    const base = args.template ? fromTemplate(args.template, lang(), folders[0] ?? '') : null;
    const given = Object.fromEntries(
      Object.entries({ description: args.description, instructions: args.instructions, folders: args.folders, enabled: args.enabled }).filter(([, v]) => v != null),
    );
    const raw = { ...base, ...given, ...this.postValues(args, null), id: '', name: args.name, mode: '' };
    const refused = await this.allowFolders(raw, args.name, signal);
    if (refused) return refused;
    const r = this.saveRole(raw, 'master');
    if ('error' in r) throw new Error(this.roleErrorText(r.error, args.name));
    this.masterSaw(known);
    return `${t('role.created', { name: r.role.name, session: sessionNameOf(r.role) })}\n${this.roleText(r.role)}`;
  }

  private async updateRole(
    args: {
      name: string;
      new_name?: string | null;
      description?: string | null;
      instructions?: string | null;
      append_instructions?: string | null;
      folders?: string[] | null;
      provider?: string | null;
      account?: string | null;
      model?: string | null;
      effort?: string | null;
      ultracode?: boolean | null;
      enabled?: boolean | null;
    },
    signal: AbortSignal,
  ): Promise<string> {
    const known = rosterKey(this.opts.cfg);
    const changes = (role: TeamRole): TeamRole => {
      const next: TeamRole = { ...role, ...this.postValues(args, role) };
      if (args.new_name != null) next.name = args.new_name;
      if (args.description != null) next.description = args.description;
      if (args.instructions != null) next.instructions = args.instructions;
      if (args.append_instructions?.trim()) next.instructions = [next.instructions.trim(), args.append_instructions.trim()].filter(Boolean).join('\n');
      if (args.folders != null) next.folders = args.folders;
      if (args.enabled != null) next.enabled = args.enabled;
      return next;
    };
    const asked = this.findRole(args.name);
    const refused = await this.allowFolders(changes(asked), asked.name, signal);
    if (refused) return refused;
    // Applied to the post as it is now: the user may have changed it while the question waited.
    const before = this.opts.cfg.team.find((x) => x.id === asked.id);
    if (!before) throw new Error(t('role.notFound', { name: args.name }));
    const r = this.saveRole(changes(before), 'master');
    if ('error' in r) throw new Error(this.roleErrorText(r.error, before.name));
    this.masterSaw(known);
    const after = r.role;
    const changed = (['name', 'description', 'folders', 'model', 'effort', 'ultracode', 'enabled'] as const)
      .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
      .map((k) => `- ${k}: ${JSON.stringify(before[k])} → ${JSON.stringify(after[k])}`);
    if (before.account !== after.account) changed.unshift(`- provider: ${JSON.stringify(postProvider(this.opts.cfg, before))} → ${JSON.stringify(postProvider(this.opts.cfg, after))}`);
    // The former instructions in full: nothing the master replaces is lost.
    if (before.instructions !== after.instructions) changed.push(t('role.instructionsWere', { text: inside(before.instructions) || t('report.none') }));
    if (changed.length === 0) return t('role.unchanged', { name: after.name });
    return [t('role.updated', { name: after.name }), ...changed, ...this.choiceNotes(r.notes), this.roleText(after)].join('\n');
  }

  /** The user confirms a deletion the master asks for, in the master's conversation, whatever the permission mode. */
  private async deleteAsked(name: string, signal: AbortSignal): Promise<string> {
    const known = rosterKey(this.opts.cfg);
    const role = this.findRole(name);
    const answer = await this.confirm(
      {
        tool: t('ask.delete.tool', { name: role.name }),
        title: t('ask.delete.title', { name: role.name }),
        summary: t('ask.delete.summary'),
        facts: this.postFacts(role),
        allow: t('ask.delete.allow'),
        deny: t('ask.delete.deny'),
      },
      signal,
    );
    if (!answer.ok) return t('role.deleteRefused', { name: role.name, reason: answer.reason ? ` (${answer.reason})` : '' });
    if (!this.deleteRole(role.id)) throw new Error(t('role.working', { name: role.name }));
    this.masterSaw(known);
    return t('role.deleted', { name: role.name });
  }

  /**
   * A post the master wants to work outside the user's working folders and followed repos: the user says yes first
   * (folders the post already had are not asked again). Returns the refusal for the master, else ''. An invalid post
   * is refused before anything is asked.
   */
  private async allowFolders(raw: unknown, name: string, signal: AbortSignal): Promise<string> {
    // Never touched, not even to check it exists: Windows would sign in to that server with the user's account.
    const folders = (raw as { folders?: unknown }).folders;
    if (Array.isArray(folders) && folders.some((f) => typeof f === 'string' && isNetworkPath(f))) {
      throw new Error(this.roleErrorText({ field: 'folders', problem: 'format' }, name));
    }
    const check = this.checkRole(raw, 'master');
    if ('error' in check) throw new Error(this.roleErrorText(check.error, name));
    const { role, before } = check;
    const outside = role.folders.filter((f) => !this.inScope(f) && !before?.folders.some((b) => samePath(b, f)));
    if (outside.length === 0) return '';
    const list = outside.map(shortPath).join(', ');
    const answer = await this.confirm(
      {
        tool: t('ask.folder.tool', { name: role.name }),
        title: t('ask.folder.title', { name: role.name }),
        summary: t('ask.folder.summary', { list }),
        done: list,
        facts: [t('ask.fact.paths', { list: outside.join(' · ') }), ...this.postFacts(role)],
        allow: t('ask.folder.allow'),
        deny: t('ask.folder.deny'),
      },
      signal,
    );
    return answer.ok ? '' : t('role.folderRefused', { name: role.name, reason: answer.reason ? ` (${answer.reason})` : '' });
  }

  /**
   * An ad-hoc worker the master wants to start outside the user's working folders and followed repos: the user says
   * yes first, as for a post. Returns the refusal for the master, else ''.
   */
  private async allowCwd(args: { name: string; mission: string; cwd?: string | null; role?: string | null }, signal: AbortSignal): Promise<string> {
    const folder = args.cwd?.trim();
    if (args.role?.trim() || !folder) return '';
    if (isNetworkPath(folder) || !isAbsolute(folder) || !existsSync(folder) || !statSync(folder).isDirectory()) throw new Error(t('spawn.badDir', { cwd: folder }));
    if (this.inScope(folder)) return '';
    const name = slugify(args.name, 28) || 'worker';
    const answer = await this.confirm(
      {
        tool: t('ask.cwd.tool', { name }),
        title: t('ask.cwd.title', { name }),
        summary: t('ask.cwd.summary', { folder: shortPath(folder) }),
        done: shortPath(folder),
        facts: [t('ask.fact.paths', { list: folder }), t('ask.cwd.mission', { text: oneLine(args.mission, 300) })],
        allow: t('ask.folder.allow'),
        deny: t('ask.folder.deny'),
      },
      signal,
    );
    return answer.ok ? '' : t('spawn.cwdRefused', { name, reason: answer.reason ? ` (${answer.reason})` : '' });
  }

  /** Inside one of the working folders or followed repos: where the user lets the hub's sessions work. */
  private inScope(folder: string): boolean {
    const { cfg } = this.opts;
    // Real paths: a link or junction inside a working folder may lead anywhere.
    const norm = (dir: string) => (process.platform === 'linux' ? realPath(dir) : realPath(dir).toLowerCase());
    const path = norm(folder);
    return [...cfg.workspaces, ...cfg.mainRepos.map((repo) => mainRepoPath(cfg, repo))].some((root) => {
      const r = norm(root);
      return path === r || path.startsWith(r.endsWith(sep) ? r : `${r}${sep}`);
    });
  }

  /**
   * A question the hub puts to the user in the master's conversation, whatever the permission mode: the master cannot
   * answer it. Its own sentence and buttons; the facts fold under "Details".
   */
  private async confirm(
    q: { tool: string; title: string; summary: string; facts: string[]; allow: string; deny: string; done?: string },
    signal: AbortSignal,
  ): Promise<{ ok: boolean; reason: string }> {
    const master = this.sessions.get(MASTER_ID);
    if (!master) throw new Error(t('ask.unanswered'));
    const item: PermissionItem = {
      kind: 'permission',
      id: `perm-${randomUUID()}`,
      tool: q.tool,
      title: q.title,
      allowLabel: q.allow,
      denyLabel: q.deny,
      summary: q.summary,
      detail: q.facts.join('\n'),
      diff: false,
      reason: '',
      canAlways: false,
      state: 'pending',
    };
    const d = await this.ask(master, item, signal);
    // Answered, the question folds to its outcome and its subject ("Denied · Delete a post"), plus what it was about
    // when that still matters (the folders allowed).
    this.upsert(master, { ...item, summary: q.done ?? '', state: !d ? 'expired' : d.behavior === 'deny' ? 'denied' : 'allowed' });
    if (!d) throw new Error(t('ask.unanswered'));
    return { ok: d.behavior !== 'deny', reason: d.message?.trim() ?? '' };
  }

  /** A post as the user reads it in a question: no path, no tag. */
  private postFacts(r: TeamRole): string[] {
    const lines = r.instructions.trim() ? r.instructions.trim().split('\n').length : 0;
    const run =
      r.model || r.effort
        ? t('ask.fact.run', {
            // Claude Code's own name for it once a session reported the models ("Opus 5.5"), else the alias, capitalized.
            model: r.model ? this.labelFor(r.model, r.model).replace(/^\w/, (c) => c.toUpperCase()) : t('ask.fact.byMaster'),
            effort: r.effort ? t(`post.effort.${r.effort}`) : t('ask.fact.byMaster'),
          })
        : t('ask.fact.runAuto');
    return [
      t('ask.fact.description', { text: oneLine(r.description, 200) }),
      t('ask.fact.folders', { list: r.folders.map((f) => basename(f) || f).join(', ') }),
      run,
      lines > 0 ? tn('ask.fact.instructions', lines) : t('ask.fact.noInstructions'),
    ];
  }

  /**
   * A worker writes to this hub's master: delivered as a hub message, the worker's words between random tags inside a
   * note the master reads as data; the bubble shows them as written.
   */
  private messageMaster(s: Session, message: string): string {
    const text = message.trim();
    if (!text) throw new Error(t('message.empty'));
    const master = this.sessions.get(MASTER_ID);
    if (!master) throw new Error(t('master.unreachable'));
    s.owesReport = false;
    const tag = `worker-output-${randomTag()}`;
    const note = t('hub.workerMessage', { tag, text: inside(text.slice(0, 20_000)) });
    const topic = this.workerTopic(s);
    this.deliver(master, {
      text: `${tags().worker(s.name)}\n<hub-note>\n${note}\n</hub-note>${topic ? `\n${topicBlock(topic, 'hub')}` : ''}`,
      images: [],
      from: s.name,
      shown: text,
      ...(topic ? { topic: topic.id } : {}),
    });
    return t('master.delivered');
  }

  /** A worker writes to another session (the master, or a worker) through the hub, as Claude Code's SendMessage does. */
  private sendPeer(from: Session, to: string, message: string): string {
    const text = message.trim();
    if (!text) throw new Error(t('message.empty'));
    const wanted = to.trim().toLowerCase().replace(/\s*\[[0-9a-f]{4,}\]$/i, '');
    if (wanted === masterName().toLowerCase() || wanted === MASTER_ID) return this.messageMaster(from, text);
    const peer = this.findWorker(wanted);
    if (peer === from) throw new Error(t('worker.notFound', { name: to }));
    if (this.ended(peer)) throw new Error(t('instance.ended', { name: peer.name }));
    this.deliver(peer, { text: `${tags().worker(from.name)}\n${text}`, images: [], from: from.name, shown: text });
    return t('message.delivered', { name: peer.name });
  }

  /** The master changed the team itself: it knows, unless the user had changed it too since it last heard. */
  private masterSaw(known: string): void {
    const master = this.sessions.get(MASTER_ID);
    if (master && master.seen === known) master.seen = rosterKey(this.opts.cfg);
  }

  /** Cached 30 s: the scan is synchronous and every worker may call it. */
  private listRepos(): string {
    if (this.reposCache && Date.now() - this.reposCache.at < 30_000) return this.reposCache.text;
    const { cfg } = this.opts;
    const main = new Set(cfg.mainRepos.map((r) => mainRepoPath(cfg, r).toLowerCase()));
    const seen = new Set<string>();
    // Working folders may nest: a repo found under two of them is listed once.
    const repos = cfg.workspaces.flatMap(findRepos).filter((r) => !seen.has(r.path.toLowerCase()) && seen.add(r.path.toLowerCase()));
    const text =
      repos.length === 0
        ? t('repos.none', { roots: cfg.workspaces.join(', ') })
        : repos
            .map((r) => {
              const labels = [main.has(r.path.toLowerCase()) ? t('repos.main') : '', r.worktreeOf ? t('repos.worktreeOf', { path: r.worktreeOf }) : ''].filter(Boolean);
              return `- ${r.name} · ${r.path} · ${r.remote || t('repos.noRemote')} · ${t('repos.branch', { branch: r.branch })}${labels.length ? ` · ${labels.join(' · ')}` : ''}`;
            })
            .join('\n');
    this.reposCache = { at: Date.now(), text };
    return text;
  }

  /** Settings changed (working folders, main repos): the next list_repos scans again. */
  forgetRepos(): void {
    this.reposCache = null;
  }

  private workerLine(s: Session): string {
    const m = s.metrics;
    const ctx = m?.contextPct != null ? `ctx ${Math.round(m.contextPct)}%` : 'ctx —';
    const cost = m ? `$${m.costUsd.toFixed(2)}` : '$—';
    const model = `${s.modelLabel || s.model || t('spawn.usualModel')}/${s.effort ?? t('spawn.usualEffort')}`;
    const mine = [s.userModel ? t('workers.userModel') : '', s.userEffort ? t('workers.userEffort') : ''].filter(Boolean);
    const since = s.busySince && s.status !== 'idle' ? t('workers.since', { n: minutesSince(s.busySince) }) : '';
    const status = s.roleId && s.status === 'exited' && !s.error ? t('status.asleep') : this.ended(s) ? t('status.ended') : t(`status.${s.status}`);
    const account = this.opts.cfg.accounts.length > 0 ? ` · ${t('workers.account', { name: this.accountName(s.runAccount || this.accountOf(s)) })}${s.userAccount ? ` (${t('workers.byUser', { what: t('workers.userAccount') })})` : ''}` : '';
    return `${s.name} · ${status}${since} · ${model}${mine.length ? ` (${t('workers.byUser', { what: mine.join(', ') })})` : ''}${account} · ${ctx} · ${cost} · ${s.cwd}`;
  }

  /** Its worktree as the master reads it: branch, and what was kept at the last close. */
  private treeLine(s: Session): string {
    const tree = s.tree;
    if (!tree) return s.readOnly ? t('workers.readOnly') : '';
    const kept = tree.state === 'kept' ? t('workers.treeKept', { reasons: tree.kept.map((w) => t(`tree.why.${w}`)).join(' · ') }) : '';
    const install = s.installing ? t('workers.installing') : s.installFailed ? t('workers.installFailed') : '';
    return t('workers.tree', { branch: tree.branch, state: t(`tree.state.${tree.state}`) }) + kept + install;
  }

  /** Every worker for the master (and the workers that coordinate); a lead's own tool shows its groups only. */
  private listWorkers(lead?: Session): string {
    const { cfg } = this.opts;
    const all = this.visible().filter((s) => s.role === 'worker');
    const workers = lead ? all.filter((w) => w === lead || leads(cfg.groups, lead, w)) : all;
    const outside = lead ? all.length - workers.length : 0;
    const accounts = lead ? '' : cfg.accounts.length > 0 ? t('workers.accounts', { list: this.accountBadges().map((a) => a.name).join(', '), usual: this.accountName(firstAccount(cfg.accounts, cfg.workerAccount)) }) : '';
    if (workers.length === 0) return [t('workers.none'), accounts].filter(Boolean).join('\n');
    const block = (s: Session) => {
      const post = this.roleOf(s);
      const lines = [`${s.instanceOf ? '  ↳ ' : '- '}${this.workerLine(s)}`];
      if (post) lines.push(t('workers.post', { text: oneLine(post.description, 160), model: post.model || 'auto', effort: post.effort || 'auto' }));
      if (s.instanceOf) lines.push(t('workers.instance', { post: this.postOf(s)?.name ?? '' }));
      const member = this.groupOf(s);
      if (member) lines.push(t('workers.member', { group: member.name, lead: `hub-${refName(cfg.team, member.lead)}` }));
      const led = this.groupsLed(s);
      if (led.length > 0) lines.push(t('workers.leads', { list: led.map((g) => g.name).join(', ') }));
      const tree = this.treeLine(s);
      if (tree) lines.push(tree);
      if (s.mission) lines.push(t('workers.mission', { text: oneLine(s.mission, 160) }));
      if (s.background.length > 0) lines.push(t('workers.background', { text: oneLine(s.background.join(' ; '), 200) }));
      if (s.lastMessage) lines.push(t('workers.last', { text: oneLine(s.lastMessage, 200) }));
      return lines.join('\n');
    };
    const { team } = cfg;
    const order = (s: Session) => team.findIndex((r) => r.id === s.roleId);
    const posts = workers.filter((s) => s.roleId).sort((a, b) => order(a) - order(b));
    // An instance goes under its post; one whose post is gone, with the ad-hoc workers.
    const under = (p: Session) => workers.filter((w) => w.instanceOf === p.roleId);
    const adhoc = workers.filter((s) => !s.roleId && !(s.instanceOf && posts.some((p) => p.roleId === s.instanceOf)));
    return [
      accounts,
      lead ? '' : groupsText(cfg),
      posts.length > 0 ? `${t('workers.team')}\n${posts.flatMap((p) => [p, ...under(p)]).map(block).join('\n')}` : '',
      adhoc.length > 0 ? `${t('workers.adhoc')}\n${adhoc.map(block).join('\n')}` : '',
      outside > 0 ? t('workers.notMine', { n: outside }) : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private async workerReport(name: string, lead?: Session): Promise<string> {
    const s = lead ? this.memberNamed(lead, name) : this.findWorker(name);
    if (!s.inbox && s.started) await this.loadHistory(s);
    const steps = [...s.items.values()]
      .map((i): string | null => {
        switch (i.kind) {
          case 'tool':
            return `· ${i.name} ${oneLine(i.summary, 140)}${i.result === null ? t('report.running') : i.isError ? t('report.error') : ''}`;
          case 'assistant':
            return i.live ? null : `» ${oneLine(i.text, 200)}`;
          case 'peer':
            return `← ${i.from} : ${oneLine(i.text, 160)}`;
          case 'user':
            return t('report.user', { text: oneLine(i.text, 160) });
          case 'permission':
            return i.state === 'pending' ? t('report.awaiting', { tool: i.tool, text: oneLine(i.summary, 120) }) : null;
          case 'notice':
            return `! ${oneLine(i.text, 160)}`;
          default:
            return null;
        }
      })
      .filter((line): line is string => line !== null)
      .slice(-REPORT_ITEMS);
    return [
      this.workerLine(s),
      s.background.length > 0 ? t('report.background', { text: s.background.join(' ; ') }) : '',
      t('report.mission', { text: s.mission }),
      t('report.activity', { text: steps.join('\n') || t('report.nothing') }),
      t('report.last', { text: s.lastMessage || t('report.none') }),
    ]
      .filter(Boolean)
      .join('\n');
  }

  // ---------- groups ----------

  /** The group a worker is a member of. */
  private groupOf(s: Session): TeamGroup | null {
    return s.role === 'worker' ? memberOf(this.opts.cfg.groups, s) : null;
  }

  /** The groups a worker leads. */
  private groupsLed(s: Session): TeamGroup[] {
    return s.role === 'worker' ? ledBy(this.opts.cfg.groups, s) : [];
  }

  /** A group's lead: its post's own worker, or the ad-hoc worker; a disabled post's cannot be reached. */
  private leadOf(g: TeamGroup): Session | undefined {
    return this.visible().find((x) => x.role === 'worker' && (isPostRef(g.lead) ? x.roleId === g.lead : !x.roleId && x.name === g.lead));
  }

  /** The lead a worker's report goes to: the one that wrote to it last, if it still leads its group. */
  private reportLead(s: Session): Session | undefined {
    const lead = s.reportTo ? this.sessions.get(s.reportTo) : undefined;
    return lead && !this.ended(lead) && this.visible().includes(lead) && leads(this.opts.cfg.groups, lead, s) ? lead : undefined;
  }

  /** A member of the groups a lead leads, by its session name. */
  private memberNamed(lead: Session, name: string): Session {
    const s = this.findWorker(name);
    if (!leads(this.opts.cfg.groups, lead, s)) throw new Error(t('group.notMember', { name: s.name }));
    return s;
  }

  /** What the sidebar shows of a worker's groups: the one it is a member of (under its lead), the ones it leads. */
  private groupBadges(s: Session): Pick<SessionView, 'group' | 'leads'> {
    const member = this.groupOf(s);
    const lead = member ? this.leadOf(member) : undefined;
    return { group: member && lead ? { name: member.name, leadId: lead.id } : null, leads: this.groupsLed(s).map((g) => g.name) };
  }

  /**
   * A member writes to its group's lead: delivered as a hub message, the member's words between random tags the
   * lead reads as data. A sleeping lead is woken. It answers the report owed for a turn the lead started.
   */
  private messageLead(s: Session, message: string): string {
    const text = message.trim();
    if (!text) throw new Error(t('message.empty'));
    const group = this.groupOf(s);
    const lead = group ? this.leadOf(group) : undefined;
    if (!group || !lead || this.ended(lead)) throw new Error(t('lead.unreachable'));
    if (s.reportTo === lead.id) s.owesReport = false;
    const tag = `worker-output-${randomTag()}`;
    const note = t('hub.memberMessage', { tag, text: inside(text.slice(0, 20_000)) });
    this.deliver(lead, { text: `${tags().member(s.name, group.name)}\n<hub-note>\n${note}\n</hub-note>`, images: [], from: s.name, shown: text });
    return t('lead.delivered', { name: lead.name });
  }

  /** A post, or an ad-hoc worker, named by the master, as a group holds it: the post's id, or the worker's session name. */
  private groupRef(name: string): string {
    const wanted = name.trim().toLowerCase().replace(/^hub-/, '');
    const post = this.opts.cfg.team.find((r) => r.name === wanted);
    if (post) return post.id;
    const s = this.visible().find((x) => x.role === 'worker' && !x.roleId && !x.instanceOf && x.name === `hub-${wanted}`);
    if (s) return s.name;
    throw new Error(t('group.unknownWorker', { name }));
  }

  /** A live ad-hoc worker by its session name (an instance goes through its post). */
  private adhocNamed(name: string): boolean {
    return [...this.sessions.values()].some((x) => x.role === 'worker' && !x.roleId && !x.instanceOf && x.name === name);
  }

  private findGroup(name: string): TeamGroup {
    const wanted = slugify(name, 40);
    const g = this.opts.cfg.groups.find((x) => x.name === wanted);
    if (!g) throw new Error(t('group.notFound', { name }));
    return g;
  }

  private groupText(g: TeamGroup): string {
    const { team } = this.opts.cfg;
    const name = (ref: string) => `hub-${refName(team, ref)}`;
    return t('group.line', { name: g.name, lead: name(g.lead), members: g.members.map(name).join(', ') });
  }

  private listGroups(): string {
    const { groups } = this.opts.cfg;
    return groups.length === 0 ? t('group.none') : groups.map((g) => this.groupText(g)).join('\n');
  }

  /** The master's create_group (no group yet) and update_group: names become references, the rest is saveGroup's. */
  private groupAsked(before: TeamGroup | null, args: { name?: string | null; lead?: string | null; members?: string[] | null }): string {
    const known = rosterKey(this.opts.cfg);
    const raw = {
      id: before?.id ?? '',
      name: args.name || before?.name || '',
      lead: args.lead ? this.groupRef(args.lead) : (before?.lead ?? ''),
      members: args.members ? args.members.map((m) => this.groupRef(m)) : (before?.members ?? []),
    };
    const r = this.saveGroup(raw);
    if ('error' in r) throw new Error(t('group.invalid', { field: r.error.field, problem: t(`group.problem.${r.error.problem}`) }));
    this.masterSaw(known);
    return `${t(before ? 'group.updated' : 'group.created', { text: this.groupText(r.group) })}\n${t('group.later')}`;
  }

  /** Creates (no known id) or replaces a group, from the settings or the master's tools. */
  saveGroup(raw: unknown): GroupCheck {
    const { cfg } = this.opts;
    const check = prepareGroup(cfg, raw, (ref) => this.adhocNamed(ref));
    if ('error' in check) return check;
    const before = cfg.groups.find((g) => g.id === check.group.id) ?? null;
    cfg.groups = before ? cfg.groups.map((g) => (g.id === check.group.id ? check.group : g)) : [...cfg.groups, check.group];
    this.groupsChanged([before, check.group]);
    return check;
  }

  deleteGroup(id: string): boolean {
    const { cfg } = this.opts;
    const g = cfg.groups.find((x) => x.id === id);
    if (!g) return false;
    cfg.groups = cfg.groups.filter((x) => x.id !== id);
    this.groupsChanged([g]);
    return true;
  }

  /** A post or an ad-hoc worker that is gone leaves its groups (a group without lead or members goes too). */
  private dropFromGroups(ref: string | null): void {
    const { cfg } = this.opts;
    const before = cfg.groups;
    const kept = withoutPosts(before, cfg.team)
      .map((g) => ({ ...g, members: g.members.filter((m) => m !== ref) }))
      .filter((g) => g.lead !== ref && g.members.length > 0);
    if (JSON.stringify(kept) === JSON.stringify(before)) return;
    cfg.groups = kept;
    this.groupsChanged(before.filter((g) => !kept.some((k) => JSON.stringify(k) === JSON.stringify(g))));
  }

  /**
   * A lead's tools and its members' prompts are set at launch: the posts of the groups touched that wait for work go
   * to sleep (the next message starts them with the change); those at work, and ad-hoc workers, get it at their next launch.
   */
  private groupsChanged(touched: (TeamGroup | null)[]): void {
    const refs = new Set(touched.flatMap((g) => (g ? [g.lead, ...g.members] : [])));
    for (const s of this.sessions.values()) {
      // A post's worker only: closing an ad-hoc worker or an instance would retire its worktree.
      if (!s.roleId || !s.inbox || !refsOf(s).some((r) => refs.has(r))) continue;
      if (this.settled(s) && !s.owesReport) this.stop(s.id);
    }
    this.opts.persist();
    this.changed();
    this.emit('team', this.opts.cfg.team);
  }

  /** A worker by its session name, with or without "hub-"; a disabled post's worker cannot be reached. */
  private findWorker(name: string): Session {
    const wanted = name.trim().toLowerCase();
    const s = this.visible().find((x) => x.role === 'worker' && (x.name === wanted || x.name === `hub-${wanted}`));
    if (!s) throw new Error(t('worker.notFound', { name }));
    return s;
  }

  /** "hub-<slug>", numbered when taken; the names of every post are taken, even a disabled one's. */
  private uniqueName(raw: string, max = 28): string {
    const slug = slugify(raw, max) || 'worker';
    const taken = new Set([...[...this.sessions.values()].map((s) => s.name), ...this.opts.cfg.team.map(sessionNameOf)]);
    let name = `hub-${slug}`;
    for (let i = 2; taken.has(name); i++) name = `hub-${slug}-${i}`;
    return name;
  }

  // ---------- models ----------

  private modelOptions(): ModelOption[] {
    return this.optionsOf(this.modelInfos);
  }

  private optionsOf(models: AgentModel[]): ModelOption[] {
    return models.map((m) => ({
      value: m.value,
      label: modelLabel(m.value, m.displayName),
      description: m.description && !this.modelInfos.includes(m) ? m.description : modelHint(m.value, m.displayName),
      efforts: m.efforts,
      ...(m.noEffort ? { noEffort: true } : {}),
    }));
  }

  /** Effort of a worker nobody fixed one for (master, post or user), within the highest one allowed. */
  private workerEffort(): Effort {
    return capEffort(WORKER_EFFORT, this.opts.cfg.workerMaxEffort);
  }

  /** The program an account's sessions run (its path, empty when it was not found). */
  private executableOf(harness: HarnessId): string {
    return harness === 'claude' ? this.opts.executable() : harness === 'codex' ? this.opts.codexExecutable() : this.opts.geminiExecutable();
  }

  /** The account offers models of its own (Codex, Gemini, OpenAI's API, DeepSeek) rather than Claude's. */
  private ownCatalog(account: string): boolean {
    const a = this.opts.cfg.accounts.find((x) => x.id === account);
    return !!a && (a.kind === 'codex' || a.kind === 'gemini' || a.kind === 'gemini-key' || a.kind === 'openai' || providerOfAccount(a) === 'deepseek');
  }

  private catalogOf(account: string): AgentModel[] {
    const a = this.opts.cfg.accounts.find((x) => x.id === account);
    if (a && providerOfAccount(a) === 'deepseek') return DEEPSEEK_MODELS.map((m) => ({ value: m.value, displayName: m.label, description: m.description, efforts: [] }));
    return this.ownCatalog(account) ? (this.catalogs.get(account) ?? []) : this.modelInfos;
  }

  /** What the program is asked for: OpenAI's models go by the environment, DeepSeek's by the names its endpoint maps. */
  private launchModel(account: string, picked: string): string {
    const a = this.opts.cfg.accounts.find((x) => x.id === account);
    if (!a || !picked || a.kind === 'openai') return a?.kind === 'openai' ? '' : picked;
    return providerOfAccount(a) === 'deepseek' ? deepseekAlias(picked) : picked;
  }

  /** A model the program of this account can take (Claude's names are not Codex's): else the account's own choice stands. */
  private modelFits(account: string, model: string): boolean {
    if (!model) return false;
    const kind = this.kindOf(account);
    if (this.pinned(account)) return false;
    if (this.ownCatalog(account)) {
      const catalog = this.catalogOf(account);
      return catalog.length === 0 ? kind === 'codex' && !/^(default|opus|sonnet|haiku|fable|claude-)/i.test(model) : catalog.some((m) => m.value === model);
    }
    return /^(default|best|opusplan|opus|sonnet|haiku|fable|claude-)/i.test(model) || this.modelInfos.some((m) => m.value === model || m.resolvedModel === model);
  }

  /**
   * The CLI does not report an effort it took from settings (system/init leaves it empty), so resolve it with the
   * CLI's own settings cascade: per-model `modelSettings` first, then the global `effortLevel`.
   */
  private async inheritEffort(s: Session, modelId: string): Promise<void> {
    if (s.fixedEffort || s.effortResolved || !modelId) return;
    s.effortResolved = true;
    if (s.role === 'worker') {
      s.effort = this.workerEffort();
      return;
    }
    const effort = await this.adapterOf(s).inheritedEffort(s.cwd, [modelId, s.model]);
    if (s.fixedEffort || effort === undefined) return; // Chosen in the composer meanwhile, or unreadable.
    s.effort = effort;
  }

  /** Display model: the explicit choice, else what settings.json resolved to (as a picker alias when one matches). */
  private applyModel(s: Session, modelId: string): void {
    if (!modelId) return;
    // On a bridged account the model is the account's: shown as it is, the Claude choice kept for the next account.
    if (s.runAccount && this.pinned(s.runAccount)) {
      s.modelLabel = modelId;
      return;
    }
    if (s.runAccount && harnessOf(this.kindOf(s.runAccount)) !== 'claude' && this.ownCatalog(s.runAccount)) {
      s.model = modelId;
      s.modelLabel = this.catalogOf(s.runAccount).find((m) => m.value === modelId)?.displayName ?? modelId;
      return;
    }
    if (s.runAccount && this.ownCatalog(s.runAccount)) {
      // OpenAI's API or DeepSeek: the session's pick if the account has it, else what runs; DeepSeek says only its own name.
      const catalog = this.catalogOf(s.runAccount);
      const picked = catalog.find((m) => m.value === s.fixedModel);
      const deepseek = providerOfAccount(this.opts.cfg.accounts.find((x) => x.id === s.runAccount) ?? { kind: 'claude', baseUrl: '' }) === 'deepseek';
      s.model = picked?.value ?? (deepseek ? '' : modelId);
      s.modelLabel = picked?.displayName ?? (deepseek ? 'DeepSeek' : modelId);
      return;
    }
    const alias = this.modelInfos.find((m) => m.resolvedModel === modelId && m.value !== 'default')?.value;
    s.model = s.fixedModel || alias || modelId;
    s.modelLabel = this.labelFor(s.model, modelId);
  }

  private labelFor(value: string, modelId: string): string {
    const info = this.modelInfos.find((m) => m.value === value) ?? this.modelInfos.find((m) => m.resolvedModel === modelId);
    return info ? modelLabel(info.value, info.displayName) : modelId.replace(/^claude-/, '');
  }

  // ---------- state ----------

  private create(id: string, role: Role, name: string, mission: string, cwd: string, model: string, effort: Effort | null): Session {
    const s: Session = {
      id,
      role,
      name,
      mission,
      cwd,
      model,
      modelLabel: model,
      effort,
      mode: null,
      status: 'starting',
      lastMessage: '',
      metrics: null,
      createdAt: Date.now(),
      busySince: null,
      background: [],
      agents: 0,
      compacting: false,
      retrying: false,
      error: '',
      sessionId: randomUUID(),
      started: false,
      items: new Map(),
      query: null,
      inbox: null,
      pending: new Map(),
      liveId: null,
      liveText: '',
      historyLoad: null,
      queued: 0,
      fixedModel: model,
      fixedEffort: effort,
      effortResolved: false,
      owesReport: false,
      closeWhenDone: false,
      activeAt: Date.now(),
      agentTasks: new Set(),
      idleAt: Date.now(),
      roleId: null,
      note: '',
      noteFresh: false,
      contextBase: null,
      handoff: false,
      handoffStale: false,
      handoffDone: false,
      seen: '',
      userModel: false,
      userEffort: false,
      userUltracode: false,
      ultracode: false,
      runUltracode: false,
      noteSentTo: '',
      noteSending: false,
      noteDue: false,
      instanceOf: null,
      reportTo: null,
      tree: null,
      readOnly: false,
      installing: null,
      installFailed: false,
      retiring: null,
      exit: null,
      usageBase: Promise.resolve(null),
      usageSeen: null,
      commands: [],
      accountId: '',
      runAccount: '',
      usageAccount: '',
      switchPending: false,
      ultracodePending: false,
      pendingTo: '',
      mcpLease: null,
      home: null,
      fallbackAt: 0,
      fallbackMark: 0,
      fallbackModel: '',
      convs: {},
      fallbackPending: null,
      backNote: '',
      userAccount: false,
    };
    this.sessions.set(id, s);
    return s;
  }

  /** Environment of a Claude Code process started by the hub on an account: the hub's own, without a parent session's variables. */
  environment(account = DEFAULT_ACCOUNT, model?: string): Record<string, string> {
    const { set, unset } = this.opts.sessionEnv(account, model);
    return { ...this.toolEnv(unset), ...set };
  }

  /** Environment of the hub's own tools (an install, a sign-in terminal): the same, without the Claude access and GitHub sign-in added. */
  toolEnv(unset = this.opts.sessionEnv(DEFAULT_ACCOUNT).unset): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !PARENT_SESSION_VARS.test(key) && !unset.includes(key)) env[key] = value;
    }
    return env;
  }

  private restore(): void {
    if (!existsSync(this.stateFile)) return;
    try {
      const saved = JSON.parse(readFileSync(this.stateFile, 'utf8')) as { sessions?: Persisted[]; topics?: unknown; cooldowns?: unknown };
      this.cooldowns.restore(saved.cooldowns, Date.now());
      for (const { resume, ...p } of saved.sessions ?? []) {
        // State saved before fixed* existed only holds display values: those sessions inherit from settings.json.
        const s = this.create(p.id, p.role, p.name, p.mission, p.cwd, p.fixedModel ?? '', p.fixedEffort ?? null);
        Object.assign(s, p, { status: 'exited' });
        // The hub removes this worktree and deletes its branch later: only one that it could have made itself.
        if (s.tree && !validTree(s.tree)) s.tree = null;
        // Its note written, the hub closed before the worker did: the next conversation starts afresh all the same.
        if (s.noteFresh) this.freshStart(s);
        // Saved before its first reading was kept: all of its context counts as work.
        if (s.started && !s.contextBase) s.contextBase = { id: s.sessionId, tokens: 0 };
        if (resume && s.role === 'worker') this.resumeOnStart.set(s.id, resume);
      }
      // The topics of the master's conversation, if they are this conversation's.
      this.topics.restore(saved.topics, this.sessions.get(MASTER_ID)?.sessionId ?? '');
    } catch {
      // Unreadable state file: set it aside (never overwrite it) and start with an empty hub.
      renameSync(this.stateFile, `${this.stateFile}.corrupt`);
      this.sessions.clear();
    }
  }

  private changed(): void {
    this.emitTimer ??= setTimeout(() => {
      this.emitTimer = null;
      this.emit('changed');
    }, 80);
    this.saveTimer ??= setTimeout(() => {
      this.saveTimer = null;
      // killAll() saved which sessions were working; the teardowns that follow must not overwrite it.
      if (!this.quitting) this.save();
    }, 1000);
  }

  private save(): void {
    const sessions: Persisted[] = [...this.sessions.values()].map((s) => ({
      id: s.id,
      role: s.role,
      name: s.name,
      mission: s.mission,
      cwd: s.cwd,
      model: s.model,
      modelLabel: s.modelLabel,
      effort: s.effort,
      lastMessage: s.lastMessage,
      metrics: s.metrics,
      createdAt: s.createdAt,
      sessionId: s.sessionId,
      started: s.started,
      fixedModel: s.fixedModel,
      fixedEffort: s.fixedEffort,
      roleId: s.roleId,
      note: s.note,
      noteFresh: s.noteFresh,
      contextBase: s.contextBase,
      activeAt: s.activeAt,
      noteSentTo: s.noteSentTo,
      userModel: s.userModel,
      userEffort: s.userEffort,
      userUltracode: s.userUltracode,
      ultracode: s.ultracode,
      instanceOf: s.instanceOf,
      tree: s.tree,
      readOnly: s.readOnly,
      accountId: s.accountId,
      userAccount: s.userAccount,
      home: s.home,
      fallbackAt: s.fallbackAt,
      fallbackMark: s.fallbackMark,
      fallbackModel: s.fallbackModel,
      convs: s.convs,
      reportTo: s.reportTo,
      // Read at close time: a worker cut mid-work (or before its CLI took the mission) is picked up at the next start.
      // A post woken without a mission has none to get back.
      ...(s.inbox && !s.started && (!s.roleId || s.owesReport) ? { resume: 'mission' as const } : s.inbox && this.isWorking(s) ? { resume: 'work' as const } : {}),
    }));
    // Write-then-rename: a crash mid-save can never leave a truncated state.json behind.
    const tmp = `${this.stateFile}.tmp`;
    const master = this.sessions.get(MASTER_ID);
    const topics = master ? this.topics.state(master.sessionId) : undefined;
    writeFileSync(tmp, JSON.stringify({ sessions, topics, cooldowns: this.cooldowns.state() }, null, 2));
    renameSync(tmp, this.stateFile);
  }
}
