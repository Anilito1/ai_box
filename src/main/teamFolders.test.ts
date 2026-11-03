import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyPatch, loadConfig, saveConfig } from './config';

// The sidebar's folders live in config.json with the other settings: a restart or an update finds them as they were.

const post = (id: string, name: string, folder: string) => ({ id, name, description: name, instructions: '', folders: [folder], model: '', effort: '', mode: '', account: '', enabled: true });

function withDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'hub-folders-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const team = (dir: string) => [post('r-aaaaaaaa', 'brain', dir), post('r-bbbbbbbb', 'ecole', dir), post('r-cccccccc', 'perso', dir)];

test('the folders survive a restart, and an older config without them has none', () => {
  withDir((dir) => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ version: 2, onboarded: true, team: team(dir) }));
    const cfg = loadConfig(dir, 'fr');
    assert.deepEqual(cfg.teamFolders, { folders: [], root: [] });
    const folders = {
      folders: [
        { id: 'f-00000001', name: 'Coiffissimo', collapsed: false, posts: ['r-aaaaaaaa'] },
        { id: 'f-00000002', name: 'École', collapsed: true, posts: ['r-bbbbbbbb'] },
      ],
      root: ['r-cccccccc'],
    };
    assert.equal(applyPatch(cfg, { teamFolders: folders }), null);
    saveConfig(dir, cfg);
    assert.deepEqual(loadConfig(dir, 'fr').teamFolders, folders);
  });
});

test('a post gone from the team leaves its folder, on load and on save', () => {
  withDir((dir) => {
    const folders = { folders: [{ id: 'f-00000001', name: 'Coiffissimo', collapsed: false, posts: ['r-aaaaaaaa', 'r-zzzzzzzz'] }], root: ['r-zzzzzzzz', 'r-cccccccc'] };
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ version: 2, onboarded: true, team: team(dir), teamFolders: folders }));
    const cfg = loadConfig(dir, 'fr');
    assert.deepEqual(cfg.teamFolders, { folders: [{ id: 'f-00000001', name: 'Coiffissimo', collapsed: false, posts: ['r-aaaaaaaa'] }], root: ['r-cccccccc'] });
    // A sidebar that missed a deletion sends the old id back: it does not come back.
    assert.equal(applyPatch(cfg, { teamFolders: folders }), null);
    assert.deepEqual(cfg.teamFolders.folders[0]?.posts, ['r-aaaaaaaa']);
    // Only the known fields reach the file.
    assert.equal(applyPatch(cfg, { teamFolders: { folders: [{ id: 'f-00000001', name: 'A', collapsed: false, posts: [], junk: 'x' } as never], root: [] } }), null);
    assert.deepEqual(Object.keys(cfg.teamFolders.folders[0] ?? {}), ['id', 'name', 'collapsed', 'posts']);
  });
});

test('a malformed arrangement is refused from the window and ignored in the file', () => {
  withDir((dir) => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ version: 2, onboarded: true, team: team(dir), teamFolders: { folders: 'nope' } }));
    const cfg = loadConfig(dir, 'fr');
    assert.deepEqual(cfg.teamFolders, { folders: [], root: [] });
    assert.equal(applyPatch(cfg, { teamFolders: { folders: [{ id: 'f-1', name: 'x', collapsed: false, posts: [] }], root: [] } }), 'teamFolders');
    assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).teamFolders.folders, 'nope');
  });
});
