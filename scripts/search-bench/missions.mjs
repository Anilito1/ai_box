// The same read-only missions run by Claude Code with and without search_code, to compare tokens and time
// (docs/recherche-semantique.md). `npm run build` first; the repos must already be indexed in AIBOX_SEARCH_DATA.
//   node scripts/search-bench/missions.mjs <missions.json> <out.jsonl> [runs=2] [model=sonnet] [arms=without,with]
// missions.json: [{ "id": "…", "cwd": "C:/…/repo", "prompt": "…" }]
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [missionsFile, outFile, runs = '2', model = 'sonnet', arms = 'without,with'] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const missions = JSON.parse(readFileSync(missionsFile, 'utf8'));
const dataDir = resolve(process.env.AIBOX_SEARCH_DATA ?? '');
// The program itself, not npm's shim: no shell stands between the prompt and Claude Code.
const CLAUDE = process.env.CLAUDE_BIN ?? (process.platform === 'win32' ? join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe') : 'claude');

/** What both arms are told: the bounded reads workers already apply. */
const BASE = 'Lectures bornées : Read avec offset/limit sur un gros fichier, Grep avec head_limit. Ne modifie rien.';
/** The instruction proposed for the prompts, measured as written. */
export const SEARCH_RULE =
  "Pour localiser du code, commence par `search_code` (une question en français ou en anglais, ou un nom exact) : il renvoie les meilleurs passages en `chemin:lignes`. Lis ensuite seulement ces lignes (Read avec offset/limit), pas le fichier entier. Garde Grep pour lister toutes les occurrences d'un nom exact.";

const mcpWith = join(here, '..', '..', 'node_modules', '.search-bench', 'mcp-with.json');
const mcpWithout = join(here, '..', '..', 'node_modules', '.search-bench', 'mcp-without.json');

function run(mission, arm) {
  writeFileSync(mcpWithout, JSON.stringify({ mcpServers: {} }));
  writeFileSync(mcpWith, JSON.stringify({ mcpServers: { search: { command: process.execPath, args: [join(here, '..', 'search-mcp.mjs')], env: { AIBOX_SEARCH_DATA: dataDir, AIBOX_SEARCH_REPOS: mission.cwd } } } }));
  const withTool = arm === 'with';
  const args = [
    '-p', mission.prompt,
    '--model', model,
    '--output-format', 'json',
    '--strict-mcp-config', '--mcp-config', withTool ? mcpWith : mcpWithout,
    '--tools', 'Read,Grep,Glob',
    '--allowedTools', withTool ? 'Read,Grep,Glob,mcp__search__search_code' : 'Read,Grep,Glob',
    '--append-system-prompt', withTool ? `${BASE}\n${SEARCH_RULE}` : BASE,
  ];
  const t0 = Date.now();
  const r = spawnSync(CLAUDE, args, { cwd: mission.cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 900_000 });
  const wallMs = Date.now() - t0;
  try {
    const out = JSON.parse(r.stdout);
    const u = out.usage ?? {};
    return {
      mission: mission.id, arm, model, wallMs, durationMs: out.duration_ms, apiMs: out.duration_api_ms, turns: out.num_turns, costUsd: out.total_cost_usd, error: out.is_error === true,
      input: u.input_tokens, cacheCreation: u.cache_creation_input_tokens, cacheRead: u.cache_read_input_tokens, output: u.output_tokens,
      answer: String(out.result ?? '').slice(0, 6000),
    };
  } catch {
    return { mission: mission.id, arm, model, wallMs, error: true, answer: `${r.stdout}`.slice(0, 300) + `${r.stderr}`.slice(0, 300) };
  }
}

for (let n = 0; n < Number(runs); n++) {
  for (const mission of missions) {
    // The order alternates so neither arm always runs on a warm prompt cache.
    for (const arm of n % 2 === 0 ? arms.split(',') : arms.split(',').reverse()) {
      const row = run(mission, arm);
      appendFileSync(outFile, `${JSON.stringify({ at: new Date().toISOString(), run: n, ...row })}\n`);
      const { answer: _answer, ...shown } = row;
      console.log(JSON.stringify(shown));
    }
  }
}
