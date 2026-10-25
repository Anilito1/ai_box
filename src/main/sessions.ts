import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import {
  createSdkMcpServer,
  getSessionInfo,
  getSessionMessages,
  query,
  resolveSettings,
  tool,
  type ElicitationRequest,
  type ElicitationResult,
  type ModelInfo,
  type Options,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { capReached, isSafeBranch, topicOf, type KeepReason } from '../shared/parallel';
import {
  capEffort,
  fromTemplate,
  needsFreshStart,
  resolveChoice,
  roleKey,
  sessionNameOf,
  slugify,
  TEMPLATE_IDS,
  type ChoiceNote,
  type RoleError,
} from '../shared/team';
import {
  EFFORTS,
  type ChatItem,
  type Effort,
  type HubEventKind,
  type HubSnapshot,
  type ImageInput,
  type Metrics,
  type Mode,
  type ModelOption,
  type PermissionDecision,
  type RateLimits,
  type Role,
  type SessionView,
  type TeamRole,
} from '../shared/types';
import { mainRepoPath, masterCwd, prepareRole, type HubConfig } from './config';
import { assistantError, humanError } from './errors';
import { lang, t, tn } from './i18n';
import {
  defaultMasterName,
  handoffBlock,
  handoffRequest,
  IDLE_CLOSE_MIN,
  inside,
  masterName,
  masterPrompt,
  missionNote,
  PERMANENT_SLEEP_MIN,
  postUpdate,
  rosterBlock,
  rosterKey,
  setMasterName,
  tags,
  workerPrompt,
  type InstanceInfo,
} from './prompts';
import { findRepos, repoOf } from './repos';
import {
  assistantItems,
  blocksOf,
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
import { installPlan, makeTree, planText, retireTree, runInstall, type InstallPlan, type NewTree, type WorkTree } from './worktrees';

/** Push-based prompt stream: keeps a query in streaming-input mode so it can receive messages and controls. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private waiting: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(msg: SDKUserMessage): void {
    if (this.waiting) {
      this.waiting({ value: msg, done: false });
      this.waiting = null;
    } else {
      this.queue.push(msg);
    }
  }

  close(): void {
    this.closed = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = null;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const msg = this.queue.shift();
        if (msg) return Promise.resolve({ value: msg, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiting = resolve));
      },
    };
  }
}

interface Session extends Omit<SessionView, 'idleSince' | 'post' | 'instance' | 'tree'> {
  sessionId: string;
  /** True once the conversation exists on disk, i.e. it can be resumed. */
  started: boolean;
  costBase: number;
  items: Map<string, ChatItem>;
  query: Query | null;
  inbox: Inbox | null;
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
  /** The conversation that got the handoff note with its first message: each new one gets it once. */
  noteSentTo: string;
  /** The note is on its way with a first message: until the conversation exists, it is not added again. */
  noteSending: boolean;
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
  | 'noteSentTo'
  | 'userModel'
  | 'userEffort'
  | 'instanceOf'
  | 'tree'
  | 'readOnly'
>;

export interface ManagerOptions {
  /** Live settings: changes made in the settings screen apply at the next launch of each session. */
  cfg: HubConfig;
  dataDir: string;
  /** Claude Code executable to run; empty = the SDK's default. */
  executable(): string;
  /** Variables added to (set) or removed from (unset) the environment of every session: Claude access, GitHub. */
  sessionEnv(): { set: Record<string, string>; unset: string[] };
  /** Writes the settings: the master's tools change the team. */
  persist(): void;
}

/** `notes`: the master's changes that a choice the user made by hand kept from applying. */
export type RoleSave = { role: TeamRole; before: TeamRole | null; notes: ChoiceNote[] } | { error: RoleError | 'working' };

type PermissionItem = Extract<ChatItem, { kind: 'permission' }>;

const MASTER_ID = 'master';
const HUB_TOOLS = [
  'message_master',
  'spawn_worker',
  'message_worker',
  'list_workers',
  'list_repos',
  'worker_report',
  'close_worker',
  'list_roles',
  'create_role',
  'update_role',
  'delete_role',
];
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
const samePath = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();

export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, Session>();
  private modelInfos: ModelInfo[] = [];
  private rateLimits: RateLimits | null = null;
  private usageCheckedAt = 0;
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

  constructor(private readonly opts: ManagerOptions) {
    super();
    this.stateFile = join(opts.dataDir, 'state.json');
    this.attachDir = join(opts.dataDir, 'attachments');
    this.restore();
    this.syncTeam();
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
    this.sweepTimer = setInterval(() => this.closeIdle(), 60_000);
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
    this.emit('items', s.id, [], true);
    if (running) void this.launch(s, false);
    this.changed();
  }

  /** A message the main process could not accept: kept visible in the conversation so its text is not lost. */
  refuse(id: string, text: string, reason: string): void {
    const s = this.sessions.get(id);
    if (s) this.notice(s, t('notice.refused', { reason, text: text.trim() ? ` : « ${oneLine(text, 300)} »` : '' }), 'error');
  }

  /** A message typed by the user in a session's composer. */
  send(id: string, text: string, images: ImageInput[] = []): void {
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
    const textForModel = [shown, ...paths.map(capturedLine)].filter(Boolean).join('\n');
    // The user took the worker over: its turn no longer answers the master, and it stays open.
    s.owesReport = false;
    s.closeWhenDone = false;
    this.deliver(s, { text: textForModel, images, shown });
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

  /** A permanent worker that wrote its handoff note: its next launch is a new conversation, seeded with the note. */
  private freshStart(s: Session): void {
    Object.assign(s, { sessionId: randomUUID(), started: false, historyLoad: null, noteFresh: false });
    if (s.metrics) s.metrics = { ...s.metrics, contextTokens: 0, contextPct: 0 };
    this.notice(s, t('notice.freshStart'), 'info');
  }

  resume(id: string): void {
    const s = this.sessions.get(id);
    if (s && !s.inbox && !this.ended(s) && !this.orphan(s)) void this.launch(s, s.started);
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

  /** Sessions whose work a close would cut: a turn in progress, or background tasks left running after one. */
  busySessions(): number {
    return [...this.sessions.values()].filter((s) => s.query && this.isWorking(s)).length;
  }

  // ---------- live controls (composer) ----------

  /** `byUser`: picked by hand in the composer, so the master's later choices leave it alone. */
  setModel(id: string, model: string, byUser = true): void {
    const s = this.sessions.get(id);
    if (!s) return;
    if (byUser) s.userModel = true;
    s.fixedModel = model;
    s.model = model;
    s.modelLabel = this.labelFor(model, model);
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
    s.query?.applyFlagSettings({ effortLevel: effort }).catch((err: unknown) => this.notice(s, t('notice.effortRefused'), 'error', errorText(err)));
    this.changed();
  }

  setMode(id: string, mode: Mode): void {
    const s = this.sessions.get(id);
    if (!s) return;
    // Claude Code holds a cross-session message whose sender runs in another permission class (bypass vs prompting).
    const bypasses = (m: Mode | null) => m === 'bypassPermissions';
    if (bypasses(mode) !== bypasses(this.hubMode())) this.notice(s, t('notice.modeMismatch'), 'info');
    s.mode = mode;
    s.query?.setPermissionMode(mode).catch((err: unknown) => this.notice(s, t('notice.modeRefused'), 'error', errorText(err)));
    this.changed();
  }

  decide(id: string, requestId: string, decision: PermissionDecision): void {
    this.sessions.get(id)?.pending.get(requestId)?.(decision);
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
      }));
    return { sessions, models: this.modelOptions(), rateLimits: this.rateLimits };
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
      this.failed(s, errorText(err));
      this.changed();
    }
  }

  private async start(s: Session, resume: boolean, firstPrompt?: Prompt): Promise<void> {
    const { cfg } = this.opts;
    // Claimed synchronously: a send() or resume() during the awaits below queues into this inbox instead of launching twice.
    const inbox = new Inbox();
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

    // Resume only a conversation still on disk; an unreadable check keeps the id rather than dropping the link to it.
    if (resume && !(await getSessionInfo(s.sessionId, { dir: s.cwd }).then(Boolean, () => true))) {
      resume = false;
      s.sessionId = randomUUID();
    }
    if (resume) await this.loadHistory(s);
    // Everything of a conversation started now is already in `items`: reading its transcript later would duplicate it.
    else s.historyLoad ??= Promise.resolve();
    if (this.quitting || s.inbox !== inbox) return; // Hub closing, or the session was closed while launching.

    const isMaster = s.role === 'master';
    const post = this.postOf(s);
    // Every launch starts in the configured mode (a composer change lasts as long as the process). None configured:
    // Claude Code picks its own default, which system/init reports.
    const mode = this.modeOf(s);
    s.mode = mode ?? (await this.settingsMode(s.cwd));
    if (this.quitting || s.inbox !== inbox) return;
    const executable = this.opts.executable();
    // The master's and a post's prompts change between launches (team, post, handoff note): rendered at each launch,
    // never the copy recorded with the conversation. Changes made while they run come with their next message.
    s.seen = isMaster ? rosterKey(cfg) : post ? roleKey(post) : '';
    const append = isMaster ? masterPrompt(cfg) : workerPrompt(cfg, post ?? undefined, post && s.instanceOf ? this.instanceInfo(s, post) : undefined);
    const options: Options = {
      cwd: s.cwd,
      ...(post && post.folders.length > 1 ? { additionalDirectories: post.folders.slice(1) } : {}),
      // No model/effort = the CLI resolves them from settings.json, exactly like a normal session.
      ...(s.fixedModel ? { model: s.fixedModel } : {}),
      ...(s.fixedEffort ? { effort: s.fixedEffort } : {}),
      ...(mode ? { permissionMode: mode } : {}),
      // Lets the composer switch a session to bypass as well: an explicit choice, which the mode menu warns about.
      allowDangerouslySkipPermissions: true,
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
      systemPrompt: { type: 'preset', preset: 'claude_code', append, ...(isMaster || post ? { snapshot: false } : {}) },
      // Workers talk to the master and to each other through native cross-session messaging (SendMessage). The master
      // writes to workers through the hub (message_worker), which delivers its words as a user turn: a peer message
      // carries no user authority, so a "go" sent that way would not unblock a commit or a push.
      // replay-user-messages surfaces incoming cross-session messages (origin.kind === 'peer') on the stream.
      extraArgs: { name: s.name, 'replay-user-messages': null },
      includePartialMessages: true,
      disallowedTools: isMaster
        ? ['Edit', 'Write', 'NotebookEdit', 'AskUserQuestion', 'SendMessage']
        : s.readOnly
          ? ['Edit', 'Write', 'NotebookEdit', 'AskUserQuestion']
          : ['AskUserQuestion'],
      mcpServers: { hub: this.hubServer(s) },
      // The hub's own tools by exact name: a project .mcp.json declaring another server named "hub" gets nothing.
      allowedTools: HUB_TOOLS.map((name) => `mcp__hub__${name}`),
      canUseTool: (name, input, o) => this.askPermission(s, name, input, o),
      onElicitation: (req, o) => this.answerElicitation(s, req, o.signal),
      env: this.environment(),
      ...(resume ? { resume: s.sessionId } : { sessionId: s.sessionId }),
    };

    // Shown (and queued) before Claude Code starts: a start that fails still leaves the message visible.
    if (firstPrompt) this.pushUser(s, this.withNote(s, firstPrompt));
    const q = query({ prompt: inbox, options });
    s.query = q;
    // A post's cost runs on across its conversations.
    s.costBase = resume || s.roleId ? (s.metrics?.costUsd ?? 0) : 0;
    this.changed();
    void this.onReady(s, q);
    s.exit = this.consume(s, q);
    await s.exit;
  }

  private async consume(s: Session, q: Query): Promise<void> {
    let failure = '';
    try {
      for await (const msg of q) this.onMessage(s, q, msg);
    } catch (err) {
      failure = errorText(err);
    }
    if (s.query !== q) return; // stop() already tore the session down.
    this.teardown(s);
    if (failure && !this.quitting) this.failed(s, failure);
    this.changed();
  }

  /** A session that stopped on an error: its card and conversation say why; the master hears about a worker. */
  private failed(s: Session, failure: string): void {
    if (this.quitting) return;
    // The executable the SDK expects is missing: the fix is in the settings, not in the conversation.
    const noClaude = !this.opts.executable() || /Native CLI binary|pathToClaudeCodeExecutable|spawn \S*claude\S* ENOENT/i.test(failure);
    s.error = noClaude ? t('error.noClaude') : humanError(failure);
    this.event(s, 'crashed');
    if (noClaude) this.upsert(s, { kind: 'notice', id: `notice-${randomUUID()}`, text: t('notice.noClaude'), tone: 'error', action: 'claude-settings' });
    else this.notice(s, t('notice.stopped', { error: s.error }), 'error', failure);
    if (s.role === 'worker') this.notifyMaster(t('hub.crashed', { name: displayName(s), error: s.error }), t('hub.crashed.note', { error: oneLine(failure, 400) }));
  }

  private teardown(s: Session): void {
    s.query = null;
    s.inbox = null;
    s.liveId = null;
    s.queued = 0;
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

  private onMessage(s: Session, q: Query, msg: SDKMessage): void {
    s.activeAt = Date.now();
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          s.started = true;
          // The note is in this conversation now: its later prompts never carry it again.
          if (s.noteSending) Object.assign(s, { noteSentTo: msg.session_id, noteSending: false });
          s.sessionId = msg.session_id;
          s.mode = msg.permissionMode;
          if (msg.effort) s.effort = msg.effort;
          this.applyModel(s, msg.model);
        } else if (msg.subtype === 'compact_boundary') {
          s.compacting = false;
          this.notice(s, t('notice.compacted'), 'info');
        } else if (msg.subtype === 'status') {
          const compacting = msg.status === 'compacting';
          if (compacting && !s.compacting) this.event(s, 'compacting');
          s.compacting = compacting;
        } else if (msg.subtype === 'api_retry') {
          s.retrying = true;
          this.event(s, 'retry');
        } else if (msg.subtype === 'background_tasks_changed') {
          // Level signal with replace semantics; ambient tasks (watchers) are not activity.
          s.background = msg.tasks.filter((t) => !t.ambient).map((t) => t.description);
          if (s.closeWhenDone && s.background.length === 0) setTimeout(() => this.closeIfDone(s, q), SILENCE_MS);
        } else if (msg.subtype === 'task_started') {
          if (msg.task_type === 'local_agent' && !msg.ambient) this.trackAgent(s, msg.task_id, true);
        } else if (msg.subtype === 'task_updated') {
          const { status } = msg.patch;
          if (status === 'completed' || status === 'failed' || status === 'killed') this.endAgent(s, msg.task_id, status === 'failed');
        } else if (msg.subtype === 'task_notification') {
          this.endAgent(s, msg.task_id, msg.status === 'failed');
        }
        break;
      case 'rate_limit_event':
        // Refused by a plan limit: the CLI waits or gives up; either way the session is stuck until the next frame.
        if (msg.rate_limit_info.status === 'rejected') {
          s.retrying = true;
          this.event(s, 'retry');
        }
        break;
      case 'stream_event': {
        if (msg.parent_tool_use_id) return;
        const before = s.status;
        const retried = s.retrying;
        s.retrying = false; // A frame came through: the retry worked.
        this.markBusy(s);
        if (msg.event.type === 'content_block_start' && msg.event.content_block.type === 'text') {
          s.liveId = `live-${randomUUID()}`;
          s.liveText = '';
        } else if (msg.event.type === 'content_block_delta' && msg.event.delta.type === 'text_delta' && s.liveId) {
          s.liveText += msg.event.delta.text;
          this.upsert(s, { kind: 'assistant', id: s.liveId, text: s.liveText, live: true });
        }
        // Deltas travel on the items channel; the snapshot only needs a refresh when the status flips.
        if (s.status !== before || retried) this.changed();
        return;
      }
      case 'assistant': {
        if (msg.parent_tool_use_id) break;
        s.retrying = false;
        this.markBusy(s);
        // A frame carrying an error has Claude Code's own wording as its text ("Invalid API key · Fix external API
        // key"): neither shown nor kept as the last message; the notice below says it for the user.
        const blocks = blocksOf(msg.message).filter((b) => !msg.error || b.type !== 'text');
        const hasText = blocks.some((b) => b.type === 'text');
        if (msg.error && s.liveId) {
          this.drop(s, s.liveId);
          s.liveId = null;
        }
        for (const item of assistantItems(blocks, msg.uuid, hasText ? (s.liveId ?? undefined) : undefined)) this.upsert(s, item);
        if (hasText) s.liveId = null;
        if (blocks.some((b) => b.type === 'tool_use' && b.name === 'SendMessage' && (b.input as { to?: unknown })?.to === masterName())) {
          s.owesReport = false;
        }
        if (blocks.some((b) => b.type === 'tool_use' && OUTGOING.test(String(b.name)))) this.event(s, 'message_out');
        if (msg.error) this.notice(s, assistantError(msg.error), 'error', msg.error);
        const u = msg.message.usage;
        const tokens = (u?.input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0);
        if (tokens > 0) this.setContext(s, tokens, s.metrics?.contextSize ?? 0);
        break;
      }
      case 'user': {
        if (msg.parent_tool_use_id) break;
        const blocks = blocksOf(msg.message);
        if ('isReplay' in msg && msg.isReplay && msg.origin?.kind !== 'peer') {
          // One of our prompts reached the model: it is no longer waiting in the queue.
          s.queued = Math.max(0, s.queued - 1);
          this.markBusy(s);
          break;
        }
        if (msg.origin?.kind === 'peer') {
          // `body` (the sender's raw text) is sent by the CLI but not yet in the SDK typings.
          const origin = msg.origin as typeof msg.origin & { body?: string };
          const text = origin.body ?? userTextItem(blocks, '')?.text ?? '';
          this.upsert(s, { kind: 'peer', id: `peer-${msg.uuid ?? randomUUID()}`, from: origin.name || origin.from, text });
          this.event(s, 'message_in');
          break;
        }
        for (const b of blocks) {
          if (b.type !== 'tool_result') continue;
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
      }
      case 'result': {
        const costBefore = s.metrics?.costUsd ?? s.costBase;
        s.liveId = null;
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
        if (handoff) {
          // A turn that ended on an error carries Claude Code's error text, not a note.
          const ok = msg.subtype === 'success' && !msg.is_error;
          const note = ok ? msg.result.trim().slice(0, NOTE_MAX) : '';
          if (note) Object.assign(s, { note, noteFresh: true });
          // Not written: the worker keeps its conversation as it is, and a note is asked again at its next sleep after work.
          else this.notice(s, t('notice.noteFailed'), 'info', ok ? '' : msg.subtype === 'success' ? msg.result.trim() : msg.subtype);
        } else if (msg.subtype === 'success') {
          // A turn that ended on an error carries Claude Code's wording as its result: the notice already said it, and
          // the previous turn's text would pass for this one's.
          if (msg.is_error) s.lastMessage = '';
          else if (msg.result.trim()) s.lastMessage = msg.result;
          this.event(s, 'turn_done');
        } else {
          this.notice(s, t('notice.interrupted'), 'info');
          this.event(s, 'interrupted');
        }
        const windows = Object.values(msg.modelUsage ?? {}).map((m) => m.contextWindow);
        const size = Math.max(s.metrics?.contextSize ?? 0, ...windows);
        this.setContext(s, s.metrics?.contextTokens ?? 0, size);
        if (s.metrics) s.metrics.costUsd = s.costBase + msg.total_cost_usd;
        const costAfter = s.metrics?.costUsd ?? costBefore;
        if (COST_MILESTONES.some((m) => costBefore < m && costAfter >= m)) this.event(s, 'cost_milestone');
        if (s.role === 'worker' && s.owesReport) setTimeout(() => this.chaseSilence(s, q), SILENCE_MS);
        if (s.closeWhenDone) setTimeout(() => this.closeIfDone(s, q), SILENCE_MS);
        void this.refreshContext(s, q);
        void this.refreshUsage(q);
        break;
      }
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

  /**
   * Mode shown before the first turn of a session that leaves it to Claude Code (system/init reports the real one):
   * the settings' `permissions.defaultMode`, else null.
   */
  private async settingsMode(cwd: string): Promise<Mode | null> {
    try {
      const { effective } = await resolveSettings({ cwd });
      return (effective.permissions?.defaultMode as Mode | undefined) ?? null;
    } catch {
      return null;
    }
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
  private async onReady(s: Session, q: Query): Promise<void> {
    try {
      const init = await q.initializationResult();
      if (init.models.length > 0) this.modelInfos = init.models;
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
    void this.refreshUsage(q);
    this.changed();
  }

  private async refreshContext(s: Session, q: Query): Promise<void> {
    try {
      const usage = await q.getContextUsage({ detail: 'summary' });
      this.setContext(s, usage.totalTokens, usage.maxTokens);
      // Before the first turn this is the only source of the inherited model.
      this.applyModel(s, usage.model);
      await this.inheritEffort(s, usage.model);
      this.changed();
    } catch {
      // Session closed meanwhile.
    }
  }

  private setContext(s: Session, tokens: number, size: number): void {
    const metrics: Metrics = s.metrics ?? { contextTokens: 0, contextSize: 0, contextPct: null, costUsd: s.costBase };
    metrics.contextTokens = tokens;
    metrics.contextSize = size || metrics.contextSize;
    metrics.contextPct = metrics.contextSize ? (tokens / metrics.contextSize) * 100 : null;
    s.metrics = metrics;
  }

  /** Plan limits (5 h / 7 days) from the SDK's experimental /usage API, at most once a minute. */
  private async refreshUsage(q: Query): Promise<void> {
    if (Date.now() - this.usageCheckedAt < 60_000) return;
    this.usageCheckedAt = Date.now();
    try {
      const limits = (await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })).rate_limits;
      if (!limits) return;
      const epoch = (iso: string | null | undefined) => (iso ? Date.parse(iso) / 1000 : null);
      this.rateLimits = {
        fiveHourPct: limits.five_hour?.utilization ?? null,
        fiveHourResetsAt: epoch(limits.five_hour?.resets_at),
        sevenDayPct: limits.seven_day?.utilization ?? null,
        sevenDayResetsAt: epoch(limits.seven_day?.resets_at),
      };
      this.changed();
    } catch {
      // Experimental API unavailable in this CLI version: the status bar simply omits plan limits.
    }
  }

  private askPermission(
    s: Session,
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; suggestions?: PermissionUpdate[]; decisionReason?: string },
  ): Promise<PermissionResult> {
    if (opts.signal.aborted) return Promise.resolve({ behavior: 'deny', message: t('perm.cancelled') });
    const item: PermissionItem = {
      kind: 'permission',
      id: `perm-${randomUUID()}`,
      tool: toolLabel(toolName),
      summary: toolSummary(toolName, input),
      ...toolDetail(toolName, input),
      // A command or an edit stays in view (it is what is being allowed); any other input is raw data.
      showDetail: SHOWN_INPUT.test(toolName),
      reason: opts.decisionReason ?? '',
      // "Always allow" persists the CLI's suggested rules; without suggestions it would silently be a one-time allow.
      canAlways: (opts.suggestions?.length ?? 0) > 0,
      state: 'pending',
    };
    return this.ask(s, item, opts.signal).then((d): PermissionResult => {
      if (!d) return { behavior: 'deny', message: t('perm.cancelled') };
      if (d.behavior === 'deny') return { behavior: 'deny', message: d.message?.trim() || t('perm.denied') };
      const always = d.behavior === 'always' && opts.suggestions ? { updatedPermissions: opts.suggestions } : {};
      return { behavior: 'allow', updatedInput: input, ...always };
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
  private answerElicitation(s: Session, req: ElicitationRequest, signal: AbortSignal): Promise<ElicitationResult> {
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
    return this.ask(s, item, signal).then((d): ElicitationResult => (d && d.behavior !== 'deny' ? { action: 'accept', content } : { action: 'decline' }));
  }

  /** Into the running session, or resumes a closed one with its conversation. */
  private deliver(s: Session, prompt: Prompt): void {
    prompt = this.withNote(s, prompt);
    if (s.inbox) return this.pushUser(s, this.withNews(s, prompt));
    // A worker closed before its CLI took the mission gets it back, ahead of the new message (a post's missions come one by one).
    const lostMission = s.role === 'worker' && !s.roleId && !s.started && s.mission;
    void this.launch(s, s.started, lostMission ? { ...prompt, text: `${this.missionPrompt(s).text}\n\n${prompt.text}` } : prompt);
  }

  /** The first message of a post's conversation after a context renewal carries its handoff note. */
  private withNote(s: Session, prompt: Prompt): Prompt {
    if (!s.roleId || !s.note || s.started || prompt.handoff || s.noteSending || s.noteSentTo === s.sessionId) return prompt;
    s.noteSending = true;
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
    if (key === s.seen || !s.query) return prompt;
    s.seen = key;
    const news = s.role === 'master' ? rosterBlock(cfg) : post ? postUpdate(post, undefined, !!s.instanceOf) : '';
    return { ...prompt, text: `${prompt.text}\n\n${news}` };
  }

  private pushUser(s: Session, { text, images, from, shown, handoff }: Prompt): void {
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
    if (from) {
      this.upsert(s, { kind: 'peer', id: `peer-${randomUUID()}`, from, text: shown ?? taggedSender(text)?.text ?? visibleText(text) });
    } else {
      const urls = images.map((img) => `data:${img.mediaType};base64,${img.data}`);
      this.upsert(s, { kind: 'user', id: `user-${randomUUID()}`, text: shown ?? text, images: urls });
    }
    s.inbox?.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: s.sessionId });
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
    try {
      const messages = (await getSessionMessages(s.sessionId, { dir: s.cwd })).slice(-HISTORY_MAX);
      for (const m of messages) {
        if (m.parent_tool_use_id) continue;
        // Claude Code stores an API error as a "<synthetic>" reply with its own wording: not shown again on reload.
        const synthetic = (m.message as { model?: unknown } | null)?.model === '<synthetic>';
        const blocks = blocksOf(m.message).filter((b) => !synthetic || b.type !== 'text');
        if (m.type === 'assistant') {
          for (const item of assistantItems(blocks, m.uuid)) history.set(item.id, item);
        } else if (m.type === 'user') {
          for (const b of blocks) {
            if (b.type !== 'tool_result') continue;
            const item = history.get(String(b.tool_use_id));
            if (item?.kind === 'tool') history.set(item.id, { ...item, result: resultText(b.content), isError: b.is_error === true });
          }
          const text = userTextItem(blocks, m.uuid);
          if (text) history.set(text.id, text);
        }
      }
    } catch {
      s.historyLoad = null; // Unreadable transcript (locked, missing): the view stays as is until the next try.
      return;
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

  /** `detail`: the raw message behind it (an error), folded under "Details" in the conversation. */
  private notice(s: Session, text: string, tone: 'info' | 'error', detail = ''): void {
    this.upsert(s, { kind: 'notice', id: `notice-${randomUUID()}`, text, tone, ...(detail ? { detail } : {}) });
    this.changed();
  }

  // ---------- master supervision ----------

  /** Wakes the master with a hub message about a worker it would otherwise wait on forever. */
  /** `shown`: the short line the user reads; `note`: what the model alone needs (visibleText() hides it). */
  private notifyMaster(shown: string, note: string): void {
    const master = this.sessions.get(MASTER_ID);
    if (!master || this.quitting) return;
    this.deliver(master, { text: `${tags().hub} ${shown}\n<hub-note>\n${note}\n</hub-note>`, images: [], from: 'hub' });
  }

  /** A worker the master wrote to ended its turn without answering: the master hears it from the hub. */
  private chaseSilence(s: Session, q: Query): void {
    if (s.query !== q || !s.owesReport || !this.settled(s)) return;
    if (Date.now() - s.activeAt < SILENCE_MS) {
      setTimeout(() => this.chaseSilence(s, q), SILENCE_MS); // Something moved meanwhile: look again once it is quiet.
      return;
    }
    s.owesReport = false;
    // A random tag the worker's text cannot guess: nothing inside it can pass for the hub's own words.
    const tag = `worker-output-${randomUUID().slice(0, 8)}`;
    const last = s.lastMessage ? inside(s.lastMessage.slice(0, 3000)) : t('hub.noText');
    this.notifyMaster(t('hub.silent', { name: displayName(s) }), t('hub.silent.note', { name: s.name, tag, last }));
  }

  /** End of the turn (and of its background tasks) of a worker the master closed while it was finishing. */
  private closeIfDone(s: Session, q: Query): void {
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
    this.notice(s, t('notice.closedByMaster'), 'info');
    this.tellKept(s);
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
      if (s.tree?.state === 'kept' && text) this.notifyMaster(t('hub.treeKept', { name: displayName(s) }), text);
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
      const tag = `install-output-${randomUUID().slice(0, 8)}`;
      const note = r.ok ? t('install.done.note', { command }) : t('install.failed.note', { command, tag, output: inside(r.output.slice(-1500)) });
      // Only while the worker may still need them: an idle one that has reported is not woken for this.
      if (this.isWorking(s) || s.owesReport || s.status === 'starting') {
        this.pushUser(s, { text: `${tags().hub} ${line}\n<hub-note>\n${note}\n</hub-note>`, images: [], from: 'hub' });
      } else this.notice(s, line, r.ok ? 'info' : 'error', r.ok ? '' : r.output);
    });
  }

  /**
   * A settled permanent worker goes to sleep. With a well-filled context it first writes its handoff note: the hub
   * asks for it once, closes the worker when the note is in, and its next mission starts in a fresh conversation
   * seeded with the note. False while it writes the note. `idleMin`: it falls asleep for lack of work.
   */
  private sleep(s: Session, idleMin?: number): boolean {
    if (s.query && !s.handoffDone && needsFreshStart(s.metrics)) {
      s.owesReport = false;
      s.closeWhenDone = true;
      this.pushUser(s, { text: handoffRequest(), images: [], from: 'hub', handoff: true });
      return false;
    }
    this.event(s, 'idle_closed');
    this.stop(s.id);
    this.notice(s, idleMin ? t('notice.asleepIdle', { min: idleMin }) : t('notice.asleep'), 'info');
    return true;
  }

  // ---------- hub tools (in-process MCP server) ----------

  /**
   * Master: workers, posts and repos. Workers: read-only list_workers + list_repos to coordinate, and message_master:
   * a session name is shared by every Claude Code session of the machine (another hub may run a "hub-maitre"), the
   * hub's own channel always reaches this hub's master.
   */
  private hubServer(s: Session) {
    const role = s.role;
    const { cfg } = this.opts;
    const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
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
    if (role === 'worker') {
      const toMaster = tool('message_master', t('tool.messageMaster'), { message: z.string().describe(t('tool.messageMaster.message')) }, ({ message }) =>
        run(() => this.messageMaster(s, message)),
      );
      return createSdkMcpServer({ name: 'hub', version: '0.6.0', tools: [listWorkers, listRepos, toMaster] });
    }
    const signalOf = (extra: unknown) => (extra as { signal?: AbortSignal } | undefined)?.signal ?? new AbortController().signal;

    // Models and effort are checked against the settings at each call (they may change while the master runs).
    // nullish: models often send null for an optional field they mean to leave out.
    const model = z.string().nullish().describe(t('tool.model'));
    const effort = z
      .enum(EFFORTS as [Effort, ...Effort[]])
      .nullish()
      .describe(t('tool.effort'));
    const byPost = z.string().describe(t('tool.role.byName'));
    const postFields = {
      description: z.string().nullish().describe(t('tool.role.description')),
      instructions: z.string().nullish().describe(t('tool.role.instructions')),
      folders: z.array(z.string()).nullish().describe(t('tool.role.folders')),
      model: z.string().nullish().describe(t('tool.role.model')),
      effort: z
        .enum(['auto', ...EFFORTS] as [string, ...string[]])
        .nullish()
        .describe(t('tool.role.effort')),
      enabled: z.boolean().nullish().describe(t('tool.role.enabled')),
    };
    return createSdkMcpServer({
      name: 'hub',
      version: '0.6.0',
      tools: [
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
          },
          (args) =>
            run(() => {
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
          },
          (args) => run(() => this.messageWorker(args)),
        ),
        listWorkers,
        listRepos,
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
      ],
    });
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
  }): Promise<string> {
    const { cfg } = this.opts;
    const mission = args.mission.trim();
    if (!mission) throw new Error(t('spawn.empty'));
    const post = args.role?.trim() ? this.findRole(args.role) : null;
    if (post && !post.enabled) throw new Error(t('instance.off', { name: post.name }));
    const folder = post ? post.folders[0] : args.cwd?.trim() || masterCwd(cfg);
    if (!isAbsolute(folder) || !existsSync(folder) || !statSync(folder).isDirectory()) throw new Error(t('spawn.badDir', { cwd: folder }));
    const over = this.overCap(post?.id ?? null);
    if (over) throw new Error(over);
    const choice = this.choose(null, args, post);
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
    const name = post ? this.uniqueName(`${post.name}-${topic || 'work'}`, 48) : this.uniqueName(args.name);
    const s = this.create(`w-${randomUUID().slice(0, 8)}`, 'worker', name, mission, cwd, model, effort);
    Object.assign(s, { instanceOf: post?.id ?? null, tree: made?.tree ?? null, readOnly, owesReport: true });
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
      ...(post ? [t('instance.started', { post: post.name, main: sessionNameOf(post), others: others.join(', ') || t('report.none') })] : []),
      ...(made ? [t('tree.made', { branch: made.tree.branch, base: made.tree.baseRef || 'HEAD', sha: made.tree.base.slice(0, 8) }), ...(made.stale ? [t('tree.stale')] : [])] : []),
      ...(plan ? [t(byHub ? 'install.byHub' : 'install.byWorker', { command: planText(plan) })] : []),
      ...(readOnly ? [t('spawn.readOnly')] : []),
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

  private async messageWorker(args: { name: string; message: string; interrupt?: boolean | null; model?: string | null; effort?: Effort | null }): Promise<string> {
    const s = this.findWorker(args.name);
    const message = args.message.trim();
    if (!message) throw new Error(t('message.empty'));
    if (s.retiring) await s.retiring;
    if (this.ended(s)) throw new Error(t('instance.ended', { name: s.name }));
    if (!s.inbox && this.orphan(s)) throw new Error(t('instance.orphan', { name: s.name }));
    if (!s.inbox) {
      const over = this.overCap(s.instanceOf);
      if (over) throw new Error(over);
    }
    const choice = this.choose(s, args);
    const wasClosed = !s.inbox;
    const wasWorking = !wasClosed && this.isWorking(s);
    // A permanent worker handed work while it had none starts a new mission: its card and list_workers show it, and
    // the mission's first line gives it its name (it may be a fresh conversation).
    const newMission = !!s.roleId && !wasWorking && !s.owesReport;
    if (newMission) s.mission = message;
    if (choice.model && choice.model !== s.fixedModel) this.setModel(s.id, choice.model, false);
    if (choice.effort && choice.effort !== s.fixedEffort) this.setEffort(s.id, choice.effort, false);
    if (args.interrupt && s.query && wasWorking) await s.query.interrupt().catch(() => undefined);
    s.owesReport = true;
    s.closeWhenDone = false;
    this.deliver(s, { text: `${newMission ? tags().mission(s.name) : tags().master}\n${message}`, images: [], from: masterName() });
    const state = wasClosed
      ? t(s.roleId ? 'message.woken' : 'message.wasClosed', { name: s.name })
      : args.interrupt && wasWorking
        ? t('message.interrupted', { name: s.name })
        : t(wasWorking ? 'message.queued' : 'message.delivered', { name: s.name });
    const runs = choice.model || choice.effort ? [t('message.runs', { model: s.modelLabel || s.model || t('spawn.usualModel'), effort: s.effort ?? t('spawn.usualEffort') })] : [];
    return [state, ...runs, ...this.choiceNotes(choice.notes)].join('\n');
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
  private choose(s: Session | null, requested: { model?: string | null; effort?: Effort | null }, post = s ? this.postOf(s) : null) {
    const { cfg } = this.opts;
    const choice = resolveChoice({
      requested,
      post: post ? { model: post.model, effort: post.effort } : null,
      locked: { model: !!s?.userModel, effort: !!s?.userEffort },
      allowed: cfg.workerModels,
      maxEffort: cfg.workerMaxEffort,
    });
    if ('error' in choice) throw new Error(t('choice.badModel', { model: requested.model ?? '', allowed: cfg.workerModels.join(', ') }));
    return choice;
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
      Object.assign(s, { roleId: role.id, status: 'exited' });
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
      t('role.line.run', { model: r.model || 'auto', effort: r.effort || 'auto', mode: r.mode || t('role.hubMode') }),
      t('role.line.instructions', { text: inside(r.instructions) || t('report.none') }),
    ].join('\n');
  }

  private listRoles(): string {
    const { team } = this.opts.cfg;
    return team.length === 0 ? t('role.none') : team.map((r) => this.roleText(r)).join('\n\n');
  }

  /** The master's fields for a post: "auto" (or empty) leaves the choice to it, a model must be an allowed one. */
  private postValues(args: { model?: string | null; effort?: string | null }): Partial<TeamRole> {
    const { cfg } = this.opts;
    const out: Partial<TeamRole> = {};
    if (args.model != null) {
      const model = args.model.trim().toLowerCase();
      const allowed = cfg.workerModels.find((a) => a.toLowerCase() === model);
      if (model && model !== 'auto' && !allowed) throw new Error(t('choice.badModel', { model, allowed: cfg.workerModels.join(', ') }));
      out.model = model === 'auto' ? '' : (allowed ?? '');
    }
    if (args.effort != null) out.effort = args.effort === 'auto' ? '' : capEffort(args.effort as Effort, cfg.workerMaxEffort);
    return out;
  }

  private async createRole(
    args: {
      name: string;
      template?: (typeof TEMPLATE_IDS)[number] | null;
      description?: string | null;
      instructions?: string | null;
      folders?: string[] | null;
      model?: string | null;
      effort?: string | null;
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
    const raw = { ...base, ...given, ...this.postValues(args), id: '', name: args.name, mode: '' };
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
      model?: string | null;
      effort?: string | null;
      enabled?: boolean | null;
    },
    signal: AbortSignal,
  ): Promise<string> {
    const known = rosterKey(this.opts.cfg);
    const changes = (role: TeamRole): TeamRole => {
      const next: TeamRole = { ...role, ...this.postValues(args) };
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
    const changed = (['name', 'description', 'folders', 'model', 'effort', 'enabled'] as const)
      .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
      .map((k) => `- ${k}: ${JSON.stringify(before[k])} → ${JSON.stringify(after[k])}`);
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
    const check = this.checkRole(raw, 'master');
    if ('error' in check) throw new Error(this.roleErrorText(check.error, name));
    const { role, before } = check;
    const outside = role.folders.filter((f) => !this.inScope(f) && !before?.folders.some((b) => samePath(b, f)));
    if (outside.length === 0) return '';
    const answer = await this.confirm(
      {
        tool: t('ask.folder.tool', { name: role.name }),
        title: t('ask.folder.title', { name: role.name }),
        summary: t('ask.folder.summary', { list: outside.map((f) => basename(f) || f).join(', ') }),
        done: outside.map((f) => basename(f) || f).join(', '),
        facts: [t('ask.fact.paths', { list: outside.join(' · ') }), ...this.postFacts(role)],
        allow: t('ask.folder.allow'),
        deny: t('ask.folder.deny'),
      },
      signal,
    );
    return answer.ok ? '' : t('role.folderRefused', { name: role.name, reason: answer.reason ? ` (${answer.reason})` : '' });
  }

  /** Inside one of the working folders or followed repos: where the user lets the hub's sessions work. */
  private inScope(folder: string): boolean {
    const { cfg } = this.opts;
    // Real paths: a link or junction inside a working folder may lead anywhere.
    const real = (dir: string) => {
      try {
        return realpathSync.native(dir);
      } catch {
        return resolve(dir);
      }
    };
    const norm = (dir: string) => (process.platform === 'linux' ? real(dir) : real(dir).toLowerCase());
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
    const tag = `worker-output-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const note = t('hub.workerMessage', { tag, text: inside(text.slice(0, 20_000)) });
    this.deliver(master, { text: `${tags().worker(s.name)}\n<hub-note>\n${note}\n</hub-note>`, images: [], from: s.name, shown: text });
    return t('master.delivered');
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
    return `${s.name} · ${status}${since} · ${model}${mine.length ? ` (${t('workers.byUser', { what: mine.join(', ') })})` : ''} · ${ctx} · ${cost} · ${s.cwd}`;
  }

  /** Its worktree as the master reads it: branch, and what was kept at the last close. */
  private treeLine(s: Session): string {
    const tree = s.tree;
    if (!tree) return s.readOnly ? t('workers.readOnly') : '';
    const kept = tree.state === 'kept' ? t('workers.treeKept', { reasons: tree.kept.map((w) => t(`tree.why.${w}`)).join(' · ') }) : '';
    const install = s.installing ? t('workers.installing') : s.installFailed ? t('workers.installFailed') : '';
    return t('workers.tree', { branch: tree.branch, state: t(`tree.state.${tree.state}`) }) + kept + install;
  }

  private listWorkers(): string {
    const workers = this.visible().filter((s) => s.role === 'worker');
    if (workers.length === 0) return t('workers.none');
    const block = (s: Session) => {
      const post = this.roleOf(s);
      const lines = [`${s.instanceOf ? '  ↳ ' : '- '}${this.workerLine(s)}`];
      if (post) lines.push(t('workers.post', { text: oneLine(post.description, 160), model: post.model || 'auto', effort: post.effort || 'auto' }));
      if (s.instanceOf) lines.push(t('workers.instance', { post: this.postOf(s)?.name ?? '' }));
      const tree = this.treeLine(s);
      if (tree) lines.push(tree);
      if (s.mission) lines.push(t('workers.mission', { text: oneLine(s.mission, 160) }));
      if (s.background.length > 0) lines.push(t('workers.background', { text: oneLine(s.background.join(' ; '), 200) }));
      if (s.lastMessage) lines.push(t('workers.last', { text: oneLine(s.lastMessage, 200) }));
      return lines.join('\n');
    };
    const { team } = this.opts.cfg;
    const order = (s: Session) => team.findIndex((r) => r.id === s.roleId);
    const posts = workers.filter((s) => s.roleId).sort((a, b) => order(a) - order(b));
    // An instance goes under its post; one whose post is gone, with the ad-hoc workers.
    const under = (p: Session) => workers.filter((w) => w.instanceOf === p.roleId);
    const adhoc = workers.filter((s) => !s.roleId && !(s.instanceOf && posts.some((p) => p.roleId === s.instanceOf)));
    return [
      posts.length > 0 ? `${t('workers.team')}\n${posts.flatMap((p) => [p, ...under(p)]).map(block).join('\n')}` : '',
      adhoc.length > 0 ? `${t('workers.adhoc')}\n${adhoc.map(block).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private async workerReport(name: string): Promise<string> {
    const s = this.findWorker(name);
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
    return this.modelInfos.map((m) => ({
      value: m.value,
      label: modelLabel(m.value, m.displayName),
      description: modelHint(m.value, m.displayName),
      efforts: m.supportsEffort ? (m.supportedEffortLevels ?? []) : [],
    }));
  }

  /**
   * The CLI does not report an effort it took from settings (system/init leaves it empty), so resolve it with the
   * CLI's own settings cascade: per-model `modelSettings` first, then the global `effortLevel`.
   */
  private async inheritEffort(s: Session, modelId: string): Promise<void> {
    if (s.fixedEffort || s.effortResolved || !modelId) return;
    s.effortResolved = true;
    try {
      const { effective } = await resolveSettings({ cwd: s.cwd });
      if (s.fixedEffort) return; // Chosen in the composer meanwhile.
      const perModel = effective.modelSettings;
      s.effort = perModel?.[modelId]?.effortLevel ?? perModel?.[s.model]?.effortLevel ?? effective.effortLevel ?? null;
    } catch {
      // Display only: the session keeps running with the CLI's own resolution.
    }
  }

  /** Display model: the explicit choice, else what settings.json resolved to (as a picker alias when one matches). */
  private applyModel(s: Session, modelId: string): void {
    if (!modelId) return;
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
      costBase: 0,
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
      handoff: false,
      handoffStale: false,
      handoffDone: false,
      seen: '',
      userModel: false,
      userEffort: false,
      noteSentTo: '',
      noteSending: false,
      instanceOf: null,
      tree: null,
      readOnly: false,
      installing: null,
      installFailed: false,
      retiring: null,
      exit: null,
    };
    this.sessions.set(id, s);
    return s;
  }

  /** Environment of a Claude Code process started by the hub: the hub's own, without a parent session's variables. */
  environment(): Record<string, string> {
    return { ...this.toolEnv(), ...this.opts.sessionEnv().set };
  }

  /** Environment of the hub's own tools (an install): the same, without the Claude access and GitHub sign-in added. */
  private toolEnv(): Record<string, string> {
    const { unset } = this.opts.sessionEnv();
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !PARENT_SESSION_VARS.test(key) && !unset.includes(key)) env[key] = value;
    }
    return env;
  }

  private restore(): void {
    if (!existsSync(this.stateFile)) return;
    try {
      const saved = JSON.parse(readFileSync(this.stateFile, 'utf8')) as { sessions?: Persisted[] };
      for (const { resume, ...p } of saved.sessions ?? []) {
        // State saved before fixed* existed only holds display values: those sessions inherit from settings.json.
        const s = this.create(p.id, p.role, p.name, p.mission, p.cwd, p.fixedModel ?? '', p.fixedEffort ?? null);
        Object.assign(s, p, { status: 'exited' });
        // The hub removes this worktree and deletes its branch later: only one that it could have made itself.
        if (s.tree && !validTree(s.tree)) s.tree = null;
        // Its note written, the hub closed before the worker did: the next conversation starts afresh all the same.
        if (s.noteFresh) this.freshStart(s);
        if (resume && s.role === 'worker') this.resumeOnStart.set(s.id, resume);
      }
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
      noteSentTo: s.noteSentTo,
      userModel: s.userModel,
      userEffort: s.userEffort,
      instanceOf: s.instanceOf,
      tree: s.tree,
      readOnly: s.readOnly,
      // Read at close time: a worker cut mid-work (or before its CLI took the mission) is picked up at the next start.
      // A post woken without a mission has none to get back.
      ...(s.inbox && !s.started && (!s.roleId || s.owesReport) ? { resume: 'mission' as const } : s.inbox && this.isWorking(s) ? { resume: 'work' as const } : {}),
    }));
    // Write-then-rename: a crash mid-save can never leave a truncated state.json behind.
    const tmp = `${this.stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ sessions }, null, 2));
    renameSync(tmp, this.stateFile);
  }
}
