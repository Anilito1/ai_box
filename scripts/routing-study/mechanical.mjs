// Mechanical read-only tasks of the kind a worker hands to a subagent (a list to extract, a count, a cross-check), each
// with an answer computed from the repo itself, run on a cheap and on a mid model: is the cheap one right as often?
// Each run is a fresh read-only Claude Code session in this checkout that answers with a JSON array.
//
//   node scripts/routing-study/mechanical.mjs [--models claude-haiku-5-5:medium,claude-sonnet-5-5:low] [--runs 2] [--only M1,M2]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, d) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : d);
const configs = arg('models', 'claude-haiku-5-5:medium,claude-sonnet-5-5:low,claude-sonnet-5-5:medium').split(',').map((c) => c.split(':'));
const runs = Number(arg('runs', 2));
const only = arg('only', '') ? arg('only', '').split(',') : null;

const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
const walk = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
const all = (text, re) => [...text.matchAll(re)].map((m) => m[1]);
const FILES = ['src/main/sessions.ts', 'src/main/prompts.ts', 'src/shared/team.ts', 'src/shared/costs.ts', 'scripts/eval/run.mjs'];

const TASKS = [
  { id: 'M1', ask: "Liste les noms de tous les outils du hub déclarés dans src/main/sessions.ts par un appel `tool('nom', …)` (le premier argument). Chaque nom une seule fois.",
    truth: () => [...new Set(all(read('src/main/sessions.ts'), /\btool\(\s*'([a-z_]+)'/g))] },
  { id: 'M2', ask: 'Liste tous les identifiants exportés par src/shared/team.ts (export const, function, type, interface).',
    truth: () => all(read('src/shared/team.ts'), /^export (?:const|function|type|interface) (\w+)/gm) },
  { id: 'M3', ask: "Parmi les 40 commits les plus récents de la branche courante (HEAD), lesquels modifient src/main/prompts.ts ? Donne leurs identifiants abrégés (7 caractères).",
    truth: () => git('log', '-40', '--pretty=%h', '--', 'src/main/prompts.ts').map((h) => h.slice(0, 7)).filter((h) => git('log', '-40', '--pretty=%h').map((x) => x.slice(0, 7)).includes(h)),
    norm: (s) => String(s).slice(0, 7) },
  { id: 'M4', ask: "Liste les fichiers de test sous src/ (*.test.ts) qui importent directement le module src/shared/costs.ts (import statique ou `await import`). Chemins relatifs à la racine du repo, avec des /.",
    truth: () => walk('src').filter((f) => f.endsWith('.test.ts') && (/(from|import\()\s*'\.\.\/shared\/costs'/.test(read(f)) || (f.startsWith('src/shared/') && /(from|import\()\s*'\.\/costs'/.test(read(f))))),
    norm: (s) => String(s).replace(/\\/g, '/').replace(/^\.\//, '') },
  { id: 'M5', ask: `Donne le nombre de lignes de chacun de ces fichiers, sous la forme "chemin:nombre" (comme \`wc -l\`) : ${FILES.join(', ')}.`,
    truth: () => FILES.map((f) => `${f}:${read(f).split('\n').length - 1}`),
    norm: (s) => String(s).replace(/\\/g, '/').replace(/\s/g, '') },
  { id: 'M6', ask: "Dans scripts/eval/scenarios.json, liste les identifiants des scénarios de rôle \"master\" dont l'attente (expect) contient une clé \"noCall\".",
    truth: () => JSON.parse(read('scripts/eval/scenarios.json')).scenarios.filter((s) => s.role === 'master' && s.expect?.noCall).map((s) => s.id) },
  { id: 'M7', ask: "Dans src/main/i18n.ts, liste les clés de traduction qui commencent par 'tool.role.' (chaque clé une seule fois).",
    truth: () => [...new Set(all(read('src/main/i18n.ts'), /'(tool\.role\.[\w.]+)'\s*:/g))] },
  { id: 'M8', ask: "Liste les fichiers sous src/shared/ (hors tests) qui n'ont aucun fichier de test du même nom à côté d'eux (x.ts sans x.test.ts). Chemins relatifs à la racine, avec des /.",
    truth: () => {
      const files = walk('src/shared');
      return files.filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts') && !files.includes(f.replace(/\.ts$/, '.test.ts')));
    },
    norm: (s) => String(s).replace(/\\/g, '/').replace(/^\.\//, '') },
].filter((t) => !only || only.includes(t.id));

const guard = async (input) => {
  const name = input.tool_name ?? '';
  const cmd = String(input.tool_input?.command ?? '');
  const writes = /^(Edit|Write|NotebookEdit|WebFetch|WebSearch|Agent|Task)$/.test(name) || (name === 'Bash' && /(^|[;&|]\s*)(rm|mv|cp|git\s+(commit|push|checkout|reset|stash|add)|npm|npx|node\s+-e)\b|>\s*[^&\s]/.test(cmd));
  return writes ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Read-only task.' } } : {};
};

async function run(task, model, effort) {
  const r = { task: task.id, model, effort, cost: 0, ms: 0, requests: 0, f1: 0, exact: false, error: '' };
  const t0 = Date.now();
  let text = '';
  const seen = new Set();
  try {
    const q = query({
      prompt: `${task.ask}\n\nTâche en lecture seule dans ce repo. Vérifie avec les outils, ne devine pas. Termine par une seule ligne : un tableau JSON de chaînes, sans rien après.`,
      options: { cwd: root, model, effort, systemPrompt: { type: 'preset', preset: 'claude_code' }, settingSources: [], strictMcpConfig: true, permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, maxTurns: 40, maxBudgetUsd: 1, env: { ...process.env, CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' }, hooks: { PreToolUse: [{ hooks: [guard] }] } },
    });
    for await (const msg of q) {
      if (msg.type === 'assistant' && !seen.has(msg.message.id)) {
        seen.add(msg.message.id);
        r.requests++;
      } else if (msg.type === 'result') {
        r.cost = msg.total_cost_usd;
        if (msg.subtype === 'success') text = msg.result;
        else r.error = msg.subtype;
      }
    }
  } catch (err) {
    r.error = String(err).slice(0, 120);
  }
  r.ms = Date.now() - t0;
  const norm = task.norm ?? ((s) => String(s).trim());
  const truth = new Set(task.truth().map(norm));
  // The last array of the answer; `strict`: it also ends the answer, as asked.
  let got = [];
  try {
    got = JSON.parse((text.match(/\[[^[\]]*\]/g) ?? []).pop() ?? '[]').map(norm);
  } catch { /* no array: nothing right */ }
  r.strict = /\]\s*$/.test(text.trim());
  const hit = got.filter((g) => truth.has(g)).length;
  const p = got.length ? hit / got.length : 0;
  const rec = truth.size ? hit / truth.size : 0;
  r.f1 = p + rec ? (2 * p * rec) / (p + rec) : 0;
  r.exact = hit === truth.size && new Set(got).size === truth.size;
  r.size = truth.size;
  console.log(`${task.id} ${model.replace('claude-', '')}·${effort} f1 ${r.f1.toFixed(2)}${r.exact ? ' exact' : ''}${r.strict ? '' : ' [format not kept]'} (${hit}/${truth.size}, ${got.length} given) $${r.cost.toFixed(3)} ${Math.round(r.ms / 1000)}s ${r.requests} req${r.error ? ` ${r.error}` : ''}`);
  return r;
}

const jobs = TASKS.flatMap((task) => configs.flatMap(([model, effort]) => Array.from({ length: runs }, () => ({ task, model, effort }))));
const results = [];
let at = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (at < jobs.length) {
    const j = jobs[at++];
    results.push(await run(j.task, j.model, j.effort));
  }
}));
console.log('\nmodel · effort        exact   format  mean f1   $ per task   s per task');
for (const [model, effort] of configs) {
  const a = results.filter((r) => r.model === model && r.effort === effort);
  const mean = (f) => a.reduce((s, r) => s + f(r), 0) / a.length;
  console.log(`${`${model.replace('claude-', '')} · ${effort}`.padEnd(20)} ${`${a.filter((r) => r.exact).length}/${a.length}`.padEnd(7)} ${`${a.filter((r) => r.strict).length}/${a.length}`.padEnd(7)}${mean((r) => r.f1).toFixed(2).padEnd(9)} ${mean((r) => r.cost).toFixed(3).padEnd(12)} ${Math.round(mean((r) => r.ms) / 1000)}`);
}
const dir = path.join(process.env.AIBOX_SCRATCH_DIR ?? path.join(root, '.aibox', 'scratch'), 'routing-study');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, `mechanical-${Date.now()}.json`), JSON.stringify(results, null, 1));
