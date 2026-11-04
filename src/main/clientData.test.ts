import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { clientDataRule } from '../shared/clientData';
import type { Lang } from '../shared/i18n';
import { normalizeRole } from '../shared/team';
import { applyPatch, loadConfig } from './config';
import { setLang } from './i18n';
import { clientDataVariant, masterPrompt, workerPrompt } from './prompts';

// Client data never reaches Claude: every prompt carries the rule, and only the OpenAI workers get the reader's version.

const CODEX = 'a-cdx00001';
const GEMINI = 'a-gem00001';

function hub() {
  const dir = mkdtempSync(join(tmpdir(), 'hub-client-data-'));
  const cfg = loadConfig(dir, 'en');
  cfg.accounts = [
    { id: CODEX, kind: 'codex', name: 'OpenAI (ChatGPT)', baseUrl: '', model: '', smallModel: '', slug: '', models: [], isolated: true },
    { id: GEMINI, kind: 'gemini', name: 'Gemini', baseUrl: '', model: '', smallModel: '', slug: '', models: [], isolated: true },
  ];
  return { cfg, done: () => rmSync(dir, { recursive: true, force: true }) };
}

for (const l of ['fr', 'en'] as Lang[]) {
  test(`every prompt carries the client data rule (${l})`, () => {
    const { cfg, done } = hub();
    setLang(l);
    try {
      assert.equal(cfg.clientDataRule, true);
      const guarded = clientDataRule('guarded', l);
      const reader = clientDataRule('reader', l);
      const post = normalizeRole({ name: 'Data', instructions: 'x' });
      const group = { leads: [{ name: 'lead', members: ['a'] }], member: null };
      const instance = { name: 'data-2', main: 'data', others: [], readOnly: false };
      const prompts = {
        master: masterPrompt(cfg),
        adHoc: workerPrompt(cfg),
        permanent: workerPrompt(cfg, post),
        instance: workerPrompt(cfg, post, instance),
        lead: workerPrompt(cfg, undefined, undefined, group),
      };
      for (const [kind, p] of Object.entries(prompts)) {
        assert.ok(p.includes(guarded), kind);
        assert.ok(!p.includes(reader), kind);
      }
      // A worker on OpenAI may read client data and anonymizes it; Gemini and Claude may not.
      for (const account of [CODEX, GEMINI, 'default']) {
        const variant = clientDataVariant(cfg, account);
        assert.equal(variant, account === CODEX ? 'reader' : 'guarded', account);
        const p = workerPrompt(cfg, post, undefined, undefined, variant);
        assert.ok(p.includes(variant === 'reader' ? reader : guarded), account);
        assert.ok(!p.includes(variant === 'reader' ? guarded : reader), account);
      }
    } finally {
      done();
    }
  });
}

test('Settings turn the client data rule off', () => {
  const { cfg, done } = hub();
  setLang('en');
  try {
    assert.equal(applyPatch(cfg, { clientDataRule: false }), null);
    assert.ok(!masterPrompt(cfg).includes('## Client data'));
    assert.ok(!workerPrompt(cfg, undefined, undefined, undefined, 'reader').includes('## Client data'));
    assert.equal(applyPatch(cfg, { clientDataRule: 'no' as never }), 'clientDataRule');
  } finally {
    done();
  }
});
