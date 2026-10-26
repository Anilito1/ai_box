import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { HubTool } from './providers/types';

/** What a session that cannot take in-process tools holds: where its tools are, and how to give them up. */
export interface McpLease {
  url: string;
  token: string;
  dispose(): void;
}

const BODY_MAX = 8 * 1024 * 1024;

/**
 * The hub's tools for programs that reach MCP servers over HTTP (Codex). One server on 127.0.0.1 only, a token made
 * for each launch of a session (it names the session, so a tool stays closed on the session that called it) and no
 * other way in. Stateless: each request gets a server of its own, built from the tools the token was given.
 */
export class McpHub {
  private server: Server | null = null;
  private port = 0;
  private readonly leases = new Map<string, HubTool[]>();

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => void this.handle(req, res));
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
    this.leases.clear();
  }

  register(tools: HubTool[]): McpLease {
    const token = randomBytes(24).toString('hex');
    this.leases.set(token, tools);
    return { url: `http://127.0.0.1:${this.port}/mcp`, token, dispose: () => void this.leases.delete(token) };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const end = (status: number, body = '') => {
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    };
    try {
      const token = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1] ?? '';
      const tools = this.leases.get(token);
      if (!tools || (req.url ?? '').split('?')[0] !== '/mcp') return end(tools ? 404 : 401);
      if (req.method !== 'POST') return end(405, JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }));
      const body = await readJson(req);
      const mcp = new McpServer({ name: 'hub', version: '0.6.0' });
      for (const def of tools) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mcp.tool(def.name, def.description, def.shape, ((args: unknown, extra: unknown) => def.handler(args, extra)) as any);
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      end(500, JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: err instanceof Error ? err.message : String(err) }, id: null }));
    }
  }
}

function readJson(req: IncomingMessage): Promise<unknown> {
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
        resolve(chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined);
      } catch {
        reject(new Error('The request body is not JSON.'));
      }
    });
    req.on('error', reject);
  });
}
