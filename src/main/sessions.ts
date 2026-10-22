import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  createSdkMcpServer,
  getSessionInfo,
  getSessionMessages,
  query,
  resolveSettings,
  tool,
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
  STATUS_LABEL,
  type ChatItem,
  type Effort,
  type HubSnapshot,
  type Metrics,
  type Mode,
  type ModelOption,
  type PermissionDecision,
  type RateLimits,
  type Role,
  type SessionView,
} from '../shared/types';
import type { HubConfig } from './config';
import { MASTER_NAME, masterPrompt, workerPrompt } from './prompts';
import { findRepos, repoRootOf } from './repos';
import { assistantItems, blocksOf, resultText, toolDetail, toolLabel, toolSummary, userTextItem } from './transcript';

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

interface Session extends SessionView {
  sessionId: string;
  /** True once the conversation exists on disk, i.e. it can be resumed. */
  started: boolean;
  costBase: number;
  items: Map<string, ChatItem>;
  query: Query | null;
  inbox: Inbox | null;
  pending: Map<string, (decision: PermissionDecision) => void>;
  liveId: string | null;
  liveText: string;
  historyLoaded: boolean;
  /** Explicit choices (config, master's spawn args, composer): the only model/effort passed at launch. Empty = settings.json. */
  fixedModel: string;
  fixedEffort: Effort | null;
  /** The inherited effort was already resolved for the current model. */
  effortResolved: boolean;
}

type Persisted = Pick<
  Session,
  | 'id'
  | 'role'
  | 'name'
  | 'mission'
  | 'cwd'
  | 'model'
  | 'modelLabel'
  | 'effort'
  | 'mode'
  | 'lastMessage'
  | 'metrics'
  | 'createdAt'
  | 'sessionId'
  | 'started'
  | 'fixedModel'
  | 'fixedEffort'
>;

export interface ManagerOptions {
  cfg: HubConfig;
  dataDir: string;
}

const MASTER_ID = 'master';
const WORKER_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
const ITEMS_MAX = 1500;
const ITEMS_TRIM = 300;
const HISTORY_MAX = 400;
// Exported by a parent Claude Code session (e.g. when the hub is started from one); children must not inherit them.
const PARENT_SESSION_VARS =
  /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(CHILD_SESSION|SESSION_ID|MESSAGING_SOCKET|MESSAGING_TOKEN|SESSION_ATTENDED|ENTRYPOINT|EXECPATH))$/;

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
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
  private quitting = false;
  private readonly stateFile: string;

  constructor(private readonly opts: ManagerOptions) {
    super();
    this.stateFile = join(opts.dataDir, 'state.json');
    this.restore();
  }

  // ---------- lifecycle ----------

  startMaster(): void {
    const { cfg } = this.opts;
    const master =
      this.sessions.get(MASTER_ID) ??
      this.create(MASTER_ID, 'master', MASTER_NAME, '', cfg.masterCwd, cfg.master.model, cfg.master.effort || null);
    void this.launch(master, master.started);
  }

  send(id: string, text: string): void {
    const s = this.sessions.get(id);
    const prompt = text.trim();
    if (!s || !prompt) return;
    if (s.inbox) this.pushUser(s, prompt);
    else void this.launch(s, s.started, prompt);
  }

  interrupt(id: string): void {
    void this.sessions.get(id)?.query?.interrupt();
  }

  stop(id: string): void {
    const s = this.sessions.get(id);
    const q = s?.query;
    if (!s || !q) return;
    s.inbox?.close();
    this.teardown(s);
    q.close();
    this.changed();
  }

  resume(id: string): void {
    const s = this.sessions.get(id);
    if (s && !s.inbox) void this.launch(s, s.started);
  }

  remove(id: string): void {
    const s = this.sessions.get(id);
    if (!s || s.role !== 'worker' || s.inbox) return;
    this.sessions.delete(id);
    this.changed();
  }

  killAll(): void {
    this.quitting = true;
    this.save();
    for (const s of this.sessions.values()) {
      s.inbox?.close();
      s.query?.close();
    }
  }

  busyWorkers(): number {
    return [...this.sessions.values()].filter((s) => s.role === 'worker' && s.query && (s.status === 'busy' || s.status === 'attention'))
      .length;
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
      .catch((err: unknown) => this.notice(s, `Changement de modèle refusé : ${errorText(err)}`, 'error'));
    this.changed();
  }

  setEffort(id: string, effort: Effort): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.fixedEffort = effort;
    s.effort = effort;
    s.query?.applyFlagSettings({ effortLevel: effort }).catch((err: unknown) => this.notice(s, `Changement d'effort refusé : ${errorText(err)}`, 'error'));
    this.changed();
  }

  setMode(id: string, mode: Mode): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.mode = mode;
    s.query?.setPermissionMode(mode).catch((err: unknown) => this.notice(s, `Changement de mode refusé : ${errorText(err)}`, 'error'));
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
      }));
    return { sessions, models: this.modelOptions(), rateLimits: this.rateLimits };
  }

  allItems(): [string, ChatItem[]][] {
    return [...this.sessions.values()].map((s) => [s.id, [...s.items.values()]]);
  }

  // ---------- SDK session ----------

  private async launch(s: Session, resume: boolean, firstPrompt?: string): Promise<void> {
    const { cfg } = this.opts;
    // Claimed synchronously: a send() or resume() during the awaits below queues into this inbox instead of launching twice.
    const inbox = new Inbox();
    s.inbox = inbox;
    s.status = 'starting';
    s.liveId = null;
    this.changed();

    // Resume only a conversation still on disk; an unreadable check keeps the id rather than dropping the link to it.
    if (resume && !(await getSessionInfo(s.sessionId, { dir: s.cwd }).then(Boolean, () => true))) {
      resume = false;
      s.sessionId = randomUUID();
    }
    if (resume) await this.loadHistory(s);
    if (this.quitting) return;

    const isMaster = s.role === 'master';
    s.mode ??= (cfg.permissionMode || 'auto') as Mode;
    const options: Options = {
      cwd: s.cwd,
      // No model/effort = the CLI resolves them from settings.json, exactly like a normal session.
      ...(s.fixedModel ? { model: s.fixedModel } : {}),
      ...(s.fixedEffort ? { effort: s.fixedEffort } : {}),
      permissionMode: s.mode,
      ...(cfg.claudePath ? { pathToClaudeCodeExecutable: cfg.claudePath } : {}),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: isMaster ? masterPrompt(cfg) : workerPrompt() },
      // Master and workers talk through native cross-session messaging (SendMessage). They all run in a prompting
      // mode, so Claude Code's default mode-parity rule delivers their messages without widening crossSessionInbound.
      // replay-user-messages surfaces incoming cross-session messages (origin.kind === 'peer') on the stream.
      extraArgs: { name: s.name, 'replay-user-messages': null },
      includePartialMessages: true,
      disallowedTools: isMaster ? ['Edit', 'Write', 'NotebookEdit', 'AskUserQuestion'] : ['AskUserQuestion'],
      mcpServers: { hub: this.hubServer(s.role) },
      allowedTools: ['mcp__hub'],
      canUseTool: (name, input, o) => this.askPermission(s, name, input, o),
      env: this.env(),
      ...(resume ? { resume: s.sessionId } : { sessionId: s.sessionId }),
    };

    const q = query({ prompt: inbox, options });
    s.query = q;
    s.costBase = resume ? (s.metrics?.costUsd ?? 0) : 0;
    if (firstPrompt) this.pushUser(s, firstPrompt);
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
    if (failure && !this.quitting) this.notice(s, `Session arrêtée : ${failure}`, 'error');
    this.changed();
  }

  private teardown(s: Session): void {
    s.query = null;
    s.inbox = null;
    s.liveId = null;
    for (const finish of [...s.pending.values()]) finish({ behavior: 'deny', message: 'Session arrêtée.' });
    s.status = 'exited';
    s.busySince = null;
  }

  private onMessage(s: Session, q: Query, msg: SDKMessage): void {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          s.started = true;
          s.sessionId = msg.session_id;
          s.mode = msg.permissionMode;
          if (msg.effort) s.effort = msg.effort;
          this.applyModel(s, msg.model);
        } else if (msg.subtype === 'compact_boundary') {
          this.notice(s, 'Contexte compacté', 'info');
        }
        break;
      case 'stream_event': {
        if (msg.parent_tool_use_id) return;
        const before = s.status;
        this.markBusy(s);
        if (msg.event.type === 'content_block_start' && msg.event.content_block.type === 'text') {
          s.liveId = `live-${randomUUID()}`;
          s.liveText = '';
        } else if (msg.event.type === 'content_block_delta' && msg.event.delta.type === 'text_delta' && s.liveId) {
          s.liveText += msg.event.delta.text;
          this.upsert(s, { kind: 'assistant', id: s.liveId, text: s.liveText, live: true });
        }
        // Deltas travel on the items channel; the snapshot only needs a refresh when the status flips.
        if (s.status !== before) this.changed();
        return;
      }
      case 'assistant': {
        if (msg.parent_tool_use_id) break;
        this.markBusy(s);
        const blocks = blocksOf(msg.message);
        const hasText = blocks.some((b) => b.type === 'text');
        for (const item of assistantItems(blocks, msg.uuid, hasText ? (s.liveId ?? undefined) : undefined)) this.upsert(s, item);
        if (hasText) s.liveId = null;
        if (msg.error) this.notice(s, `Erreur : ${msg.error}`, 'error');
        const u = msg.message.usage;
        const tokens = (u?.input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0);
        if (tokens > 0) this.setContext(s, tokens, s.metrics?.contextSize ?? 0);
        break;
      }
      case 'user': {
        if (msg.parent_tool_use_id) break;
        const blocks = blocksOf(msg.message);
        if (msg.origin?.kind === 'peer') {
          // `body` (the sender's raw text) is sent by the CLI but not yet in the SDK typings.
          const origin = msg.origin as typeof msg.origin & { body?: string };
          const text = origin.body ?? userTextItem(blocks, '')?.text ?? '';
          this.upsert(s, { kind: 'peer', id: `peer-${msg.uuid ?? randomUUID()}`, from: origin.name || origin.from, text });
          break;
        }
        for (const b of blocks) {
          if (b.type !== 'tool_result') continue;
          const item = s.items.get(String(b.tool_use_id));
          if (item?.kind === 'tool') this.upsert(s, { ...item, result: resultText(b.content), isError: b.is_error === true });
        }
        break;
      }
      case 'result': {
        s.liveId = null;
        s.status = s.pending.size > 0 ? 'attention' : 'idle';
        if (s.status === 'idle') s.busySince = null;
        if (msg.subtype === 'success') {
          if (msg.result.trim()) s.lastMessage = msg.result;
        } else {
          this.notice(s, 'Tour interrompu', 'info');
        }
        const windows = Object.values(msg.modelUsage ?? {}).map((m) => m.contextWindow);
        const size = Math.max(s.metrics?.contextSize ?? 0, ...windows);
        this.setContext(s, s.metrics?.contextTokens ?? 0, size);
        if (s.metrics) s.metrics.costUsd = s.costBase + msg.total_cost_usd;
        void this.refreshContext(s, q);
        void this.refreshUsage(q);
        break;
      }
    }
    this.changed();
  }

  private markBusy(s: Session): void {
    if (s.status === 'attention') return;
    if (s.status !== 'busy') s.busySince = Date.now();
    s.status = 'busy';
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
    if (s.status === 'starting') s.status = 'idle';
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
    if (opts.signal.aborted) return Promise.resolve({ behavior: 'deny', message: 'Demande annulée.' });
    const id = `perm-${randomUUID()}`;
    const item: ChatItem = {
      kind: 'permission',
      id,
      tool: toolLabel(toolName),
      summary: toolSummary(toolName, input),
      ...toolDetail(toolName, input),
      reason: opts.decisionReason ?? '',
      // "Always allow" persists the CLI's suggested rules; without suggestions it would silently be a one-time allow.
      canAlways: (opts.suggestions?.length ?? 0) > 0,
      state: 'pending',
    };
    this.upsert(s, item);
    s.status = 'attention';
    this.emit('attention', s.id);
    this.changed();

    return new Promise((resolve) => {
      const settle = (state: 'allowed' | 'denied' | 'expired', result: PermissionResult) => {
        if (!s.pending.delete(id)) return;
        this.upsert(s, { ...item, state });
        if (s.status === 'attention' && s.pending.size === 0) s.status = 'busy';
        this.changed();
        resolve(result);
      };
      s.pending.set(id, (d) => {
        if (d.behavior === 'deny') {
          settle('denied', { behavior: 'deny', message: d.message?.trim() || "L'utilisateur a refusé cette action." });
        } else {
          const always = d.behavior === 'always' && opts.suggestions ? { updatedPermissions: opts.suggestions } : {};
          settle('allowed', { behavior: 'allow', updatedInput: input, ...always });
        }
      });
      opts.signal.addEventListener('abort', () => settle('expired', { behavior: 'deny', message: 'Demande annulée.' }), { once: true });
    });
  }

  private pushUser(s: Session, text: string): void {
    this.upsert(s, { kind: 'user', id: `user-${randomUUID()}`, text });
    s.inbox?.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: s.sessionId });
    this.markBusy(s);
    this.changed();
  }

  private async loadHistory(s: Session): Promise<void> {
    if (s.historyLoaded) return;
    s.historyLoaded = true;
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
      return; // No readable transcript: the view starts empty.
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

  // ---------- hub tools (in-process MCP server) ----------

  /** Master: spawn/list/report/stop workers + repos. Workers: read-only list_workers + list_repos, to coordinate. */
  private hubServer(role: Role) {
    const { cfg } = this.opts;
    const run = (fn: () => string) => {
      try {
        return Promise.resolve({ content: [{ type: 'text' as const, text: fn() }] });
      } catch (err) {
        return Promise.resolve({ content: [{ type: 'text' as const, text: errorText(err) }], isError: true });
      }
    };
    const byName = { name: z.string().describe('Nom du worker (ex. "hub-fix-api")') };
    const listWorkers = tool(
      'list_workers',
      'Tous les workers du hub : statut, repo (cwd), mission, modèle, effort, contexte, coût, aperçu du dernier message.',
      {},
      () => run(() => this.listWorkers()),
    );
    const listRepos = tool(
      'list_repos',
      `Dépôts git locaux sous ${cfg.masterCwd} : nom, chemin, remote, branche courante. Le cwd d'un worker = la racine du repo.`,
      {},
      () => run(() => this.listRepos()),
    );
    if (role === 'worker') return createSdkMcpServer({ name: 'hub', version: '0.3.0', tools: [listWorkers, listRepos] });

    return createSdkMcpServer({
      name: 'hub',
      version: '0.3.0',
      tools: [
        tool(
          'spawn_worker',
          "Lance un worker Claude Code dans le hub, avec une mission autonome. Retourne son nom de session (adresse SendMessage). Le worker t'enverra son rapport final via SendMessage.",
          {
            name: z.string().describe('Nom court en kebab-case décrivant la mission (ex. "fix-api")'),
            mission: z
              .string()
              .describe('Brief complet et autonome : objectif, contexte, contraintes, critère de fin. Le worker ne voit pas ta conversation.'),
            // nullish: models often send null for an optional field they mean to leave out.
            cwd: z.string().nullish().describe(`Racine absolue du repo concerné (voir list_repos ; défaut : ${cfg.masterCwd})`),
            model: z
              .enum(cfg.workerModels as [string, ...string[]])
              .nullish()
              .describe("À omettre par défaut : le worker hérite de la config habituelle de l'utilisateur"),
            effort: z.enum(WORKER_EFFORTS).nullish().describe("À omettre par défaut : effort habituel de l'utilisateur"),
          },
          (args) => run(() => this.spawnWorker(args)),
        ),
        listWorkers,
        listRepos,
        tool("worker_report", "Mission et dernier message complet d'un worker.", byName, ({ name }) =>
          run(() => {
            const s = this.findWorker(name);
            return `${s.name} · ${STATUS_LABEL[s.status]}\n\nMission :\n${s.mission}\n\nDernier message :\n${s.lastMessage || '(aucun)'}`;
          }),
        ),
        tool('stop_worker', 'Arrête un worker. Sa conversation reste reprenable depuis le hub.', byName, ({ name }) =>
          run(() => {
            const s = this.findWorker(name);
            this.stop(s.id);
            return `${s.name} arrêté. Conversation reprenable depuis le hub.`;
          }),
        ),
      ],
    });
  }

  private spawnWorker(args: { name: string; mission: string; cwd?: string | null; model?: string | null; effort?: Effort | null }): string {
    const { cfg } = this.opts;
    const mission = args.mission.trim();
    if (!mission) throw new Error('Mission vide.');
    const cwd = args.cwd?.trim() || cfg.masterCwd;
    if (!isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`Dossier invalide : ${cwd}`);
    const model = args.model ?? cfg.worker.model;
    const effort = args.effort ?? (cfg.worker.effort || null);

    // Compared by repository root, so a worker in a subfolder of the same repo counts too.
    const repoKey = (dir: string) => (repoRootOf(dir) ?? resolve(dir)).toLowerCase();
    const notes: string[] = [];
    const sameRepo = [...this.sessions.values()]
      .filter((w) => w.role === 'worker' && w.inbox && repoKey(w.cwd) === repoKey(cwd))
      .map((w) => w.name);
    if (sameRepo.length > 0) {
      notes.push(`⚠ Déjà actif dans ce repo : ${sameRepo.join(', ')}. Coordonne-les (nomme-les dans les briefs) ou réutilise l'existant.`);
    }
    if (!repoRootOf(cwd)) notes.push(`ℹ ${cwd} n'est dans aucun repo git (voir list_repos).`);

    const s = this.create(`w-${randomUUID().slice(0, 8)}`, 'worker', this.uniqueName(args.name), mission, cwd, model, effort);
    void this.launch(s, false, `[Mission du maître — tu es le worker "${s.name}"]\n${mission}`);
    return [
      `Worker lancé : "${s.name}" (${model || 'modèle habituel'} · ${effort ?? 'effort habituel'}) dans ${cwd}.`,
      ...notes,
      `Pour lui écrire : SendMessage(to: "${s.name}"). Il t'enverra son rapport final.`,
    ].join('\n');
  }

  /** Cached 30 s: the scan is synchronous and every worker may call it. */
  private listRepos(): string {
    if (this.reposCache && Date.now() - this.reposCache.at < 30_000) return this.reposCache.text;
    const root = this.opts.cfg.masterCwd;
    const repos = findRepos(root);
    const text =
      repos.length === 0
        ? `Aucun repo git trouvé sous ${root}.`
        : repos.map((r) => `- ${r.name} · ${r.path} · ${r.remote || 'sans remote'} · branche ${r.branch}`).join('\n');
    this.reposCache = { at: Date.now(), text };
    return text;
  }

  private listWorkers(): string {
    const workers = [...this.sessions.values()].filter((s) => s.role === 'worker');
    if (workers.length === 0) return 'Aucun worker.';
    return workers
      .map((s) => {
        const m = s.metrics;
        const ctx = m?.contextPct != null ? `ctx ${Math.round(m.contextPct)}%` : 'ctx —';
        const cost = m ? `$${m.costUsd.toFixed(2)}` : '$—';
        const last = s.lastMessage ? `\n  dernier : ${oneLine(s.lastMessage, 200)}` : '';
        const model = `${s.modelLabel || s.model || 'modèle habituel'}/${s.effort ?? 'effort habituel'}`;
        return `- ${s.name} · ${STATUS_LABEL[s.status]} · ${model} · ${ctx} · ${cost} · ${s.cwd}\n  mission : ${oneLine(s.mission, 160)}${last}`;
      })
      .join('\n');
  }

  private findWorker(name: string): Session {
    const wanted = name.trim().toLowerCase();
    const s = [...this.sessions.values()].find((x) => x.role === 'worker' && (x.name === wanted || x.name === `hub-${wanted}`));
    if (!s) throw new Error(`Worker introuvable : "${name}". Utilise list_workers.`);
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
      sessionId: randomUUID(),
      started: false,
      costBase: 0,
      items: new Map(),
      query: null,
      inbox: null,
      pending: new Map(),
      liveId: null,
      liveText: '',
      historyLoaded: false,
      fixedModel: model,
      fixedEffort: effort,
      effortResolved: false,
    };
    this.sessions.set(id, s);
    return s;
  }

  private env(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !PARENT_SESSION_VARS.test(key)) env[key] = value;
    }
    return env;
  }

  private restore(): void {
    if (!existsSync(this.stateFile)) return;
    try {
      const saved = JSON.parse(readFileSync(this.stateFile, 'utf8')) as { sessions?: Persisted[] };
      for (const p of saved.sessions ?? []) {
        // State saved before fixed* existed only holds display values: those sessions inherit from settings.json.
        const s = this.create(p.id, p.role, p.name, p.mission, p.cwd, p.fixedModel ?? '', p.fixedEffort ?? null);
        Object.assign(s, p, { status: 'exited' });
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
      this.save();
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
      mode: s.mode,
      lastMessage: s.lastMessage,
      metrics: s.metrics,
      createdAt: s.createdAt,
      sessionId: s.sessionId,
      started: s.started,
      fixedModel: s.fixedModel,
      fixedEffort: s.fixedEffort,
    }));
    // Write-then-rename: a crash mid-save can never leave a truncated state.json behind.
    const tmp = `${this.stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ sessions }, null, 2));
    renameSync(tmp, this.stateFile);
  }
}
