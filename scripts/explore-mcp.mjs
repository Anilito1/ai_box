// `explore` as a stand-alone MCP server (stdio): a question about the repo, answered by a cheap read-only helper that
// explores in its own small context, so the session that asks does not pay one round trip of its large context per
// lookup. Prototype of the delegated exploration (scripts/search-bench/tokens/rapport.md, section 6), measured by
// scripts/search-bench/missions.mjs (arms explore-*) and scripts/search-bench/explore-eval.mjs.
//   EXPLORE_MODEL   the helper's model alias (default haiku)
//   EXPLORE_CWD     the repo it explores (default: where the server starts)
//   EXPLORE_LEDGER  a JSONL file that receives one line per call: cost, turns, time (numbers only)
//   EXPLORE_EXPOSE  always (default: description in the prompt) | deferred (name only, behind the tool search)
//   EXPLORE_EFFORT  the helper's effort (default: the model's own)
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const CLAUDE = process.env.CLAUDE_BIN ?? (process.platform === 'win32' ? join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe') : 'claude');
/** The answer the asking session keeps: bounded whatever the helper writes. */
const ANSWER_CHARS = 4000;
const TIMEOUT_MS = 180_000;

export const HELPER_PROMPT = `You explore a code repository for another agent, which acts on your answer without opening the files again. You only read: Grep, Glob, Read.

How to work
- At most {rounds} rounds of tool calls. In every round, send all the calls that do not depend on each other in the same message: several Grep, Glob and Read together.
- Grep with a head_limit; Read the lines around a match (offset, limit), never a whole file of more than 300 lines.
- Stop as soon as you can answer. An outline of the repo is given with the question: start from it.

Your answer
- 25 lines at most, no preamble, no advice.
- First the direct answer in one or two sentences.
- Then one line per step or fact: \`path:start-end\` and what the code does there, with the exact names and values as written (functions, constants, strings).
- When the caller means to change something, give the exact line that holds it and the other places that must change with it.
- Say plainly what you did not find or did not check.`;

/** The repo's shape in a few hundred tokens: its folders two levels deep with their number of tracked files. */
export function outlineOf(cwd) {
  const r = spawnSync('git', ['-C', cwd, 'ls-files'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) return '';
  const counts = new Map();
  for (const file of r.stdout.split('\n')) {
    if (!file) continue;
    const parts = file.split('/');
    const dir = parts.length === 1 ? '.' : parts.slice(0, Math.min(parts.length - 1, 2)).join('/');
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 60)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dir, n]) => `${dir}/ (${n})`)
    .join('\n');
}

/**
 * One exploration: the helper's answer and what it cost. `seed` is more to start from (a map of the repo, likely
 * places). Never throws: a helper that fails says so in words the
 * asking session can act on (fall back to its own lookups).
 */
export function explore({ cwd, question, paths = [], thorough = false, model = process.env.EXPLORE_MODEL ?? 'haiku', seed = '' }) {
  const rounds = thorough ? 6 : 4;
  const prompt = [
    paths.length ? `Look first under: ${paths.join(', ')}` : '',
    `Repo outline (folder, tracked files):\n${outlineOf(cwd)}`,
    seed,
    `Question:\n${question}`,
  ].filter(Boolean).join('\n\n');
  const args = [
    '-p', prompt,
    '--model', model,
    '--output-format', 'json',
    '--system-prompt', HELPER_PROMPT.replace('{rounds}', String(rounds)),
    '--tools', 'Read,Grep,Glob',
    '--allowedTools', 'Read,Grep,Glob',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', '',
    // Read-only and kept inside the repo: no tool that runs code, no file outside the working folder.
    '--restricted',
    '--disable-slash-commands',
    '--no-session-persistence',
    // The rounds are a rule of the prompt; these only stop a helper that runs away.
    '--max-turns', String(rounds * 3 + 4),
    '--max-budget-usd', model === 'haiku' ? '0.10' : '0.60',
    ...(process.env.EXPLORE_EFFORT ? ['--effort', process.env.EXPLORE_EFFORT] : []),
  ];
  const t0 = Date.now();
  return new Promise((done) => {
    const child = spawn(CLAUDE, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    const end = (text, row = {}) => {
      clearTimeout(timer);
      const entry = { at: new Date().toISOString(), model, wallMs: Date.now() - t0, questionChars: question.length, answerChars: text.length, ...row };
      if (process.env.EXPLORE_LEDGER) appendFileSync(process.env.EXPLORE_LEDGER, `${JSON.stringify(entry)}\n`);
      done({ text, ...entry });
    };
    child.once('error', () => end('The explorer could not start. Use Grep and Read yourself.', { error: 'spawn' }));
    child.once('close', () => {
      let out = null;
      try {
        out = JSON.parse(stdout);
      } catch {}
      const u = out?.usage ?? {};
      const row = { costUsd: out?.total_cost_usd ?? 0, turns: out?.num_turns ?? 0, apiMs: out?.duration_api_ms ?? 0, input: u.input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0 };
      const answer = typeof out?.result === 'string' && !out.is_error ? out.result.trim() : '';
      if (!answer) return end('The explorer did not reach an answer. Use Grep and Read yourself.', { ...row, error: out?.subtype ?? 'no-answer' });
      end(answer.length > ANSWER_CHARS ? `${answer.slice(0, ANSWER_CHARS)}\n[answer cut]` : answer, row);
    });
  });
}

export const EXPLORE_DESCRIPTION =
  'Ask how something works or where it is in this repo; a fast read-only helper explores in its own context (many searches and reads) and answers with `path:lines` references, so your context does not grow with every lookup. Use it instead of a series of Grep, Glob and Read whenever finding out would take more than one or two lookups: how a feature works, where a behaviour, a text or a value is set, what calls what. Put everything you need to know in one call, and say what you will do with it (explain, or change something: it then gives the exact lines). Afterwards Read only the lines you must edit. Not for a file whose path you already know: Read it.';

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const cwd = resolve(process.env.EXPLORE_CWD ?? process.cwd());
  const server = new McpServer({ name: 'explore', version: '0.1.0' });
  server.registerTool(
    'explore',
    {
      description: EXPLORE_DESCRIPTION,
      inputSchema: {
        question: z.string().min(8).max(2000).describe('What you need to know, and what for (explain, or edit)'),
        paths: z.array(z.string().max(300)).max(8).optional().describe('Folders or files to look at first'),
        thorough: z.boolean().optional().describe('More rounds, for a question that spans several parts of the repo'),
      },
      _meta: (process.env.EXPLORE_EXPOSE ?? 'always') === 'always' ? { 'anthropic/alwaysLoad': true } : {},
    },
    async (a) => {
      const r = await explore({ cwd, question: a.question, paths: a.paths ?? [], thorough: a.thorough === true });
      return { content: [{ type: 'text', text: r.text }], ...(r.error ? { isError: true } : {}) };
    },
  );
  await server.connect(new StdioServerTransport());
}
