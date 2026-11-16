// The hub's search_code as a stand-alone MCP server (stdio), to measure a session with and without it outside the
// app (docs/recherche-semantique.md). It drives the built search host: `npm run build` first.
//   AIBOX_SEARCH_DATA  folder that holds search/{runtime,models,index} (the app's data folder, or a lab copy)
//   AIBOX_SEARCH_REPOS repo roots the search may index, separated by ";"
import { fork } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const dataDir = resolve(process.env.AIBOX_SEARCH_DATA ?? '');
const repos = (process.env.AIBOX_SEARCH_REPOS ?? process.cwd()).split(';').filter(Boolean).map((p) => resolve(p));
const settings = { enabled: true, idleMinutes: 5, device: 'auto', repos, budget: 1500 };

let host = null;
let seq = 0;
const waiting = new Map();
function call(method, ...args) {
  if (!host) {
    host = fork(join(dist, 'search-host.mjs'), [], { env: { ...process.env, AIBOX_SEARCH_HOST: JSON.stringify({ dataDir, workerScript: join(dist, 'search-worker.mjs'), settings, env: {} }) }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    host.on('message', (m) => {
      if (m.changed) return;
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.error !== undefined) w?.reject(new Error(m.error));
      else w?.resolve(m.result);
    });
    host.once('exit', () => {
      host = null;
      for (const w of waiting.values()) w.reject(new Error('The search stopped'));
      waiting.clear();
    });
  }
  return new Promise((done, fail) => {
    const id = ++seq;
    waiting.set(id, { resolve: done, reject: fail });
    host.send({ id, method, args });
  });
}

const server = new McpServer({ name: 'search', version: '0.1.0' });
server.tool(
  'search_code',
  'Local search of this repo by meaning and by exact names. Ask a question or describe a behaviour, in French or English: answers the best pieces as `path:lines symbol` with a short excerpt. To locate code, cheaper than Grep and reading whole files; then Read only the lines you need. Not exhaustive: Grep lists every occurrence.',
  {
    query: z.string().min(2).max(500).describe('Question or description of what you look for'),
    k: z.number().int().min(1).max(20).optional().describe('Number of results (default 8, 3 with expand)'),
    path: z.string().max(300).optional().describe('Only under this folder of the repo (e.g. src/main)'),
    expand: z.boolean().optional().describe('true: each piece whole instead of an excerpt'),
    budget: z.number().int().min(300).max(8000).optional().describe('Size of the answer in tokens (default 1500)'),
  },
  async (a) => {
    try {
      return { content: [{ type: 'text', text: await call('searchCode', process.cwd(), { query: a.query, k: a.k, expand: a.expand === true, budget: a.budget, under: a.path }) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
    }
  },
);
process.on('exit', () => host?.kill());
await server.connect(new StdioServerTransport());
