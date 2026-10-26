// Compiles the voice-dictation helper (native/dictation-mac, Swift, macOS only) into native/dictation-mac/build/.
// Run by `npm run build` on a Mac; skipped, with a note, where there is no Swift compiler. The hub works without it:
// the dictation button simply does not show.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'native/dictation-mac';
const out = join(dir, 'build', 'dictation-mac');

export function buildNative() {
  if (process.platform !== 'darwin') return;
  const sources = [join(dir, 'main.swift'), join(dir, 'Info.plist')];
  // Up to date: nothing to compile.
  if (existsSync(out) && sources.every((s) => statSync(s).mtimeMs <= statSync(out).mtimeMs)) return;
  if (spawnSync('swiftc', ['--version'], { stdio: 'ignore' }).status !== 0) {
    console.warn('native: no Swift compiler (xcode-select --install): voice dictation will be unavailable');
    return;
  }
  mkdirSync(join(dir, 'build'), { recursive: true });
  // One binary per architecture (the package targets both), joined into one. Older systems load it and report that
  // dictation needs macOS 26 (the Speech API is guarded at run time).
  const slices = [];
  for (const arch of ['arm64', 'x86_64']) {
    const file = join(dir, 'build', `dictation-mac-${arch}`);
    const run = spawnSync(
      'swiftc',
      ['-O', '-target', `${arch}-apple-macos14.0`, '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', join(dir, 'Info.plist'), join(dir, 'main.swift'), '-o', file],
      { stdio: 'inherit' },
    );
    if (run.status === 0) slices.push(file);
    else console.warn(`native: the ${arch} helper did not build`);
  }
  if (slices.length === 0) return;
  const lipo = spawnSync('lipo', ['-create', ...slices, '-output', out], { stdio: 'inherit' });
  for (const s of slices) rmSync(s, { force: true });
  if (lipo.status !== 0) return;
  // Signed ad hoc: the system runs nothing unsigned on Apple silicon (a developer ID signs it in a release).
  spawnSync('codesign', ['--force', '-s', '-', out], { stdio: 'inherit' });
  console.log('native ok');
}

if (import.meta.url === `file://${process.argv[1]}`) buildNative();
