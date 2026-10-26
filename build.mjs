import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const common = { bundle: true, target: 'es2022', logLevel: 'warning' };
const renderer = { ...common, platform: 'browser', format: 'iife', minify: true };

await Promise.all([
  // ESM main: the Agent SDK ships as ESM only. SDK and zod stay external so the SDK finds its binary and shares one zod.
  build({
    ...common,
    entryPoints: ['src/main/main.ts'],
    outfile: 'dist/main.mjs',
    platform: 'node',
    format: 'esm',
    external: ['electron', '@anthropic-ai/claude-agent-sdk', 'zod'],
  }),
  build({ ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload.cjs', platform: 'node', format: 'cjs', external: ['electron'] }),
  // Installs an update once the hub has closed, run by the user's Node.js: Node's own modules only.
  build({ ...common, entryPoints: ['src/main/updateHelper.ts'], outfile: 'dist/update-helper.mjs', platform: 'node', format: 'esm' }),
  build({ ...renderer, entryPoints: ['src/renderer/app.ts'], outfile: 'dist/renderer/app.js' }),
  // three.js and the mascot model (four fifths of the renderer) load after the first paint, from their own file.
  // The model is embedded in the bundle: three.js loads files with fetch(), which refuses file:// URLs.
  build({ ...renderer, entryPoints: ['src/renderer/clawd/entry.ts'], outfile: 'dist/renderer/clawd.js', loader: { '.glb': 'binary' } }),
]);

mkdirSync('dist/renderer', { recursive: true });
cpSync('src/renderer/index.html', 'dist/renderer/index.html');
cpSync('src/renderer/styles.css', 'dist/renderer/styles.css');
cpSync('assets/logo.png', 'dist/renderer/logo.png');
cpSync('THIRD_PARTY_NOTICES.md', 'dist/THIRD_PARTY_NOTICES.md');
console.log('build ok');
