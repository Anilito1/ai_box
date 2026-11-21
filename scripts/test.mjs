// Unit tests: each *.test.ts under src and poc is bundled with esbuild into a temporary folder, then run by node --test.
// `node scripts/test.mjs poc` runs the tests of the named folders only.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { build } from 'esbuild';
import { builtStamp, sourceStamp } from './sourceStamp.mjs';

const roots = process.argv.length > 2 ? process.argv.slice(2) : ['src', 'poc'];

// Some tests of src drive the built app.
if (roots.includes('src') && builtStamp('.') !== sourceStamp('.')) {
  const built = spawnSync(process.execPath, ['build.mjs'], { stdio: 'inherit' });
  if (built.status !== 0) process.exit(built.status ?? 1);
}

const find = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? find(join(dir, e.name)) : e.name.endsWith('.test.ts') ? [join(dir, e.name)] : []));
const tests = roots.flatMap(find);
// Inside the project (its node_modules): the bundles keep the SDK and zod external, and they find them from here.
const out = resolve(mkdtempSync(join('node_modules', '.hub-tests-')));
try {
  const files = tests.map((src) => join(out, (src.startsWith('src') ? relative('src', src) : src).replace(/[\\/]/g, '_').replace(/\.ts$/, '.mjs')));
  await Promise.all(
    tests.map((src, i) =>
      build({
        entryPoints: [src],
        outfile: files[i],
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'es2022',
        logLevel: 'warning',
        external: ['electron', '@anthropic-ai/claude-agent-sdk', 'zod'],
      }),
    ),
  );
  const run = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
  process.exitCode = run.status ?? 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
