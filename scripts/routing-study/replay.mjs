// Replays past changes of this repo as missions, to compare models and efforts on work the hub really did: the tree
// just before a commit, the commit's tests put in place, a brief made of the commit's subject and of the problem it
// describes, and a Claude Code session that has to make the tests pass. The judge is deterministic: the commit's own
// test files (restored first) and the typecheck. Nothing is pushed or committed outside the run's folder.
//
//   node scripts/routing-study/replay.mjs --verify                      tests fail before each commit, pass at it
//   node scripts/routing-study/replay.mjs --model claude-sonnet-5-5 --effort medium [--only T1,T3] [--runs 1] [--parallel 3]
//
// Runs live under the scratch folder of this checkout, so they find its node_modules.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, d) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : d);
const base = path.resolve(arg('dir', path.join(process.env.AIBOX_SCRATCH_DIR ?? path.join(root, '.aibox', 'scratch'), 'replay')));
const only = arg('only', '') ? arg('only', '').split(',') : null;
const model = arg('model', 'claude-sonnet-5-5');
const effort = arg('effort', 'medium');
const runs = Number(arg('runs', 1));
const parallel = Number(arg('parallel', 3));
const budget = Number(arg('budget', 2.5));
const tasks = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'routing-study', 'tasks.json'), 'utf8')).filter((t) => !only || only.includes(t.id));

const sh = (cmd, args, cwd, timeout = 300_000) => spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 64e6, shell: false });
const git = (cwd, ...args) => sh('git', args, cwd);

// The tests of a run: bundled like scripts/test.mjs does, into the run's own folder.
const RUN_TESTS = `import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
const tests = process.argv.slice(2);
const out = resolve(mkdtempSync('.tests-'));
try {
  const files = tests.map((src, i) => join(out, \`t\${i}.mjs\`));
  await Promise.all(tests.map((src, i) => build({ entryPoints: [src], outfile: files[i], bundle: true, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'warning', external: ['electron', '@anthropic-ai/claude-agent-sdk', 'zod'] })));
  process.exitCode = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' }).status ?? 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
`;

/** The tree of `ref` (or only `files` of it) written into `dir`. */
function extract(ref, dir, files = []) {
  const tar = path.join(dir, '.extract.tar');
  const made = git(root, 'archive', '--format=tar', '-o', tar, ref, ...files);
  if (made.status !== 0) throw new Error(`git archive ${ref}: ${made.stderr}`);
  const un = sh('tar', ['-xf', '.extract.tar'], dir);
  fs.rmSync(tar, { force: true });
  if (un.status !== 0) throw new Error(`tar: ${un.stderr}`);
}

function prepare(task, dir, ref) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  extract(ref, dir);
  extract(task.commit, dir, task.tests);
  fs.writeFileSync(path.join(dir, 'run-tests.mjs'), RUN_TESTS);
  fs.appendFileSync(path.join(dir, '.gitignore'), '\n.tests-*\nrun-tests.mjs\n');
  // A repository of its own: the session sees no later history.
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=replay', '-c', 'user.email=replay@localhost', 'commit', '-q', '-m', 'baseline');
}

function judge(task, dir) {
  extract(task.commit, dir, task.tests);
  const tests = sh(process.execPath, ['run-tests.mjs', ...task.tests], dir);
  const types = sh(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit'], dir);
  const stat = git(dir, 'diff', '--shortstat', 'HEAD').stdout.trim();
  return { tests: tests.status === 0, types: types.status === 0, pass: tests.status === 0 && types.status === 0, diff: stat };
}

function brief(task) {
  const [subject, , ...body] = git(root, 'log', '-1', '--pretty=%s%n%n%b', task.commit).stdout.split('\n');
  const problem = body.join('\n').split(/\n\s*\n/)[0].trim();
  return `Mission : ${subject}

Contexte (le problème constaté) :
${problem}

Les tests qui décrivent le comportement attendu sont déjà en place : ${task.tests.join(', ')}. Fais-les passer sans les modifier, dans le style du code existant.
- Lancer des tests : \`node run-tests.mjs <fichiers de test>\` (ne lance pas \`npm test\` : il démarre l'application).
- \`npx tsc --noEmit\` doit rester vert.
- Travaille uniquement dans ce dossier. Ni commit, ni push, ni installation de dépendances.
Termine par un rapport de 5 lignes au plus : ce qui est fait, ce qui est vérifié.`;
}

if (process.argv.includes('--verify')) {
  for (const task of tasks) {
    const dir = path.join(base, `verify-${task.id}`);
    prepare(task, dir, `${task.commit}^`);
    const before = judge(task, dir);
    prepare(task, dir, task.commit);
    const after = judge(task, dir);
    console.log(`${task.id} ${task.commit} before: tests ${before.tests ? 'pass' : 'fail'}, types ${before.types ? 'ok' : 'fail'} · at the commit: tests ${after.tests ? 'pass' : 'FAIL'}, types ${after.types ? 'ok' : 'FAIL'} · brief ${brief(task).length} chars`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(0);
}

const { query } = await import('@anthropic-ai/claude-agent-sdk');

async function run(task, i) {
  const dir = path.join(base, `${task.id}-${model.replace(/^claude-/, '')}-${effort}-${i}`);
  prepare(task, dir, `${task.commit}^`);
  const inside = (p) => !p || !path.relative(dir, path.resolve(dir, String(p))).startsWith('..');
  let denied = 0;
  // Nothing leaves the run's folder, and nothing outside it is read (the checkout above holds the answer).
  const guard = async (input) => {
    const name = input.tool_name ?? '';
    const a = input.tool_input ?? {};
    const cmd = String(a.command ?? '');
    const bad =
      (/^(Read|Edit|Write|NotebookEdit|Grep|Glob|LS)$/.test(name) && !inside(a.file_path ?? a.path ?? a.notebook_path)) ||
      (name === 'Bash' && (/\bgit\b[^|;&]*\b(push|commit|clone|remote|fetch|pull)\b|\bnpm\s+(test|ci|i|install|run\s+(build|ui|test))\b|\bgh\s|\.\.[\\/]\.\.|claude-hub-aibox-routage[\\/](src|scripts)\b/.test(cmd) || /^\s*cd\s+(\/|[a-zA-Z]:|~|\.\.)/.test(cmd))) ||
      /^(WebFetch|WebSearch)$/.test(name);
    if (!bad) return {};
    denied++;
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Outside this mission: work in the current folder only, with node run-tests.mjs and npx tsc --noEmit.' } };
  };
  const r = { task: task.id, model, effort, run: i, cost: 0, ms: 0, turns: 0, requests: 0, out: 0, error: '', denied: 0, models: {}, reportChars: 0, tools: {} };
  const t0 = Date.now();
  const seen = new Set();
  try {
    const q = query({
      prompt: brief(task),
      options: {
        cwd: dir,
        model,
        effort,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['project'],
        strictMcpConfig: true,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        disallowedTools: ['AskUserQuestion', 'Workflow', 'ScheduleWakeup'],
        maxTurns: 150,
        maxBudgetUsd: budget,
        env: { ...process.env, CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' },
        hooks: { PreToolUse: [{ hooks: [guard] }] },
      },
    });
    for await (const msg of q) {
      if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
        if (!seen.has(msg.message.id)) {
          seen.add(msg.message.id);
          r.requests++;
        }
        for (const b of msg.message.content) if (b.type === 'tool_use') r.tools[b.name] = (r.tools[b.name] ?? 0) + 1;
      } else if (msg.type === 'result') {
        r.cost = msg.total_cost_usd;
        r.turns = msg.num_turns;
        r.out = msg.usage?.output_tokens ?? 0;
        r.models = Object.fromEntries(Object.entries(msg.modelUsage ?? {}).map(([k, u]) => [k, +u.costUSD.toFixed(4)]));
        if (msg.subtype !== 'success') r.error = msg.subtype;
        else r.reportChars = msg.result.length;
      }
    }
  } catch (err) {
    r.error = err instanceof Error ? err.message.slice(0, 200) : String(err);
  }
  r.ms = Date.now() - t0;
  r.denied = denied;
  Object.assign(r, judge(task, dir));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`${task.id} ${model.replace(/^claude-/, '')}·${effort} #${i + 1} ${r.pass ? 'PASS' : `FAIL (tests ${r.tests}, types ${r.types}${r.error ? `, ${r.error}` : ''})`} $${r.cost.toFixed(2)} ${Math.round(r.ms / 1000)}s ${r.requests} req · ${r.diff}`);
  return r;
}

const jobs = tasks.flatMap((task) => Array.from({ length: runs }, (_, i) => ({ task, i })));
const results = [];
let at = 0;
await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, async () => {
  while (at < jobs.length) {
    const { task, i } = jobs[at++];
    results.push(await run(task, i));
  }
}));
const file = path.join(base, `replay-${model.replace(/^claude-/, '')}-${effort}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(file, JSON.stringify(results, null, 1));
const passed = results.filter((r) => r.pass).length;
console.log(`\n${model} · ${effort}: ${passed}/${results.length} pass, $${results.reduce((s, r) => s + r.cost, 0).toFixed(2)}, ${Math.round(results.reduce((s, r) => s + r.ms, 0) / 1000 / results.length)}s per run on average.\nDetails: ${file}`);
