import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isOpenAIHost } from '../shared/accounts';
import {
  adjustRequest,
  anthropicError,
  applyAdjustments,
  errorMessage,
  fromChatResponse,
  pickModel,
  sse,
  StreamTranslator,
  toChatRequest,
  ToolNames,
  type Target,
} from './bridgeFormat';

/** What the bridge needs of an OpenAI account, read at each request: a change of key or server applies at once. */
export interface BridgeAccount {
  baseUrl: string;
  key: string;
  model: string;
  smallModel: string;
}

type Json = Record<string, unknown>;

const BODY_MAX = 64 * 1024 * 1024;
const PING_MS = 15_000;
/** Refusals a request is adjusted for and sent again (a parameter the server does not take). */
const ADJUST_MAX = 4;

/**
 * Claude Code speaks Anthropic's Messages API; an OpenAI account's sessions point ANTHROPIC_BASE_URL at this server,
 * on 127.0.0.1 only, which translates each request to Chat Completions and the reply back. Sessions authenticate with
 * a token made for this run of the hub: the account's own key stays in the main process and never reaches them.
 */
export class Bridge {
  private server: Server | null = null;
  private port = 0;
  private readonly secret = randomBytes(24).toString('hex');
  /** Per account and model: what its server refused before, applied to the next requests. */
  private readonly learned = new Map<string, Set<string>>();

  constructor(private readonly lookup: (accountId: string) => BridgeAccount | null) {}

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => void this.handle(req, res));
    // Claude Code keeps a stream open for as long as a model thinks.
    server.requestTimeout = 0;
    server.headersTimeout = 60_000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    this.port = typeof address === 'object' && address ? address.port : 0;
    this.server = server;
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  /** ANTHROPIC_BASE_URL of an account's sessions. */
  url(accountId: string): string {
    return `http://127.0.0.1:${this.port}/${accountId}`;
  }

  /** ANTHROPIC_AUTH_TOKEN of every bridged session. */
  token(): string {
    return this.secret;
  }

  private authorized(req: IncomingMessage): boolean {
    const header = req.headers['x-api-key'] ?? req.headers.authorization ?? '';
    const given = Buffer.from(String(Array.isArray(header) ? header[0] : header).replace(/^Bearer\s+/i, ''));
    const want = Buffer.from(this.secret);
    return given.length === want.length && timingSafeEqual(given, want);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const fail = (status: number, message: string) => {
      const e = anthropicError(status, message);
      if (!res.headersSent) res.writeHead(e.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(e.body));
    };
    try {
      const m = /^\/(a-[a-z0-9]{8})(\/v1\/[\w/]+)$/.exec((req.url ?? '').split('?')[0]);
      if (!m) return fail(404, 'Not found');
      if (!this.authorized(req)) return fail(401, 'This bridge only answers the hub’s own sessions.');
      const account = this.lookup(m[1]);
      if (!account) return fail(404, 'This account no longer exists in the hub.');
      const route = m[2];
      if (req.method === 'GET' && route === '/v1/models') return this.models(res, account);
      if (req.method !== 'POST') return fail(405, 'Method not allowed');
      const body = await readJson(req);
      if (!body) return fail(400, 'The request body is not JSON.');
      if (route === '/v1/messages/count_tokens') return this.countTokens(res, body);
      if (route !== '/v1/messages') return fail(404, `${route} is not offered by the bridge.`);
      await this.messages(res, m[1], account, body);
    } catch (err) {
      fail(500, `Bridge: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The account's models, as Anthropic lists them. */
  private models(res: ServerResponse, account: BridgeAccount): void {
    const ids = [...new Set([account.model, account.smallModel].filter(Boolean))];
    const data = ids.map((id) => ({ type: 'model', id, display_name: id, created_at: '2026-01-01T00:00:00Z' }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data, has_more: false, first_id: ids[0] ?? null, last_id: ids.at(-1) ?? null }));
  }

  /** OpenAI has no token counter: an estimate, about four characters a token. */
  private countTokens(res: ServerResponse, body: Json): void {
    const size = JSON.stringify([body.system ?? '', body.messages ?? [], body.tools ?? []]).length;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ input_tokens: Math.ceil(size / 4) }));
  }

  private async messages(res: ServerResponse, accountId: string, account: BridgeAccount, body: Json): Promise<void> {
    const target: Target = {
      model: account.model,
      smallModel: account.smallModel,
      maxTokensField: isOpenAIHost(account.baseUrl) ? 'max_completion_tokens' : 'max_tokens',
    };
    const names = new ToolNames();
    const chat = toChatRequest(body, target, names);
    const key = `${accountId}\n${pickModel(body.model, target)}`;
    const learned = this.learned.get(key) ?? new Set<string>();
    applyAdjustments(chat, learned);

    // The session hung up (interrupted, closed): the request to the server stops with it.
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: chat.stream ? 'text/event-stream' : 'application/json' };
    if (account.key) headers.authorization = `Bearer ${account.key}`;
    const url = `${account.baseUrl.replace(/\/+$/, '')}/chat/completions`;

    let upstream: Response | null = null;
    for (let attempt = 0; attempt <= ADJUST_MAX; attempt++) {
      upstream = await fetch(url, { method: 'POST', headers, body: JSON.stringify(chat), signal: abort.signal });
      if (upstream.ok) break;
      const text = await upstream.text();
      const { message, code } = errorMessage(text);
      const change = attempt < ADJUST_MAX ? adjustRequest(chat, upstream.status, message) : null;
      if (change) {
        learned.add(change);
        this.learned.set(key, learned);
        continue;
      }
      // An exhausted quota is no rate limit: Claude Code would retry it for minutes.
      const status = code === 'insufficient_quota' ? 403 : upstream.status;
      const e = anthropicError(status, `${hostOf(account.baseUrl)}: ${message}`);
      res.writeHead(e.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(e.body));
      return;
    }
    if (!upstream?.ok) return;

    if (!chat.stream) {
      const reply = fromChatResponse((await upstream.json()) as Json, String(chat.model), names);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
      return;
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const stream = new StreamTranslator(String(chat.model), names);
    const write = (events: string[]) => {
      for (const e of events) res.write(e);
    };
    write(stream.start());
    const ping = setInterval(() => res.write(sse('ping', { type: 'ping' })), PING_MS);
    try {
      const reader = upstream.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let done = false;
      while (reader && !done) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            done = true;
            break;
          }
          let parsed: Json;
          try {
            parsed = JSON.parse(data) as Json;
          } catch {
            continue; // A comment or a keep-alive some servers send.
          }
          if (parsed.error) {
            write([sse('error', { type: 'error', error: { type: 'api_error', message: `${hostOf(account.baseUrl)}: ${errorMessage(JSON.stringify(parsed)).message}` } })]);
            res.end();
            return;
          }
          write(stream.push(parsed));
        }
      }
      write(stream.end());
      res.end();
    } catch (err) {
      if (!abort.signal.aborted) {
        write([sse('error', { type: 'error', error: { type: 'api_error', message: `${hostOf(account.baseUrl)}: ${err instanceof Error ? err.message : String(err)}` } })]);
      }
      res.end();
    } finally {
      clearInterval(ping);
    }
  }
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

function readJson(req: IncomingMessage): Promise<Json | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > BODY_MAX) {
        reject(new Error('request too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
      } catch {
        resolve(null);
      }
    });
    req.on('error', reject);
  });
}
