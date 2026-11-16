// The hub's search tools as a stand-alone MCP server (stdio), to measure a session with and without them outside
// the app (docs/recherche-semantique.md). It drives the built search host: `npm run build` first.
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
const settings = { enabled: true, idleMinutes: 5, device: process.env.AIBOX_SEARCH_DEVICE ?? 'auto', repos, budget: 800 };

let host = null;
let seq = 0;
const waiting = new Map();
function call(method, ...args) {
  if (!host) {
    host = fork(join(dist, 'search-host.mjs'), [], { env: { ...process.env, AIBOX_SEARCH_HOST: JSON.stringify({ dataDir, workerScript: join(dist, 'search-worker.mjs'), settings }) }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
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
const answer = async (work) => {
  try {
    return { content: [{ type: 'text', text: await work() }] };
  } catch (err) {
    return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
};

// The same words as the hub gives its sessions (src/main/i18n.ts): what is measured is what would ship.
const server = new McpServer({ name: 'search', version: '0.2.0' });
server.tool(
  'search_code',
  'Finds where something is in a repo: give a name of the code, a path, or describe a behaviour (French or English). Answers `path:lines symbol (score)` with a short excerpt; then Read only those lines. Local, nothing leaves this computer. Not exhaustive: Grep lists every occurrence.',
  {
    query: z.string().min(2).max(500).describe('Question or description of what you look for'),
    k: z.number().int().min(1).max(20).optional().describe('Number of results (default 5, 3 with expand)'),
    path: z.string().max(300).optional().describe('Only under this folder of the repo (e.g. src/main)'),
    expand: z.boolean().optional().describe('true: each piece whole instead of an excerpt'),
    budget: z.number().int().min(300).max(8000).optional().describe('Size of the answer in tokens (default 800)'),
  },
  (a) => answer(() => call('searchCode', process.cwd(), { query: a.query, k: a.k, expand: a.expand === true, budget: a.budget, under: a.path })),
);
server.tool(
  'where_is',
  'What a name is across the indexed repos (edge function, table, SQL function, scheduled job, policy, function of the code): its current definition as `repo path:lines`, and where it is used. Instant, no model.',
  { name: z.string().min(2).max(200).describe('The exact name (e.g. a table, an RPC, an edge function slug)') },
  (a) => answer(() => call('whereIs', process.cwd(), a.name)),
);
process.on('exit', () => host?.kill());
await server.connect(new StdioServerTransport());
