import type { SubagentStatus, SubagentStep, SubagentView } from '../shared/types';
import type { Block } from './providers/blocks';
import type { AgentEvent } from './providers/types';
import { resultText, toolLabel, toolSummary } from './transcript';

// The subagents of one CLI process, followed from its stream: the Agent (or Task) call that launches one, the frames
// its model sends (parent_tool_use_id), its task events (task_started, task_progress, task_updated, task_notification)
// and the result of its call. A foreground subagent ends with its call's result; a background one gets a placeholder
// result at once, and ends with its notification. Pure but for the clock: the tests replay a stream through it.

/** The tools that launch a subagent: Agent, named Task by older CLIs. */
export const AGENT_TOOLS = new Set(['Agent', 'Task']);
/** Steps kept per subagent, and the length of one. */
const LOG_MAX = 40;
const STEP_MAX = 240;
const RESULT_MAX = 2000;
/** Ended subagents kept per session besides the running ones: the oldest go first. */
const KEEP_ENDED = 12;
/** What a background launch answers at once: the subagent is not over. */
const LAUNCHED = /^\s*(async agent launched|agent (is )?running in the background|launched in the background)/i;

type Task = Extract<AgentEvent, { type: 'agentTask' }>;
type Progress = Extract<AgentEvent, { type: 'agentProgress' }>;

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const clip = (text: string, max: number) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

export class Subagents {
  /** By the id of the call that launched it, else (a task whose call was not seen) by its task id. */
  private readonly list = new Map<string, SubagentView>();
  /** Task id → key in `list`. */
  private readonly tasks = new Map<string, string>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Those running now. */
  get running(): number {
    let n = 0;
    for (const a of this.list.values()) if (a.status === 'running') n++;
    return n;
  }

  /** Running ones first (oldest first), then the ended ones, latest first. */
  views(): SubagentView[] {
    const all = [...this.list.values()];
    const running = all.filter((a) => a.status === 'running').sort((a, b) => a.startedAt - b.startedAt);
    const ended = all.filter((a) => a.status !== 'running').sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    return [...running, ...ended].map((a) => ({ ...a, log: [...a.log] }));
  }

  /** The calls of a reply (the session's or a subagent's: one may launch its own). Says whether anything changed. */
  calls(blocks: Block[]): boolean {
    let changed = false;
    for (const b of blocks) {
      if (b.type !== 'tool_use' || !AGENT_TOOLS.has(str(b.name))) continue;
      const id = str(b.id);
      if (!id || this.list.has(id)) continue;
      const input = (b.input ?? {}) as Record<string, unknown>;
      this.add(id, {
        description: str(input.description) || clip(str(input.prompt), 80),
        agentType: str(input.subagent_type),
        model: str(input.model),
        background: input.run_in_background === true,
      });
      changed = true;
    }
    return changed;
  }

  /** A task starts or ends. Only subagent tasks come here (the translation keeps the others out). */
  task(ev: Task): boolean {
    let key = this.keyOf(ev.id, ev.toolUseId);
    if (ev.state === 'start') {
      if (!key) {
        key = ev.toolUseId || ev.id;
        this.add(key, { description: ev.description ?? '', agentType: ev.agentType ?? '', model: '', background: ev.background === true });
      }
      this.tasks.set(ev.id, key);
      const a = this.list.get(key) as SubagentView;
      if (ev.description && !a.description) a.description = ev.description;
      if (ev.agentType && !a.agentType) a.agentType = ev.agentType;
      if (ev.background) a.background = true;
      return true;
    }
    if (!key) return false;
    this.tasks.set(ev.id, key);
    const a = this.list.get(key) as SubagentView;
    if (ev.summary && !a.result) a.result = clip(ev.summary, RESULT_MAX);
    return this.end(a, ev.state === 'failed' ? 'failed' : ev.state);
  }

  progress(ev: Progress): boolean {
    const key = this.keyOf(ev.id, ev.toolUseId);
    const a = key ? this.list.get(key) : undefined;
    if (!a) return false;
    this.tasks.set(ev.id, a.id);
    if (ev.background) a.background = true;
    const line = ev.summary ? clip(ev.summary, STEP_MAX) : ev.lastTool ? toolLabel(ev.lastTool) : '';
    // Its frames say more than the name of its last tool: a summary is the only thing worth adding.
    if (ev.summary && line !== a.activity) this.step(a, 'text', line);
    else if (line && !a.activity) Object.assign(a, { activity: line, activityAt: this.now() });
    return true;
  }

  /** A frame of a subagent's own: what its model wrote and called, the errors its tools gave back. */
  steps(parent: string, blocks: Block[]): boolean {
    let changed = this.calls(blocks);
    const a = this.list.get(parent);
    if (!a) return changed;
    for (const b of blocks) {
      if (b.type === 'text' && str(b.text).trim()) {
        this.step(a, 'text', clip(str(b.text), STEP_MAX));
        changed = true;
      } else if (b.type === 'tool_use') {
        const name = str(b.name);
        const summary = toolSummary(name, (b.input ?? {}) as Record<string, unknown>);
        a.tools++;
        this.step(a, 'tool', clip(`${toolLabel(name)} ${summary}`, STEP_MAX));
        changed = true;
      } else if (b.type === 'tool_result' && b.is_error === true) {
        this.step(a, 'error', clip(resultText(b.content), STEP_MAX));
        changed = true;
      }
    }
    return changed;
  }

  /** Results of the session's calls: a foreground subagent ends with its own. */
  results(blocks: Block[]): boolean {
    let changed = false;
    for (const b of blocks) {
      const a = this.list.get(str(b.tool_use_id));
      if (!a || a.status !== 'running') continue;
      const text = resultText(b.content);
      const failed = b.is_error === true;
      // Launched in the background: the result only says so; its notification will end it.
      if (!failed && (a.background || LAUNCHED.test(text))) {
        a.background = true;
        continue;
      }
      if (text) a.result = text.length > RESULT_MAX ? `${text.slice(0, RESULT_MAX - 1)}…` : text;
      changed = this.end(a, failed ? 'failed' : 'done') || changed;
    }
    return changed;
  }

  /** The process is gone: what still ran was stopped with it. */
  stopAll(): boolean {
    let changed = false;
    for (const a of this.list.values()) if (a.status === 'running') changed = this.end(a, 'stopped') || changed;
    this.tasks.clear();
    return changed;
  }

  private keyOf(taskId: string, toolUseId?: string): string | null {
    if (toolUseId && this.list.has(toolUseId)) return toolUseId;
    const key = this.tasks.get(taskId) ?? (this.list.has(taskId) ? taskId : null);
    return key && this.list.has(key) ? key : null;
  }

  private add(id: string, a: Pick<SubagentView, 'description' | 'agentType' | 'model' | 'background'>): void {
    this.list.set(id, { id, ...a, status: 'running', startedAt: this.now(), endedAt: null, activity: '', activityAt: null, tools: 0, log: [], result: '' });
  }

  private step(a: SubagentView, kind: SubagentStep['kind'], text: string): void {
    const at = this.now();
    a.log.push({ at, kind, text });
    if (a.log.length > LOG_MAX) a.log.splice(0, a.log.length - LOG_MAX);
    a.activity = text;
    a.activityAt = at;
  }

  /** The first end counts: its update and its notification both say it. */
  private end(a: SubagentView, status: Exclude<SubagentStatus, 'running'>): boolean {
    if (a.status !== 'running') return false;
    a.status = status;
    a.endedAt = this.now();
    this.prune();
    return true;
  }

  private prune(): void {
    const ended = [...this.list.values()].filter((a) => a.status !== 'running').sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    for (const a of ended.slice(KEEP_ENDED)) {
      this.list.delete(a.id);
      for (const [task, key] of this.tasks) if (key === a.id) this.tasks.delete(task);
    }
  }
}
