import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixedKeyBlob } from './keychain';

test('a "v10" blob is Chromium\'s fixed key on Linux only; a keychain\'s "v11" never is', () => {
  const blob = (prefix: string) => Buffer.concat([Buffer.from(prefix, 'latin1'), Buffer.alloc(16, 1)]);
  assert.equal(fixedKeyBlob(blob('v10'), 'linux'), true);
  assert.equal(fixedKeyBlob(blob('v11'), 'linux'), false);
  assert.equal(fixedKeyBlob(blob('v10'), 'win32'), false);
  assert.equal(fixedKeyBlob(blob('v10'), 'darwin'), false);
  assert.equal(fixedKeyBlob(Buffer.alloc(0), 'linux'), false);
});
