import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signature } from './capabilities';
import { applyManual, detectModel, detectModels, guessPreset } from './detect';

// What a provider's list says of a model, on entries shaped like the ones Venice and OpenRouter give today
// (GET /models?type=all and GET /models, trimmed to the fields that are read).

const spec = (entry: unknown) => {
  const found = detectModel('p', entry);
  assert.ok('spec' in found, JSON.stringify(found));
  return found.spec;
};

test('Venice: the type says the API, the capabilities say what a text model reads', () => {
  const plain = spec({ id: 'deepseek-v4', type: 'text', model_spec: { name: 'DeepSeek V4', pricing: { input: { usd: 0.5 }, output: { usd: 2 } }, capabilities: { supportsVision: false, supportsVideoInput: false } } });
  assert.equal(signature(plain), 'texte → texte');
  assert.deepEqual([plain.api, plain.source, plain.name, plain.price, plain.queued], ['chat', 'listed', 'DeepSeek V4', { input: 0.5, output: 2 }, false]);

  const eyes = spec({ id: 'qwen-vl', type: 'text', model_spec: { capabilities: { supportsVision: true, supportsMultipleImages: true, maxImages: 5 } } });
  assert.equal(signature(eyes), 'texte + images ×5 → texte');
  assert.equal(signature(spec({ id: 'one-image', type: 'text', model_spec: { capabilities: { supportsVision: true, supportsMultipleImages: false } } })), 'texte + image → texte');
  assert.equal(signature(spec({ id: 'gemini', type: 'text', model_spec: { capabilities: { supportsVision: true, supportsVideoInput: true } } })), 'texte + images ×8 + vidéo → texte');
});

test('Venice: images, edits with reference images, videos, speech', () => {
  const image = spec({ id: 'venice-sd35', type: 'image', model_spec: { name: 'Venice SD35', pricing: { generation: { usd: 0.01 } } } });
  assert.deepEqual([signature(image), image.api, image.price], ['texte → image', 'image', { perCall: 0.01 }]);

  // "inpaint" is Venice's name for its instruction editors: the "Reference to Image" models.
  const edit = spec({ id: 'firered-image-edit', type: 'inpaint', model_spec: { pricing: { inpaint: { usd: 0.04 } }, constraints: { combineImages: true, maxInputImages: 4 } } });
  assert.deepEqual([signature(edit), edit.api, edit.price], ['texte + images ×4 → image', 'image-edit', { perCall: 0.04 }]);
  assert.equal(edit.inputs.find((p) => p.id === 'images')?.required, true);
  assert.equal(signature(spec({ id: 'one-edit', type: 'inpaint', model_spec: { constraints: {} } })), 'texte + image → image');

  const i2v = spec({ id: 'wan-i2v', type: 'video', model_spec: { constraints: { model_type: 'image-to-video', durations: ['5s', '10s'], aspect_ratios: ['16:9'], resolutions: ['720p'] } } });
  assert.deepEqual([signature(i2v), i2v.api, i2v.queued, i2v.durations, i2v.resolutions], ['texte + image → vidéo', 'video', true, ['5s', '10s'], ['720p']]);
  assert.equal(signature(spec({ id: 'wan-t2v', type: 'video', model_spec: { constraints: { model_type: 'text-to-video' } } })), 'texte → vidéo');
  assert.equal(signature(spec({ id: 'wan-edit', type: 'video', model_spec: { constraints: { model_type: 'video' } } })), 'texte + vidéo → vidéo');

  assert.equal(signature(spec({ id: 'tts-kokoro', type: 'tts' })), 'texte → audio');
  assert.equal(signature(spec({ id: 'nvidia/parakeet', type: 'asr' })), 'audio → texte');
});

test('what the graph has no use for is left out: embeddings, upscalers, models that are off', () => {
  assert.deepEqual(detectModel('p', { id: 'text-embedding-bge-m3', type: 'embedding' }), { skipped: 'embedding' });
  assert.deepEqual(detectModel('p', { id: 'upscaler', type: 'upscale' }), { skipped: 'upscale' });
  assert.deepEqual(detectModel('p', { type: 'text' }), { skipped: 'no id' });
  const listed = detectModels('venice', {
    data: [
      { id: 'b', type: 'text' },
      { id: 'off', type: 'text', model_spec: { offline: true } },
      { id: 'e', type: 'embedding' },
      { id: 'a', type: 'image' },
    ],
  });
  assert.deepEqual(listed.map((m) => m.ref), ['venice/a', 'venice/b']);
});

test('OpenRouter: the modalities of the list', () => {
  const eyes = spec({ id: 'google/gemini', name: 'Gemini', architecture: { input_modalities: ['text', 'image', 'video'], output_modalities: ['text'] }, pricing: { prompt: '0.0000025', completion: '0.00001' } });
  assert.deepEqual([signature(eyes), eyes.source, eyes.price], ['texte + images ×8 + vidéo → texte', 'listed', { input: 2.5, output: 10 }]);
  assert.equal(signature(spec({ id: 'x/plain', architecture: { input_modalities: ['text'], output_modalities: ['text'] } })), 'texte → texte');
  assert.equal(signature(spec({ id: 'x/image', architecture: { input_modalities: ['text', 'image'], output_modalities: ['image', 'text'] } })), 'texte + images ×8 → texte');
  assert.equal(signature(spec({ id: 'x/draw', architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] } })), 'texte + images ×4 → image');
});

test('a list that gives only names: a guess, marked as one', () => {
  const guessed = spec({ id: 'deepseek-chat', object: 'model' });
  assert.deepEqual([signature(guessed), guessed.source], ['texte → texte', 'guessed']);
  assert.equal(guessPreset('gpt-4o-mini'), 'llm-vision');
  assert.equal(guessPreset('dall-e-3'), 'text-to-image');
  assert.equal(guessPreset('gpt-image-1'), 'text-to-image');
  assert.equal(guessPreset('wan-2.2-image-to-video'), 'image-to-video');
  assert.equal(guessPreset('sora-2'), 'text-to-video');
  assert.equal(guessPreset('flux-kontext-edit'), 'reference-to-image');
  assert.equal(guessPreset('whisper-1'), 'speech-to-text');
  assert.equal(guessPreset('tts-1-hd'), 'text-to-speech');
  assert.equal(guessPreset('text-embedding-3-small'), null);
  assert.deepEqual(detectModel('p', { id: 'text-embedding-3-small' }), { skipped: 'not a generation model' });
});

test('what the user declares wins over the list, and adds the models it lacks', () => {
  const listed = detectModels('p', [
    { id: 'Mystery-1', type: 'text', model_spec: { name: 'Mystery One', pricing: { input: { usd: 1 }, output: { usd: 2 } } } },
    { id: 'other', type: 'text' },
  ]);
  const models = applyManual('p', listed, [
    { model: 'mystery-1', preset: 'reference-to-image', maxImages: 2 },
    { model: 'reference-to-image-xl', preset: 'reference-to-image' },
  ]);
  assert.deepEqual(models.map((m) => [m.ref, signature(m), m.source]), [
    ['p/Mystery-1', 'texte + images ×2 → image', 'manual'],
    ['p/other', 'texte → texte', 'listed'],
    ['p/reference-to-image-xl', 'texte + images ×4 → image', 'manual'],
  ]);
  // The name the list gave stays.
  assert.equal(models[0].name, 'Mystery One');
});
