import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { providersFromEnv, readEnv } from './providers';
import { startServer } from './server';

// The POC's entry, started by run.mjs once the page is built: reads the optional .env, starts the local server,
// opens the page.

const root = process.env.POC_ROOT ?? '';
const assets = process.env.POC_ASSETS ?? '';
if (!root || !assets) throw new Error('Start the POC with: npm run poc:graph');

const envFile = join(root, '.env');
const env = { ...(existsSync(envFile) ? readEnv(readFileSync(envFile, 'utf8')) : {}), ...process.env };

const server = await startServer({ root, assets, port: Number(env.POC_PORT) || 4517, simSpeed: Number(env.POC_SIM_SPEED) || 1 });

for (const p of providersFromEnv(env)) {
  await server.providers.add(p.name, p.baseUrl, p.key, true).catch((err: unknown) => console.error(`Fournisseur « ${p.name} » ignoré : ${err instanceof Error ? err.message : err}`));
}
const real = server.providers.info();
console.log(`\n  Graphe de modèles (POC) : ${server.url}`);
console.log(real.length ? `  Fournisseurs réels : ${real.map((p) => `${p.name} (${p.models} modèles${p.error ? ', liste illisible' : ''})`).join(', ')}` : '  Mode simulé : aucun fournisseur réel (voir poc/model-graph/README.md pour en ajouter).');
console.log('  Ctrl+C pour arrêter.\n');

if (!process.argv.includes('--no-open')) {
  const [command, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', server.url]] : process.platform === 'darwin' ? ['open', [server.url]] : ['xdg-open', [server.url]];
  spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true })
    .on('error', () => undefined)
    .unref();
}
