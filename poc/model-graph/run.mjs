// npm run poc:graph — builds the POC (its page and its local server) and starts it. Nothing of the app is touched:
// the build goes to node_modules/.poc-model-graph and the server listens on 127.0.0.1 only.
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
// Inside node_modules: the server's bundle keeps the same packages external as the app, and finds them from here.
const out = resolve(root, '../../node_modules/.poc-model-graph');
mkdirSync(out, { recursive: true });

const common = { bundle: true, target: 'es2022', logLevel: 'warning' };
await Promise.all([
  build({ ...common, entryPoints: [join(root, 'server/main.ts')], outfile: join(out, 'server.mjs'), platform: 'node', format: 'esm', external: ['electron', '@anthropic-ai/claude-agent-sdk', 'zod'] }),
  build({ ...common, entryPoints: [join(root, 'client/app.ts')], outfile: join(out, 'app.js'), platform: 'browser', format: 'iife' }),
]);
cpSync(join(root, 'client/index.html'), join(out, 'index.html'));
cpSync(join(root, 'client/styles.css'), join(out, 'styles.css'));

// `npm run poc:graph -- --no-open` starts it without opening the browser.
const server = spawn(process.execPath, [join(out, 'server.mjs'), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, POC_ROOT: root, POC_ASSETS: out } });
server.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill());
