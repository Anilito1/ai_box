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
// The folder the session works in; AIBOX_SEARCH_CWD when that is a throwaway worktree of an indexed repo (the A/B's
// modification missions): its paths are the repo's.
const here = process.env.AIBOX_SEARCH_CWD ?? process.cwd();
const repos = (process.env.AIBOX_SEARCH_REPOS ?? here).split(';').filter(Boolean).map((p) => resolve(p));
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

// The words the hub should give its sessions too (src/main/i18n.ts, src/main/providers/claude/adapter.ts): what is
// measured is what would ship. Claude Code defers MCP tools behind its tool search, showing the model only their names
// until it loads them; `alwaysLoad` keeps search_code in the prompt, for a few hundred cached tokens a request.
//   AIBOX_SEARCH_EXPOSE  how the agent learns of the tools, to compare: deferred | always (default) | instructions | both | hint (deferred, a hint by its name)
const expose = process.env.AIBOX_SEARCH_EXPOSE ?? 'always';
const INSTRUCTIONS =
  'Local index of the repo you work in. To find where something is (a feature, a behaviour, a name you are not sure of), call search_code before Grep, Glob or reading files, then Read only the line ranges it gives. For what a table, an RPC, an edge function or a scheduled job is: where_is. Keep Grep to list every occurrence of an exact string.';
const ALWAYS = expose === 'always' || expose === 'both' ? { 'anthropic/alwaysLoad': true } : expose === 'hint' ? { 'anthropic/searchHint': 'find code by behaviour or name in this repo, local, cheaper than Grep+Read' } : {};
const server = new McpServer({ name: 'search', version: '0.3.0' }, expose === 'instructions' || expose === 'both' ? { instructions: INSTRUCTIONS } : {});
server.registerTool(
  'search_code',
  {
    description:
      'Use first when you do not know which file holds something: a behaviour or a feature described in French or English, a name you are unsure of, a path. One call replaces several rounds of Grep, Glob and exploratory reads. Answers the best places as `path:start-end symbol (score)` with a short excerpt, about 800 tokens; then Read only those lines. "No confident match": use Grep. Local, nothing leaves this computer. Not exhaustive: Grep lists every occurrence of an exact string.',
    inputSchema: {
      query: z.string().min(2).max(500).describe('A described behaviour, a name or a path'),
      k: z.number().int().min(1).max(20).optional().describe('Number of places (default 5, 3 with expand)'),
      path: z.string().max(300).optional().describe('Only under this folder (e.g. src/main)'),
      expand: z.boolean().optional().describe('Whole pieces instead of excerpts (more tokens)'),
      budget: z.number().int().min(300).max(8000).optional().describe('Answer size in tokens (default 800)'),
    },
    _meta: ALWAYS,
  },
  (a) => answer(() => call('searchCode', here, { query: a.query, k: a.k, expand: a.expand === true, budget: a.budget, under: a.path })),
);
server.registerTool(
  'where_is',
  {
    description:
      'What a name is across the indexed repos (edge function, table, SQL function, scheduled job, policy, function of the code): its current definition as `repo path:lines`, and where it is used. Use it instead of grepping several repos or the migrations for a name. Instant, no model, a few lines.',
    inputSchema: { name: z.string().min(2).max(200).describe('The exact name (e.g. a table, an RPC, an edge function slug)') },
  },
  (a) => answer(() => call('whereIs', here, a.name)),
);
process.on('exit', () => host?.kill());
await server.connect(new StdioServerTransport());
