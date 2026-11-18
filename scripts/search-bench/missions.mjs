// The same missions run by Claude Code under several conditions, to compare tokens, time and success
// (docs/recherche-semantique.md). `npm run build` first; the repos must already be indexed in AIBOX_SEARCH_DATA.
//   node scripts/search-bench/missions.mjs <missions.json> <out.jsonl> [runs=3] [model=sonnet] [arms=current,bounded,brief,tool]
// missions.json: [{ "id": "…", "cwd": "C:/…/repo" or "repo": "name under AIBOX_BENCH_REPOS", "prompt": "…", "expect": ["path/cited.ts"] }]
//   AIBOX_SEARCH_EXPOSE  how the tool arms show the search tools (scripts/search-mcp.mjs); BENCH_MAX_TURNS cuts each run short
// Arms (nothing here touches the hub's prompts: each condition is given by this test's own configuration):
//   current     Claude Code as the workers run today
//   bounded     + the bounded-reading rule
//   brief       + 5 to 10 likely places added to the mission, found by the search before the launch
//   tool        + the search tools and the bounded-reading rule
//   tool+brief  + the tools, the brief and the rule
//   tool-bare   + the tools alone, as they would ship without a word in the prompts
//   tool-cited  + the tools and the instruction that names them (no bounded-reading rule)
//   batch       + the rule that groups independent lookups in one message
//   explore     + the explore tool (scripts/explore-mcp.mjs: a cheap helper in its own context) and the rule that names it
//   explore-sonnet  the same, the helper on Sonnet
//   explore-bare  + the explore tool alone
//   agent       + Claude Code's own sub-agents, with an "explorer" on the helper's model and prompt, and the rule that names it
//   EXPLORE_MODEL  the helper's model for the explore and agent arms (default haiku)
//   BENCH_PAD_TOKENS  fills every session's system prompt with that many tokens of unrelated text, to measure in the
//                     large context the real sessions have (the padding is the same for every arm and mission)
//   BENCH_SPEND_FILE  the study's ceiling, shared with the other benches (budget.mjs); else BENCH_BUDGET_USD for this run
//   BENCH_ONLY  comma-separated mission ids, to run a part of the file
import { fork, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HELPER_PROMPT } from '../explore-mcp.mjs';
import { budget as sharedBudget } from './budget.mjs';

const [missionsFile, outFile, runs = '3', model = 'sonnet', arms = 'current,bounded,brief,tool'] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', '..', 'dist');
const only = process.env.BENCH_ONLY?.split(',');
const missions = JSON.parse(readFileSync(missionsFile, 'utf8')).filter((m) => !only || only.includes(m.id)).map((m) => ({ ...m, cwd: m.cwd ?? join(resolve(process.env.AIBOX_BENCH_REPOS ?? ''), m.repo) }));
const dataDir = resolve(process.env.AIBOX_SEARCH_DATA ?? '');
// The program itself, not npm's shim: no shell stands between the prompt and Claude Code.
const CLAUDE = process.env.CLAUDE_BIN ?? (process.platform === 'win32' ? join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe') : 'claude');

/** The bounded-reading rule proposed for the workers' instructions, measured as written. */
export const BOUNDED_RULE =
  "Lecture économe : cherche d'abord (Grep ciblé, avec head_limit), puis lis seulement la plage utile (Read avec offset/limit), jamais un fichier entier de plus de 200 lignes. Pas de `cat`, `sed`, `head` ni `tail` en Bash pour lire un fichier. Ne relis pas un fichier ou une plage déjà lus dans la session.";
/** The instruction proposed with the search tools. */
export const SEARCH_RULE =
  "Pour localiser du code, commence par `search_code` (un nom du code, un chemin, ou un comportement décrit en français ou en anglais) ou `where_is` (table, RPC, edge function, tâche planifiée) : ils renvoient `chemin:lignes`. Lis ensuite seulement ces lignes. S'ils répondent « No confident match », passe à Grep. Garde Grep pour lister toutes les occurrences d'un nom exact.";

/** The rule proposed to group lookups. */
export const BATCH_RULE =
  "Regroupe tes recherches : quand plusieurs Grep, Glob ou Read ne dépendent pas les uns des autres, lance-les tous dans le même message plutôt qu'un par un, car chaque message relit toute la conversation. Avec Grep, demande le contexte autour des correspondances (-C) plutôt que de relire le fichier ensuite.";
/** The instruction proposed with the explore tool. */
export const EXPLORE_RULE =
  "Pour comprendre ou localiser du code, pose ta question à `explore` (une seule fois, avec tout ce que tu veux savoir et ce que tu comptes en faire) au lieu d'enchaîner des Grep, Glob et Read : il explore dans son propre contexte et répond avec des `chemin:lignes`. Fie-toi à sa réponse ; ne relis ensuite que les lignes que tu dois modifier. Lis directement un fichier dont tu connais déjà le chemin.";
/** The same, for Claude Code's own sub-agent. */
export const AGENT_RULE =
  'Pour comprendre ou localiser du code, pose ta question au sous-agent `explorer` (outil Agent, subagent_type "explorer", run_in_background false pour attendre sa réponse, une seule fois, avec tout ce que tu veux savoir et ce que tu comptes en faire) au lieu d\'enchaîner des Grep, Glob et Read : il explore dans son propre contexte et répond avec des `chemin:lignes`. Fie-toi à sa réponse ; ne relis ensuite que les lignes que tu dois modifier. Lis directement un fichier dont tu connais déjà le chemin.';
const HELPER_MODEL = process.env.EXPLORE_MODEL ?? 'haiku';

const scratch = join(here, '..', '..', 'node_modules', '.search-bench');
mkdirSync(scratch, { recursive: true });
const mcpWith = join(scratch, `mcp-with-${process.pid}.json`);
const mcpWithout = join(scratch, `mcp-without-${process.pid}.json`);
writeFileSync(mcpWithout, JSON.stringify({ mcpServers: {} }));
const ledger = join(scratch, `explore-ledger-${process.pid}.jsonl`);

/**
 * Unrelated text of a given size, the same on every run: type declarations shipped with the dev dependencies. It
 * stands for the conversation a real session already holds when it explores.
 */
function padding(tokens) {
  const lib = join(here, '..', '..', 'node_modules', 'typescript', 'lib');
  let text = '';
  for (const name of readdirSync(lib).filter((n) => /^lib\..*\.d\.ts$/.test(n)).sort()) {
    if (text.length >= tokens * PAD_CHARS_PER_TOKEN) break;
    text += readFileSync(join(lib, name), 'utf8');
  }
  return `Earlier in this conversation you worked on something else. What you read then is kept below; it has nothing to do with the next request.\n<earlier-context>\n${text.slice(0, Math.round(tokens * PAD_CHARS_PER_TOKEN))}\n</earlier-context>`;
}
// Measured on this text: 480 000 characters came to 202 242 tokens.
const PAD_CHARS_PER_TOKEN = 2.37;
const pad = process.env.BENCH_PAD_TOKENS ? padding(Number(process.env.BENCH_PAD_TOKENS)) : '';

/** The places the search gives for a mission, as the master would add them to a brief: locations only, 300 tokens at most. */
function briefOf(mission) {
  return new Promise((done) => {
    const settings = { enabled: true, idleMinutes: 1, device: 'auto', repos: [mission.cwd], budget: 300 };
    const host = fork(join(dist, 'search-host.mjs'), [], { env: { ...process.env, AIBOX_SEARCH_HOST: JSON.stringify({ dataDir, workerScript: join(dist, 'search-worker.mjs'), settings }) }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const end = (text) => {
      host.kill();
      done(text);
    };
    host.on('message', (m) => {
      if (m.id !== 1) return;
      const places = String(m.result ?? '').split('\n').filter((l) => /^\S+:\d+-\d+/.test(l)).slice(0, 10);
      end(places.length ? `\n\nEmplacements probables, trouvés par une recherche automatique (à vérifier) :\n${places.map((p) => `- ${p}`).join('\n')}` : '');
    });
    // A host that cannot start or answer leaves the mission without a brief, not the bench waiting.
    host.once('error', () => end(''));
    host.once('exit', () => done(''));
    setTimeout(() => end(''), 120_000).unref();
    host.send({ id: 1, method: 'searchCode', args: [mission.cwd, { query: mission.prompt.slice(0, 500), k: 8, budget: 300 }] });
  });
}

/** A modification mission works in a throwaway worktree of the bench repo, removed after its check. */
function worktreeOf(mission, arm) {
  const dir = join(process.env.BENCH_WORKTREES ?? join(scratch, 'wt'), `${mission.id}-${arm}`);
  spawnSync('git', ['-C', mission.cwd, 'worktree', 'remove', '--force', dir]);
  const r = spawnSync('git', ['-C', mission.cwd, 'worktree', 'add', '--detach', dir], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`worktree ${dir}: ${r.stderr}`);
  return dir;
}
const checker = process.env.BENCH_CHECK ? (await import(pathToFileURL(resolve(process.env.BENCH_CHECK)).href)).check : null;

async function run(mission, arm) {
  const tool = arm.startsWith('tool');
  const explore = arm.startsWith('explore');
  const agent = arm === 'agent';
  const helperModel = arm.endsWith('-sonnet') ? 'sonnet' : HELPER_MODEL;
  const modify = mission.kind === 'modify';
  const work = modify ? worktreeOf(mission, arm) : mission.cwd;
  const brief = arm.includes('brief') ? await briefOf(mission) : '';
  const ruled = tool && arm !== 'tool-bare';
  // tool-cited: the tools and the sentence that names them, without the bounded-reading rule.
  const rules = [arm === 'bounded' || (ruled && arm !== 'tool-cited') ? BOUNDED_RULE : '', ruled ? SEARCH_RULE : '', arm === 'batch' ? BATCH_RULE : '', arm === 'explore' || arm === 'explore-sonnet' ? EXPLORE_RULE : '', agent ? AGENT_RULE : ''].filter(Boolean).join('\n');
  // The padding first: the rules differ by arm, and what follows a difference is not read from the cache.
  const system = [pad, rules].filter(Boolean).join('\n\n');
  const systemFile = join(scratch, `system-${process.pid}.txt`);
  if (system) writeFileSync(systemFile, system);
  if (explore) {
    writeFileSync(ledger, '');
    writeFileSync(mcpWith, JSON.stringify({ mcpServers: { explore: { command: process.execPath, args: [join(here, '..', 'explore-mcp.mjs')], env: { EXPLORE_CWD: work, EXPLORE_MODEL: helperModel, EXPLORE_LEDGER: ledger, ...(process.env.EXPLORE_EFFORT ? { EXPLORE_EFFORT: process.env.EXPLORE_EFFORT } : {}) } } } }));
  }
  const granted = ['Read', 'Grep', 'Glob', 'ToolSearch', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(ls:*)', ...(modify ? ['Edit', 'Write'] : []), ...(tool ? ['mcp__search__search_code', 'mcp__search__where_is'] : []), ...(explore ? ['mcp__explore__explore'] : []), ...(agent ? ['Agent'] : [])];
  const expose = process.env.AIBOX_SEARCH_EXPOSE ? { AIBOX_SEARCH_EXPOSE: process.env.AIBOX_SEARCH_EXPOSE } : {};
  if (tool) writeFileSync(mcpWith, JSON.stringify({ mcpServers: { search: { command: process.execPath, args: [join(here, '..', 'search-mcp.mjs')], env: { AIBOX_SEARCH_DATA: dataDir, AIBOX_SEARCH_REPOS: mission.cwd, AIBOX_SEARCH_CWD: mission.cwd, ...(process.env.AIBOX_SEARCH_EMBED ? { AIBOX_SEARCH_EMBED: process.env.AIBOX_SEARCH_EMBED } : {}), ...expose } } } }));
  const args = [
    '-p', mission.prompt + brief,
    '--model', model,
    '--output-format', 'stream-json', '--verbose',
    ...(process.env.BENCH_MAX_TURNS ? ['--max-turns', process.env.BENCH_MAX_TURNS] : []),
    '--strict-mcp-config', '--mcp-config', tool || explore ? mcpWith : mcpWithout,
    ...(process.env.BENCH_SESSION_USD ? ['--max-budget-usd', process.env.BENCH_SESSION_USD] : []),
    '--tools', `Read,Grep,Glob,Bash,ToolSearch${modify ? ',Edit,Write' : ''}${agent ? ',Agent' : ''}`,
    '--allowedTools', granted.join(','),
    ...(agent ? ['--agents', JSON.stringify({ explorer: { description: 'Explores the repo in its own context and answers a question with path:lines references.', prompt: HELPER_PROMPT.replace('{rounds}', '4'), tools: ['Read', 'Grep', 'Glob'], model: helperModel } })] : []),
    // One padded prefix for every folder: the folder and its git status go to the first message instead.
    ...(pad ? ['--exclude-dynamic-system-prompt-sections'] : []),
    ...(system ? ['--append-system-prompt-file', systemFile] : []),
  ];
  const t0 = Date.now();
  const r = spawnSync(CLAUDE, args, { cwd: work, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 1_200_000 });
  const wallMs = Date.now() - t0;
  try {
    // The calls the session made, in order: what it explored with, and whether it took up the search.
    const events = String(r.stdout)
      .split('\n')
      .flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      });
    const seen = new Set();
    // The session's own requests (a sub-agent's carry its call's id): each one read the whole conversation again.
    const own = events.filter((e) => e.type === 'assistant' && !e.parent_tool_use_id);
    const calls = own.flatMap((e) => (e.message?.content ?? []).filter((b) => b.type === 'tool_use' && !seen.has(b.id) && seen.add(b.id)).map((b) => b.name.replace(/^mcp__(search|explore)__/, '')));
    const requests = new Map();
    for (const e of own) {
      const u = e.message?.usage;
      if (!e.message?.id || !u) continue;
      const r = requests.get(e.message.id) ?? { calls: 0, output: 0 };
      requests.set(e.message.id, { calls: r.calls + (e.message.content ?? []).filter((b) => b.type === 'tool_use').length, context: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), write: u.cache_creation_input_tokens ?? 0, read: u.cache_read_input_tokens ?? 0, output: Math.max(r.output, u.output_tokens ?? 0) });
    }
    const reqs = [...requests.values()];
    const sum = (f) => reqs.reduce((a, r) => a + f(r), 0);
    // What the helper cost: the explore tool's own ledger, or the share of the bill of the sub-agent's model.
    const helperRows = explore && existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const ledgerUsd = helperRows.reduce((a, r) => a + (r.costUsd ?? 0), 0);
    const subUsage = Object.entries(events.find((e) => e.type === 'result')?.modelUsage ?? {}).filter(([m]) => agent && m.includes(helperModel));
    const helperUsd = ledgerUsd + subUsage.reduce((a, [, u]) => a + (u.costUSD ?? 0), 0);
    const count = (names) => calls.filter((c) => names.includes(c)).length;
    const out = events.find((e) => e.type === 'result');
    const u = out.usage ?? {};
    const answer = String(out.result ?? '');
    return {
      mission: mission.id, arm, model, wallMs, durationMs: out.duration_ms, apiMs: out.duration_api_ms, turns: out.num_turns,
      // The whole bill: the session, and the helper when it runs outside it (the explore tool's own process).
      costUsd: out.total_cost_usd + ledgerUsd, helperUsd, helperCalls: explore ? helperRows.length : agent ? count(['Agent']) : 0, helperMs: helperRows.reduce((a, r) => a + (r.wallMs ?? 0), 0), ...(explore || agent ? { helper: helperModel } : {}),
      error: out.is_error === true,
      // The session's requests: how many, how many carried more than one call, and the tokens they read, wrote and produced.
      requests: reqs.length, grouped: reqs.filter((r) => r.calls > 1).length, ownContext: sum((r) => r.context), ownWrite: sum((r) => r.write), ownRead: sum((r) => r.read), ownOutput: sum((r) => r.output), padTokens: Number(process.env.BENCH_PAD_TOKENS ?? 0),
      calls: calls.length, searchCalls: count(['search_code', 'where_is']), exploreCalls: count(['explore', 'Agent']), grep: count(['Grep', 'Glob']), reads: count(['Read']), bash: count(['Bash']), toolSearch: count(['ToolSearch']),
      firstLook: calls.find((c) => c !== 'ToolSearch') ?? null,
      // The agent arm: the model the session asked for in its Agent call (it may override the sub-agent's own), and the models billed.
      ...(agent ? { agentAsked: own.flatMap((e) => (e.message?.content ?? []).filter((b) => b.type === 'tool_use' && b.name === 'Agent').map((b) => b.input?.model ?? null)), billed: Object.fromEntries(Object.entries(out.modelUsage ?? {}).map(([m, u]) => [m, +(u.costUSD ?? 0).toFixed(4)])) } : {}),
      input: u.input_tokens, cacheCreation: u.cache_creation_input_tokens, cacheRead: u.cache_read_input_tokens, output: u.output_tokens, briefTokens: Math.ceil(brief.length / 2.25),
      // Success, where the mission says what a right answer cites: one of the expected files is named.
      ...(mission.expect ? { success: mission.expect.some((p) => answer.includes(p) || answer.includes(p.split('/').pop())) } : {}),
      // A modification: its check on the worktree (expected change in the expected files), and the diff for a look.
      ...(modify && checker ? (({ ok, why }) => ({ success: ok, why }))(checker(mission, work)) : {}),
      ...(modify ? { diff: String(spawnSync('git', ['-C', work, 'diff'], { encoding: 'utf8' }).stdout).slice(0, 4000) } : {}),
      answer: answer.slice(0, 6000),
    };
  } catch {
    return { mission: mission.id, arm, model, wallMs, error: true, answer: `${r.stdout}`.slice(0, 300) + `${r.stderr}`.slice(0, 300) };
  } finally {
    if (modify) spawnSync('git', ['-C', mission.cwd, 'worktree', 'remove', '--force', work]);
  }
}

const order = arms.split(',');
// A ceiling at API prices (BENCH_BUDGET_USD): no session starts once the spend plus one session's ceiling
// (BENCH_SESSION_USD, passed to Claude Code as --max-budget-usd) could pass it.
const wallet = process.env.BENCH_SPEND_FILE ? sharedBudget() : null;
const budget = wallet ? wallet.cap : Number(process.env.BENCH_BUDGET_USD ?? Infinity);
const reserve = Number(process.env.BENCH_SESSION_USD ?? 1);
let spent = wallet ? wallet.spent() : 0;
rounds: for (let n = 0; n < Number(runs); n++) {
  for (const [m, mission] of missions.entries()) {
    // The order turns from one mission to the next so no arm always runs first, on a cold prompt cache.
    const k = (n + m) % order.length;
    for (const arm of [...order.slice(k), ...order.slice(0, k)]) {
      if (spent + reserve > budget) {
        console.log(JSON.stringify({ stopped: 'budget', spent: Number(spent.toFixed(2)), budget }));
        break rounds;
      }
      const row = await run(mission, arm);
      wallet?.charge(`missions:${arm}`, row.costUsd ?? reserve);
      spent = wallet ? wallet.spent() : spent + (row.costUsd ?? reserve);
      appendFileSync(outFile, `${JSON.stringify({ at: new Date().toISOString(), run: n, ...row })}\n`);
      const { answer: _answer, ...shown } = row;
      console.log(JSON.stringify(shown));
    }
  }
}
