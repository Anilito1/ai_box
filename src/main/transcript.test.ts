import assert from 'node:assert/strict';
import { test } from 'node:test';
import { digest } from '../shared/passation';
import { setLang } from './i18n';
import { attachedFiles, capturedLine, fileLine, userTextItem, visibleText } from './transcript';

const PDF = 'C:\\data\\attachments\\u1\\Devis été [final].pdf';

test('attached files reach the model by their path; the user sees them by name, after a restart too', () => {
  for (const lang of ['fr', 'en'] as const) {
    setLang(lang);
    const text = ['Lis ce devis', capturedLine('C:\\data\\attachments\\capture-1.png'), fileLine(PDF), fileLine('/home/a/notes')].join('\n');
    assert.equal(visibleText(text), 'Lis ce devis');
    const files = [
      { name: 'Devis été [final].pdf', path: PDF },
      { name: 'notes', path: '/home/a/notes' },
    ];
    assert.deepEqual(attachedFiles(text), files);
    assert.deepEqual(userTextItem([{ type: 'text', text }], 'u'), { kind: 'user', id: 'u', text: 'Lis ce devis', images: [], files });
  }
});

test('a message of files alone still comes back', () => {
  setLang('fr');
  const item = userTextItem([{ type: 'text', text: fileLine('C:\\x\\data.zip') }], 'u');
  assert.deepEqual(item, { kind: 'user', id: 'u', text: '', images: [], files: [{ name: 'data.zip', path: 'C:\\x\\data.zip' }] });
});

test('a line the user writes that only starts like an attachment stays', () => {
  setLang('fr');
  assert.equal(visibleText('[Fichier joint : a] puis la suite'), '[Fichier joint : a] puis la suite');
});

test('the note carried to another account keeps the paths of the attached files', () => {
  const note = digest([{ kind: 'user', id: 'u', text: '', images: [], files: [{ name: 'Devis.pdf', path: PDF }] }]);
  assert.ok(note.includes(PDF), note);
});
