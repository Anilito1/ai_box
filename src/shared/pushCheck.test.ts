import assert from 'node:assert/strict';
import { test } from 'node:test';
import { announcedCommits } from './pushCheck';

test('a report that says a commit is pushed names it; one that says it is not, or only mentions it, does not', () => {
  assert.deepEqual(announcedCommits('Fix poussé sur main (commit 05ea78d).'), ['05ea78d']);
  assert.deepEqual(announcedCommits('Commit 05ea78d poussé.'), ['05ea78d']);
  assert.deepEqual(announcedCommits('Pushed 1b81c88 and 4b66fae to origin/ai-box/optim.'), ['1b81c88', '4b66fae']);
  assert.deepEqual(announcedCommits('Commit 05ea78d en local, pas encore poussé.'), []);
  assert.deepEqual(announcedCommits('Le commit 05ea78d corrige le panier.'), []);
  // Not commit ids: a number, a word, a too short id.
  assert.deepEqual(announcedCommits('Poussé sur main : 1234567 lignes, facade, abc12.'), []);
  assert.deepEqual(announcedCommits(Array.from({ length: 8 }, (_, i) => `pushed ${i}abcdef0`).join('\n')).length, 5);
  // Intent or failure is no claim; an id inside another name is no commit.
  for (const line of ['Commit a1b2c3d prêt, à merger sur main.', 'Push failed for a1b2c3d.', 'I will push a1b2c3d to main.', 'Mission m-1a2b3c4d poussée sur main.']) assert.deepEqual(announcedCommits(line), [], line);
});
