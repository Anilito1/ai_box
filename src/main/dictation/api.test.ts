import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { baseUrlOf, DICTATION_DEFAULTS, engineOf, isSttUrl, modelOf, type DictationEvent } from '../../shared/dictation';
import { applyPatch, loadConfig } from '../config';
import { ApiEngine, errorOf, languageFor, MAX_PCM_BYTES, MIN_PCM_BYTES, textOf, transcriptionRequest, wav, type ApiTarget } from './api';

const groq: ApiTarget = { protocol: 'openai', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo', key: 'gsk_secret' };
const xai: ApiTarget = { protocol: 'xai', baseUrl: 'https://api.x.ai/v1', model: 'grok-voice-transcribe-2.0', key: 'xai-secret' };
const second = Buffer.alloc(32_000);

test('the engine: Apple’s only where the machine has it, the service everywhere else', () => {
  assert.equal(engineOf({ engine: 'native' }, true), 'native');
  assert.equal(engineOf({ engine: 'native' }, false), 'api');
  assert.equal(engineOf({ engine: 'api' }, true), 'api');
  assert.equal(modelOf({ preset: 'groq', model: '' }), 'whisper-large-v3-turbo');
  assert.equal(modelOf({ preset: 'openai', model: 'whisper-1' }), 'whisper-1');
  assert.equal(modelOf({ preset: 'custom', model: '' }), '');
  assert.equal(baseUrlOf({ preset: 'openai', baseUrl: 'https://ignored' }), 'https://api.openai.com/v1');
  assert.equal(baseUrlOf({ preset: 'custom', baseUrl: 'http://localhost:8000/v1/' }), 'http://localhost:8000/v1');
  for (const ok of ['', 'https://api.example.com/v1', 'http://192.168.1.4:9000']) assert.ok(isSttUrl(ok), ok);
  for (const bad of ['ftp://x', 'https://', 'https://a b', 'https://x/v1?key=1', 42]) assert.ok(!isSttUrl(bad), String(bad));
});

test('settings: the service is kept, a bad value is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-stt-'));
  try {
    const cfg = loadConfig(dir, 'fr');
    assert.deepEqual(cfg.dictation, DICTATION_DEFAULTS);
    assert.equal(applyPatch(cfg, { dictation: { engine: 'api', preset: 'custom', baseUrl: 'https://stt.example/v1', model: 'whisper-1' } }), null);
    assert.deepEqual({ ...cfg.dictation }, { ...DICTATION_DEFAULTS, engine: 'api', preset: 'custom', baseUrl: 'https://stt.example/v1', model: 'whisper-1' });
    assert.equal(applyPatch(cfg, { dictation: { preset: 'elsewhere' as never } }), 'dictation.preset');
    assert.equal(applyPatch(cfg, { dictation: { baseUrl: 'javascript:alert(1)' } }), 'dictation.baseUrl');
    assert.equal(applyPatch(cfg, { dictation: { model: 'a b' } }), 'dictation.model');
    assert.equal(cfg.dictation.preset, 'custom');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the audio goes as a 16 kHz mono 16-bit WAV', () => {
  const file = wav(Buffer.from([1, 2, 3, 4]));
  assert.equal(file.length, 48);
  assert.equal(file.toString('ascii', 0, 4), 'RIFF');
  assert.equal(file.readUInt32LE(4), 40);
  assert.equal(file.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.equal(file.readUInt16LE(22), 1);
  assert.equal(file.readUInt32LE(24), 16_000);
  assert.equal(file.readUInt16LE(34), 16);
  assert.equal(file.readUInt32LE(40), 4);
  assert.deepEqual([...file.subarray(44)], [1, 2, 3, 4]);
});

test('the language as each service names it', () => {
  assert.equal(languageFor('openai', 'fr-FR'), 'fr');
  assert.equal(languageFor('openai', 'pt-BR'), 'pt');
  assert.equal(languageFor('xai', 'es-ES'), 'es-ES');
  assert.equal(languageFor('xai', 'pt-BR'), 'pt');
  assert.equal(languageFor('xai', 'en-GB'), 'en');
});

test('the request: OpenAI-style with a prompt of terms, xAI with key terms, the audio last', () => {
  const terms = ['React', 'Supabase', ...Array.from({ length: 80 }, (_, i) => `term-number-${i}`)];
  const a = transcriptionRequest(groq, { language: 'fr-FR', terms }, wav(second));
  assert.equal(a.url, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(a.form.get('model'), 'whisper-large-v3-turbo');
  assert.equal(a.form.get('language'), 'fr');
  assert.equal(a.form.get('response_format'), 'json');
  const prompt = a.form.get('prompt') as string;
  assert.ok(prompt.startsWith('React, Supabase, ') && prompt.length <= 400);
  assert.equal([...a.form.keys()].at(-1), 'file');
  const b = transcriptionRequest(xai, { language: 'fr-FR', terms }, wav(second));
  assert.equal(b.url, 'https://api.x.ai/v1/stt');
  assert.equal(b.form.getAll('keyterm').length, terms.length);
  assert.equal(b.form.get('prompt'), null);
  assert.equal([...b.form.keys()].at(-1), 'file');
});

test('refusals and answers', () => {
  assert.deepEqual(errorOf(401, '{"error":{"message":"Invalid API Key"}}'), { code: 'auth', message: 'Invalid API Key' });
  assert.equal(errorOf(429, '').code, 'rate');
  assert.equal(errorOf(404, '').code, 'model');
  assert.equal(errorOf(413, '').code, 'too-long');
  assert.equal(errorOf(503, 'oops').message, 'HTTP 503');
  assert.equal(errorOf(400, '{"error":"bad"}').code, 'request');
  assert.equal(textOf('{"text":"Bonjour"}'), 'Bonjour');
  assert.equal(textOf('{"words":[]}'), null);
  assert.equal(textOf('<html>'), null);
});

/** A service answering `status` with `body`; the requests it got. */
function fake(status: number, body: string) {
  const calls: { url: string; init: RequestInit }[] = [];
  const send = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { calls, send };
}

function run(engine: ApiEngine, audio: Buffer[], cancel = false): Promise<DictationEvent[]> {
  const events: DictationEvent[] = [];
  return new Promise((resolve) => {
    engine.onEvent((e) => {
      events.push(e);
      if (e.type === 'final' || e.type === 'error') resolve(events);
    });
    engine.start({ language: 'fr-FR', terms: ['React'] });
    for (const a of audio) engine.feed(a);
    engine.stop();
    if (cancel) {
      engine.cancel();
      setTimeout(() => resolve(events), 20);
    }
  });
}

test('the engine sends the audio once it ends, with the key in the header only', async () => {
  const service = fake(200, '{"text":"Bonjour le monde"}');
  const events = await run(new ApiEngine(groq, service.send), [second, second]);
  assert.deepEqual(events, [{ type: 'ready' }, { type: 'final', text: 'Bonjour le monde' }]);
  assert.equal(service.calls.length, 1);
  const { url, init } = service.calls[0]!;
  assert.equal(url, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.deepEqual(init.headers, { Authorization: 'Bearer gsk_secret' });
  assert.equal(init.redirect, 'error');
  assert.equal(((init.body as FormData).get('file') as Blob).size, 44 + 64_000);
});

test('too short a recording sends nothing; a refusal is an error; a cancelled one is silent', async () => {
  const quiet = fake(200, '{"text":"x"}');
  assert.deepEqual(await run(new ApiEngine(groq, quiet.send), [Buffer.alloc(MIN_PCM_BYTES - 2)]), [{ type: 'ready' }, { type: 'final', text: '' }]);
  assert.equal(quiet.calls.length, 0);
  const refused = fake(401, '{"error":{"message":"Invalid API Key"}}');
  assert.deepEqual((await run(new ApiEngine(groq, refused.send), [second])).at(-1), { type: 'error', code: 'auth', message: 'Invalid API Key' });
  const dropped = fake(200, '{"text":"x"}');
  assert.deepEqual(await run(new ApiEngine(groq, dropped.send), [second], true), [{ type: 'ready' }]);
});

test('a network failure is an error; audio past the limit is left out', async () => {
  const send = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  assert.deepEqual((await run(new ApiEngine(groq, send), [second])).at(-1), { type: 'error', code: 'network', message: 'fetch failed' });
  const service = fake(200, '{"text":"ok"}');
  await run(new ApiEngine(groq, service.send), [Buffer.alloc(MAX_PCM_BYTES), second]);
  assert.equal(((service.calls[0]!.init.body as FormData).get('file') as Blob).size, 44 + MAX_PCM_BYTES);
});
