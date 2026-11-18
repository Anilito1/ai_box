import { execFile } from 'node:child_process';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { totalsOf, type Totals } from '../../../shared/costs';

// `explore`: a question about the code a worker is in, answered by a cheap read-only helper (Haiku) that searches and
// reads in its own small context, so the worker does not pay one round trip of its large context per lookup. Measured
// in scripts/search-bench/tokens/rapport.md (section 6): explanation missions -45 % requests, -36 % cost, same success.
//
// The helper runs on the worker's own Claude Code, account and settings: the permission rules that refuse a read to
// the worker refuse it to the helper. It only has Read, Grep and Glob, inside the worker's folders; anything that would
// need a person's approval is refused. Few run at once, and each one's cost goes to the cost log.

export const EXPLORE_MODEL = 'haiku';
/** Helpers running at once for the whole hub: a call beyond them is answered at once, to do the lookups itself. */
export const MAX_EXPLORERS = 3;
/** The answer the asking session keeps: bounded whatever the helper writes. */
export const ANSWER_CHARS = 4000;
const TIMEOUT_MS = 180_000;
const OUTLINE_DIRS = 60;

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

export interface ExploreAsk {
  question: string;
  paths: string[];
  thorough: boolean;
}

/** Where and as whom the helper runs: the asking session's folder, its other folders, its program and environment. */
export interface ExploreHost {
  cwd: string;
  dirs: string[];
  executable: string;
  env: Record<string, string>;
}

export interface ExploreResult {
  text: string;
  error: boolean;
  /** What it cost, per model; null when nothing ran. */
  totals: Totals | null;
}

/** The folders of a repo two levels deep with their number of tracked files, a few hundred tokens; '' outside git. */
export function outlineFrom(files: string[]): string {
  const counts = new Map<string, number>();
  for (const file of files) {
    if (!file) continue;
    const parts = file.split('/');
    const dir = parts.length === 1 ? '.' : parts.slice(0, Math.min(parts.length - 1, 2)).join('/');
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, OUTLINE_DIRS)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dir, n]) => `${dir}/ (${n})`)
    .join('\n');
}

const OUTLINE_TTL_MS = 5 * 60_000;
const outlines = new Map<string, { at: number; text: Promise<string> }>();

function outlineOf(cwd: string): Promise<string> {
  const kept = outlines.get(cwd);
  if (kept && Date.now() - kept.at < OUTLINE_TTL_MS) return kept.text;
  const text = new Promise<string>((done) => {
    execFile('git', ['-C', cwd, 'ls-files'], { maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) => done(err ? '' : outlineFrom(stdout.split('\n'))));
  });
  outlines.set(cwd, { at: Date.now(), text });
  return text;
}

export function explorePrompt(ask: ExploreAsk, outline: string): string {
  return [ask.paths.length ? `Look first under: ${ask.paths.join(', ')}` : '', outline ? `Repo outline (folder, tracked files):\n${outline}` : '', `Question:\n${ask.question}`]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * The helper's options. Same settings files as the session (so its deny rules hold), but no hooks, no MCP server, no
 * slash command, nothing saved; Read, Grep and Glob only, inside the session's folders, and every request that would
 * ask a person refused.
 */
export function exploreOptions(host: ExploreHost, ask: ExploreAsk, abortController: AbortController): Options {
  const rounds = ask.thorough ? 6 : 4;
  return {
    abortController,
    cwd: host.cwd,
    ...(host.dirs.length > 0 ? { additionalDirectories: host.dirs } : {}),
    ...(host.executable ? { pathToClaudeCodeExecutable: host.executable } : {}),
    env: host.env,
    model: EXPLORE_MODEL,
    systemPrompt: HELPER_PROMPT.replace('{rounds}', String(rounds)),
    tools: ['Read', 'Grep', 'Glob'],
    settingSources: ['user', 'project', 'local'],
    settings: { disableAllHooks: true },
    mcpServers: {},
    strictMcpConfig: true,
    permissionMode: 'default',
    canUseTool: async () => ({ behavior: 'deny', message: 'Outside what the explorer may read.' }),
    persistSession: false,
    maxTurns: rounds * 3 + 4,
    maxBudgetUsd: 0.1,
  };
}

let running = 0;

/** One exploration. Never throws: a helper that cannot answer says so in words the asking session can act on. */
export async function explore(host: ExploreHost, ask: ExploreAsk, signal: AbortSignal): Promise<ExploreResult> {
  if (running >= MAX_EXPLORERS) return { text: 'Other explorations are running: use Grep, Glob and Read yourself.', error: true, totals: null };
  running++;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  const stop = () => abort.abort();
  signal.addEventListener('abort', stop, { once: true });
  let totals: Totals | null = null;
  try {
    const prompt = explorePrompt(ask, await outlineOf(host.cwd));
    for await (const msg of query({ prompt, options: exploreOptions(host, ask, abort) })) {
      if (msg.type !== 'result') continue;
      totals = totalsOf(msg.total_cost_usd, msg.modelUsage);
      const answer = msg.subtype === 'success' && !msg.is_error ? msg.result.trim() : '';
      if (!answer) return { text: 'The explorer did not reach an answer: use Grep, Glob and Read yourself.', error: true, totals };
      return { text: answer.length > ANSWER_CHARS ? `${answer.slice(0, ANSWER_CHARS)}\n[answer cut]` : answer, error: false, totals };
    }
    return { text: 'The explorer stopped without an answer: use Grep, Glob and Read yourself.', error: true, totals };
  } catch {
    return { text: 'The explorer could not run: use Grep, Glob and Read yourself.', error: true, totals };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
    running--;
  }
}
