import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// What the build is made from, as a short hash of every source's size and modification time: written into dist by
// build.mjs, compared at start by a hub run from source. Stats only, no reading: cheap enough for every start.

const FILES = ['build.mjs', 'package.json', 'package-lock.json', 'assets/logo.png', 'THIRD_PARTY_NOTICES.md', 'scripts/sourceStamp.mjs'];
export const STAMP_FILE = 'dist/source-stamp.txt';

/** @param {string} dir */
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

/** @param {string} root @returns {string} */
export function sourceStamp(root) {
  const hash = createHash('sha256');
  for (const path of [...walk(join(root, 'src')).sort(), ...FILES.map((f) => join(root, f))]) {
    let stat = 'missing';
    try {
      const s = statSync(path);
      stat = `${s.size}:${s.mtimeMs}`;
    } catch {
      // A file that is not there is part of the stamp too.
    }
    hash.update(`${relative(root, path).replace(/\\/g, '/')}=${stat}\n`);
  }
  return hash.digest('hex').slice(0, 32);
}

/** @param {string} root @returns {string} The stamp of the build in dist, or empty when there is none. */
export function builtStamp(root) {
  try {
    return readFileSync(join(root, STAMP_FILE), 'utf8').trim();
  } catch {
    return '';
  }
}
