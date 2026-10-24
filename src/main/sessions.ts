import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
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
import {
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
} from '../shared/types';
import { mainRepoPath, masterCwd, type HubConfig } from './config';
import { t } from './i18n';
import { defaultMasterName, IDLE_CLOSE_MIN, masterName, masterPrompt, setMasterName, tags, workerPrompt } from './prompts';
import { findRepos, repoRootOf } from './repos';
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
} from './transcript';

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

interface Session extends Omit<SessionView, 'idleSince'> {
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
>;

export interface ManagerOptions {
  /** Live settings: changes made in the settings screen apply at the next launch of each session. */
  cfg: HubConfig;
  dataDir: string;
  /** Claude Code executable to run; empty = the SDK's default. */
  executable(): string;
  /** Variables added to (set) or removed from (unset) the environment of every session: Claude access, GitHub. */
  sessionEnv(): { set: Record<string, string>; unset: string[] };
}

type PermissionItem = Extract<ChatItem, { kind: 'permission' }>;

const MASTER_ID = 'master';
const HUB_TOOLS = ['spawn_worker', 'message_worker', 'list_workers', 'list_repos', 'worker_report', 'close_worker'];
const WORKER_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
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
}

// Tool calls that send a message to another session (worker ↔ worker, worker → master, master → worker).
const OUTGOING = /^(SendMessage|mcp__hub__(message_worker|spawn_worker))$/;

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
const minutesSince = (at: number) => Math.max(1, Math.round((Date.now() - at) / 60_000));

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
  /** Workers to relaunch at start, from the state saved when the hub last closed. */
  private readonly resumeOnStart = new Map<string, 'mission' | 'work'>();

  constructor(private readonly opts: ManagerOptions) {
    super();
    this.stateFile = join(opts.dataDir, 'state.json');
    this.attachDir = join(opts.dataDir, 'attachments');
    this.restore();
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
      if (cfg.master.model) this.setModel(s.id, cfg.master.model);
      else s.fixedModel = '';
    }
    const effort = cfg.master.effort || null;
    if (effort !== s.fixedEffort) {
      if (effort) this.setEffort(s.id, effort);
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
    // Saved images get their path in the text, so the master can hand them to a worker (which opens them with Read).
    let paths: string[] = [];
    try {
      paths = this.saveImages(images);
    } catch (err) {
      this.notice(s, t('notice.imagesNotSaved', { error: errorText(err) }), 'error');
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

  /** Also works while the session is still launching: launch() sees its inbox gone and gives up. */
  stop(id: string): void {
    const s = this.sessions.get(id);
    if (!s?.inbox) return;
    const q = s.query;
    s.inbox.close();
    this.teardown(s);
    q?.close();
    this.changed();
  }

  resume(id: string): void {
    const s = this.sessions.get(id);
    if (s && !s.inbox) void this.launch(s, s.started);
  }

  /** Shows the conversation of a closed session without resuming it. */
  open(id: string): void {
    const s = this.sessions.get(id);
    if (s && !s.inbox && s.started) void this.loadHistory(s);
  }

  remove(id: string): void {
    const s = this.sessions.get(id);
    if (!s || s.role !== 'worker' || s.inbox) return;
    this.sessions.delete(id);
    this.changed();
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
    }
  }

  /** Sessions whose work a close would cut: a turn in progress, or background tasks left running after one. */
  busySessions(): number {
    return [...this.sessions.values()].filter((s) => s.query && this.isWorking(s)).length;
  }

  // ---------- live controls (composer) ----------

  setModel(id: string, model: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
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
      .catch((err: unknown) => this.notice(s, t('notice.modelRefused', { error: errorText(err) }), 'error'));
    this.changed();
  }

  setEffort(id: string, effort: Effort): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.fixedEffort = effort;
    s.effort = effort;
    s.query?.applyFlagSettings({ effortLevel: effort }).catch((err: unknown) => this.notice(s, t('notice.effortRefused', { error: errorText(err) }), 'error'));
    this.changed();
  }

  setMode(id: string, mode: Mode): void {
    const s = this.sessions.get(id);
    if (!s) return;
    // Claude Code holds a cross-session message whose sender runs in another permission class (bypass vs prompting).
    const bypasses = (m: Mode | null) => m === 'bypassPermissions';
    if (bypasses(mode) !== bypasses(this.hubMode())) this.notice(s, t('notice.modeMismatch'), 'info');
    s.mode = mode;
    s.query?.setPermissionMode(mode).catch((err: unknown) => this.notice(s, t('notice.modeRefused', { error: errorText(err) }), 'error'));
    this.changed();
  }

  decide(id: string, requestId: string, decision: PermissionDecision): void {
    this.sessions.get(id)?.pending.get(requestId)?.(decision);
  }

  // ---------- views ----------

  snapshot(): HubSnapshot {
    const sessions = [...this.sessions.values()]
      .sort((a, b) => (a.role === b.role ? a.createdAt - b.createdAt : a.role === 'master' ? -1 : 1))
      .map((s) => ({
        id: s.id,
        role: s.role,
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
    return [...this.sessions.values()].map((s) => [s.id, [...s.items.values()]]);
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
    // Every launch starts in the configured mode (a composer change lasts as long as the process). None configured:
    // Claude Code picks its own default, which system/init reports.
    const mode = this.hubMode();
    s.mode = mode ?? (await this.settingsMode(s.cwd));
    if (this.quitting || s.inbox !== inbox) return;
    const executable = this.opts.executable();
    const options: Options = {
      cwd: s.cwd,
      // No model/effort = the CLI resolves them from settings.json, exactly like a normal session.
      ...(s.fixedModel ? { model: s.fixedModel } : {}),
      ...(s.fixedEffort ? { effort: s.fixedEffort } : {}),
      ...(mode ? { permissionMode: mode } : {}),
      // Lets the composer switch a session to bypass as well: an explicit choice, which the mode menu warns about.
      allowDangerouslySkipPermissions: true,
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: isMaster ? masterPrompt(cfg) : workerPrompt(cfg) },
      // Workers talk to the master and to each other through native cross-session messaging (SendMessage). The master
      // writes to workers through the hub (message_worker), which delivers its words as a user turn: a peer message
      // carries no user authority, so a "go" sent that way would not unblock a commit or a push.
      // replay-user-messages surfaces incoming cross-session messages (origin.kind === 'peer') on the stream.
      extraArgs: { name: s.name, 'replay-user-messages': null },
      includePartialMessages: true,
      disallowedTools: isMaster ? ['Edit', 'Write', 'NotebookEdit', 'AskUserQuestion', 'SendMessage'] : ['AskUserQuestion'],
      mcpServers: { hub: this.hubServer(s.role) },
      // The hub's own tools by exact name: a project .mcp.json declaring another server named "hub" gets nothing.
      allowedTools: HUB_TOOLS.map((name) => `mcp__hub__${name}`),
      canUseTool: (name, input, o) => this.askPermission(s, name, input, o),
      onElicitation: (req, o) => this.answerElicitation(s, req, o.signal),
      env: this.environment(),
      ...(resume ? { resume: s.sessionId } : { sessionId: s.sessionId }),
    };

    // Shown (and queued) before Claude Code starts: a start that fails still leaves the message visible.
    if (firstPrompt) this.pushUser(s, firstPrompt);
    const q = query({ prompt: inbox, options });
    s.query = q;
    s.costBase = resume ? (s.metrics?.costUsd ?? 0) : 0;
    this.changed();
    void this.onReady(s, q);
    await this.consume(s, q);
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
    s.error = noClaude ? t('error.noClaude') : oneLine(failure, 300);
    this.event(s, 'crashed');
    if (noClaude) this.upsert(s, { kind: 'notice', id: `notice-${randomUUID()}`, text: t('notice.noClaude'), tone: 'error', action: 'claude-settings' });
    else this.notice(s, t('notice.stopped', { error: failure }), 'error');
    if (s.role === 'worker') this.notifyMaster(t('hub.crashed', { name: s.name, error: oneLine(failure, 400) }));
  }

  private teardown(s: Session): void {
    s.query = null;
    s.inbox = null;
    s.liveId = null;
    s.queued = 0;
    for (const finish of [...s.pending.values()]) finish({ behavior: 'deny', message: t('perm.sessionStopped') });
    s.status = 'exited';
    s.busySince = null;
    this.resetActivity(s);
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
        const blocks = blocksOf(msg.message);
        const hasText = blocks.some((b) => b.type === 'text');
        for (const item of assistantItems(blocks, msg.uuid, hasText ? (s.liveId ?? undefined) : undefined)) this.upsert(s, item);
        if (hasText) s.liveId = null;
        if (blocks.some((b) => b.type === 'tool_use' && b.name === 'SendMessage' && (b.input as { to?: unknown })?.to === masterName())) {
          s.owesReport = false;
        }
        if (blocks.some((b) => b.type === 'tool_use' && OUTGOING.test(String(b.name)))) this.event(s, 'message_out');
        if (msg.error) this.notice(s, t('notice.error', { error: msg.error }), 'error');
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
        if (msg.subtype === 'success') {
          if (msg.result.trim()) s.lastMessage = msg.result;
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
    if (s.inbox) return this.pushUser(s, prompt);
    // A worker closed before its CLI took the mission gets it back, ahead of the new message.
    const lostMission = s.role === 'worker' && !s.started && s.mission;
    void this.launch(s, s.started, lostMission ? { ...prompt, text: `${tags().mission(s.name)}\n${s.mission}\n\n${prompt.text}` } : prompt);
  }

  private pushUser(s: Session, { text, images, from, shown }: Prompt): void {
    const content =
      images.length === 0
        ? text
        : [
            ...images.map((img) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: img.mediaType, data: img.data } })),
            ...(text ? [{ type: 'text' as const, text }] : []),
          ];
    if (from) {
      this.upsert(s, { kind: 'peer', id: `peer-${randomUUID()}`, from, text: taggedSender(text)?.text ?? text });
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
        const blocks = blocksOf(m.message);
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

  private notice(s: Session, text: string, tone: 'info' | 'error'): void {
    this.upsert(s, { kind: 'notice', id: `notice-${randomUUID()}`, text, tone });
    this.changed();
  }

  // ---------- master supervision ----------

  /** Wakes the master with a hub message about a worker it would otherwise wait on forever. */
  private notifyMaster(text: string): void {
    const master = this.sessions.get(MASTER_ID);
    if (!master || this.quitting) return;
    this.deliver(master, { text: `${tags().hub} ${text}`, images: [], from: 'hub' });
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
    const last = s.lastMessage ? s.lastMessage.slice(0, 3000) : t('hub.noText');
    this.notifyMaster(t('hub.silent', { name: s.name, tag, last }));
  }

  /** End of the turn (and of its background tasks) of a worker the master closed while it was finishing. */
  private closeIfDone(s: Session, q: Query): void {
    if (s.query !== q || !s.closeWhenDone || !this.settled(s)) return;
    if (Date.now() - s.activeAt < SILENCE_MS) {
      setTimeout(() => this.closeIfDone(s, q), SILENCE_MS);
      return;
    }
    this.stop(s.id);
    this.notice(s, t('notice.closedByMaster'), 'info');
  }

  /** Idle workers are closed: their conversation stays on disk and the next message resumes them. */
  private closeIdle(): void {
    for (const s of this.sessions.values()) {
      if (s.role !== 'worker' || !s.query || !this.settled(s)) continue;
      if (Date.now() - s.activeAt < IDLE_CLOSE_MIN * 60_000) continue;
      this.event(s, 'idle_closed');
      this.stop(s.id);
      this.notice(s, t('notice.closedIdle', { min: IDLE_CLOSE_MIN }), 'info');
    }
  }

  // ---------- hub tools (in-process MCP server) ----------

  /** Master: spawn/message/list/report/close workers + repos. Workers: read-only list_workers + list_repos, to coordinate. */
  private hubServer(role: Role) {
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
    if (role === 'worker') return createSdkMcpServer({ name: 'hub', version: '0.4.0', tools: [listWorkers, listRepos] });

    return createSdkMcpServer({
      name: 'hub',
      version: '0.4.0',
      tools: [
        tool(
          'spawn_worker',
          t('tool.spawn'),
          {
            name: z.string().describe(t('tool.spawn.name')),
            mission: z.string().describe(t('tool.spawn.mission')),
            // nullish: models often send null for an optional field they mean to leave out.
            cwd: z.string().nullish().describe(t('tool.spawn.cwd', { cwd: masterCwd(cfg) })),
            model: z
              .enum(cfg.workerModels as [string, ...string[]])
              .nullish()
              .describe(t('tool.spawn.model')),
            effort: z.enum(WORKER_EFFORTS).nullish().describe(t('tool.spawn.effort')),
          },
          (args) => run(() => this.spawnWorker(args)),
        ),
        tool(
          'message_worker',
          t('tool.message'),
          {
            name: byName,
            message: z.string().describe(t('tool.message.message')),
            interrupt: z.boolean().nullish().describe(t('tool.message.interrupt')),
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
            run(() => {
              const s = this.findWorker(name);
              if (!s.query) return t('close.already', { name: s.name });
              if (this.isWorking(s) && !force) {
                s.closeWhenDone = true;
                const what = s.background.length > 0 ? t('close.tasks', { list: s.background.join(' ; ') }) : t('close.turn');
                return t('close.later', { name: s.name, what });
              }
              this.stop(s.id);
              return t('close.done', { name: s.name });
            }),
        ),
      ],
    });
  }

  private spawnWorker(args: { name: string; mission: string; cwd?: string | null; model?: string | null; effort?: Effort | null }): string {
    const { cfg } = this.opts;
    const mission = args.mission.trim();
    if (!mission) throw new Error(t('spawn.empty'));
    const cwd = args.cwd?.trim() || masterCwd(cfg);
    if (!isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(t('spawn.badDir', { cwd }));
    const model = args.model ?? cfg.worker.model;
    const effort = args.effort ?? (cfg.worker.effort || null);

    // Compared by checkout root, so a worker in a subfolder of the same folder counts too.
    const rootKey = (dir: string) => (repoRootOf(dir) ?? resolve(dir)).toLowerCase();
    const notes: string[] = [];
    const sameRepo = [...this.sessions.values()]
      .filter((w) => w.role === 'worker' && w.inbox && rootKey(w.cwd) === rootKey(cwd))
      .map((w) => w.name);
    if (sameRepo.length > 0) notes.push(t('spawn.sameRepo', { names: sameRepo.join(', ') }));
    if (!repoRootOf(cwd)) notes.push(t('spawn.noRepo', { cwd }));

    const s = this.create(`w-${randomUUID().slice(0, 8)}`, 'worker', this.uniqueName(args.name), mission, cwd, model, effort);
    s.owesReport = true;
    void this.launch(s, false, this.missionPrompt(s));
    return [
      t('spawn.started', { name: s.name, model: model || t('spawn.usualModel'), effort: effort ?? t('spawn.usualEffort'), cwd }),
      ...notes,
      t('spawn.howTo', { name: s.name }),
    ].join('\n');
  }

  private async messageWorker(args: { name: string; message: string; interrupt?: boolean | null }): Promise<string> {
    const s = this.findWorker(args.name);
    const message = args.message.trim();
    if (!message) throw new Error(t('message.empty'));
    const wasClosed = !s.inbox;
    const wasWorking = !wasClosed && this.isWorking(s);
    if (args.interrupt && s.query && wasWorking) await s.query.interrupt().catch(() => undefined);
    s.owesReport = true;
    s.closeWhenDone = false;
    this.deliver(s, { text: `${tags().master}\n${message}`, images: [], from: masterName() });
    if (wasClosed) return t('message.wasClosed', { name: s.name });
    if (args.interrupt && wasWorking) return t('message.interrupted', { name: s.name });
    return t(wasWorking ? 'message.queued' : 'message.delivered', { name: s.name });
  }

  private missionPrompt(s: Session): Prompt {
    return { text: `${tags().mission(s.name)}\n${s.mission}`, images: [], from: masterName() };
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
    const since = s.busySince && s.status !== 'idle' ? t('workers.since', { n: minutesSince(s.busySince) }) : '';
    return `${s.name} · ${t(`status.${s.status}`)}${since} · ${model} · ${ctx} · ${cost} · ${s.cwd}`;
  }

  private listWorkers(): string {
    const workers = [...this.sessions.values()].filter((s) => s.role === 'worker');
    if (workers.length === 0) return t('workers.none');
    return workers
      .map((s) => {
        const lines = [`- ${this.workerLine(s)}`, t('workers.mission', { text: oneLine(s.mission, 160) })];
        if (s.background.length > 0) lines.push(t('workers.background', { text: oneLine(s.background.join(' ; '), 200) }));
        if (s.lastMessage) lines.push(t('workers.last', { text: oneLine(s.lastMessage, 200) }));
        return lines.join('\n');
      })
      .join('\n');
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

  private findWorker(name: string): Session {
    const wanted = name.trim().toLowerCase();
    const s = [...this.sessions.values()].find((x) => x.role === 'worker' && (x.name === wanted || x.name === `hub-${wanted}`));
    if (!s) throw new Error(t('worker.notFound', { name }));
    return s;
  }

  private uniqueName(raw: string): string {
    const slug =
      raw
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/^hub-/, '')
        .slice(0, 28) || 'worker';
    const taken = new Set([...this.sessions.values()].map((s) => s.name));
    let name = `hub-${slug}`;
    for (let i = 2; taken.has(name); i++) name = `hub-${slug}-${i}`;
    return name;
  }

  // ---------- models ----------

  private modelOptions(): ModelOption[] {
    return this.modelInfos.map((m) => ({
      value: m.value,
      label: m.displayName,
      description: m.description,
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
    return info?.displayName ?? modelId.replace(/^claude-/, '');
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
    };
    this.sessions.set(id, s);
    return s;
  }

  /** Environment of a Claude Code process started by the hub: the hub's own, without a parent session's variables. */
  environment(): Record<string, string> {
    const { set, unset } = this.opts.sessionEnv();
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !PARENT_SESSION_VARS.test(key) && !unset.includes(key)) env[key] = value;
    }
    return { ...env, ...set };
  }

  private restore(): void {
    if (!existsSync(this.stateFile)) return;
    try {
      const saved = JSON.parse(readFileSync(this.stateFile, 'utf8')) as { sessions?: Persisted[] };
      for (const { resume, ...p } of saved.sessions ?? []) {
        // State saved before fixed* existed only holds display values: those sessions inherit from settings.json.
        const s = this.create(p.id, p.role, p.name, p.mission, p.cwd, p.fixedModel ?? '', p.fixedEffort ?? null);
        Object.assign(s, p, { status: 'exited' });
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
      // Read at close time: a worker cut mid-work (or before its CLI took the mission) is picked up at the next start.
      ...(s.inbox && !s.started ? { resume: 'mission' as const } : s.inbox && this.isWorking(s) ? { resume: 'work' as const } : {}),
    }));
    // Write-then-rename: a crash mid-save can never leave a truncated state.json behind.
    const tmp = `${this.stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ sessions }, null, 2));
    renameSync(tmp, this.stateFile);
  }
}
