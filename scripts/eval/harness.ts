// One run of a prompt-eval scenario: the hub's real instructions and hub tools (built by the real SessionManager on a
// test roster), the real Claude Code through the Agent SDK, and no side effect. Hub tools that act (spawn, message,
// close...) are recorded and answered with a canned reply; Claude Code's own tools that write or run are recorded and
// refused ("not run in the eval"). Bundled by run.mjs against the current tree or another one (--ref).
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSdkMcpServer, query, tool, type HookCallback, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { loadConfig } from '../../src/main/config';
import type { CostLog } from '../../src/main/costLog';
import { setLang } from '../../src/main/i18n';
import type { McpHub } from '../../src/main/mcpHub';
import { clientDataVariant, groupInfo, masterPrompt, scratchSection, setMasterName, workerPrompt } from '../../src/main/prompts';
import type { HubTool } from '../../src/main/providers/types';
import { SessionManager } from '../../src/main/sessions';
import { SCRATCH_ENV } from '../../src/shared/purge';

export interface PostSpec {
  name: string;
  description: string;
  instructions?: string;
  folder: string;
  model?: string;
}
export interface WorkerSpec {
  name: string;
  mission: string;
  folder: string;
  model?: string;
  userModel?: boolean;
  lastMessage?: string;
  /** Instance of this post. */
  instanceOf?: string;
}
export interface Scenario {
  id: string;
  role: 'master' | 'worker';
  title: string;
  posts?: PostSpec[];
  workers?: WorkerSpec[];
  /** For a worker scenario: the session that runs (one of `workers`). */
  self?: string;
  /** Local repositories list_repos shows (folders of the test workspace). */
  repos?: string[];
  messages: string[];
  replies?: Record<string, string>;
  model?: string;
  effort?: string;
  maxTurns?: number;
}
export interface Call {
  tool: string;
  input: Record<string, unknown>;
  /** The API message (request) it came in. */
  request: string;
  refused?: boolean;
}
export interface RunResult {
  calls: Call[];
  /** Tool names per API response, in order. */
  requests: string[][];
  text: string;
  costUsd: number;
  turns: number;
  error: string;
  scratch: string;
}

/** Claude Code tools that only read: they run. Every other one is recorded and refused. */
const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'LS', 'ToolSearch', 'TodoWrite', 'Skill']);
/** Hub tools that only read the hub: their real answer, from the test roster. */
const REAL = new Set(['list_workers', 'topic']);

interface Inner {
  sessions: Map<string, Record<string, unknown>>;
  create(id: string, role: string, name: string, mission: string, cwd: string, model: string, effort: string | null): Record<string, unknown>;
  createRole(args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
  hubTools(s: unknown, harness?: string, remote?: boolean): HubTool[];
  memoryRules?(s: unknown): string;
  postOf(s: unknown): unknown;
  instanceInfo(s: unknown, post: unknown): unknown;
  groupsLed(s: unknown): unknown[];
  groupOf(s: unknown): unknown;
  prepareScratch(s: unknown): string | null;
  killAll?(): void;
}

const defaultReply = (name: string, input: Record<string, unknown>): string => {
  const who = String(input.name ?? input.worker ?? '').replace(/^hub-/, '');
  if (name === 'spawn_worker') return `Worker hub-${who || 'nouveau'} lancé.`;
  if (name === 'message_worker') return `Message remis à hub-${who}.`;
  if (name === 'close_worker') return `hub-${who} fermé.`;
  if (name === 'message_master') return 'Remis au maître.';
  return 'ok';
};

export async function runScenario(sc: Scenario, opts: { lang: 'fr' | 'en'; signal?: AbortSignal }): Promise<RunResult> {
  setLang(opts.lang);
  const dir = mkdtempSync(join(tmpdir(), `hub-eval-${sc.id}-`));
  const ws = join(dir, 'ws');
  mkdirSync(ws);
  const cfg = loadConfig(dir, opts.lang);
  cfg.workspaces = [ws];
  const folder = (f: string) => {
    const p = join(ws, f);
    mkdirSync(p, { recursive: true });
    return p;
  };
  const m = new SessionManager({
    cfg,
    dataDir: dir,
    executable: () => '',
    codexExecutable: () => '',
    geminiExecutable: () => '',
    mcpHub: {} as McpHub,
    sessionEnv: () => ({ set: {}, unset: [] }),
    persist: () => undefined,
    costLog: { limits: () => undefined, append: () => undefined } as unknown as CostLog,
    capabilities: async () => '',
  } as ConstructorParameters<typeof SessionManager>[0]);
  const inner = m as unknown as Inner;
  const result: RunResult = { calls: [], requests: [], text: '', costUsd: 0, turns: 0, error: '', scratch: '' };
  try {
    const signal = opts.signal ?? new AbortController().signal;
    for (const p of sc.posts ?? []) {
      await inner.createRole({ name: p.name, description: p.description, instructions: p.instructions ?? '', folders: [folder(p.folder)], ...(p.model ? { model: p.model } : {}) }, signal);
    }
    const byName = (name: string) => [...inner.sessions.values()].find((s) => s.name === `hub-${name}`);
    for (const w of sc.workers ?? []) {
      const post = w.instanceOf ? cfg.team.find((r) => r.name === w.instanceOf) : undefined;
      const s = inner.create(`w-${w.name}`, 'worker', `hub-${w.name}`, w.mission, folder(w.folder), w.model ?? '', null);
      Object.assign(s, { status: 'idle', started: true, lastMessage: w.lastMessage ?? '', ...(w.userModel ? { userModel: true, fixedModel: w.model ?? '' } : {}), ...(post ? { instanceOf: post.id } : {}) });
    }
    const repos = (sc.repos ?? []).map((r) => `- ${r} · ${folder(r)} · origin https://github.com/example/${r}.git · main`).join('\n');
    const master = inner.create('master', 'master', opts.lang === 'fr' ? 'hub-maitre' : 'hub-master', '', folder('master'), '', null);
    setMasterName(String(master.name));
    const self = sc.role === 'master' ? master : byName(sc.self ?? '');
    if (!self) throw new Error(`no session ${sc.self}`);

    // The instructions the hub appends to Claude Code's own, as at a launch (sessions.ts, launch()).
    let append: string;
    if (sc.role === 'master') append = masterPrompt(cfg);
    else {
      const post = inner.postOf(self);
      const instance = post && self.instanceOf ? inner.instanceInfo(self, post) : undefined;
      append = workerPrompt(cfg, (post ?? undefined) as never, instance as never, groupInfo(cfg, inner.groupsLed(self) as never, inner.groupOf(self) as never), clientDataVariant(cfg, ''));
      const scratch = inner.prepareScratch(self);
      if (scratch) {
        result.scratch = scratch;
        append += scratchSection(scratch, SCRATCH_ENV);
      }
    }
    append += inner.memoryRules ? inner.memoryRules(self) : '';

    const defs = inner.hubTools(self, 'claude', false);
    let request = '';
    const record = (name: string, input: Record<string, unknown>, refused = false) => result.calls.push({ tool: name, input, request, ...(refused ? { refused } : {}) });
    const hub = createSdkMcpServer({
      name: 'hub',
      version: 'eval',
      tools: defs.map((d) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tool(d.name, d.description, d.shape, (async (input: Record<string, unknown>, extra: unknown) => {
          record(`mcp__hub__${d.name}`, input);
          if (REAL.has(d.name)) return d.handler(input as never, extra as never);
          const text = sc.replies?.[d.name] ?? (d.name === 'list_repos' && repos ? repos : defaultReply(d.name, input));
          return { content: [{ type: 'text' as const, text }] };
        }) as any),
      ),
    });
    const guard: HookCallback = async (input) => {
      const call = input as { tool_name?: string; tool_input?: Record<string, unknown> };
      const name = call.tool_name ?? '';
      if (READ_ONLY.has(name) || name.startsWith('mcp__hub__')) return {};
      record(name, call.tool_input ?? {}, true);
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Eval: this tool call is recorded, not run. Go on as if it had worked.' } };
    };
    const disallowed = sc.role === 'master' ? ['Edit', 'Write', 'NotebookEdit', 'AskUserQuestion', 'SendMessage'] : ['AskUserQuestion', 'Workflow', 'ScheduleWakeup'];

    // The user turns, one at a time: the next once the previous turn ended.
    let next: (() => void) | null = null;
    const prompts = (async function* (): AsyncGenerator<SDKUserMessage> {
      for (const text of sc.messages) {
        yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' };
        await new Promise<void>((resolve) => (next = resolve));
      }
    })();
    const q = query({
      prompt: prompts,
      options: {
        cwd: String(self.cwd),
        model: sc.model ?? (sc.role === 'master' ? 'claude-opus-5-5' : 'claude-sonnet-5-5'),
        effort: (sc.effort ?? (sc.role === 'master' ? 'high' : 'medium')) as never,
        systemPrompt: { type: 'preset', preset: 'claude_code', append },
        disallowedTools: disallowed,
        mcpServers: { hub },
        allowedTools: defs.map((d) => `mcp__hub__${d.name}`),
        strictMcpConfig: true,
        maxTurns: sc.maxTurns ?? 10,
        // Cheaper writes for runs that follow each other within minutes; the main conversation is on 1 h in production.
        env: { ...(process.env as Record<string, string>), CLAUDE_CODE_PROMPT_CACHE_TTL: '5m', ...(sc.role === 'worker' ? { SLASH_COMMAND_TOOL_CHAR_BUDGET: '8000' } : {}) },
        // Before any permission rule of the user's settings: nothing that writes or runs leaves the eval.
        hooks: { PreToolUse: [{ hooks: [guard] }] },
      },
    });
    for await (const msg of q) {
      if (msg.type === 'assistant') {
        const id = msg.message.id;
        if (id !== request) {
          request = id;
          result.requests.push([]);
        }
        for (const b of msg.message.content) {
          if (b.type === 'tool_use') {
            result.requests[result.requests.length - 1].push(b.name);
            // Claude Code's own tools that ran are not recorded by canUseTool: noted here.
            if (READ_ONLY.has(b.name)) record(b.name, b.input as Record<string, unknown>);
          } else if (b.type === 'text') result.text += `${b.text}\n`;
        }
      } else if (msg.type === 'result') {
        result.costUsd += msg.total_cost_usd;
        result.turns += msg.num_turns;
        if (msg.subtype !== 'success') result.error = msg.subtype;
        const go = next;
        next = null;
        if (go) go();
      }
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    inner.killAll?.();
    rmSync(dir, { recursive: true, force: true });
  }
  return result;
}

// The hub's own launch settings, for the static check (S11): no conversation brought under the model's window.
import * as adapter from '../../src/main/providers/claude/adapter';
export const launchSettings = adapter.launchSettings;
export const fullWindow = (adapter as unknown as { fullWindow?: (model: string) => string }).fullWindow;
