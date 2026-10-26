import type { ZodRawShape } from 'zod';
import type { Totals } from '../../shared/costs';
import type { Effort, HarnessId, Mode, RateLimits } from '../../shared/types';
import type { Block } from './blocks';

// What the session manager knows of an AI agent, whichever program runs it. An adapter (providers/<harness>) starts the
// program, turns its own protocol into AgentEvents and carries the hub's requests back; the manager keeps everything
// that is the hub's own (topics, worktrees, posts, handoff, costs, idle closing).

export type { HarnessId };

/** A model an account offers, with the efforts it takes. */
export interface AgentModel {
  value: string;
  displayName: string;
  description: string;
  /** The canonical model id `value` stands for (an alias), when known. */
  resolvedModel?: string;
  efforts: Effort[];
}

/** A command or skill of the program (typed with a "/"), as it lists them. */
export interface AgentCommand {
  name: string;
  description: string;
  argumentHint: string;
  aliases?: string[];
}

/** A tool of the hub offered to an agent (spawn_worker, message_master…), in MCP's shape. */
export interface HubToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}
export interface HubTool {
  name: string;
  description: string;
  shape: ZodRawShape;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any, extra?: unknown) => Promise<HubToolResult>;
}

/** A message for the agent: text, or text and images, as the Messages API writes it. */
export interface AgentInput {
  content: string | Block[];
}

export interface PermissionRequest {
  tool: string;
  input: Record<string, unknown>;
  /** Why the program asks, in its own words (may be empty). */
  reason: string;
  /** Allowing it for good is possible (the program proposed a rule). */
  canAlways: boolean;
  signal: AbortSignal;
}
export type PermissionAnswer = { behavior: 'allow'; always: boolean } | { behavior: 'deny'; message: string };

/** An MCP server asking the user something (a confirmation before a destructive query, a form, a sign-in). */
export interface ElicitationRequest {
  serverName: string;
  message: string;
  mode?: 'form' | 'url';
  requestedSchema?: Record<string, unknown>;
}
export type ElicitationAnswer = { action: 'accept'; content: Record<string, boolean | string> } | { action: 'decline' };

/**
 * A provider told the agent it cannot go on for now. `resetsAt` (epoch seconds) says when it can, when it knows.
 * Phase 4 turns these into a cooldown of the account and a fallback to the next one.
 */
export interface LimitSignal {
  kind: 'rate' | 'quota' | 'overloaded' | 'auth';
  resetsAt: number | null;
  /** Where it came from (an event or error name), for the log. */
  source: string;
}

export type AgentEvent =
  /** The conversation the process runs: its id (given by the program for some), model, effort and permission mode. */
  | { type: 'conversation'; id: string; mode: Mode; effort: Effort | null; model: string }
  | { type: 'compacted'; before: number; after?: number }
  | { type: 'commands'; commands: AgentCommand[] }
  | { type: 'compacting'; on: boolean }
  | { type: 'retry' }
  /** Level signal: the background tasks running now (their descriptions). */
  | { type: 'background'; tasks: string[] }
  | { type: 'agentTask'; id: string; state: 'start' | 'done' | 'failed' }
  | { type: 'limit'; signal: LimitSignal }
  /** A fragment of the reply being written: a text block starts, or text is added to it. */
  | { type: 'stream'; textStart: boolean; delta: string }
  | { type: 'assistant'; id: string; blocks: Block[]; error: string; contextTokens: number }
  /** One of the hub's prompts reached the model (the program replays it as it takes it). */
  | { type: 'promptTaken'; text: string }
  /** A message from another session, delivered by the program's own messaging. */
  | { type: 'peer'; id: string | null; from: string; body: string | null; blocks: Block[] }
  | { type: 'toolResults'; blocks: Block[] }
  | {
      type: 'turn';
      /** `subtype` is 'success' unless the turn was cut or failed; `isError`: a "success" that carries an error's wording. */
      subtype: string;
      isError: boolean;
      result: string;
      /** Prompts still waiting in the program's queue, when it says. */
      queued: number | null;
      contextWindows: number[];
      /** Running totals of the conversation. */
      usage: Totals;
    }
  /** Something arrived that changes nothing but "the session is alive". */
  | { type: 'activity' };

export interface LaunchSpec {
  role: 'master' | 'worker';
  /** The session's name: how other sessions address it. */
  name: string;
  cwd: string;
  extraDirs: string[];
  readOnly: boolean;
  /** Empty = the program's own choice (its settings). */
  model: string;
  effort: Effort | null;
  mode: Mode | null;
  /** The hub's instructions for this session, added to the program's own. */
  instructions: string;
  /** Instructions that never change between launches of this session (a post, the master). */
  stableInstructions: boolean;
  tools: HubTool[];
  /** Absolute path of the program, empty = its default. */
  executable: string;
  env: Record<string, string>;
  conversation: { id: string; resume: boolean };
  input: AsyncIterable<AgentInput>;
  onPermission(req: PermissionRequest): Promise<PermissionAnswer>;
  onElicitation(req: ElicitationRequest, signal: AbortSignal): Promise<ElicitationAnswer>;
}

export interface AgentProcess {
  /** Iterated once, by the manager; ends when the process ends, throws when it fails. */
  readonly events: AsyncIterable<AgentEvent>;
  /** Answers once the process is ready for prompts. */
  ready(): Promise<{ models: AgentModel[]; commands: AgentCommand[] }>;
  interrupt(): Promise<void>;
  close(): void;
  setModel(model: string): Promise<void>;
  setEffort(effort: Effort): Promise<void>;
  setMode(mode: Mode): Promise<void>;
  context(): Promise<{ tokens: number; size: number; model: string }>;
  /** Running totals of the conversation so far (a resumed one carries its earlier turns); rejects when unknown. */
  totals(): Promise<Totals>;
  /** The plan limits of the account, null when the program has none to tell. */
  rateLimits(): Promise<RateLimits | null>;
}

/** A message of a stored conversation, as the program kept it. */
export interface HistoryMessage {
  role: 'user' | 'assistant';
  id: string;
  blocks: Block[];
}

export interface ProviderAdapter {
  readonly harness: HarnessId;
  start(spec: LaunchSpec): AgentProcess;
  /** The conversation is still stored (can be resumed); an unreadable check says yes rather than lose the link. */
  hasConversation(id: string, cwd: string): Promise<boolean>;
  /** The stored conversation, oldest first; throws when it cannot be read. */
  history(id: string, cwd: string): Promise<HistoryMessage[]>;
  /** The permission mode the program would start in, before it says (from its own settings). */
  defaultMode(cwd: string): Promise<Mode | null>;
  /** The effort its settings give a model, when the program does not report it; undefined when they cannot be read. */
  inheritedEffort(cwd: string, models: string[]): Promise<Effort | null | undefined>;
  /** A start that failed because the program is not installed. */
  isMissingProgram(failure: string): boolean;
}
