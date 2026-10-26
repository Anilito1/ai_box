import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

type Json = Record<string, unknown>;

/** The agent answered a request with an error (`code` is JSON-RPC's, or the HTTP status the CLI forwards). */
export class AcpError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

export interface AcpRequest {
  id: string | number;
  method: string;
  params: Json;
}

export interface AcpOptions {
  executable: string;
  env: Record<string, string>;
  cwd?: string;
  version: string;
}

const STDERR_KEEP = 4000;

/**
 * `gemini --acp` over stdio: the Agent Client Protocol, JSON-RPC 2.0 with one message per line. The client sends
 * requests and notifications, receives answers, notifications of the agent (session/update) and requests of the agent
 * (a permission to ask) that it must answer. It knows nothing of sessions or turns; the adapter does.
 */
export class AcpClient {
  private child: ChildProcess | null = null;
  private nextId = 0;
  private readonly waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private stderr = '';
  private closed = false;
  onNotification: (method: string, params: Json) => void = () => undefined;
  onRequest: (req: AcpRequest) => Promise<unknown> = () => Promise.reject(new AcpError('unsupported', -32601));
  onExit: (info: { code: number | null; stderr: string; closed: boolean }) => void = () => undefined;

  constructor(private readonly opts: AcpOptions) {}

  /** Starts the agent and completes the handshake; answers what the agent says it can do. */
  async start(): Promise<Json> {
    const child = spawn(this.opts.executable, ['--acp'], { cwd: this.opts.cwd, env: this.opts.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    child.stderr?.on('data', (d: Buffer) => (this.stderr = (this.stderr + d.toString()).slice(-STDERR_KEEP)));
    const exited = new Promise<void>((resolve) => {
      child.once('error', (err) => {
        this.stderr += String(err.message);
        this.finish(null);
        resolve();
      });
      child.once('exit', (code) => {
        this.finish(code);
        resolve();
      });
    });
    if (child.stdout) createInterface({ input: child.stdout }).on('line', (line) => this.receive(line));
    return (await Promise.race([
      this.request('initialize', { protocolVersion: 1, clientCapabilities: {} }),
      exited.then(() => {
        throw new Error(this.stderr.trim() || 'gemini exited');
      }),
    ])) as Json;
  }

  private finish(code: number | null): void {
    for (const w of this.waiting.values()) w.reject(new Error(this.stderr.trim().split('\n').pop() || 'gemini exited'));
    this.waiting.clear();
    this.onExit({ code, stderr: this.stderr, closed: this.closed });
  }

  private send(message: Json): void {
    if (!this.child?.stdin?.writable) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  request<T = Json>(method: string, params: Json = {}): Promise<T> {
    if (this.closed || !this.child) return Promise.reject(new Error('gemini is closed'));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: Json = {}): void {
    this.send({ method, params });
  }

  private receive(line: string): void {
    let m: Json;
    try {
      m = JSON.parse(line) as Json;
    } catch {
      return; // A log line, not a message.
    }
    const id = m.id as string | number | undefined;
    const method = typeof m.method === 'string' ? m.method : '';
    if (method && id !== undefined) {
      this.onRequest({ id, method, params: (m.params ?? {}) as Json }).then(
        (result) => this.send({ id, result }),
        (err: unknown) => this.send({ id, error: { code: err instanceof AcpError ? err.code : -32603, message: err instanceof Error ? err.message : String(err) } }),
      );
    } else if (method) {
      this.onNotification(method, (m.params ?? {}) as Json);
    } else if (typeof id === 'number') {
      const w = this.waiting.get(id);
      if (!w) return;
      this.waiting.delete(id);
      const error = m.error as { message?: string; code?: number } | undefined;
      if (error) w.reject(new AcpError(error.message ?? 'request failed', error.code ?? -32603));
      else w.resolve(m.result);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child?.kill();
  }
}
