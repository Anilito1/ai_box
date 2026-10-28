import { build } from 'esbuild';
import { cpSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { sourceStamp, STAMP_FILE } from './scripts/sourceStamp.mjs';

// Taken before building: a file changed meanwhile makes the next start build again.
const stamp = sourceStamp('.');

const common = { bundle: true, target: 'es2022', logLevel: 'warning' };
const renderer = { ...common, platform: 'browser', format: 'iife', minify: true };
// The other providers' mascots, one file each: fetched the first time a session wears one (clawd/stage.ts).
const mascots = readdirSync('assets/mascots')
  .filter((f) => f.endsWith('.glb'))
  .map((f) => f.slice(0, -4));

await Promise.all([
  // ESM main: the Agent SDK ships as ESM only. SDK and zod stay external so the SDK finds its binary and shares one zod.
  build({
    ...common,
    entryPoints: ['src/main/main.ts'],
    outfile: 'dist/main.mjs',
    platform: 'node',
    format: 'esm',
    external: ['electron', '@anthropic-ai/claude-agent-sdk', 'zod'],
    // The release notes shown at start (main/releaseNotes.ts) travel inside the build.
    loader: { '.md': 'text' },
  }),
  build({ ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload.cjs', platform: 'node', format: 'cjs', external: ['electron'] }),
  // Installs an update once the hub has closed, run by the user's Node.js: Node's own modules only.
  build({ ...common, entryPoints: ['src/main/updateHelper.ts'], outfile: 'dist/update-helper.mjs', platform: 'node', format: 'esm' }),
  build({ ...renderer, entryPoints: ['src/renderer/app.ts'], outfile: 'dist/renderer/app.js' }),
  // three.js and the mascot model (four fifths of the renderer) load after the first paint, from their own file.
  // The model is embedded in the bundle: three.js loads files with fetch(), which refuses file:// URLs.
  build({ ...renderer, entryPoints: ['src/renderer/clawd/entry.ts'], outfile: 'dist/renderer/clawd.js', loader: { '.glb': 'binary' } }),
  ...mascots.map((id) =>
    build({
      ...renderer,
      stdin: { contents: `import glb from './assets/mascots/${id}.glb'; (window.hubMascots ??= {}).${id} = glb;`, resolveDir: '.' },
      outfile: `dist/renderer/mascot-${id}.js`,
      loader: { '.glb': 'binary' },
    }),
  ),
]);

mkdirSync('dist/renderer', { recursive: true });
cpSync('src/renderer/index.html', 'dist/renderer/index.html');
cpSync('src/renderer/styles.css', 'dist/renderer/styles.css');
cpSync('assets/logo.png', 'dist/renderer/logo.png');
// Still pictures of every mascot, Clawd's too: placeholders until the 3D one is drawn, and the providers' cards.
cpSync('assets/mascots', 'dist/renderer/mascots', { recursive: true, filter: (src) => !src.endsWith('.glb') });
cpSync('THIRD_PARTY_NOTICES.md', 'dist/THIRD_PARTY_NOTICES.md');
writeFileSync(STAMP_FILE, stamp);
console.log('build ok');
