import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

type Json = Record<string, unknown>;

/** The server answered a request with an error. */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

export interface ServerRequest {
  id: string | number;
  method: string;
  params: Json;
}

export interface ClientOptions {
  executable: string;
  env: Record<string, string>;
  cwd?: string;
  version: string;
}

const STDERR_KEEP = 4000;

/**
 * `codex app-server` over stdio: one JSON message per line. The client sends requests and notifications, receives
 * answers, notifications of the server and requests of the server (approvals) that it must answer. It knows nothing of
 * threads or turns; the adapter does.
 */
export class CodexClient {
  private child: ChildProcess | null = null;
  private nextId = 0;
  private readonly waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private stderr = '';
  private closed = false;
  /** Set by the adapter before `start()`. */
  onNotification: (method: string, params: Json) => void = () => undefined;
  onRequest: (req: ServerRequest) => Promise<unknown> = () => Promise.reject(new RpcError('unsupported', -32601));
  /** The process ended (on its own, or closed): code, and the end of its stderr. */
  onExit: (info: { code: number | null; stderr: string; closed: boolean }) => void = () => undefined;

  constructor(private readonly opts: ClientOptions) {}

  /** Starts the server and completes the protocol's handshake. */
  async start(): Promise<void> {
    const child = spawn(this.opts.executable, ['app-server', '--listen', 'stdio://'], {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
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
    // A process that never started (no such file) fails the handshake with its own message.
    await Promise.race([
      this.request('initialize', { clientInfo: { name: 'claude_hub', title: 'Claude Hub', version: this.opts.version } }),
      exited.then(() => {
        throw new Error(this.stderr.trim() || 'codex app-server exited');
      }),
    ]);
    this.send({ method: 'initialized' });
  }

  private finish(code: number | null): void {
    for (const w of this.waiting.values()) w.reject(new Error(this.stderr.trim().split('\n').pop() || 'codex app-server exited'));
    this.waiting.clear();
    this.onExit({ code, stderr: this.stderr, closed: this.closed });
  }

  private send(message: Json): void {
    if (!this.child?.stdin?.writable) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request<T = Json>(method: string, params: Json = {}): Promise<T> {
    if (this.closed || !this.child) return Promise.reject(new Error('codex app-server is closed'));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.send({ id, method, params });
    });
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
      const params = (m.params ?? {}) as Json;
      this.onRequest({ id, method, params }).then(
        (result) => this.send({ id, result }),
        (err: unknown) => this.send({ id, error: { code: err instanceof RpcError ? err.code : -32603, message: err instanceof Error ? err.message : String(err) } }),
      );
    } else if (method) {
      this.onNotification(method, (m.params ?? {}) as Json);
    } else if (typeof id === 'number') {
      const w = this.waiting.get(id);
      if (!w) return;
      this.waiting.delete(id);
      const error = m.error as { message?: string; code?: number } | undefined;
      if (error) w.reject(new RpcError(error.message ?? 'request failed', error.code ?? -32603));
      else w.resolve(m.result);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child?.kill();
  }
}
