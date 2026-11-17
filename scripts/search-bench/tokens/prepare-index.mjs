// Builds the search index of the bench's repos before a run, so no session waits on it or measures it.
// `npm run build` first. The index goes to AIBOX_SEARCH_DATA/search/index: a folder of the bench's own, never the app's.
//   AIBOX_SEARCH_DATA=… node scripts/search-bench/tokens/prepare-index.mjs <repo> [<repo>…]
import { fork } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist');
const dataDir = resolve(process.env.AIBOX_SEARCH_DATA ?? '');
const repos = process.argv.slice(2).map((p) => resolve(p));
if (!process.env.AIBOX_SEARCH_DATA || !repos.length) throw new Error('Usage: AIBOX_SEARCH_DATA=<folder> node prepare-index.mjs <repo>…');
const settings = { enabled: true, idleMinutes: 1, device: process.env.AIBOX_SEARCH_DEVICE ?? 'auto', repos, budget: 800 };
const host = fork(join(dist, 'search-host.mjs'), [], { env: { ...process.env, AIBOX_SEARCH_HOST: JSON.stringify({ dataDir, workerScript: join(dist, 'search-worker.mjs'), settings }) }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
let seq = 0;
const waiting = new Map();
host.on('message', (m) => {
  if (m.changed) return;
  waiting.get(m.id)?.(m);
  waiting.delete(m.id);
});
host.once('exit', (code) => {
  console.error(`search host stopped (${code})`);
  process.exit(1);
});
const call = (method, ...args) => new Promise((done) => {
  const id = ++seq;
  waiting.set(id, done);
  host.send({ id, method, args });
});

const t0 = Date.now();
await call('prepare');
for (;;) {
  await new Promise((r) => setTimeout(r, 15_000));
  const { result: state, error } = await call('state');
  if (error) throw new Error(error);
  const line = state.repos.map((r) => `${r.path.replace(/^.*[\\/]/, '')} ${r.vectors}/${r.chunks}${r.indexing ? ' …' : ''}${r.error ? ` (${r.error})` : ''}`).join(' · ');
  console.log(`${Math.round((Date.now() - t0) / 1000)} s  ${line}`);
  if (state.repos.every((r) => r.error || (!r.indexing && r.chunks > 0 && r.vectors >= r.chunks))) break;
}
host.removeAllListeners('exit');
host.kill();
