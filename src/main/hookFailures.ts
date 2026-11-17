/** Failed hook runs, across all sessions, before the user is told: a hook that fails once may be a passing hiccup. */
export const HOOK_FAILURES_NOTICE = 10;

/**
 * Failed hook runs, counted across the sessions of the hub (Claude Code's hooks are the user's, shared by every
 * session). Hooks that fail on every tool call went unnoticed for two weeks (36,585 non-blocking errors, about half a
 * second each): the hub says it once, when the count reaches the threshold, with the hooks seen failing.
 */
export class HookFailures {
  private count = 0;
  private told = false;
  private readonly hooks = new Set<string>();

  constructor(private readonly threshold = HOOK_FAILURES_NOTICE) {}

  /** One more failure of `hook`; what to tell the first time the threshold is reached, else null. */
  add(hook: string): { count: number; hooks: string[] } | null {
    this.count++;
    if (hook) this.hooks.add(hook);
    if (this.told || this.count < this.threshold) return null;
    this.told = true;
    return { count: this.count, hooks: [...this.hooks] };
  }
}
