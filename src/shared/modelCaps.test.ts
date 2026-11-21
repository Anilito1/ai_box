import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeAccount } from './accounts';
import { applyCaps, chatShapes, detectModel, detectModels, guessPreset, normalizeCaps, shapeOf, specOf, type ModelShape } from './modelCaps';

// What a provider's list says of a model, on entries shaped like the ones Venice and OpenRouter give (GET
// /models?type=all and GET /models, trimmed to the fields that are read), and what the user declares over it.

const shape = (entry: unknown): ModelShape => {
  const found = detectModel(entry);
  assert.ok('shape' in found, JSON.stringify(found));
  return found.shape;
};
/** A model's ports in a few words, as the tests compare them. */
const sig = (s: ModelShape) => {
  const spec = specOf('p', s);
  const side = (ports: typeof spec.inputs, inputs: boolean) => ports.map((p) => `${p.type}${(p.max ?? 1) > 1 ? `×${p.max}` : ''}${inputs && !p.required ? '?' : ''}`).join('+');
  return `${side(spec.inputs, true)} > ${side(spec.outputs, false)}`;
};

test('Venice: the type says the API, the capabilities what a text model reads', () => {
  const plain = shape({ id: 'deepseek-v4', type: 'text', model_spec: { name: 'DeepSeek V4', pricing: { input: { usd: 0.5 }, output: { usd: 2 } }, capabilities: { supportsVision: false } } });
  assert.deepEqual(plain, { model: 'deepseek-v4', name: 'DeepSeek V4', preset: 'llm', source: 'listed', price: { input: 0.5, output: 2 } });
  assert.equal(sig(plain), 'text > text');
  const spec = specOf('a-ven00001', plain);
  assert.deepEqual([spec.ref, spec.api, spec.queued], ['a-ven00001/deepseek-v4', 'chat', false]);

  assert.equal(sig(shape({ id: 'qwen-vl', type: 'text', model_spec: { capabilities: { supportsVision: true, maxImages: 5 } } })), 'text?+image×5? > text');
  assert.equal(sig(shape({ id: 'one', type: 'text', model_spec: { capabilities: { supportsVision: true, supportsMultipleImages: false } } })), 'text?+image? > text');
  assert.equal(sig(shape({ id: 'gemini', type: 'text', model_spec: { capabilities: { supportsVision: true, supportsVideoInput: true } } })), 'text?+image×8?+video? > text');
});

test('Venice: images, reference images (its "inpaint" models), videos, speech', () => {
  const image = shape({ id: 'venice-sd35', type: 'image', model_spec: { pricing: { generation: { usd: 0.01 } } } });
  assert.deepEqual([sig(image), specOf('p', image).api, image.price], ['text > image', 'image', { perCall: 0.01 }]);
  // A "Reference to Image" model: never an LLM.
  const edit = shape({ id: 'firered-image-edit', type: 'inpaint', model_spec: { pricing: { inpaint: { usd: 0.04 } }, constraints: { combineImages: true, maxInputImages: 4 } } });
  assert.deepEqual([sig(edit), specOf('p', edit).api], ['text+image×4 > image', 'image-edit']);
  assert.equal(sig(shape({ id: 'one-edit', type: 'inpaint', model_spec: { constraints: {} } })), 'text+image > image');

  const i2v = shape({ id: 'wan-i2v', type: 'video', model_spec: { constraints: { model_type: 'image-to-video', durations: ['5s', '10s'], resolutions: ['720p'] } } });
  assert.deepEqual([sig(i2v), specOf('p', i2v).queued, i2v.durations, i2v.resolutions, i2v.aspectRatios], ['text?+image > video', true, ['5s', '10s'], ['720p'], undefined]);
  assert.equal(shape({ id: 't2v', type: 'video', model_spec: { constraints: { model_type: 'text-to-video' } } }).preset, 'text-to-video');
  assert.equal(shape({ id: 'v2v', type: 'video', model_spec: { constraints: { model_type: 'video' } } }).preset, 'video-to-video');
  assert.equal(shape({ id: 'tts-kokoro', type: 'tts' }).preset, 'text-to-speech');
  assert.equal(shape({ id: 'nvidia/parakeet', type: 'asr' }).preset, 'speech-to-text');
});

test('what a graph cannot use is left out: embeddings, upscalers, models that are off', () => {
  assert.deepEqual(detectModel({ id: 'bge-m3', type: 'embedding' }), { skipped: 'embedding' });
  assert.deepEqual(detectModel({ type: 'text' }), { skipped: 'no id' });
  const listed = detectModels({ data: [{ id: 'b', type: 'text' }, { id: 'off', type: 'text', model_spec: { offline: true } }, { id: 'e', type: 'embedding' }, { id: 'a', type: 'image' }] });
  assert.deepEqual(listed.map((m) => m.model), ['a', 'b']);
  assert.deepEqual(chatShapes(listed), ['b']);
});

test('OpenRouter: the modalities of its list', () => {
  const eyes = shape({ id: 'google/gemini', name: 'Gemini', architecture: { input_modalities: ['text', 'image', 'video'], output_modalities: ['text'] }, pricing: { prompt: '0.0000025', completion: '0.00001' } });
  assert.deepEqual([eyes.preset, eyes.price], ['llm-video', { input: 2.5, output: 10 }]);
  assert.equal(shape({ id: 'x/draw', architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] } }).preset, 'reference-to-image');
});

test('a list that gives only names: a guess, marked as one', () => {
  assert.deepEqual(shape({ id: 'deepseek-chat' }), { model: 'deepseek-chat', name: '', preset: 'llm', source: 'guessed' });
  const guesses: [string, string | null][] = [
    ['gpt-4o-mini', 'llm-vision'],
    ['dall-e-3', 'text-to-image'],
    ['wan-2.2-image-to-video', 'image-to-video'],
    ['sora-2', 'text-to-video'],
    ['Reference to Image', 'reference-to-image'],
    ['flux-kontext-edit', 'reference-to-image'],
    ['my-picture-model', 'text-to-image'],
    ['whisper-1', 'speech-to-text'],
    ['tts-1-hd', 'text-to-speech'],
    ['text-embedding-3-small', null],
    ['meta-llama/llama-guard-4-12b', null],
    // Chat models whose names hold "guard" or "video" stay chat models.
    ['openai/gpt-oss-safeguard-20b', 'llm'],
    ['llava-next-video', 'llm-vision'],
    ['hunyuan-video', 'text-to-video'],
  ];
  for (const [id, preset] of guesses) assert.equal(guessPreset(id), preset, id);
});

test('what the user declares wins over the list, and adds the models it lacks', () => {
  const listed = detectModels([{ id: 'Mystery-1', type: 'text', model_spec: { name: 'Mystery One', pricing: { input: { usd: 1 } } } }, { id: 'other', type: 'text' }]);
  const caps = normalizeCaps({ 'mystery-1': { preset: 'reference-to-image', maxImages: 2 }, 'ref-xl': { preset: 'reference-to-image' }, bad: { preset: 'nope' }, ' sp ace': { preset: 'llm' } }, (id) => /^\w[\w.:/@+-]*$/.test(id));
  assert.deepEqual(Object.keys(caps), ['mystery-1', 'ref-xl']);
  const models = applyCaps(listed, caps);
  assert.deepEqual(
    models.map((m) => [m.model, m.preset, m.maxImages, m.source, m.name]),
    [
      ['Mystery-1', 'reference-to-image', 2, 'manual', 'Mystery One'],
      ['other', 'llm', undefined, 'listed', ''],
      ['ref-xl', 'reference-to-image', undefined, 'manual', ''],
    ],
  );
  assert.equal(shapeOf('MYSTERY-1', listed, caps).preset, 'reference-to-image');
  assert.equal(shapeOf('unknown-sora', listed, {}).preset, 'text-to-video');
});

test('a model declared as anything but a chat model leaves the session models of its provider', () => {
  const a = normalizeAccount({
    kind: 'openai',
    slug: 'pictures',
    name: 'Pictures',
    baseUrl: 'https://api.example.com/v1',
    models: ['chat-model', 'Reference-To-Image'],
    modelCaps: { 'reference-to-image': { preset: 'reference-to-image', maxImages: 3 }, 'chat-model': { preset: 'llm-vision' } },
  });
  assert.deepEqual(a.models, ['chat-model']);
  assert.equal(a.model, 'chat-model');
  assert.deepEqual(a.modelCaps, { 'reference-to-image': { preset: 'reference-to-image', maxImages: 3 }, 'chat-model': { preset: 'llm-vision' } });
  // An account without declarations keeps none, and one that is not a provider the user added never has any.
  assert.equal(normalizeAccount({ kind: 'openai', slug: 'x', name: 'X', models: ['m'] }).modelCaps, undefined);
  assert.equal(normalizeAccount({ kind: 'claude', name: 'C', modelCaps: { m: { preset: 'llm' } } }).modelCaps, undefined);
});
