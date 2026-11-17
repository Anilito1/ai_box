import type { SearchSettings } from '../../shared/search';
import type { Doc } from './indexer';
import { SearchService, type SearchQuery } from './service';

/**
 * The search, in a process of its own: reading files, cutting them and comparing vectors never run on the app's main
 * thread. The app starts it for a request and it ends by itself once nothing is loaded or being built.
 */
export interface HostInit { dataDir: string; workerScript: string; settings: SearchSettings }
export type HostCall =
  | { method: 'searchCode'; args: [folder: string, q: SearchQuery] }
  | { method: 'searchMemory'; args: [scope: string, docs: Doc[], q: SearchQuery] }
  | { method: 'whereIs'; args: [folder: string, name: string] }
  | { method: 'reindex'; args: [repo: string] }
  | { method: 'install'; args: [] }
  | { method: 'prepare'; args: [] }
  | { method: 'warm'; args: [folder: string] }
  | { method: 'state'; args: [] };
export type HostRequest = ({ id: number } & HostCall) | { settings: SearchSettings };
export type HostReply = { id: number; result?: unknown; error?: string } | { changed: true };

/** Checked this often: the process leaves when the service has been idle for two checks in a row. */
const IDLE_CHECK_MS = 20_000;

const init = JSON.parse(process.env.AIBOX_SEARCH_HOST ?? '{}') as HostInit;
let settings = init.settings;
const service = new SearchService({
  dataDir: init.dataDir,
  workerScript: init.workerScript,
  settings: () => settings,
  onState: () => void process.send?.({ changed: true } satisfies HostReply),
});

let active = 0;
let quiet = 0;
const end = (): never => {
  service.stop();
  process.exit(0);
};
process.on('disconnect', end);
setInterval(() => {
  quiet = active === 0 && service.idle ? quiet + 1 : 0;
  if (quiet >= 2) end();
}, IDLE_CHECK_MS);

process.on('message', (req: HostRequest) => {
  if ('settings' in req) {
    settings = req.settings;
    if (!settings.enabled) end();
    return;
  }
  active++;
  quiet = 0;
  const call = service[req.method] as (...args: unknown[]) => unknown;
  Promise.resolve()
    .then(() => call.apply(service, req.args))
    .then(
      (result) => process.send?.({ id: req.id, result } satisfies HostReply),
      (err) => process.send?.({ id: req.id, error: err instanceof Error ? err.message : String(err) } satisfies HostReply),
    )
    .finally(() => active--);
});
