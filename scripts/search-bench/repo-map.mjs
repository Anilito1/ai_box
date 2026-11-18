// Runs scripts/search-bench/repo-map.ts: bundled inside node_modules so it finds the grammars from there.
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const out = resolve(join('node_modules', '.search-bench', 'repo-map.mjs'));
await build({ bundle: true, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'warning', entryPoints: ['scripts/search-bench/repo-map.ts'], outfile: out });
const run = spawnSync(process.execPath, [out, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exitCode = run.status ?? 1;
