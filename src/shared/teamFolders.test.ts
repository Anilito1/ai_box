import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addFolder, arrangeTeam, folderName, isFolderPrefs, moveFolder, NO_FOLDERS, placePost, pruneFolders, removeFolder, renameFolder, toggleFolder, type TeamFolderPrefs } from './teamFolders';

const team = ['r-aaaaaaaa', 'r-bbbbbbbb', 'r-cccccccc', 'r-dddddddd'];
const [A, B, C, D] = team as [string, string, string, string];
const F1 = 'f-00000001';
const F2 = 'f-00000002';
const F3 = 'f-00000003';
const shown = (prefs: TeamFolderPrefs, posts = team) => {
  const a = arrangeTeam(posts, (p) => p, prefs);
  return { folders: a.folders.map((f) => [f.folder.name, f.posts]), root: a.root };
};
const rootOf = (prefs: TeamFolderPrefs) => arrangeTeam(team, (p) => p, prefs).root;
const three = () => addFolder(addFolder(addFolder(NO_FOLDERS, F1, 'Coiffissimo'), F2, 'École'), F3, 'Perso');

test('no folder: the posts in the team order, as before', () => {
  assert.deepEqual(shown(NO_FOLDERS), { folders: [], root: team });
});

test('a folder is created last, open and empty; a blank, duplicate-id or malformed one is refused', () => {
  const p = three();
  assert.deepEqual(
    p.folders.map((f) => [f.id, f.name, f.collapsed, f.posts]),
    [
      [F1, 'Coiffissimo', false, []],
      [F2, 'École', false, []],
      [F3, 'Perso', false, []],
    ],
  );
  assert.equal(addFolder(p, 'f-00000004', '   '), p);
  assert.equal(addFolder(p, F1, 'Again'), p);
  assert.equal(addFolder(p, 'nope', 'Bad id'), p);
  assert.equal(folderName('  a\nb\tc  '), 'a b c');
  assert.equal(folderName('x'.repeat(60)).length, 40);
});

test('rename keeps the posts; a blank name changes nothing', () => {
  let p = placePost(three(), rootOf(three()), A, F1, null);
  p = renameFolder(p, F1, '  Coiffissimo pro ');
  assert.deepEqual(p.folders[0], { id: F1, name: 'Coiffissimo pro', collapsed: false, posts: [A] });
  assert.equal(renameFolder(p, F1, ' ').folders[0]?.name, 'Coiffissimo pro');
});

test('posts go into folders, in order, and leave the root', () => {
  let p = three();
  p = placePost(p, rootOf(p), B, F1, null);
  p = placePost(p, rootOf(p), D, F1, B);
  p = placePost(p, rootOf(p), C, F2, null);
  assert.deepEqual(shown(p), {
    folders: [
      ['Coiffissimo', [D, B]],
      ['École', [C]],
      ['Perso', []],
    ],
    root: [A],
  });
  // From one folder to another.
  p = placePost(p, rootOf(p), D, F3, null);
  assert.deepEqual(shown(p).folders, [
    ['Coiffissimo', [B]],
    ['École', [C]],
    ['Perso', [D]],
  ]);
});

test('reordering inside a folder and at the root', () => {
  let p = three();
  for (const id of [A, B, C]) p = placePost(p, rootOf(p), id, F1, null);
  p = placePost(p, rootOf(p), C, F1, A);
  assert.deepEqual(p.folders[0]?.posts, [C, A, B]);
  // Last again: no "before".
  p = placePost(p, rootOf(p), C, F1, null);
  assert.deepEqual(p.folders[0]?.posts, [A, B, C]);
  // Back to the root, placed before the post already there.
  p = placePost(p, rootOf(p), B, null, D);
  assert.deepEqual(shown(p).root, [B, D]);
  p = placePost(p, rootOf(p), D, null, B);
  assert.deepEqual(shown(p).root, [D, B]);
  // Before itself: nothing moves; an unknown folder neither.
  assert.equal(placePost(p, rootOf(p), D, null, D), p);
  assert.equal(placePost(p, rootOf(p), D, 'f-99999999', null), p);
});

test('a new post arrives at the root, last; a deleted one is skipped', () => {
  let p = three();
  p = placePost(p, rootOf(p), A, null, null);
  p = placePost(p, rootOf(p), C, F2, null);
  const later = [...team, 'r-eeeeeeee'];
  assert.deepEqual(shown(p, later).root, [B, D, A, 'r-eeeeeeee']);
  assert.deepEqual(shown(p, [A, B, D]).folders[1], ['École', []]);
});

test('deleting a folder never deletes its posts: they come back to the root', () => {
  let p = three();
  p = placePost(p, rootOf(p), A, F1, null);
  p = placePost(p, rootOf(p), B, F1, null);
  const q = removeFolder(p, F1);
  assert.deepEqual(q.folders.map((f) => f.id), [F2, F3]);
  assert.deepEqual(shown(q).root, team);
  // With a root order saved, they follow it.
  p = placePost(p, rootOf(p), D, null, C);
  const r = removeFolder(p, F1);
  assert.deepEqual(shown(r).root, [D, C, A, B]);
  assert.equal(removeFolder(r, 'f-99999999'), r);
});

test('folders fold, and move to another place', () => {
  const p = toggleFolder(three(), F2);
  assert.deepEqual(p.folders.map((f) => f.collapsed), [false, true, false]);
  assert.equal(toggleFolder(p, F2).folders[1]?.collapsed, false);
  assert.deepEqual(moveFolder(p, F3, F1).folders.map((f) => f.id), [F3, F1, F2]);
  assert.deepEqual(moveFolder(p, F1, null).folders.map((f) => f.id), [F2, F3, F1]);
  assert.deepEqual(moveFolder(p, F1, F3).folders.map((f) => f.id), [F2, F1, F3]);
  assert.equal(moveFolder(p, F1, F1), p);
});

test('pruning keeps the posts of the team, each in one place', () => {
  const raw: TeamFolderPrefs = {
    folders: [
      { id: F1, name: 'A', collapsed: false, posts: [A, 'r-gone0000', B] },
      { id: F2, name: 'B', collapsed: true, posts: [B, C] },
      { id: F1, name: 'Twice', collapsed: false, posts: [D] },
    ],
    root: [C, D, 'r-gone0000'],
  };
  assert.deepEqual(pruneFolders(raw, team), {
    folders: [
      { id: F1, name: 'A', collapsed: false, posts: [A, B] },
      { id: F2, name: 'B', collapsed: true, posts: [C] },
    ],
    root: [D],
  });
});

test('the saved shape is checked: names, ids, types and sizes', () => {
  assert.ok(isFolderPrefs(three()));
  assert.ok(isFolderPrefs(NO_FOLDERS));
  assert.ok(!isFolderPrefs(null));
  assert.ok(!isFolderPrefs({ folders: [] }));
  assert.ok(!isFolderPrefs({ folders: [{ id: 'x', name: 'a', collapsed: false, posts: [] }], root: [] }));
  assert.ok(!isFolderPrefs({ folders: [{ id: F1, name: '', collapsed: false, posts: [] }], root: [] }));
  assert.ok(!isFolderPrefs({ folders: [{ id: F1, name: ' padded ', collapsed: false, posts: [] }], root: [] }));
  assert.ok(!isFolderPrefs({ folders: [{ id: F1, name: 'a', collapsed: 'no', posts: [] }], root: [] }));
  assert.ok(!isFolderPrefs({ folders: [{ id: F1, name: 'a', collapsed: false, posts: [1] }], root: [] }));
  assert.ok(!isFolderPrefs({ folders: [], root: ['x'.repeat(41)] }));
});
