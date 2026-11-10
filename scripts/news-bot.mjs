// Offline fixture harness; never connects accounts or publishes.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const action = process.argv[2] ?? 'dry-run';
if (!['test', 'dry-run'].includes(action)) throw new Error('Usage: node scripts/news-bot.mjs [test|dry-run]');
const dir = mkdtempSync(join(tmpdir(), 'ai-box-newsbot-harness-'));
try {
  const entries = action === 'test' ? ['runtime.test', 'newsBot.test'] : ['dryRunCli'];
  const files = [];
  for (const entry of entries) {
    const out = join(dir, `${entry}.mjs`);
    await build({ entryPoints: [`src/main/newsBot/${entry}.ts`], outfile: out, bundle: true, platform: 'node', format: 'esm', target: 'node24' });
    files.push(out);
  }
  const child = spawnSync(process.execPath, [...(action === 'test' ? ['--test'] : []), ...files], { stdio: 'inherit' });
  process.exitCode = child.status ?? 1;
} finally { rmSync(dir, { recursive: true, force: true }); }
