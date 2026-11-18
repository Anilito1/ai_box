// Prompt regression eval: the hub's master and worker instructions on fixed scenarios, each run several times on the
// real Claude Code (no side effect: see harness.ts), scored on the tool calls, compared with another git ref (main).
//
//   npm run eval                        current tree vs origin/main, 3 runs per scenario
//   npm run eval -- --runs 1 --only S1,S6 --ref none
//   npm run eval -- --judge             adds a Sonnet reading of each worker brief (completeness, 0-5)
//   npm run eval -- --baseline <file>   compares with the saved results of an earlier run instead of running the ref
//   npm run eval -- --master-model claude-sonnet-5-5 --master-effort medium   the master on another model or effort
//
// Exit code 1 when a scenario passes fewer runs than on the reference. Costs a few dollars of plan usage per pass.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, d) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : d);
const runs = Number(arg('runs', 3));
const only = arg('only', '') ? arg('only', '').split(',') : null;
const refName = arg('ref', 'origin/main');
const parallel = Number(arg('parallel', 3));
const judge = process.argv.includes('--judge');
const baselineFile = arg('baseline', '');
const master = { model: arg('master-model', undefined), effort: arg('master-effort', undefined) };
const outDir = resolve(arg('out', join(process.env.AIBOX_SCRATCH_DIR ?? os.tmpdir(), 'eval')));
mkdirSync(outDir, { recursive: true });

const { roster, scenarios: all } = JSON.parse(readFileSync(join(root, 'scripts', 'eval', 'scenarios.json'), 'utf8'));
const scenarios = all.filter((s) => !only || only.includes(s.id)).map((s) => ({ ...s, posts: [...roster.posts, ...(s.posts ?? [])], workers: s.workers ?? roster.workers, repos: roster.repos, models: s.models ?? roster.models }));

/** harness.ts bundled against the sources of `srcRoot` (the current tree, or a worktree of the reference). */
async function bundle(srcRoot, tag) {
  const outfile = join(root, 'node_modules', `.eval-${tag}.mjs`);
  await build({
    entryPoints: [join(root, 'scripts', 'eval', 'harness.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'es2022',
    logLevel: 'error',
    external: ['electron', '@anthropic-ai/claude-agent-sdk', 'zod'],
    nodePaths: [join(root, 'node_modules')],
    plugins: [{
      name: 'src-root',
      setup(b) {
        b.onResolve({ filter: /^\.\.\/\.\.\/src\// }, (a) => ({ path: join(srcRoot, a.path.replace(/^\.\.\/\.\.\//, '')).replace(/\.js$/, '') + '.ts' }));
      },
    }],
  });
  return import(pathToFileURL(outfile).href + `?t=${Date.now()}`);
}

const short = (name) => name.replace(/^mcp__hub__/, '');
const re = (s) => new RegExp(s, 'i');
const callsOf = (r, tools) => r.calls.filter((c) => new RegExp(`^(${tools})$`).test(short(c.tool)));
/** `input`: a pattern per field, or a list of such sets when several ways of calling are right. */
const fits = (c, input) => (Array.isArray(input) ? input.some((alt) => fits(c, alt)) : Object.entries(input ?? {}).every(([k, v]) => re(v).test(String(c.input[k] ?? ''))));
const bashLike = (c) => String(c.input.command ?? c.input.cmd ?? '');

/** Responses whose only tool call is topic: a whole request spent on filing. */
const topicAlone = (r) => r.requests.filter((names) => names.length === 1 && short(names[0]) === 'topic').length;

/** The failed expectations of one run ([] = passed). */
function check(sc, r) {
  const e = sc.expect ?? {};
  const failed = [];
  if (r.error) failed.push(`error: ${r.error}`);
  for (const spec of e.anyCall ?? []) if (!callsOf(r, spec.tool).some((c) => fits(c, spec.input))) failed.push(`no ${spec.tool} ${JSON.stringify(spec.input ?? {})}`);
  for (const spec of e.allCalls ?? []) for (const c of callsOf(r, spec.tool)) if (!fits(c, spec.input)) failed.push(`${spec.tool} ${JSON.stringify(c.input).slice(0, 120)}`);
  for (const spec of e.noCall ?? []) {
    const [tool, pattern] = spec.split(/:(.*)/s);
    const hits = callsOf(r, tool).filter((c) => !pattern || re(pattern).test(bashLike(c)));
    if (hits.length) failed.push(`called ${spec}`);
  }
  if (e.distinctTargets) {
    const names = new Set(callsOf(r, e.distinctTargets.tool).map((c) => String(c.input.name ?? c.input.mission ?? '').slice(0, 40)));
    if (names.size < e.distinctTargets.min) failed.push(`${names.size} target(s) < ${e.distinctTargets.min}`);
  }
  if (e.maxCalls && callsOf(r, e.maxCalls.tool).length > e.maxCalls.max) failed.push(`${callsOf(r, e.maxCalls.tool).length} ${e.maxCalls.tool} > ${e.maxCalls.max}`);
  if (e.text && !re(e.text).test(r.text)) failed.push(`text !~ ${e.text}`);
  if (e.maxRequests && r.requests.length > e.maxRequests) failed.push(`${r.requests.length} requests > ${e.maxRequests}`);
  if (e.topicNeverAlone && topicAlone(r) > 0) failed.push(`${topicAlone(r)} response(s) with topic alone`);
  return failed;
}

/** S11: no conversation brought under the model's 1M window, nor renewed early, by the hub's own settings. */
function staticChecks(h) {
  const out = [];
  const worker = h.launchSettings?.({ role: 'worker', ultracode: false }) ?? {};
  if (worker.autoCompactWindow !== 1_000_000) out.push(`worker autoCompactWindow ${worker.autoCompactWindow}`);
  if (!h.fullWindow || !/\[1m\]$/.test(h.fullWindow('claude-fable-5-2'))) out.push('Fable launched without its 1M variant');
  if ((h.renewal?.FRESH_START_PCT ?? 90) < 90) out.push(`ad-hoc worker renewed at ${h.renewal.FRESH_START_PCT}%`);
  if (h.renewal?.STALE_CACHE_MS) out.push('permanent worker renewed after an idle hour');
  return out;
}

async function scoreBrief(mission) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const prompt = `Note de 0 à 5 la complétude de ce brief confié à un agent de code : objectif clair, contexte utile, contraintes, livrable attendu, vérification demandée. Réponds seulement par le chiffre.\n\n<brief>\n${mission}\n</brief>`;
  let text = '';
  for await (const m of query({ prompt, options: { model: 'claude-sonnet-5-5', maxTurns: 1, tools: [], settingSources: [], strictMcpConfig: true } })) {
    if (m.type === 'result' && m.subtype === 'success') text = m.result;
  }
  const n = Number(/[0-5]/.exec(text)?.[0]);
  return Number.isFinite(n) ? n : null;
}

async function evaluate(h, tag) {
  const jobs = scenarios.flatMap((sc) => Array.from({ length: runs }, (_, i) => ({ sc, i })));
  const results = [];
  let at = 0;
  const worker = async () => {
    // One folder per lane: its runs follow each other and share the cached prefix.
    const dir = mkdtempSync(join(os.tmpdir(), 'hub-eval-lane-'));
    while (at < jobs.length) {
      const { sc, i } = jobs[at++];
      const t0 = Date.now();
      const r = await h.runScenario(sc, { lang: 'fr', dir, ...master });
      const failed = check(sc, r);
      const briefs = judge ? await Promise.all(callsOf(r, 'spawn_worker').map((c) => scoreBrief(String(c.input.mission ?? '')))) : [];
      results.push({ id: sc.id, run: i, ok: failed.length === 0, failed, requests: r.requests.length, prefix: r.prefix, topicAlone: topicAlone(r), cost: r.costUsd, ms: Date.now() - t0, briefs, calls: r.calls.map((c) => `${short(c.tool)}${c.refused ? '(refused)' : ''}`), inputs: r.calls.map((c) => JSON.stringify(Object.fromEntries(Object.entries(c.input).map(([k, v]) => [k, typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}…` : v]))).slice(0, 600)), text: r.text.slice(-1500) });
      process.stdout.write(`${tag} ${sc.id}#${i + 1} ${failed.length ? `FAIL ${failed.join(' | ').slice(0, 160)}` : 'ok'}\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, worker));
  return { results, static: staticChecks(h) };
}

function summary(res) {
  const by = new Map();
  for (const r of res.results) {
    const g = by.get(r.id) ?? { pass: 0, n: 0, requests: 0, prefix: 0, topicAlone: 0, cost: 0, briefs: [] };
    g.prefix += r.prefix ?? 0;
    g.pass += r.ok ? 1 : 0;
    g.n++;
    g.requests += r.requests;
    g.topicAlone += r.topicAlone;
    g.cost += r.cost;
    g.briefs.push(...r.briefs.filter((b) => b !== null));
    by.set(r.id, g);
  }
  return by;
}

let refRoot = '';
try {
  const current = await evaluate(await bundle(root, 'current'), 'current');
  let ref = baselineFile ? JSON.parse(readFileSync(baselineFile, 'utf8')).current : null;
  if (!ref && refName !== 'none') {
    refRoot = join(os.tmpdir(), `hub-eval-ref-${Date.now()}`);
    const added = spawnSync('git', ['-C', root, 'worktree', 'add', '--detach', refRoot, refName], { encoding: 'utf8' });
    if (added.status !== 0) throw new Error(`git worktree add ${refName}: ${added.stderr}`);
    ref = await evaluate(await bundle(refRoot, 'ref'), refName);
  }
  const cur = summary(current);
  const base = ref ? summary(ref) : null;
  const avg = (a) => (a.length ? (a.reduce((s, x) => s + x, 0) / a.length).toFixed(1) : '-');
  const lines = [`scenario  current ${ref ? `${(baselineFile ? 'baseline' : refName).padEnd(12)}` : ''} requests  prefix K  topic-alone  cost$  title`];
  let regressions = 0;
  for (const sc of scenarios) {
    const c = cur.get(sc.id);
    const b = base?.get(sc.id);
    if (b && c.pass < b.pass) regressions++;
    lines.push(`${sc.id.padEnd(9)} ${`${c.pass}/${c.n}`.padEnd(7)} ${b ? `${b.pass}/${b.n}`.padEnd(12) : ''} ${(c.requests / c.n).toFixed(1).padStart(8)}${b ? `/${(b.requests / b.n).toFixed(1)}` : ''}  ${(c.prefix / c.n / 1e3).toFixed(1)}${b ? `/${(b.prefix / b.n / 1e3).toFixed(1)}` : ''}  ${String(c.topicAlone).padStart(5)}${b ? `/${b.topicAlone}` : ''}  ${c.cost.toFixed(2)}  ${sc.title}${judge ? ` (brief ${avg(c.briefs)}${b ? `/${avg(b.briefs)}` : ''})` : ''}`);
  }
  lines.push(`S11 (static) current ${current.static.length ? `FAIL ${current.static.join('; ')}` : 'ok'}${ref ? ` · ${refName} ${ref.static.length ? `FAIL ${ref.static.join('; ')}` : 'ok'}` : ''}`);
  const totalCost = [...current.results, ...(ref?.results ?? [])].reduce((s, r) => s + r.cost, 0);
  lines.push(`${regressions} regression(s). Plan usage of this eval: $${totalCost.toFixed(2)} at API prices.`);
  console.log(`\n${lines.join('\n')}`);
  const file = join(outDir, `eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ runs, ref: refName, current, reference: ref }, null, 1));
  console.log(`Details: ${file}`);
  process.exitCode = regressions > 0 || current.static.length > 0 ? 1 : 0;
} finally {
  if (refRoot && existsSync(refRoot)) {
    spawnSync('git', ['-C', root, 'worktree', 'remove', '--force', refRoot]);
    rmSync(refRoot, { recursive: true, force: true });
  }
  for (const tag of ['current', 'ref']) rmSync(join(root, 'node_modules', `.eval-${tag}.mjs`), { force: true });
}
