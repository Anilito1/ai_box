import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DictationEvent } from '../../shared/dictation';
import { canSend, isDictationLanguage, TERMS_MAX } from '../../shared/dictation';
import { AppleEngine, appleSupported, checkApple, helperPath } from './apple';
import { LineSplitter, parseLine } from './engine';
import { applyTerms, COMMON_TERMS, mergeTerms } from './terms';

test('the helper writes JSON lines: events are read, anything else is left out', () => {
  assert.deepEqual(parseLine('{"type":"ready"}'), { type: 'ready' });
  assert.deepEqual(parseLine('{"type":"partial","text":"Bonjour"}'), { type: 'partial', text: 'Bonjour' });
  assert.deepEqual(parseLine('{"type":"final","text":""}'), { type: 'final', text: '' });
  assert.deepEqual(parseLine('{"type":"error","code":"asset","message":"x"}'), { type: 'error', code: 'asset', message: 'x' });
  assert.deepEqual(parseLine('{"type":"error"}'), { type: 'error', code: 'unknown', message: '' });
  for (const bad of ['', 'not json', '42', 'null', '{"type":"partial"}', '{"type":"partial","text":3}', '{"type":"other"}']) assert.equal(parseLine(bad), null);
});

test('lines are cut whatever the way the stream was chunked', () => {
  const s = new LineSplitter();
  assert.deepEqual(s.push('{"a":1}\n{"b"'), ['{"a":1}']);
  assert.deepEqual(s.push(':2}\n\n{"c":3}'), ['{"b":2}']);
  assert.deepEqual(s.push('\n'), ['{"c":3}']);
});

test('terms: the window’s first, no duplicate, bounded, junk dropped', () => {
  const terms = mergeTerms(['dictee', 'react', 'x', 'a'.repeat(80), 42, 'bad\u0000term', ' feature/dictee ']);
  assert.equal(terms[0], 'dictee');
  assert.ok(terms.includes('feature/dictee'));
  assert.equal(terms.filter((t) => t.toLowerCase() === 'react').length, 1);
  assert.ok(!terms.some((t) => t === 'x' || t.length > 40 || t.includes('\u0000')));
  assert.equal(mergeTerms(Array.from({ length: 500 }, (_, i) => `term${i}`)).length, TERMS_MAX);
  assert.equal(mergeTerms(undefined).length, COMMON_TERMS.length);
});

test('terms get their own spelling back, as whole words only', () => {
  const terms = ['React', 'GitHub', 'Node.js', 'commit', 'API'];
  assert.equal(applyTerms('un composant react sur github et nodejs', terms), 'un composant React sur GitHub et nodejs');
  assert.equal(applyTerms('le node.js', terms), 'le Node.js');
  assert.equal(applyTerms('reactive et api-key', terms), 'reactive et API-key');
  // Plain lowercase words are left as the engine wrote them (a capital at the start of a sentence stays).
  assert.equal(applyTerms('Commit du jour', terms), 'Commit du jour');
});

test('languages: well-formed tags only', () => {
  for (const ok of ['fr-FR', 'en-US', 'de', 'zh-Hans-CN']) assert.ok(isDictationLanguage(ok), ok);
  for (const bad of ['', 'fr_FR', '../x', 'fr-FR; rm', 3, null]) assert.ok(!isDictationLanguage(bad), String(bad));
});

test('a dictation in progress keeps the composer from sending its unfinished text', () => {
  const ready = { hasContent: true, preparing: 0, dictating: false };
  assert.equal(canSend(ready), true);
  assert.equal(canSend({ ...ready, dictating: true }), false);
  assert.equal(canSend({ ...ready, hasContent: false }), false);
  assert.equal(canSend({ ...ready, preparing: 1 }), false);
});

test('the helper is looked for next to the resources once packaged, else in the native build folder', () => {
  const posix = (path: string) => path.replaceAll('\\', '/');
  assert.equal(posix(helperPath('/app/Resources', '/src', true)), '/app/Resources/dictation-mac');
  assert.equal(posix(helperPath('/app/Resources', '/src', false)), '/src/native/dictation-mac/build/dictation-mac');
  assert.equal(appleSupported('linux', '25.0.0'), false);
  assert.equal(appleSupported('darwin', '24.6.0'), false);
  assert.equal(appleSupported('darwin', '25.6.0'), true);
});

// With the real helper and a voice from `say`: only on a Mac that has both, and the French voice asset.
const helper = helperPath('', process.cwd(), false);
const canRun = appleSupported() && existsSync(helper) && spawnSync('say', ['-v', '?'], { encoding: 'utf8' }).stdout?.includes('Thomas') === true;

test('the Apple engine turns French speech into text: partials, then the final', { skip: !canRun }, async () => {
  const support = await checkApple(helper, 'fr-FR');
  if (!support.installed) return;
  const dir = mkdtempSync(join(tmpdir(), 'dictation-'));
  try {
    const aiff = join(dir, 's.aiff');
    const wav = join(dir, 's.wav');
    assert.equal(spawnSync('say', ['-v', 'Thomas', '-o', aiff, 'Bonjour, je voudrais lancer les tests sur la branche principale.']).status, 0);
    assert.equal(spawnSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav]).status, 0);
    const pcm = readFileSync(wav).subarray(44);
    const events: DictationEvent[] = [];
    const engine = new AppleEngine(helper);
    const done = new Promise<void>((resolve) =>
      engine.onEvent((e) => {
        events.push(e);
        if (e.type === 'final' || e.type === 'error') resolve();
      }),
    );
    engine.start({ language: 'fr-FR', terms: ['Vitest'] });
    for (let i = 0; i < pcm.length; i += 3200) engine.feed(pcm.subarray(i, i + 3200));
    engine.stop();
    await done;
    assert.ok(events.some((e) => e.type === 'ready'));
    assert.ok(events.filter((e) => e.type === 'partial').length >= 2, 'partial results stream in');
    const last = events[events.length - 1];
    assert.equal(last.type, 'final');
    assert.match(last.type === 'final' ? last.text.toLowerCase() : '', /bonjour.*tests.*branche/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
