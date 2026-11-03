import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { extensionOf, FILE_LIMITS, fileKind, fileLabel, formatSize, parseFiles, safeFileName } from './attachments';

test('every kind of file gets its icon, from the extension or else the MIME type', () => {
  const cases: [string, string, string][] = [
    ['Devis 2026.PDF', '', 'pdf'],
    ['lettre.docx', '', 'doc'],
    ['ventes.xlsx', '', 'sheet'],
    ['pitch.pptx', '', 'slides'],
    ['export.zip', 'application/zip', 'archive'],
    ['main.ts', 'video/mp2t', 'code'],
    ['clients.csv', '', 'data'],
    ['config.json', '', 'data'],
    ['notes.md', '', 'text'],
    ['voix.m4a', '', 'audio'],
    ['clip.mov', '', 'video'],
    ['IMG_0042.HEIC', '', 'image'],
    ['logo.svg', 'image/svg+xml', 'image'],
    ['README', '', 'other'],
    ['scan', 'application/pdf', 'pdf'],
    ['capture', 'image/png', 'image'],
    ['journal', 'text/plain', 'text'],
  ];
  for (const [name, mime, kind] of cases) assert.equal(fileKind(name, mime), kind, name);
});

test('the extension label: none for a file without one or a dotfile', () => {
  assert.equal(fileLabel('rapport.final.pdf'), 'PDF');
  assert.equal(fileLabel('README'), '');
  assert.equal(extensionOf('.env'), '');
  assert.equal(extensionOf('archive.tar.gz'), 'gz');
});

test('a file name cannot lead out of the attachments folder nor be refused by Windows', () => {
  const dir = join('C:', 'data', 'attachments', 'abc');
  const evil = [
    '../../../etc/passwd',
    '..\\..\\Windows\\System32\\drivers\\etc\\hosts',
    'C:\\Users\\x\\Desktop\\a.pdf',
    '/abs/path/b.txt',
    '..',
    '.',
    '',
    '   ',
    'a/../../b',
    'name\u0000.pdf',
    'CON',
    'nul.txt',
    'COM1.log',
    'quoi?.txt',
    'a<b>c:d"e|f*.docx',
    'trailing. . ',
  ];
  for (const name of evil) {
    const safe = safeFileName(name);
    assert.ok(safe.length > 0, JSON.stringify(name));
    assert.doesNotMatch(safe, /[\\/<>:"|?*\u0000-\u001f]/, JSON.stringify(name));
    assert.doesNotMatch(safe, /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i, JSON.stringify(name));
    assert.notEqual(safe, '..');
    assert.equal(dirname(join(dir, safe)), dir, JSON.stringify(name));
  }
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName('C:\\Users\\x\\Desktop\\Devis été.pdf'), 'Devis été.pdf');
  assert.equal(safeFileName('nul.txt'), '_nul.txt');
  assert.equal(safeFileName('..'), 'fichier');
});

test('a long name is cut, its extension kept', () => {
  const safe = safeFileName(`${'a'.repeat(300)}.xlsx`);
  assert.equal(safe.length, 120);
  assert.ok(safe.endsWith('.xlsx'));
});

test('sizes read like a file explorer', () => {
  assert.equal(formatSize(512, 'fr'), '512 o');
  assert.equal(formatSize(2.4 * 1024 * 1024, 'fr'), '2,4 Mo');
  assert.equal(formatSize(2.4 * 1024 * 1024, 'en'), '2.4 MB');
  assert.equal(formatSize(830 * 1024, 'en'), '830 KB');
});

test('files from the renderer: a path or bytes, within the limits', () => {
  assert.deepEqual(parseFiles(undefined, 10), []);
  const pdf = { name: 'a.pdf', size: 10, path: 'C:\\Users\\x\\a.pdf' };
  assert.deepEqual(parseFiles([pdf], 10), [pdf]);
  assert.ok(parseFiles([{ name: 'b', size: 1, path: '/home/x/b' }], 10));
  const pasted = parseFiles([{ name: 'image.heic', size: 999, data: new Uint8Array(3) }], 10);
  assert.equal(pasted?.[0].size, 3);
  // Relative paths, both or neither, too many, too large, wrong shapes.
  assert.equal(parseFiles([{ name: 'a', size: 1, path: '..\\a' }], 10), null);
  assert.equal(parseFiles([{ name: 'a', size: 1, path: 'C:\\a', data: new Uint8Array(1) }], 10), null);
  assert.equal(parseFiles([{ name: 'a', size: 1 }], 10), null);
  assert.equal(parseFiles([pdf, pdf], 1), null);
  assert.equal(parseFiles([{ name: 'a', size: 1, data: new Uint8Array(FILE_LIMITS.dataBytes + 1) }], 10), null);
  assert.equal(parseFiles([{ name: '', size: 1, path: 'C:\\a' }], 10), null);
  assert.equal(parseFiles([{ name: 'a', size: -1, path: 'C:\\a' }], 10), null);
  assert.equal(parseFiles([{ name: 'a', size: 1, path: 'C:\\a\0b' }], 10), null);
  assert.equal(parseFiles('nope', 10), null);
});
