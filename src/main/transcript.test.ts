import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setLang } from './i18n';
import { attachedFiles, capturedLine, fileLine, userTextItem, visibleText } from './transcript';

test('attached files reach the model by their path; the user sees them by name, after a restart too', () => {
  for (const lang of ['fr', 'en'] as const) {
    setLang(lang);
    const text = ['Lis ce devis', capturedLine('C:\\data\\attachments\\capture-1.png'), fileLine('C:\\data\\attachments\\u1\\Devis été.pdf'), fileLine('/home/a/notes')].join('\n');
    assert.equal(visibleText(text), 'Lis ce devis');
    assert.deepEqual(attachedFiles(text), [{ name: 'Devis été.pdf' }, { name: 'notes' }]);
    const item = userTextItem([{ type: 'text', text }], 'u');
    assert.deepEqual(item, { kind: 'user', id: 'u', text: 'Lis ce devis', images: [], files: [{ name: 'Devis été.pdf' }, { name: 'notes' }] });
  }
});

test('a message of files alone still comes back', () => {
  setLang('fr');
  const item = userTextItem([{ type: 'text', text: fileLine('C:\\x\\data.zip') }], 'u');
  assert.deepEqual(item, { kind: 'user', id: 'u', text: '', images: [], files: [{ name: 'data.zip' }] });
});
