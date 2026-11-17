import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bucketOf, clip, readingOrder } from './onnx';

test('a text goes to the smallest session that holds it, the longest to the last one', () => {
  assert.equal(bucketOf(1), 128);
  assert.equal(bucketOf(128), 128);
  assert.equal(bucketOf(129), 256);
  assert.equal(bucketOf(1025), 2048);
  assert.equal(bucketOf(5000), 2048);
});

test('a text too long is cut and still ends with the marker its vector is read on', () => {
  assert.deepEqual(clip([1, 2, 3], 4, 9), [1, 2, 3]);
  assert.deepEqual(clip([1, 2, 3, 4, 5, 9], 4, 9), [1, 2, 3, 9]);
});

test('texts are read by session, longest first, keeping their order within one', () => {
  assert.deepEqual(readingOrder([40, 900, 300, 100, 2000, 700]), [4, 1, 5, 2, 0, 3]);
});
