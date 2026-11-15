import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SCRATCH_ENV } from '../shared/purge';
import { loadConfig } from './config';
import type { CostLog } from './costLog';
import type { McpHub } from './mcpHub';
import { scratchSection } from './prompts';
import { SessionManager } from './sessions';

// Every worker gets its scratch folder for throwaway files (docs/purge-ephemeres.md), whatever its program.

interface Inner {
  prepareScratch(s: { name: string; cwd: string }): string | null;
}

function manager(withRoot: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-scratch-'));
  const work = join(dir, 'work');
  mkdirSync(join(work, 'site'), { recursive: true });
  const cfg = loadConfig(dir, 'en');
  cfg.workspaces = [work];
  const m = new SessionManager({
    cfg,
    dataDir: dir,
    executable: () => '',
    codexExecutable: () => '',
    geminiExecutable: () => '',
    mcpHub: {} as McpHub,
    sessionEnv: () => ({ set: {}, unset: [] }),
    persist: () => undefined,
    costLog: { today: () => 0 } as unknown as CostLog,
    capabilities: async () => '',
    ...(withRoot ? { scratchRoot: join(dir, 'scratch') } : {}),
  });
  return { m, inner: m as unknown as Inner, dir, work, done: () => (m.killAll(), rmSync(dir, { recursive: true, force: true })) };
}

test('a worker in a project gets <project>/.aibox/scratch/<its name>, which git ignores', () => {
  const { inner, work, done } = manager(true);
  try {
    const site = join(work, 'site');
    const dir = inner.prepareScratch({ name: 'hub-qa/../x', cwd: site });
    // A name cannot climb out: the separators are gone, ".." is only text inside one folder name.
    assert.equal(dir, join(site, '.aibox', 'scratch', 'hub-qa-..-x'));
    assert.ok(existsSync(dir as string));
    assert.match(readFileSync(join(site, '.aibox', '.gitignore'), 'utf8'), /^\*$/m);
  } finally {
    done();
  }
});

test('a worker whose folder is too wide for a project gets its scratch in the app, or none', () => {
  const a = manager(true);
  try {
    assert.equal(a.inner.prepareScratch({ name: 'hub-qa', cwd: a.work }), join(a.dir, 'scratch', 'hub-qa'));
    assert.equal(a.inner.prepareScratch({ name: 'hub-qa', cwd: homedir() }), join(a.dir, 'scratch', 'hub-qa'));
    assert.ok(!existsSync(join(a.work, '.aibox')), 'nothing written in the workspace');
  } finally {
    a.done();
  }
  const b = manager(false);
  try {
    assert.equal(b.inner.prepareScratch({ name: 'hub-qa', cwd: b.work }), null);
  } finally {
    b.done();
  }
});

test('the scratch rules name the folder and the variable, in both languages', () => {
  for (const l of ['fr', 'en'] as const) {
    const text = scratchSection('/p/.aibox/scratch/w', SCRATCH_ENV, l);
    assert.ok(text.includes('`/p/.aibox/scratch/w`'));
    assert.ok(text.includes('AIBOX_SCRATCH_DIR'));
  }
});
