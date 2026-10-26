// Unit tests: each src/**/*.test.ts is bundled with esbuild into a temporary folder, then run by node --test.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { build } from 'esbuild';

const find = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? find(join(dir, e.name)) : e.name.endsWith('.test.ts') ? [join(dir, e.name)] : []));
const tests = find('src');
const out = mkdtempSync(join(tmpdir(), 'hub-tests-'));
try {
  const files = tests.map((src) => join(out, relative('src', src).replace(/[\\/]/g, '_').replace(/\.ts$/, '.mjs')));
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
