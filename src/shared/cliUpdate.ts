import { brewPackage, CLI_PACKAGES, isNewer, parseVersion, type CliUpdate, type InstallMethod, type SwitchTarget } from './news';
import type { ProviderId } from './providers';

// Updating a provider's program in one click: which commands to run for the way it was installed, and what their
// output means. Pure: the main process (main/cliUpdate.ts) runs the steps and asks the version afterwards.

/** Anthropic's official installer for macOS and Linux (code.claude.com/docs/en/setup): `~/.local/bin/claude`, updates itself. */
export const NATIVE_INSTALLER = 'https://claude.ai/install.sh';

export type UpdateAction = 'upgrade' | 'switch';

/** What each step is shown as while it runs. */
export type StepLabel = 'brew-upgrade' | 'self-update' | 'npm-install' | 'app-install' | 'download' | 'install-native' | 'remove-old';

export interface Step {
  label: StepLabel;
  /** A program and its arguments, never a shell line; empty for the app's own install (done by the main process). */
  exe: string;
  args: string[];
  /** Runs through the system's administrator prompt (macOS), never sudo in a terminal. */
  admin?: boolean;
  /** Retried through the administrator prompt if it fails for lack of rights. */
  elevate?: boolean;
  /** A program that must answer `--version` before this step runs (the old install is removed only once the new one works). */
  check?: string;
  /** The app's own copy, installed with npm in its tools folder. */
  app?: boolean;
}

export interface PlanInput {
  provider: ProviderId;
  action: UpdateAction;
  update: Pick<CliUpdate, 'method' | 'path' | 'switchTo'>;
  home: string;
  /** Where the installer script is downloaded. */
  tmp: string;
  /** npm's global folder can be written by the user (else the administrator prompt). */
  npmWritable: boolean;
}

/** The npm prefix a global install lives in (`<prefix>/lib/node_modules/...`), or empty. */
export function npmPrefix(path: string): string {
  return /^(.*)\/lib\/node_modules\//.exec(path.replace(/\\/g, '/'))?.[1] ?? '';
}

/** npm of the prefix the program was installed with, so the same Node.js (nvm, Homebrew) updates it; else the PATH's. */
export const npmOf = (path: string): string => (npmPrefix(path) ? `${npmPrefix(path)}/bin/npm` : 'npm');

/**
 * What one click can do for a program behind the registry. Homebrew may not have the latest yet (its `claude-code` cask
 * follows the stable channel, about a week behind): its upgrade is offered only when it brings something newer, and
 * when it cannot reach the latest, another install is offered: Anthropic's official installer for Claude Code (it
 * updates itself), the app's own copy for Codex and the Gemini CLI (the app runs it first, the user's install stays).
 */
export function updateChoice(provider: ProviderId, method: InstallMethod, current: string, latest: string, reach: string): Pick<CliUpdate, 'upgrade' | 'switchTo'> {
  const away: SwitchTarget = provider === 'anthropic' ? 'native' : 'app';
  if (method === 'brew') {
    const behind = reach !== '' && isNewer(latest, reach);
    return { upgrade: reach === '' || isNewer(reach, current), switchTo: behind ? away : '' };
  }
  // A program found elsewhere: Claude Code updates itself (`claude update` knows its own install); the others get the app's copy.
  if (method === 'unknown') return provider === 'anthropic' ? { upgrade: true, switchTo: '' } : { upgrade: false, switchTo: 'app' };
  return { upgrade: true, switchTo: '' };
}

/** The command a user would type for a switch (the "copy" link). */
export function switchCommand(provider: ProviderId, update: Pick<CliUpdate, 'method' | 'path'>): string {
  if (provider !== 'anthropic') return '';
  const old = removeOld(provider, update, true);
  return [`curl -fsSL ${NATIVE_INSTALLER} | bash -s latest`, ...(old ? [[old.exe.replace(/^.*\//, ''), ...old.args].join(' ')] : [])].join(' && ');
}

function removeOld(provider: ProviderId, update: Pick<CliUpdate, 'method' | 'path'>, npmWritable: boolean): Step | null {
  const pkg = CLI_PACKAGES[provider];
  const brew = brewPackage(update.path);
  if (update.method === 'brew' && brew) return { label: 'remove-old', exe: brew.brew, args: ['uninstall', ...(brew.kind === 'cask' ? ['--cask'] : []), brew.name] };
  if (update.method === 'npm' && pkg) return { label: 'remove-old', exe: npmOf(update.path), args: ['uninstall', '-g', pkg.npm], admin: !npmWritable, elevate: true };
  return null;
}

/** The steps of an update, in order; empty when one click cannot do it (the command is still there to copy). */
export function planUpdate(input: PlanInput): Step[] {
  const { provider, update } = input;
  const pkg = CLI_PACKAGES[provider];
  if (!pkg) return [];
  const target: SwitchTarget | '' = input.action === 'switch' ? update.switchTo : '';
  if (input.action === 'switch' && !target) return [];
  if (target === 'app' || (!target && update.method === 'app')) return [{ label: 'app-install', exe: '', args: [], app: true }];
  if (target === 'native') {
    const script = `${input.tmp}/claude-install.sh`;
    const installed = `${input.home}/.local/bin/claude`;
    const old = removeOld(provider, update, input.npmWritable);
    return [
      { label: 'download', exe: 'curl', args: ['-fsSL', '--retry', '2', NATIVE_INSTALLER, '-o', script] },
      { label: 'install-native', exe: '/bin/bash', args: [script, 'latest'] },
      // Left installed, a Homebrew claude earlier in the PATH would still be the one run: removed once the new one answers.
      ...(old ? [{ ...old, check: installed }] : []),
    ];
  }
  switch (update.method) {
    case 'brew': {
      const brew = brewPackage(update.path);
      if (!brew) return [];
      return [{ label: 'brew-upgrade', exe: brew.brew, args: ['upgrade', ...(brew.kind === 'cask' ? ['--cask'] : []), brew.name] }];
    }
    case 'native':
      return provider === 'anthropic' ? [{ label: 'self-update', exe: update.path, args: ['update'] }] : [];
    case 'npm':
      return [{ label: 'npm-install', exe: npmOf(update.path), args: ['install', '-g', `${pkg.npm}@latest`, '--no-audit', '--no-fund'], admin: !input.npmWritable, elevate: true }];
    case 'unknown':
      return provider === 'anthropic' && update.path ? [{ label: 'self-update', exe: update.path, args: ['update'] }] : [];
    default:
      return [];
  }
}

/** POSIX single quotes around an argument. */
export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * A command run as administrator through macOS's own password prompt (`osascript … with administrator privileges`):
 * the arguments are quoted for the shell, then for AppleScript's string. The PATH is given (root's is minimal), and
 * npm a cache of its own so the user's `~/.npm` gets no files owned by root.
 */
export function adminCommand(exe: string, args: string[], path: string, tmp: string): [string, string[]] {
  const npm = /(^|\/)npm$/.test(exe) ? ['--cache', `${tmp}/aibox-npm-admin-cache`] : [];
  const line = `PATH=${shellQuote(path)} ${[exe, ...args, ...npm].map(shellQuote).join(' ')}`;
  const script = `do shell script "${line.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" with administrator privileges`;
  return ['/usr/bin/osascript', ['-e', script]];
}

/** Why a step failed, read from its output. */
export type Failure = 'cancelled' | 'needs-admin' | 'in-use' | 'network' | 'busy' | 'no-node' | 'timeout' | 'not-installed' | 'unchanged' | 'failed';

/** What the log says when npm cannot run for want of Node.js. */
export const NO_NODE = 'Node.js not found: npm cannot run';

export function readFailure(code: number, out: string): Failure {
  if (/User cancel+ed|\(-128\)/i.test(out)) return 'cancelled';
  if (out.includes(NO_NODE) || /spawn (node|npm)\S* ENOENT/.test(out)) return 'no-node';
  if (/\bEBUSY\b|resource busy or locked/i.test(out)) return 'in-use';
  if (/\bEACCES\b|\bEPERM\b|permission denied|Operation not permitted|not writable/i.test(out)) return 'needs-admin';
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|Could not resolve host|Failed to connect|curl: \(\d+\)/i.test(out)) return 'network';
  if (/has already locked|another active Homebrew|is locked|Another .*process is running/i.test(out)) return 'busy';
  if (code === -1 && /killed|SIGTERM|timed? ?out/i.test(out)) return 'timeout';
  return 'failed';
}

/** The new version against the old one and the latest: up to date, forward but not there yet (Homebrew), or the same. */
export function verdict(before: string, after: string, latest: string): 'done' | 'partial' | 'unchanged' {
  if (!after) return 'unchanged';
  if (!isNewer(latest, after)) return 'done';
  return isNewer(after, before) ? 'partial' : 'unchanged';
}

/** The version a Homebrew API answer gives (formulae.brew.sh/api/{cask,formula}/<name>.json), '' when it has none. */
export function brewApiVersion(kind: 'cask' | 'formula', body: unknown): string {
  const o = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const raw = kind === 'cask' ? o.version : (o.versions as Record<string, unknown> | undefined)?.stable;
  // A cask's version may carry a build after a comma ("2.1.300,abc123").
  return typeof raw === 'string' ? parseVersion(raw.split(',')[0]) : '';
}

/** One update, as the window shows it: running, finished or failed, with its output. */
export interface CliRun {
  provider: ProviderId;
  tool: string;
  action: UpdateAction;
  phase: 'running' | 'done' | 'failed';
  step: StepLabel;
  /** 1-based number of the running step, and how many there are. */
  index: number;
  total: number;
  from: string;
  latest: string;
  /** The version found once it ended ('' when it could not be asked). */
  to: string;
  error: Failure | '';
  /** The output of the commands, the last part only. */
  log: string;
  /** Sessions still run the old version: AI Box restarted, they resume on the new one. */
  restart: number;
  /** Still behind the latest after it (Homebrew had not more): the other install, offered next. */
  switchTo: SwitchTarget | '';
  /** The program the app runs now is not the one just installed (another install comes first in the PATH). */
  shadowed: boolean;
}
