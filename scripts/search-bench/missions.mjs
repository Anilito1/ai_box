// The same missions run by Claude Code under several conditions, to compare tokens, time and success
// (docs/recherche-semantique.md). `npm run build` first; the repos must already be indexed in AIBOX_SEARCH_DATA.
//   node scripts/search-bench/missions.mjs <missions.json> <out.jsonl> [runs=3] [model=sonnet] [arms=current,bounded,brief,tool]
// missions.json: [{ "id": "…", "cwd": "C:/…/repo", "prompt": "…", "expect": ["path/that/must/be/cited.ts"] }]
// Arms (nothing here touches the hub's prompts: each condition is given by this test's own configuration):
//   current     Claude Code as the workers run today
//   bounded     + the bounded-reading rule
//   brief       + 5 to 10 likely places added to the mission, found by the search before the launch
//   tool        + the search tools and the bounded-reading rule
//   tool+brief  + the tools, the brief and the rule
import { fork, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [missionsFile, outFile, runs = '3', model = 'sonnet', arms = 'current,bounded,brief,tool'] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', '..', 'dist');
const missions = JSON.parse(readFileSync(missionsFile, 'utf8'));
const dataDir = resolve(process.env.AIBOX_SEARCH_DATA ?? '');
// The program itself, not npm's shim: no shell stands between the prompt and Claude Code.
const CLAUDE = process.env.CLAUDE_BIN ?? (process.platform === 'win32' ? join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe') : 'claude');

/** The bounded-reading rule proposed for the workers' instructions, measured as written. */
export const BOUNDED_RULE =
  "Lecture économe : cherche d'abord (Grep ciblé, avec head_limit), puis lis seulement la plage utile (Read avec offset/limit), jamais un fichier entier de plus de 200 lignes. Pas de `cat`, `sed`, `head` ni `tail` en Bash pour lire un fichier. Ne relis pas un fichier ou une plage déjà lus dans la session.";
/** The instruction proposed with the search tools. */
export const SEARCH_RULE =
  "Pour localiser du code, commence par `search_code` (un nom du code, un chemin, ou un comportement décrit en français ou en anglais) ou `where_is` (table, RPC, edge function, tâche planifiée) : ils renvoient `chemin:lignes`. Lis ensuite seulement ces lignes. S'ils répondent « No confident match », passe à Grep. Garde Grep pour lister toutes les occurrences d'un nom exact.";

const scratch = join(here, '..', '..', 'node_modules', '.search-bench');
mkdirSync(scratch, { recursive: true });
const mcpWith = join(scratch, 'mcp-with.json');
const mcpWithout = join(scratch, 'mcp-without.json');
writeFileSync(mcpWithout, JSON.stringify({ mcpServers: {} }));

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

async function run(mission, arm) {
  const tool = arm.startsWith('tool');
  const brief = arm.includes('brief') ? await briefOf(mission) : '';
  const rules = [arm === 'bounded' || tool ? BOUNDED_RULE : '', tool ? SEARCH_RULE : ''].filter(Boolean).join('\n');
  if (tool) writeFileSync(mcpWith, JSON.stringify({ mcpServers: { search: { command: process.execPath, args: [join(here, '..', 'search-mcp.mjs')], env: { AIBOX_SEARCH_DATA: dataDir, AIBOX_SEARCH_REPOS: mission.cwd } } } }));
  const args = [
    '-p', mission.prompt + brief,
    '--model', model,
    '--output-format', 'json',
    '--strict-mcp-config', '--mcp-config', tool ? mcpWith : mcpWithout,
    '--tools', 'Read,Grep,Glob,Bash',
    '--allowedTools', tool ? 'Read,Grep,Glob,Bash(git log:*),Bash(git show:*),Bash(ls:*),mcp__search__search_code,mcp__search__where_is' : 'Read,Grep,Glob,Bash(git log:*),Bash(git show:*),Bash(ls:*)',
    ...(rules ? ['--append-system-prompt', rules] : []),
  ];
  const t0 = Date.now();
  const r = spawnSync(CLAUDE, args, { cwd: mission.cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 1_200_000 });
  const wallMs = Date.now() - t0;
  try {
    const out = JSON.parse(r.stdout);
    const u = out.usage ?? {};
    const answer = String(out.result ?? '');
    return {
      mission: mission.id, arm, model, wallMs, durationMs: out.duration_ms, apiMs: out.duration_api_ms, turns: out.num_turns, costUsd: out.total_cost_usd, error: out.is_error === true,
      input: u.input_tokens, cacheCreation: u.cache_creation_input_tokens, cacheRead: u.cache_read_input_tokens, output: u.output_tokens, briefTokens: Math.ceil(brief.length / 3.6),
      // Success, where the mission says what a right answer cites: one of the expected files is named.
      ...(mission.expect ? { success: mission.expect.some((p) => answer.includes(p) || answer.includes(p.split('/').pop())) } : {}),
      answer: answer.slice(0, 6000),
    };
  } catch {
    return { mission: mission.id, arm, model, wallMs, error: true, answer: `${r.stdout}`.slice(0, 300) + `${r.stderr}`.slice(0, 300) };
  }
}

const order = arms.split(',');
for (let n = 0; n < Number(runs); n++) {
  for (const mission of missions) {
    // The order turns at each round so no arm always runs first, on a cold prompt cache.
    for (const arm of [...order.slice(n % order.length), ...order.slice(0, n % order.length)]) {
      const row = await run(mission, arm);
      appendFileSync(outFile, `${JSON.stringify({ at: new Date().toISOString(), run: n, ...row })}\n`);
      const { answer: _answer, ...shown } = row;
      console.log(JSON.stringify(shown));
    }
  }
}
