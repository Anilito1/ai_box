// The server's side of the environment sync (src/main/remote/envSync.ts): /opt/aibox/envsync.mjs, owned by root,
// run by launch.mjs for the worker user. Two requests, one JSON line each:
//   {"op":"env-state"}                                   prints {"files":{path:sha256}}: what the last syncs wrote
//                                                        and is still as written;
//   {"op":"env-apply","put":[{path,size,sha}],"del":[]}  then the bytes of each `put` file, one after the other:
//                                                        writes them, removes the `del` ones; prints what it did.
// Only under ~/.claude: CLAUDE.md, settings.json, skills/, agents/, design-md/, projects/<name>/memory/. It removes
// only files it wrote itself (~/.aibox/env-manifest.json), follows no symbolic link, and never sends a file back.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const HOME = homedir();
const MANIFEST = join(HOME, '.aibox', 'env-manifest.json');
const MAX_FILES = 10000;
const MAX_BYTES = 200 * 1024 * 1024;
export const ALLOWED = /^\.claude\/(CLAUDE\.md|settings\.json|(skills|agents|design-md)\/.+|projects\/[A-Za-z0-9-]{1,200}\/memory\/.+)$/;
const NEVER = /^(\.env(\..*)?|\.wrangler|\.cloudflare-profiles|\.git|\.credentials\.json|credentials(\..*)?|.*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)(\.pub)?)$/i;

const sha = (b) => createHash('sha256').update(b).digest('hex');

/** Why a path may not be written, or null. Relative to the home folder, forward slashes. */
export function badPath(path) {
  if (typeof path !== 'string' || path.length > 1000 || !ALLOWED.test(path)) return 'outside the allowed folders';
  const parts = path.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.includes('\\') || p.includes('\0'))) return 'bad path';
  if (parts.some((p) => NEVER.test(p))) return 'excluded name';
  return null;
}

/** A symbolic link anywhere from ~/.claude down to the file would write outside: refused. */
function throughLink(path) {
  const parts = path.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const p = join(HOME, ...parts.slice(0, i));
    if (!existsSync(p)) return false;
    if (lstatSync(p).isSymbolicLink()) return true;
  }
  return false;
}

function readManifest() {
  try {
    const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
  } catch {
    return {};
  }
}

function writeManifest(m) {
  mkdirSync(dirname(MANIFEST), { recursive: true, mode: 0o700 });
  writeFileSync(`${MANIFEST}.tmp`, JSON.stringify(m), { mode: 0o600 });
  renameSync(`${MANIFEST}.tmp`, MANIFEST);
}

function state() {
  const files = {};
  for (const path of Object.keys(readManifest())) {
    if (badPath(path) || throughLink(path)) continue;
    try {
      files[path] = sha(readFileSync(join(HOME, path)));
    } catch {
      // Gone since: the next apply writes it again.
    }
  }
  return { files };
}

function readBody(rest, total) {
  return new Promise((done, fail) => {
    const chunks = [rest];
    let size = rest.length;
    if (size >= total) return done(Buffer.concat(chunks));
    process.stdin.on('data', (c) => {
      chunks.push(c);
      size += c.length;
      if (size >= total) {
        process.stdin.pause();
        done(Buffer.concat(chunks));
      }
    });
    process.stdin.on('end', () => (size >= total ? done(Buffer.concat(chunks)) : fail(new Error('input cut short'))));
    process.stdin.resume();
  });
}

/** Removes the folders a removal left empty, up to the kind's folder (~/.claude/skills). */
function pruneDirs(path) {
  let dir = dirname(path);
  while (dir.split('/').length > 2) {
    try {
      rmdirSync(join(HOME, dir));
    } catch {
      return;
    }
    dir = dirname(dir);
  }
}

async function apply(h, rest) {
  const put = Array.isArray(h.put) ? h.put : [];
  const del = Array.isArray(h.del) ? h.del : [];
  if (put.length + del.length > MAX_FILES) throw new Error('too many files');
  let total = 0;
  for (const f of put) {
    const why = badPath(f?.path) ?? (Number.isInteger(f.size) && f.size >= 0 ? null : 'bad size') ?? (/^[0-9a-f]{64}$/.test(f.sha) ? null : 'bad sha');
    if (why) throw new Error(`${why}: ${String(f?.path).slice(0, 200)}`);
    if (throughLink(f.path)) throw new Error(`symbolic link on the way: ${f.path}`);
    total += f.size;
  }
  if (total > MAX_BYTES) throw new Error('too large');
  const body = await readBody(rest, total);
  let at = 0;
  const datas = put.map((f) => body.subarray(at, (at += f.size)));
  // All checked before the first write: a damaged transfer changes nothing.
  put.forEach((f, i) => {
    if (sha(datas[i]) !== f.sha) throw new Error(`damaged on the way: ${f.path}`);
  });
  const manifest = readManifest();
  let removed = 0;
  // Saved whatever happens: a file written before a failure is still known as ours.
  try {
    for (const [i, f] of put.entries()) {
      const data = datas[i];
      const abs = join(HOME, f.path);
      mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
      // A script (a skill's, starting with #!) stays runnable; Windows has no such bit to send.
      writeFileSync(`${abs}.aibox-tmp`, data, { mode: data.subarray(0, 2).toString() === '#!' ? 0o700 : 0o600 });
      renameSync(`${abs}.aibox-tmp`, abs);
      manifest[f.path] = f.sha;
    }
    for (const path of del) {
      // Only what a sync wrote: what the server's Claude Code or its user made stays.
      if (typeof path !== 'string' || !Object.hasOwn(manifest, path) || badPath(path) || throughLink(path)) continue;
      try {
        unlinkSync(join(HOME, path));
        removed++;
      } catch {
        // Already gone.
      }
      delete manifest[path];
      pruneDirs(path);
    }
  } finally {
    writeManifest(manifest);
  }
  return { written: put.length, removed };
}

export async function run(header, rest, log = () => {}) {
  try {
    const out = header.op === 'env-state' ? state() : await apply(header, rest);
    log(`${header.op} ${'files' in out ? `${Object.keys(out.files).length} files` : `wrote ${out.written}, removed ${out.removed}`}`);
    process.stdout.write(`${JSON.stringify(out)}\n`, () => process.exit(0));
  } catch (err) {
    log(`${header.op} refused: ${err.message}`);
    process.stderr.write(`aibox envsync: ${err.message}\n`);
    process.exit(2);
  }
}
