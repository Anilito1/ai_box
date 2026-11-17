import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Lang } from '../shared/i18n';
import { normalizeRole } from '../shared/team';
import type { TeamRole } from '../shared/types';
import { loadConfig } from './config';
import { setLang } from './i18n';
import { masterPrompt, workerPrompt } from './prompts';

// The hub's instructions are reread on every request of every session: each section keeps a size budget, and the two
// languages say the same things (same sections, same rules). A change past a budget is a choice, made here on purpose.

const BUDGET = { master: 18_000, worker: 6_500, section: 4_000 };

function prompts(l: Lang) {
  setLang(l);
  const dir = mkdtempSync(join(tmpdir(), 'hub-prompts-'));
  const cfg = loadConfig(dir, l);
  for (const name of ['brain', 'supabase', 'ai-box', 'etudiant']) {
    cfg.team.push(normalizeRole({ id: `r-${name}`, name, description: `Post ${name}, a description of average length.`, instructions: 'Standing rule.', folders: [join(dir, name)] }) as TeamRole);
  }
  const out = { master: masterPrompt(cfg), worker: workerPrompt(cfg, cfg.team[0]) };
  rmSync(dir, { recursive: true, force: true });
  return out;
}

/** Sections of a prompt: [size, rules (lines starting with "- ")]. */
const sections = (text: string) => text.split(/\n(?=## )/).map((s) => ({ title: s.split('\n')[0], size: s.length, rules: s.split('\n').filter((l) => l.startsWith('- ')).length }));

test('every section of the master and worker prompts stays within its budget', () => {
  for (const l of ['fr', 'en'] as Lang[]) {
    const p = prompts(l);
    assert.ok(p.master.length <= BUDGET.master, `${l} master: ${p.master.length} > ${BUDGET.master}`);
    assert.ok(p.worker.length <= BUDGET.worker, `${l} worker: ${p.worker.length} > ${BUDGET.worker}`);
    for (const s of [...sections(p.master), ...sections(p.worker)]) assert.ok(s.size <= BUDGET.section, `${l} ${s.title}: ${s.size} > ${BUDGET.section}`);
  }
});

test('French and English prompts have the same sections and the same number of rules', () => {
  const fr = prompts('fr');
  const en = prompts('en');
  for (const kind of ['master', 'worker'] as const) {
    const a = sections(fr[kind]);
    const b = sections(en[kind]);
    assert.equal(a.length, b.length, `${kind}: ${a.length} sections in French, ${b.length} in English`);
    a.forEach((s, i) => assert.equal(s.rules, b[i].rules, `${kind} "${s.title}" / "${b[i].title}": ${s.rules} rules in French, ${b[i].rules} in English`));
  }
});
