import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { classify, draft } from '../../scripts/notesDraft.mjs';
import { fingerprint, markSeen, parseNotes, pendingNotes, readMemory } from './releaseNotes';

const FILE = `# Notes

Texte d'explication, ignoré.

## 2026-11-02

### Ajouté
- Une modale des nouveautés.

### Supprimé :
- L'ancien panneau.

## 2026-10-28

### Modifié
- La barre de saisie reste dans sa bulle.
<!-- - Une ligne en commentaire. -->
`;

test('the file reads as releases, newest first, by section', () => {
  const { entries, problems } = parseNotes(FILE);
  assert.deepEqual(problems, []);
  assert.deepEqual(entries, [
    { title: '2026-11-02', added: ['Une modale des nouveautés.'], changed: [], removed: ["L'ancien panneau."] },
    { title: '2026-10-28', added: [], changed: ['La barre de saisie reste dans sa bulle.'], removed: [] },
  ]);
});

test('an unknown heading or a stray line is a problem', () => {
  const { problems } = parseNotes('## 1\n### Divers\n- x\n## 2\ntexte libre\n');
  assert.equal(problems.length, 3);
  assert.match(problems[0], /ligne 2 : section inconnue/);
});

test('the notes file of the repo is well formed', () => {
  const { entries, problems } = parseNotes(readFileSync('docs/notes-de-version.md', 'utf8'));
  assert.deepEqual(problems, []);
  assert.ok(entries.length > 0 && entries[0].added.length + entries[0].changed.length + entries[0].removed.length > 0);
});

test('a fingerprint ignores case, accents and spaces, not the section', () => {
  assert.equal(fingerprint('added', 'Une  Modale'), fingerprint('added', 'une modale'));
  assert.equal(fingerprint('added', 'Réglages'), fingerprint('added', 'reglages'));
  assert.notEqual(fingerprint('added', 'x'), fingerprint('removed', 'x'));
});

const { entries } = parseNotes(FILE);

test('a new install shows nothing', () => {
  assert.equal(pendingNotes(entries, null, true), null);
});

test('a build from before the notes shows its latest release only', () => {
  assert.deepEqual(pendingNotes(entries, null, false), { added: ['Une modale des nouveautés.'], changed: [], removed: ["L'ancien panneau."] });
});

test('nothing new since the last start shows nothing', () => {
  assert.equal(pendingNotes(entries, markSeen(entries, null), false), null);
});

test('the lines of every build skipped add up, the ones seen stay out', () => {
  const memory = markSeen([], { seen: [fingerprint('removed', "L'ancien panneau.")] });
  assert.deepEqual(pendingNotes(entries, memory, false), {
    added: ['Une modale des nouveautés.'],
    changed: ['La barre de saisie reste dans sa bulle.'],
    removed: [],
  });
});

test('a line repeated in two releases shows once', () => {
  const twice = parseNotes('## 2\n### Ajouté\n- A\n## 1\n### Ajouté\n- a\n').entries;
  assert.deepEqual(pendingNotes(twice, { seen: [] }, false)?.added, ['A']);
});

test('marking seen keeps the older fingerprints, newest first', () => {
  const memory = markSeen(entries.slice(0, 1), { seen: ['old'] });
  assert.equal(memory.seen.at(-1), 'old');
  assert.equal(memory.seen.length, 3);
});

test('a memory file that is not one is no memory', () => {
  assert.equal(readMemory(null), null);
  assert.equal(readMemory({ seen: 'x' }), null);
  assert.deepEqual(readMemory({ seen: ['a', 1] }), { seen: ['a'] });
});

test('commits sort into added, changed and removed; internal ones stay out', () => {
  const code = ['src/main/main.ts'];
  assert.equal(classify('Add custom providers in Settings', code), 'added');
  assert.equal(classify('Let the master put a post anywhere', code), 'added');
  assert.equal(classify('Drop the per-session cost', code), 'removed');
  assert.equal(classify('Keep the composer inside its bubble', code), 'changed');
  assert.equal(classify('feat: offline mode', code), 'added');
  assert.equal(classify('fix(ui): menu overflow', code), 'changed');
  assert.equal(classify('refactor: remove the old store', code), 'removed');
  assert.equal(classify('chore: bump deps', code), null);
  assert.equal(classify('docs: typo', code), null);
  assert.equal(classify("Merge hub/x: something", code), null);
  assert.equal(classify('Rewrite the README', ['README.md', 'docs/readme/a.png']), null);
  assert.equal(classify('Add tests for groups', ['src/main/groups.test.ts']), null);
});

test('the draft groups the commits under the French headings', () => {
  const text = draft([
    { subject: 'Add a thing', files: ['src/a.ts'] },
    { subject: 'Remove a thing', files: ['src/a.ts'] },
    { subject: 'chore: nothing', files: ['src/a.ts'] },
  ]);
  assert.match(text, /^## \d{4}-\d{2}-\d{2}\n\n### Ajouté\n\n- Add a thing\n\n### Supprimé\n\n- Remove a thing\n$/);
  assert.equal(draft([{ subject: 'test: more', files: ['src/a.test.ts'] }]), '');
});
