import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { NewsBotConfig, NewsBotStatus } from '../../shared/newsBot';
const configSchema = z.object({
  enabled: z.boolean(), scheduler: z.boolean(), intervalMs: z.number().int().min(60_000).max(86_400_000),
  network: z.literal(false), publishers: z.object({ x: z.literal(false), tiktok: z.literal(false) }).strict(),
  sources: z.array(z.enum(['playstation', 'xbox', 'nintendo', 'steam'])).max(4), games: z.array(z.string().regex(/^[a-z0-9-]{1,50}$/)).max(30),
}).strict();
export const runtimeDefaults: NewsBotConfig = { enabled: false, scheduler: false, intervalMs: 300_000, network: false, publishers: { x: false, tiktok: false }, sources: ['playstation', 'xbox', 'nintendo', 'steam'], games: ['gta'] };
export type Cycle = (config: NewsBotConfig) => Promise<NonNullable<NewsBotStatus['lastReport']>>;
export interface Timer { schedule(fn: () => void, ms: number): unknown; cancel(id: unknown): void }
const timer: Timer = { schedule: (fn, ms) => { const id = setTimeout(fn, ms); id.unref(); return id; }, cancel: id => clearTimeout(id as NodeJS.Timeout) };
/** Fixed-code logs only. No exception text, source contents, paths, account IDs or tokens enter IPC. */
export class NewsBotRuntime {
  private config: NewsBotConfig = structuredClone(runtimeDefaults);
  private running = false; private busy = false; private cycles = 0;
  private lastReport: NewsBotStatus['lastReport'] = null;
  private logs: NewsBotStatus['logs'] = []; private timerId: unknown; private disposed = false;
  private generation = 0;
  constructor(private dir: string, private cycle: Cycle = async config => (await import('./dryRun')).dryRun(dir, config), private timers: Timer = timer) {
    try { if (existsSync(join(dir, 'config.json'))) this.config = configSchema.parse(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))); } catch { this.log('BLOCKED_CONFIG'); }
    // Explicit start each app session, even when enabled was persisted.
  }
  state(): NewsBotStatus { return structuredClone({ config: this.config, running: this.running, busy: this.busy, cycles: this.cycles, lastReport: this.lastReport, logs: this.logs }); }
  private log(code: string): void { this.logs = [...this.logs.slice(-49), { at: Date.now(), code }]; }
  configure(input: unknown): NewsBotStatus {
    const next = configSchema.parse(input);
    this.stop(); mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, 'config.json'); writeFileSync(path + '.tmp', JSON.stringify(next), { mode: 0o600 }); renameSync(path + '.tmp', path);
    this.config = next; this.log('CONFIG_SAVED'); return this.state();
  }
  start(): NewsBotStatus {
    if (this.disposed || !this.config.enabled) { this.log('BLOCKED_DISABLED'); return this.state(); }
    if (!this.running) { this.running = true; this.generation++; this.log('STARTED_DRY_RUN_ONLY'); this.schedule(); }
    return this.state();
  }
  stop(): NewsBotStatus { this.running = false; this.generation++; if (this.timerId !== undefined) this.timers.cancel(this.timerId); this.timerId = undefined; return this.state(); }
  dispose(): void { this.stop(); this.disposed = true; }
  private schedule(): void { if (this.running && this.config.scheduler) this.timerId = this.timers.schedule(() => { this.timerId = undefined; void this.run(true); }, this.config.intervalMs); }
  async run(scheduled = false): Promise<NewsBotStatus> {
    if (this.disposed || (scheduled && !this.running)) return this.state();
    if (this.busy) { if (scheduled) this.schedule(); return this.state(); }
    const epoch = this.generation; this.busy = true;
    try { this.lastReport = await this.cycle(structuredClone(this.config)); this.cycles++; this.log('DRY_RUN_COMPLETE'); }
    catch { this.log('BLOCKED_CYCLE'); }
    finally { this.busy = false; if (scheduled && epoch === this.generation) this.schedule(); }
    return this.state();
  }
}
export type RegisterHandler = (channel: string, fn: (...args: unknown[]) => unknown) => void;
/** Register through main.ts's trusted-sender wrapper, never raw ipcMain. */
export function registerNewsBotIpc(handle: RegisterHandler, runtime: NewsBotRuntime): void {
  handle('newsbot:state', () => runtime.state());
  handle('newsbot:configure', input => runtime.configure(input));
  handle('newsbot:start', () => runtime.start()); handle('newsbot:stop', () => runtime.stop());
  handle('newsbot:dry-run', () => runtime.run());
}
