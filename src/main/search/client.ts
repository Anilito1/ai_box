import { fork, type ChildProcess } from 'node:child_process';
import type { SearchSettings, SearchState } from '../../shared/search';
import type { HostCall, HostInit, HostReply, HostRequest } from './host';
import type { Doc } from './indexer';
import type { SearchQuery } from './service';

export interface SearchClientOptions {
  dataDir: string;
  /** The built `search-host.mjs` and `search-worker.mjs`. */
  hostScript: string;
  workerScript: string;
  settings: () => SearchSettings;
  env: () => Record<string, string>;
  /** Something the settings show changed (a download, an index, a model loaded or gone). */
  onState?: () => void;
}

const NOTHING: SearchState = { installed: false, installing: null, error: '', loaded: { embed: false, rerank: false, gpu: false }, sizeMb: 0, models: [], repos: [] };

/**
 * The app's side of the local search: it starts the search process for a request and talks to it. Off, the feature
 * costs nothing: no process, no file read, no network.
 */
export class SearchClient {
  private child: ChildProcess | null = null;
  private seq = 0;
  private readonly waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(private readonly opts: SearchClientOptions) {}

  get enabled(): boolean {
    return this.opts.settings().enabled;
  }

  private host(): ChildProcess {
    if (this.child) return this.child;
    const init: HostInit = { dataDir: this.opts.dataDir, workerScript: this.opts.workerScript, settings: this.opts.settings() };
    // The environment the hub gives its own tools (npm, git): the sessions' accesses are not in it.
    const child = fork(this.opts.hostScript, [], { env: { ...this.opts.env(), AIBOX_SEARCH_HOST: JSON.stringify(init) }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    child.on('message', (m: HostReply) => {
      if ('changed' in m) return this.opts.onState?.();
      const w = this.waiting.get(m.id);
      this.waiting.delete(m.id);
      if (m.error !== undefined) w?.reject(new Error(m.error));
      else w?.resolve(m.result);
    });
    const gone = () => {
      if (this.child !== child) return;
      this.child = null;
      // Left by itself once idle: the page already knows nothing is loaded, and asking again would start it again.
      const cut = this.waiting.size > 0;
      for (const w of this.waiting.values()) w.reject(new Error('The search stopped'));
      this.waiting.clear();
      if (cut) this.opts.onState?.();
    };
    child.once('exit', gone);
    child.once('error', gone);
    return (this.child = child);
  }

  private call<T>(call: HostCall): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = ++this.seq;
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.host().send({ id, ...call } satisfies HostRequest);
    });
  }

  searchCode(folder: string, q: SearchQuery): Promise<string> {
    return this.call({ method: 'searchCode', args: [folder, q] });
  }

  searchMemory(scope: string, docs: Doc[], q: SearchQuery): Promise<string> {
    return this.call({ method: 'searchMemory', args: [scope, docs, q] });
  }

  whereIs(folder: string, name: string): Promise<string> {
    return this.call({ method: 'whereIs', args: [folder, name] });
  }

  reindex(repo: string): Promise<string> {
    return this.call({ method: 'reindex', args: [repo] });
  }

  install(): Promise<string> {
    return this.call({ method: 'install', args: [] });
  }

  /** Builds the index of the listed repos that have none (after an install, a new repo in the list). */
  prepare(): void {
    if (this.enabled) void this.call({ method: 'prepare', args: [] }).catch(() => undefined);
  }

  /** What the settings show. Off, nothing is started to answer. */
  state(): Promise<SearchState> {
    return this.enabled || this.child ? this.call<SearchState>({ method: 'state', args: [] }).catch(() => NOTHING) : Promise.resolve(NOTHING);
  }

  /** The settings changed: the running process follows them (and ends when the feature was switched off). */
  settingsChanged(): void {
    this.child?.send({ settings: this.opts.settings() } satisfies HostRequest);
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
  }
}
