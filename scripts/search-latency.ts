// How fast the local search's models answer, as the app runs them: from nothing (cold) and loaded (warm), on the
// processor and on the graphics card, with the machine idle and busy, one agent or eight at once. Rows go to the lab
// folder (AIBOX_SEARCH_LAB, results.jsonl); nothing leaves the machine.
//   npx esbuild scripts/search-latency.ts --bundle --platform=node --format=esm --outfile=node_modules/.search-latency/latency.mjs
//   node node_modules/.search-latency/latency.mjs embed <model> <cpu|gpu|auto> <idle|cpu|cpu-half|gpu|cpu+gpu> [threads]
//   node node_modules/.search-latency/latency.mjs rerank <model> <cpu|gpu|auto> <load> [threads]
import { execFileSync, fork, spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { Engine, type Device } from '../src/main/search/engine';
import { modelOf, type SearchModel } from '../src/main/search/models';

const LAB = resolve(process.env.AIBOX_SEARCH_LAB ?? '.aibox/scratch/hub-ai-box/lab');
const RUNTIME = resolve(process.env.AIBOX_SEARCH_RUNTIME ?? join(LAB, '..', 'rt-probe'));
const MODELS = resolve(process.env.AIBOX_SEARCH_MODELS ?? join(LAB, 'models'));
const SCRIPT = resolve(process.env.AIBOX_SEARCH_WORKER_SCRIPT ?? 'dist/search-worker.mjs');
const HOST = resolve(process.env.AIBOX_SEARCH_HOST_SCRIPT ?? 'dist/search-host.mjs');
const REPOS_DIR_HOST = resolve(process.env.AIBOX_BENCH_REPOS ?? join(LAB, '..', 'bench-repos'));
const SOURCES = join(REPOS_DIR_HOST, 'claude-hub', 'src', 'main');
const COLD_RUNS = Number(process.env.AIBOX_LATENCY_COLD ?? 5);
const WARM_RUNS = Number(process.env.AIBOX_LATENCY_WARM ?? 40);
/** The workers' priority (see WorkerInit.priority); the system's own when absent. */
const PRIORITY = process.env.AIBOX_LATENCY_PRIORITY as 'above' | 'below' | undefined;
/** Agents asking at the same moment. */
const CONCURRENT = 8;

type Load = 'idle' | 'cpu' | 'cpu-half' | 'gpu' | 'cpu+gpu';

const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? 0);
};
const summary = (xs: number[]) => ({ p50: pct(xs, 50), p95: pct(xs, 95), max: Math.round(Math.max(...xs)) });

const vramUsed = (): number => {
  try {
    return Number.parseInt(execFileSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { windowsHide: true }).toString(), 10);
  } catch {
    return -1;
  }
};

/**
 * Memory (MiB) of the search processes under `parent` (model workers, and the host itself when it is `parent`):
 * what the system gives them (working set) and what is theirs alone.
 */
function memoryOf(parent: number, withParent = false): { workingSetMiB: number; privateMiB: number } {
  const ps = `Get-CimInstance Win32_Process | Where-Object { ($_.ParentProcessId -eq ${parent} -and $_.CommandLine -match 'search-worker') -or (${withParent ? '$true' : '$false'} -and $_.ProcessId -eq ${parent}) } | ForEach-Object { "$($_.WorkingSetSize) $($_.PrivatePageCount)" }`;
  try {
    const rows = execFileSync('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true }).toString().trim().split('\n').filter(Boolean);
    const sum = (i: number) => Math.round(rows.reduce((s, r) => s + Number(r.trim().split(' ')[i]), 0) / 1048576);
    return { workingSetMiB: sum(0), privateMiB: sum(1) };
  } catch {
    return { workingSetMiB: -1, privateMiB: -1 };
  }
}

function questions(): string[] {
  const dirs = [resolve('scripts/search-bench'), join(LAB, 'questions')];
  const all = dirs.filter(existsSync).flatMap((d) => readdirSync(d).filter((f) => /^questions-.*\.json$/.test(f)).flatMap((f) => (JSON.parse(readFileSync(join(d, f), 'utf8')) as { q: string }[]).map((q) => q.q)));
  return [...new Set(all)];
}

/** Ten pieces of real code, 800 characters each: what the reranker reads for one question. */
function documents(): string[] {
  const files = readdirSync(SOURCES).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).slice(0, 10);
  return files.map((f) => readFileSync(join(SOURCES, f), 'utf8').slice(2000, 2800));
}

const need = (id: string): SearchModel => {
  const m = modelOf(id);
  if (!m) throw new Error(`Unknown model ${id}`);
  return m;
};
const engineOf = (model: SearchModel, device: Device, threads?: number): Engine =>
  new Engine({ script: SCRIPT, runtime: RUNTIME, modelPath: join(MODELS, model.file), model, device: () => device, idleMs: () => 600_000, ...(threads ? { threads } : {}), ...(PRIORITY ? { priority: PRIORITY } : {}) });

/**
 * What else runs on the machine while measuring. `cpu`: every logical processor busy (a build and tests beside the
 * agents); `cpu-half`: half of them; `gpu`: another model reading code on the card without a pause (an index being built).
 */
async function startLoad(load: Load): Promise<() => void> {
  const procs: ChildProcess[] = [];
  const spinners = load === 'cpu' || load === 'cpu+gpu' ? availableParallelism() : load === 'cpu-half' ? Math.ceil(availableParallelism() / 2) : 0;
  for (let i = 0; i < spinners; i++) procs.push(spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore', windowsHide: true }));
  let busy: Engine | null = null;
  let running = true;
  if (load === 'gpu' || load === 'cpu+gpu') {
    busy = engineOf(need('qwen3-embed-0.6b'), 'gpu');
    const texts = documents().map((d) => d.repeat(3));
    await busy.embed(['warm']);
    void (async () => {
      while (running) await busy!.embed(texts).catch(() => undefined);
    })();
  }
  return () => {
    running = false;
    busy?.stop();
    for (const p of procs) p.kill();
  };
}

async function measure(kind: 'embed' | 'rerank', id: string, device: Device, load: Load, threads?: number): Promise<void> {
  const model = need(id);
  const qs = questions();
  const docs = documents();
  const ask = (e: Engine, q: string) => (kind === 'embed' ? e.embed([(model.query ?? '') + q]) : e.rerank(q, docs));
  const stopLoad = await startLoad(load);
  // Lets the load settle before the first timing.
  await new Promise((r) => setTimeout(r, 1500));
  const vramBefore = vramUsed();
  // Cold: a process started, the model loaded, the question answered, the process ended, each time.
  const cold: number[] = [];
  const loadMs: number[] = [];
  let gpu = false;
  for (let i = 0; i < COLD_RUNS; i++) {
    const e = engineOf(model, device, threads);
    const t = performance.now();
    await ask(e, qs[i % qs.length]);
    cold.push(performance.now() - t);
    loadMs.push(e.state.loadMs);
    gpu = e.state.gpu;
    e.stop();
    await new Promise((r) => setTimeout(r, 500));
  }
  const engine = engineOf(model, device, threads);
  await ask(engine, 'warm up');
  const vramLoaded = vramUsed();
  const warm: number[] = [];
  for (let i = 0; i < WARM_RUNS; i++) {
    const t = performance.now();
    await ask(engine, qs[(i + 7) % qs.length]);
    warm.push(performance.now() - t);
  }
  const memory = memoryOf(process.pid);
  // Eight agents at once, five times: each one's wait, and the whole burst.
  const each: number[] = [];
  const burst: number[] = [];
  for (let round = 0; round < 5; round++) {
    const t0 = performance.now();
    await Promise.all(
      Array.from({ length: CONCURRENT }, async (_, i) => {
        const t = performance.now();
        await ask(engine, qs[(round * CONCURRENT + i + 50) % qs.length]);
        each.push(performance.now() - t);
      }),
    );
    burst.push(performance.now() - t0);
  }
  engine.stop();
  stopLoad();
  await new Promise((r) => setTimeout(r, 2500));
  const row = {
    op: 'latency', kind, model: id, device, gpu, load, threads: threads ?? 'default', priority: PRIORITY ?? 'normal', at: new Date().toISOString(),
    coldFirstMs: Math.round(cold[0]), cold: summary(cold), workerLoadMs: summary(loadMs),
    warm: summary(warm), concurrent: summary(each), burstMs: summary(burst),
    ...memory, vramBeforeMiB: vramBefore, vramLoadedMiB: vramLoaded, vramAfterMiB: vramUsed(),
  };
  mkdirSync(LAB, { recursive: true });
  appendFileSync(join(LAB, 'latency.jsonl'), `${JSON.stringify(row)}\n`);
  console.log(JSON.stringify(row));
}

/** A search host as the app starts it, on a data folder of the lab (search/runtime and search/models linked there). */
function startHost(device: Device, repo: string, rerank: boolean) {
  const settings = { enabled: true, idleMinutes: 5, device, repos: [repo], budget: 800 };
  const init = { dataDir: join(LAB, 'data'), workerScript: SCRIPT, settings };
  const child = fork(HOST, [], { env: { ...process.env, AIBOX_SEARCH_RERANK: rerank ? '' : 'none', AIBOX_SEARCH_HOST: JSON.stringify(init) }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  let seq = 0;
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  child.on('message', (m: { id?: number; result?: unknown; error?: string }) => {
    const w = m.id === undefined ? undefined : waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id!);
    if (m.error !== undefined) w.reject(new Error(m.error));
    else w.resolve(m.result);
  });
  const call = <T>(method: string, ...args: unknown[]): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = ++seq;
      waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
      child.send({ id, method, args });
    });
  const stop = async () => {
    child.kill();
    await new Promise((r) => setTimeout(r, 3000));
  };
  return { child, call, stop };
}

/**
 * The whole path of a `search_code` call as an agent makes it, through the host: from nothing (host and models to
 * start), loaded, eight agents at once, and a name answered without a model.
 */
async function host(device: Device, load: Load, rerank: boolean): Promise<void> {
  const repo = join(REPOS_DIR_HOST, 'claude-hub');
  const concepts = questions().filter((q) => q.split(/\s+/).length >= 6);
  const names = ['SearchService', 'routeOf', 'formatHits', 'SessionManager', 'busyReasons', 'Inbox.settle', 'pickDevice', 'syncFiles'];
  // The index first, complete, so what follows times questions only.
  const setup = startHost(device, repo, rerank);
  await setup.call('prepare');
  for (;;) {
    const st = await setup.call<{ repos: { chunks: number; vectors: number; indexing: boolean }[] }>('state');
    const r = st.repos[0];
    if (r && r.chunks > 0 && r.vectors === r.chunks && !r.indexing) break;
    await new Promise((res) => setTimeout(res, 3000));
  }
  await setup.stop();
  const stopLoad = await startLoad(load);
  await new Promise((r) => setTimeout(r, 1500));
  const vramBefore = vramUsed();
  const cold: number[] = [];
  for (let i = 0; i < COLD_RUNS; i++) {
    const h = startHost(device, repo, rerank);
    const t = performance.now();
    await h.call('searchCode', repo, { query: concepts[i % concepts.length] });
    cold.push(performance.now() - t);
    await h.stop();
  }
  // The same, once a turn has started: the hub warms the models, the question comes after.
  const prewarmed: number[] = [];
  for (let i = 0; i < COLD_RUNS; i++) {
    const w = startHost(device, repo, rerank);
    const read = await w.call<boolean>('warm', repo).catch(() => null);
    if (read !== null) {
      const t = performance.now();
      await w.call('searchCode', repo, { query: concepts[(i + 3) % concepts.length] });
      prewarmed.push(performance.now() - t);
    }
    await w.stop();
    if (read === null) break;
  }
  const h = startHost(device, repo, rerank);
  await h.call('searchCode', repo, { query: 'warm up the models' });
  const vramLoaded = vramUsed();
  const warm: number[] = [];
  for (let i = 0; i < WARM_RUNS; i++) {
    const t = performance.now();
    await h.call('searchCode', repo, { query: concepts[(i + 7) % concepts.length] });
    warm.push(performance.now() - t);
  }
  const named: number[] = [];
  for (let i = 0; i < 2 * names.length; i++) {
    const t = performance.now();
    await h.call('searchCode', repo, { query: names[i % names.length] });
    named.push(performance.now() - t);
  }
  const memory = memoryOf(h.child.pid!, true);
  const each: number[] = [];
  for (let round = 0; round < 5; round++) {
    await Promise.all(
      Array.from({ length: CONCURRENT }, async (_, i) => {
        const t = performance.now();
        await h.call('searchCode', repo, { query: concepts[(round * CONCURRENT + i + 50) % concepts.length] });
        each.push(performance.now() - t);
      }),
    );
  }
  await h.stop();
  stopLoad();
  const row = {
    op: 'latency', kind: 'host', rerank, device, load, at: new Date().toISOString(),
    host: HOST, cold: summary(cold), prewarmed: prewarmed.length ? summary(prewarmed) : null, warm: summary(warm), named: summary(named), concurrent: summary(each),
    ...memory, vramBeforeMiB: vramBefore, vramLoadedMiB: vramLoaded, vramAfterMiB: vramUsed(),
  };
  appendFileSync(join(LAB, 'latency.jsonl'), `${JSON.stringify(row)}\n`);
  console.log(JSON.stringify(row));
}

const [command, id, device = 'auto', load = 'idle', threads] = process.argv.slice(2);
if (command === 'embed' || command === 'rerank') await measure(command, id, device as Device, load as Load, threads ? Number(threads) : undefined);
else if (command === 'host') await host((id ?? 'auto') as Device, device as Load, load !== 'norerank');
else console.log('embed|rerank <model> <cpu|gpu|auto> <idle|cpu|cpu-half|gpu|cpu+gpu> [threads] | host <cpu|gpu|auto> <load> [rerank|norerank]');
process.exit(0);
