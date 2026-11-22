import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ModelLists } from './modelLists';

test("a provider's listed models are kept by address, across starts, the most recent twenty", () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-lists-'));
  const file = join(dir, 'model-lists.json');
  try {
    let now = 1000;
    const lists = new ModelLists(file, () => now);
    assert.equal(lists.get('https://api.venice.ai/api/v1'), null);
    lists.set('https://api.venice.ai/api/v1/', ['llama-3.3-70b', 'qwen-coder']);
    assert.deepEqual(lists.get('HTTPS://api.venice.ai/api/v1'), { at: 1000, models: ['llama-3.3-70b', 'qwen-coder'] }, 'case and trailing slash aside');
    assert.doesNotMatch(readFileSync(file, 'utf8'), /key|token/i);
    // Read again at the next start.
    assert.deepEqual(new ModelLists(file).get('https://api.venice.ai/api/v1')?.models, ['llama-3.3-70b', 'qwen-coder']);
    for (let i = 0; i < 25; i++) {
      now += 1;
      lists.set(`https://host${i}.example/v1`, [`m${i}`]);
    }
    const again = new ModelLists(file);
    assert.equal(again.get('https://api.venice.ai/api/v1'), null, 'the oldest went first');
    assert.deepEqual(again.get('https://host24.example/v1')?.models, ['m24']);
    assert.deepEqual(again.get('https://host5.example/v1')?.models, ['m5']);
    assert.equal(again.get('https://host4.example/v1'), null);
    writeFileSync(file, '{ not json');
    assert.equal(new ModelLists(file).get('https://host24.example/v1'), null, 'an unreadable file: asked for again');
    writeFileSync(file, JSON.stringify({ 'https://a.example/v1': { at: 1, models: [42] }, 'https://b.example/v1': { at: 2, models: ['ok'] } }));
    const mixed = new ModelLists(file);
    assert.equal(mixed.get('https://a.example/v1'), null);
    assert.deepEqual(mixed.get('https://b.example/v1')?.models, ['ok']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
