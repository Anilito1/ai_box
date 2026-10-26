import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { adminCommand, NO_NODE, npmPrefix, planUpdate, readFailure, verdict, type CliRun, type Failure, type Step, type UpdateAction } from '../shared/cliUpdate';
import { CLI_PACKAGES, installMethod, isNewer, type CliUpdate } from '../shared/news';
import type { ProviderId } from '../shared/providers';
import { installTool, toolCommand, userNpm, type Tool } from './providers/tools';
import { run } from './updateExec';

// Updates a provider's program in one click: the steps of its install method run here, one after the other, with the
// PATH of the user's shell and no terminal; the version is asked again afterwards. Sessions running keep the program
// they started with (a file replaced or removed stays valid for a process that runs it); new ones get the new one.

/** How commands run: the real one spawns them, a test or a dry run hands its own. */
export interface Runner {
  run(exe: string, args: string[], env: Record<string, string>, onData: (text: string) => void): Promise<{ code: number; out: string }>;
  /** The app's own copy of a program (npm in its tools folder): '' when done, else an error code. */
  installApp(provider: ProviderId): Promise<string>;
  /** The version a program answers, '' when it does not. */
  version(path: string): Promise<string>;
  /** npm's global folder of a prefix can be written without administrator rights. */
  writable(prefix: string): boolean;
  exists(path: string): boolean;
}

export interface CliUpdateDeps {
  runner: Runner;
  env(): Record<string, string>;
  home: string;
  tmp: string;
  platform: NodeJS.Platform;
  toolsDir: string;
  /** The update the news found for the provider's program. */
  update(provider: ProviderId): CliUpdate | null;
  /** Checks the providers again (programs found, versions, news): the menu's notice goes when it is up to date. */
  refresh(): Promise<void>;
  /** The program the app runs now for the provider, with its version, after refresh(). */
  program(provider: ProviderId): { path: string; version: string; real: string } | null;
  /** Sessions with a process running this provider's program. */
  running(provider: ProviderId): number;
  /** The user agrees to change how the program is installed. */
  confirmSwitch(provider: ProviderId, update: CliUpdate): Promise<boolean>;
  send(run: CliRun): void;
}

const LOG_MAX = 20_000;
const SEND_EVERY_MS = 250;

export class CliUpdater {
  private runs = new Map<ProviderId, CliRun>();
  private busy = false;

  constructor(private readonly deps: CliUpdateDeps) {}

  /** The updates shown in the window (a reload gets them back). */
  view(): CliRun[] {
    return [...this.runs.values()];
  }

  /** The user closed a finished update's notice ("Later", "OK"). */
  dismiss(provider: ProviderId): void {
    const run = this.runs.get(provider);
    if (run && run.phase !== 'running') this.runs.delete(provider);
  }

  /** One update at a time: Homebrew and npm keep locks of their own, and the window shows one progress. */
  async start(provider: ProviderId, action: UpdateAction): Promise<CliRun | null> {
    if (this.busy) return null;
    const update = this.deps.update(provider);
    if (!update) return null;
    this.busy = true;
    try {
      if (action === 'switch' && !(await this.deps.confirmSwitch(provider, update))) return null;
      return await this.execute(provider, action, update).catch((err: unknown) => {
        // Whatever threw, the window must not stay on "running".
        const run = this.runs.get(provider);
        if (!run) return null;
        Object.assign(run, { phase: 'failed', error: 'failed', log: `${run.log}\n${err instanceof Error ? err.message : String(err)}\n` });
        this.deps.send({ ...run });
        return run;
      });
    } finally {
      this.busy = false;
    }
  }

  private async execute(provider: ProviderId, action: UpdateAction, update: CliUpdate): Promise<CliRun> {
    const prefix = npmPrefix(update.path);
    const planned = planUpdate({ provider, action, update, home: this.deps.home, tmp: this.deps.tmp, npmWritable: !prefix || this.deps.runner.writable(prefix) });
    // A prefix without its own npm (Volta's images): the PATH's.
    const steps = planned.map((s) => (/\/npm$/.test(s.exe) && !this.deps.runner.exists(s.exe) ? { ...s, exe: 'npm' } : s));
    const run: CliRun = { provider, tool: update.tool, action, phase: 'running', step: steps[0]?.label ?? 'npm-install', index: 1, total: steps.length, from: update.current, latest: update.latest, to: '', error: '', log: '', restart: 0, switchTo: '', shadowed: false };
    this.runs.set(provider, run);
    let last = 0;
    const show = (force = false) => {
      if (!force && Date.now() - last < SEND_EVERY_MS) return;
      last = Date.now();
      this.deps.send({ ...run });
    };
    const append = (text: string) => {
      run.log = (run.log + text).slice(-LOG_MAX);
      show();
    };
    const fail = (error: Failure): CliRun => {
      Object.assign(run, { phase: 'failed', error, switchTo: action === 'upgrade' ? update.switchTo : '' });
      show(true);
      return run;
    };
    show(true);
    if (steps.length === 0) return fail('failed');
    for (const [i, step] of steps.entries()) {
      Object.assign(run, { step: step.label, index: i + 1 });
      show(true);
      if (step.check && !(await this.deps.runner.version(step.check))) {
        append(`\n${step.check} --version: no answer\n`);
        return fail('not-installed');
      }
      const error = await this.runStep(provider, step, append).catch((err: unknown) => {
        append(`\n${err instanceof Error ? err.message : String(err)}\n`);
        return 'failed' as const;
      });
      if (error) return fail(error);
    }
    // A check that throws leaves the version unknown: the result says so rather than staying "running".
    await this.deps.refresh().catch(() => undefined);
    const now = this.deps.program(provider);
    // Asked again here: another check running at the same time may have read the program before the update.
    const probed = now ? await this.deps.runner.version(now.path) : '';
    const to = probed && isNewer(probed, now?.version ?? '') ? probed : now?.version || probed;
    const result = verdict(update.current, to, update.latest);
    // After a switch the app must run the new install: another one earlier in the PATH would hide it.
    const shadowed = action === 'switch' && !!now && installMethod(now.real, this.deps.toolsDir) !== (update.switchTo === 'native' ? 'native' : 'app');
    if (result === 'unchanged' && !shadowed) {
      run.to = to;
      return fail('unchanged');
    }
    Object.assign(run, {
      phase: 'done',
      to,
      restart: this.deps.running(provider),
      // Homebrew brought it forward, not to the latest: the other install is offered next.
      switchTo: result === 'partial' && action === 'upgrade' ? update.switchTo : '',
      shadowed,
    });
    show(true);
    return run;
  }

  /** Runs one step; '' when it went through. A lack of rights is asked again through the administrator prompt. */
  private async runStep(provider: ProviderId, step: Step, append: (text: string) => void): Promise<Failure | ''> {
    if (step.app) {
      append(`\n$ npm install --prefix ${this.deps.toolsDir} ${CLI_PACKAGES[provider]?.npm ?? ''}@latest\n`);
      const error = await this.deps.runner.installApp(provider);
      if (error) append(`${error}\n`);
      return error === 'no-node' ? 'no-node' : error ? 'failed' : '';
    }
    const env = this.envFor(step);
    const once = async (admin: boolean): Promise<Failure | ''> => {
      const [exe, args] = admin ? adminCommand(step.exe, step.args, env.PATH ?? '', this.deps.tmp) : [step.exe, step.args];
      append(`\n$ ${admin ? '(administrator) ' : ''}${[step.exe, ...step.args].join(' ')}\n`);
      const r = await this.deps.runner.run(exe, args, env, append);
      if (r.code === 0) return '';
      const failure = readFailure(r.code, r.out);
      // Windows refuses to remove or move a program's files while a process runs them: held, not a lack of rights.
      return failure === 'needs-admin' && this.deps.platform === 'win32' && /\bsyscall (unlink|rename)\b/.test(r.out) ? 'in-use' : failure;
    };
    const canElevate = this.deps.platform === 'darwin';
    const first = await once(!!step.admin && canElevate);
    if (first === 'needs-admin' && step.elevate && !step.admin && canElevate) return once(true);
    return first;
  }

  /** The user's environment, without prompts: npm's own Node.js first, Homebrew quiet and non-interactive. */
  private envFor(step: Step): Record<string, string> {
    const env: Record<string, string> = { ...this.deps.env(), NONINTERACTIVE: '1', HOMEBREW_NO_ENV_HINTS: '1', npm_config_yes: 'true' };
    const bin = step.exe.includes('/') ? step.exe.slice(0, step.exe.lastIndexOf('/')) : '';
    if (/(^|\/)npm$/.test(step.exe) && bin) env.PATH = [bin, env.PATH].filter(Boolean).join(':');
    return env;
  }
}

const STEP_MS = 10 * 60_000;
const TOOLS: Partial<Record<ProviderId, Tool>> = { anthropic: 'claude', openai: 'codex', gemini: 'gemini' };

/** The runner that does it: programs spawned with an argument list, never a shell. */
export function realRunner(env: () => Record<string, string>): Runner {
  return {
    run: async (exe, args, e, onData) => {
      // npm is a .cmd on Windows, which does not start without a shell: its script runs with the user's Node.js.
      if (process.platform === 'win32' && /(^|[\\/])npm$/.test(exe)) {
        const npm = await userNpm(e);
        if (!npm) {
          onData(`${NO_NODE}\n`);
          return { code: -1, out: NO_NODE };
        }
        return run(npm.node, [npm.cli, ...args], homedir(), e, STEP_MS, onData);
      }
      return run(exe, args, homedir(), e, STEP_MS, onData);
    },
    installApp: (provider) => {
      const tool = TOOLS[provider];
      return tool ? installTool(tool, env()) : Promise.resolve('install-failed');
    },
    version: (path) =>
      new Promise((resolve) => {
        const [file, args] = toolCommand(path, ['--version']);
        execFile(file, args, { env: env(), timeout: 15_000, windowsHide: true }, (err, stdout) => resolve(err ? '' : (/\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? '')));
      }),
    exists: (path) => existsSync(path),
    writable: (prefix) => {
      try {
        accessSync(join(prefix, 'lib', 'node_modules'), constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * A dry run for development (AIBOX_CLI_UPDATE_SIMULATE=1, or `fail`): each step prints what it would run and waits,
 * nothing is installed or removed.
 */
export function simulatedRunner(mode: string): Runner {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return {
    run: async (_exe, _args, _env, onData) => {
      for (const line of ['(simulated: nothing runs)', '==> Downloading…', '==> Installing…']) {
        onData(`${line}\n`);
        await wait(2_500);
      }
      if (mode === 'fail') {
        const out = 'npm error code EACCES\nnpm error syscall rename\nnpm error Error: EACCES: permission denied\n';
        onData(out);
        return { code: 1, out };
      }
      return { code: 0, out: '' };
    },
    installApp: async () => {
      await wait(4_000);
      return mode === 'fail' ? 'install-failed' : '';
    },
    // Older than anything: the version shown is the one the dry run pretends to reach.
    version: async () => '0.0.1',
    writable: () => true,
    exists: () => true,
  };
}
