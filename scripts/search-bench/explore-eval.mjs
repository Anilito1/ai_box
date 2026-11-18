// The explore helper asked directly, without a session around it: does its answer cite the right file and lines, what
// does it cost, how long does it take. Compares helper models on the same questions.
//   node scripts/search-bench/explore-eval.mjs <questions.json> <out.jsonl> [models=haiku,sonnet] [limit=all] [parallel=3]
// questions.json: [{ id?, repo (under AIBOX_BENCH_REPOS) or cwd, q, expect: [{ path, start?, end? }] }]
//   BENCH_SPEND_FILE, BENCH_BUDGET_USD  the study's ceiling (budget.mjs)
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { explore } from '../explore-mcp.mjs';
import { budget } from './budget.mjs';

const [file, outFile, models = 'haiku,sonnet', limit = 'all', parallel = '3'] = process.argv.slice(2);
const all = JSON.parse(readFileSync(file, 'utf8')).map((q, i) => ({ id: q.id ?? `q${i}`, ...q, cwd: q.cwd ?? join(resolve(process.env.AIBOX_BENCH_REPOS ?? ''), q.repo) }));
// A sample spread over the whole file rather than its first rows.
const n = limit === 'all' ? all.length : Math.min(Number(limit), all.length);
const questions = Array.from({ length: n }, (_, i) => all[Math.floor((i * all.length) / n)]);
const wallet = budget();
/** EVAL_MAP_DIR: a folder of map-<repo>.txt (repo-map.mjs); each helper then also starts from its repo's map. */
function mapOf(cwd) {
  const file = join(process.env.EVAL_MAP_DIR ?? '', `map-${basename(cwd)}.txt`);
  return process.env.EVAL_MAP_DIR && existsSync(file) ? `Main definitions, most referenced files first (file (lines): name@line):\n${readFileSync(file, 'utf8')}` : '';
}
const RESERVE = { haiku: 0.1, sonnet: 0.6 };

/** The `path:start-end` references of an answer. */
function citations(text) {
  return [...text.matchAll(/([\w./@\\-]+\.[a-z]{1,5}):(\d+)(?:-(\d+))?/gi)].map((m) => ({ path: m[1].replace(/\\/g, '/'), start: Number(m[2]), end: Number(m[3] ?? m[2]) }));
}
function score(q, text) {
  const cited = citations(text);
  const same = (c, e) => c.path === e.path || c.path.endsWith(`/${e.path}`) || e.path.endsWith(`/${c.path}`);
  const file = q.expect.some((e) => text.includes(e.path) || cited.some((c) => same(c, e)));
  // The lines: a citation that overlaps the expected range, with 5 lines of slack.
  const ranged = q.expect.filter((e) => e.start);
  const lines = ranged.length ? ranged.some((e) => cited.some((c) => same(c, e) && c.start <= e.end + 5 && e.start <= c.end + 5)) : null;
  return { file, lines, citations: cited.length };
}

const jobs = questions.flatMap((q) => models.split(',').map((model) => ({ q, model })));
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const { q, model } = jobs[next++];
    if (!wallet.room(RESERVE[model] ?? 0.6)) return console.log(JSON.stringify({ stopped: 'budget', spent: +wallet.spent().toFixed(2) }));
    const { text, ...row } = await explore({ cwd: q.cwd, question: q.q, model, seed: mapOf(q.cwd) });
    wallet.charge(`explore-eval:${model}`, row.costUsd ?? 0);
    const out = { id: q.id, type: q.type, ...row, ...score(q, text) };
    appendFileSync(outFile, `${JSON.stringify({ ...out, answer: text })}\n`);
    console.log(JSON.stringify(out));
  }
}
await Promise.all(Array.from({ length: Number(parallel) }, worker));
