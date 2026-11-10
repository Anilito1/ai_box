/** Correlation stays inside adapters so existing provider event consumers remain compatible. */
export type OperationTerminal = 'success' | 'interrupted' | 'failed';
export interface Operation {
  readonly generation: number;
  readonly opId: number;
  readonly inputId: number;
  readonly kind: 'turn' | 'compact';
  turnId: string | null;
  interrupted: boolean;
  terminal: OperationTerminal | null;
}

/** One process generation, one active operation; terminal notifications win over delayed RPC replies. */
export class OperationLifecycle {
  private generation = 0;
  private sequence = 0;
  private readonly retiredTurns = new Set<string>();
  active: Operation | null = null;

  begin(kind: Operation['kind']): Operation {
    if (this.active) throw new Error('An operation is already active');
    const op: Operation = { generation: this.generation, opId: ++this.sequence, inputId: this.sequence, kind, turnId: null, interrupted: false, terminal: null };
    this.active = op;
    return op;
  }

  owns(op: Operation): boolean {
    return this.active === op && op.generation === this.generation && op.terminal === null;
  }

  bind(op: Operation, turnId: string): boolean {
    if (!this.owns(op) || !turnId || this.retiredTurns.has(turnId) || (op.turnId !== null && op.turnId !== turnId)) return false;
    op.turnId = turnId;
    return true;
  }

  matches(turnId: string): boolean {
    const op = this.active;
    return !!op && !!turnId && this.bind(op, turnId);
  }

  finish(op: Operation, terminal: OperationTerminal): boolean {
    if (!this.owns(op)) return false;
    op.terminal = terminal;
    if (op.turnId) this.retiredTurns.add(op.turnId);
    this.active = null;
    return true;
  }

  /** Invalidate callbacks captured before the process was closed or replaced. */
  invalidate(): void {
    this.generation++;
    this.active = null;
  }
}
