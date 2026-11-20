import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAccount, normalizeAccount } from './accounts';
import { manualVideoModel, mergeVideoModels, modelKind, textModels, videoAmong, videoApiOf } from './video';

test('a model has a kind: what a list calls video or image is no text model, anything else is', () => {
  assert.deepEqual(['video', 'Video', 'text-to-video', 'image-to-video'].map(modelKind), Array(4).fill('video'));
  assert.deepEqual(['image', 'inpaint', 'upscale', 'text-to-image'].map(modelKind), Array(4).fill('image'));
  // A list that says nothing, or names a kind of text model (one that reads images or videos too), leaves the model where it always was.
  assert.deepEqual([undefined, null, 42, '', 'text', 'chat', 'language', 'code', 'image-text-to-text', 'video-llm', 'constructor'].map(modelKind), Array(11).fill('text'));
});

test('the hub speaks a video API at Venice’s address only', () => {
  assert.equal(videoApiOf('https://api.venice.ai/api/v1'), 'venice');
  assert.equal(videoApiOf('https://API.Venice.ai/api/v1/'), 'venice');
  for (const url of ['https://api.deepseek.com', 'https://venice.ai.example.com/api/v1', 'https://example.com/api.venice.ai', 'not a url', '']) assert.equal(videoApiOf(url), null, url);
});

test('video models never count among the models that run a session', () => {
  const video = ['wan-2.5-preview-text-to-video', 'Kling-Video'];
  assert.deepEqual(textModels(['venice-uncensored', 'wan-2.5-preview-text-to-video', 'kling-video', 'llama-3.3-70b'], video), ['venice-uncensored', 'llama-3.3-70b']);
  assert.deepEqual(videoAmong(['venice-uncensored', 'KLING-VIDEO'], video), ['KLING-VIDEO']);
  const models = ['a', 'b'];
  assert.equal(textModels(models, []), models, 'nothing known as video: the list as it is');
});

test('the models named by hand come after the provider’s own, without a double', () => {
  const listed = [{ ...manualVideoModel('wan-video'), name: 'Wan', manual: false }];
  assert.deepEqual(mergeVideoModels(listed, ['WAN-video', 'my-video']).map((m) => [m.id, m.manual]), [['wan-video', false], ['my-video', true]]);
});

test('a provider’s account keeps the video models named by hand, apart from its session models', () => {
  const raw = { id: 'a-ven00001', kind: 'openai', name: 'Venice', baseUrl: 'https://api.venice.ai/api/v1', slug: 'venice', models: ['venice-uncensored'], videoModels: [' my-video ', 'my-video', '', 7] };
  const account = normalizeAccount(raw);
  assert.deepEqual(account.videoModels, ['my-video']);
  assert.equal(checkAccount(account, []), null);
  assert.equal(normalizeAccount({ ...raw, videoModels: [] }).videoModels, undefined, 'none named: the account is written as before');
  assert.equal(normalizeAccount({ ...raw, slug: '', videoModels: ['x'] }).videoModels, undefined, 'only a provider the user added has any');

  // The same name on both sides: refused, a video model runs no session.
  assert.deepEqual(checkAccount(normalizeAccount({ ...raw, models: ['venice-uncensored', 'My-Video'] }), []), { field: 'models', problem: 'video' });
  assert.deepEqual(checkAccount(normalizeAccount({ ...raw, videoModels: ['-bad name'] }), []), { field: 'videoModels', problem: 'format' });
  assert.deepEqual(checkAccount(normalizeAccount({ ...raw, videoModels: Array.from({ length: 51 }, (_, i) => `v-${i}`) }), []), { field: 'videoModels', problem: 'tooMany' });
});
