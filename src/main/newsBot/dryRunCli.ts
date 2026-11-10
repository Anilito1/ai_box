import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dryRun } from './dryRun';
import { runtimeDefaults } from './runtime';
const dir = mkdtempSync(join(tmpdir(), 'ai-box-newsbot-dry-run-'));
console.log(JSON.stringify({ dir, report: await dryRun(dir, runtimeDefaults) }, null, 2));
