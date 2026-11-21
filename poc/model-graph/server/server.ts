import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { pause, runGraph, type RunEvent, type RunOptions, type Value } from '../shared/engine';
import { catalogOf, GraphFormatError, parseGraph, type Graph } from '../shared/graph';
import type { AddProviderRequest, AppState, ClientEvent, ClientValue, DeclareRequest, RunRequest } from '../shared/protocol';
import { Providers } from './providers';
import { framesRunner } from './runners/frames';
import { realRunner } from './runners/real';
import { SIM, simRunner } from './runners/sim';

// The POC's local server: what the hub's main process would be. It holds the providers and their keys, runs the
// graphs, keeps what they make, and serves the page. It listens on this computer only, and every call of the page
// carries a token written into the page when it is served: another site open in the browser cannot use it.

export interface ServerOptions {
  /** poc/model-graph: where the examples are. */
  root: string;
  /** Where index.html, styles.css and the built app.js are. */
  assets: string;
  port: number;
  /** Simulated calls go this many times faster (tests of the page). */
  simSpeed?: number;
  fetch?: typeof fetch;
}

export interface RunningServer {
  url: string;
  providers: Providers;
  close(): Promise<void>;
}

const BODY_MAX = 80 * 1024 * 1024;
/** The images a message may carry: none that can hold a script. */
const IMAGE_TYPES = /^image\/(png|jpeg|webp|gif)$/i;
const ARTIFACTS_MAX = 600 * 1024 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function body<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_MAX) throw new HttpError(413, 'Message trop gros.');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw new HttpError(400, 'JSON illisible.');
  }
}

function examples(root: string): Graph[] {
  const dir = join(root, 'examples');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => parseGraph(JSON.parse(readFileSync(join(dir, f), 'utf8'))));
}

export async function startServer(o: ServerOptions): Promise<RunningServer> {
  const providers = new Providers(o.fetch ?? fetch);
  const token = randomBytes(24).toString('hex');
  const shipped = examples(o.root);

  // What the runs made, by an address nobody can guess; the oldest go when there is too much.
  const artifacts = new Map<string, { mime: string; bytes: Uint8Array }>();
  let kept = 0;
  const keep = (mime: string, bytes: Uint8Array): string => {
    const id = randomBytes(12).toString('hex');
    artifacts.set(id, { mime, bytes });
    kept += bytes.length;
    for (const [old, a] of artifacts) {
      if (kept <= ARTIFACTS_MAX || old === id) break;
      artifacts.delete(old);
      kept -= a.bytes.length;
    }
    return `/artifact/${id}`;
  };
  // A value shown on two nodes (made by one, read by the next) is kept once.
  const addresses = new WeakMap<Uint8Array, string>();
  const forPage = (v: Value): ClientValue => {
    if (v.type === 'text') return v;
    const known = addresses.get(v.bytes);
    // An address whose file made room for newer ones is given again.
    const url = known && artifacts.has(known.slice('/artifact/'.length)) ? known : keep(v.mime, v.bytes);
    addresses.set(v.bytes, url);
    return { type: v.type, mime: v.mime, url, size: v.bytes.length, ...(v.label ? { label: v.label } : {}) };
  };
  const eventForPage = (e: RunEvent): ClientEvent => {
    if (e.type === 'run') return e;
    // The job stays here: it may hold the provider's address of the result.
    const { outputs, job: _job, ...rest } = e;
    return { ...rest, ...(outputs ? { outputs: Object.fromEntries(Object.entries(outputs).map(([port, values]) => [port, values.map(forPage)])) } : {}) };
  };

  const state = (): AppState => ({ providers: providers.info(), models: providers.models(), examples: shipped });
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  };

  async function run(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const asked = await body<RunRequest>(req);
    const graph = parseGraph(asked.graph);
    const images = (Array.isArray(asked.images) ? asked.images : []).slice(0, 8).map((i): Value => ({ type: 'image', mime: IMAGE_TYPES.test(i.mime) ? i.mime : 'image/png', bytes: new Uint8Array(Buffer.from(String(i.base64), 'base64')) }));
    const history = (Array.isArray(asked.history) ? asked.history : []).filter((t) => (t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string').slice(-40);
    // A cap that cannot be read is refused rather than dropped: the run would have none.
    const cap = asked.maxCostUsd;
    if (cap !== undefined && !(typeof cap === 'number' && Number.isFinite(cap) && cap >= 0)) throw new HttpError(400, 'Plafond invalide : un nombre positif, en dollars.');

    // One line of JSON per event, as they happen: the page reads the answer while it is written.
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    const stop = new AbortController();
    // The page went away, or the user pressed stop: nothing more is asked of the providers.
    res.on('close', () => stop.abort(new Error('cancelled')));
    const options: RunOptions = {
      graph,
      catalog: catalogOf(providers.models()),
      input: { text: String(asked.text ?? ''), images },
      history,
      maxCostUsd: cap,
      signal: stop.signal,
      onEvent: (e) => res.writable && res.write(`${JSON.stringify(eventForPage(e))}\n`),
      runnerFor(node, spec) {
        if (node.kind === 'convert') return node.convert === 'frames' ? framesRunner : null;
        if (!spec) return null;
        if (spec.provider === SIM) return simRunner(spec, { sleep: pause, speed: o.simSpeed });
        const access = providers.access(spec.provider);
        return access ? realRunner(access, spec) : null;
      },
    };
    try {
      await runGraph(options);
    } catch (err) {
      // The engine reports a node's failure itself: this is a fault of the POC. The page is told the run is over.
      console.error(`Exécution interrompue : ${err instanceof Error ? err.message : String(err)}`);
      const event: ClientEvent = { type: 'run', state: 'error', error: 'Erreur interne du moteur : exécution interrompue.', costUsd: 0 };
      if (res.writable) res.write(`${JSON.stringify(event)}\n`);
    }
    res.end();
  }

  function artifact(req: IncomingMessage, res: ServerResponse, id: string): void {
    const found = artifacts.get(id);
    if (!found) {
      res.writeHead(404).end();
      return;
    }
    const total = found.bytes.length;
    // A video player asks for parts of the file, to start early and to seek. Opened in a tab of its own, a file
    // runs nothing (sandbox): what a provider sent never acts as this page.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    const headers = { 'content-type': found.mime, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox' };
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, total - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
      if (start > end || start >= total) {
        res.writeHead(416, { 'content-range': `bytes */${total}` }).end();
        return;
      }
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${total}`, 'content-length': end - start + 1 });
      res.end(found.bytes.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { ...headers, 'content-length': total });
    res.end(found.bytes);
  }

  const FILES: Record<string, [file: string, type: string]> = {
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  };

  async function handle(req: IncomingMessage, res: ServerResponse, origin: string): Promise<void> {
    const url = new URL(req.url ?? '/', origin);
    const path = url.pathname;
    // Only this page, at this address: a name pointed at 127.0.0.1 by another site is refused.
    if (!['127.0.0.1', 'localhost'].includes((req.headers.host ?? '').replace(/:\d+$/, ''))) throw new HttpError(403, 'Refusé.');
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(readFileSync(join(o.assets, 'index.html'), 'utf8').replace('__TOKEN__', token));
      return;
    }
    if (req.method === 'GET' && FILES[path]) {
      res.writeHead(200, { 'content-type': FILES[path][1], 'cache-control': 'no-store' });
      res.end(readFileSync(join(o.assets, FILES[path][0])));
      return;
    }
    if (req.method === 'GET' && path.startsWith('/artifact/')) return artifact(req, res, path.slice('/artifact/'.length));
    if (!path.startsWith('/api/')) throw new HttpError(404, 'Introuvable.');
    if (req.headers['x-poc-token'] !== token) throw new HttpError(403, 'Refusé.');

    if (req.method === 'GET' && path === '/api/state') return json(res, 200, state());
    if (req.method === 'POST' && path === '/api/run') return run(req, res);
    if (req.method === 'POST' && path === '/api/providers') {
      const p = await body<AddProviderRequest>(req);
      try {
        await providers.add(String(p.name ?? ''), String(p.baseUrl ?? ''), String(p.key ?? ''));
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : 'Fournisseur refusé.');
      }
      return json(res, 200, state());
    }
    const one = /^\/api\/providers\/([a-z0-9-]+)(\/declare)?$/.exec(path);
    if (one && req.method === 'DELETE' && !one[2]) {
      providers.remove(one[1]);
      return json(res, 200, state());
    }
    if (one && req.method === 'POST' && one[2]) {
      const d = await body<DeclareRequest>(req);
      try {
        providers.declare(one[1], { model: String(d.model ?? ''), preset: d.preset, ...(typeof d.maxImages === 'number' ? { maxImages: d.maxImages } : {}) });
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : 'Déclaration refusée.');
      }
      return json(res, 200, state());
    }
    throw new HttpError(404, 'Introuvable.');
  }

  let origin = '';
  const server = createServer((req, res) => {
    handle(req, res, origin).catch((err: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      // What a refusal says is ours; anything else is not shown, it could quote what was sent.
      const ours = err instanceof HttpError || err instanceof GraphFormatError;
      json(res, err instanceof HttpError ? err.status : ours ? 400 : 500, { error: ours ? err.message : 'Erreur interne du serveur du POC.' });
    });
  });

  // The port asked for, or one of the next when it is taken (the POC already runs in another terminal).
  const port = await new Promise<number>((resolve, reject) => {
    let at = o.port;
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && o.port !== 0 && at < o.port + 20) server.listen(++at, '127.0.0.1');
      else reject(err);
    });
    server.on('listening', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : at);
    });
    server.listen(at, '127.0.0.1');
  });
  origin = `http://127.0.0.1:${port}`;

  return {
    url: origin,
    providers,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
