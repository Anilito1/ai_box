// Measures the local code search (docs/recherche-semantique.md): `node scripts/search-bench.mjs help`.
// The bench and the model worker are bundled inside node_modules so they find the grammars from there.
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const out = resolve(join('node_modules', '.search-bench'));
const common = { bundle: true, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'warning' };
await Promise.all([
  build({ ...common, entryPoints: ['scripts/search-bench.ts'], outfile: join(out, 'bench.mjs') }),
  build({ ...common, entryPoints: ['src/main/search/worker.ts'], outfile: join(out, 'search-worker.mjs') }),
]);
const run = spawnSync(process.execPath, [join(out, 'bench.mjs'), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, AIBOX_SEARCH_WORKER_SCRIPT: join(out, 'search-worker.mjs') } });
process.exitCode = run.status ?? 1;
