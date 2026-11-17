/**
 * Context windows as the runtime tells them (Claude Code's result and /context, Codex's and Gemini's usage), by the
 * model id the runtime itself reports: a `[1m]` suffix or an alias resolved to another id is another key, never guessed.
 * Nothing here is a table of models: a model never heard of has no window (0), and the meter says so.
 */
export class ContextWindows {
  private readonly known = new Map<string, number>();

  learn(windows: Record<string, number>): void {
    for (const [model, size] of Object.entries(windows)) if (model && size > 0) this.known.set(model, size);
  }

  /** The window of a model heard of before, 0 when not. */
  of(model: string): number {
    return this.known.get(model) ?? 0;
  }

  /**
   * The window of the model a turn ran on. A turn also lists the models of its subagents, so no max of them: the session's own
   * model, else the turn's only one, else 0.
   */
  ofTurn(windows: Record<string, number>, model: string): number {
    const sizes = Object.values(windows).filter((w) => w > 0);
    return windows[model] || this.of(model) || (sizes.length === 1 ? sizes[0] : 0);
  }
}
