import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { npmCli, run } from '../updateExec';

// The programs a provider's sign-in runs in (Claude Code, Codex, the Gemini CLI). When one is missing or too old, the
// app installs its own copy with npm, in a folder of its own (never a global install): the user never types a command.

export type Tool = 'claude' | 'codex' | 'gemini';

const PACKAGES: Record<Tool, string> = { claude: '@anthropic-ai/claude-code', codex: '@openai/codex', gemini: '@google/gemini-cli' };
const INSTALL_MS = 5 * 60_000;

let root = '';
const running = new Map<Tool, Promise<string>>();
/** Installs share one folder: npm runs them one after the other. */
let queue: Promise<unknown> = Promise.resolve();

/** Where the app keeps its own copies: set once at start. */
export function setToolsDir(dir: string): void {
  root = dir;
}

/** Codex's own binary in an npm `node_modules`: the package of this platform, hoisted or under @openai/codex. */
export function codexBinary(modules: string): string {
  const pkg = `codex-${process.platform}-${process.arch}`;
  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex';
  for (const dir of [join(modules, '@openai', pkg), join(modules, '@openai', 'codex', 'node_modules', '@openai', pkg)]) {
    try {
      for (const triple of readdirSync(join(dir, 'vendor'))) {
        const path = join(dir, 'vendor', triple, 'bin', exe);
        if (existsSync(path)) return path;
      }
    } catch {
      // Not installed there.
    }
  }
  return '';
}

/** The Gemini CLI's script in an npm `node_modules` (Node runs it: its .cmd wrapper needs a shell on Windows). */
export const geminiScript = (modules: string): string => {
  const path = join(modules, '@google', 'gemini-cli', 'bundle', 'gemini.js');
  return existsSync(path) ? path : '';
};

/** The app's own copy of a tool, if it installed one. */
export function localTool(tool: Tool): string {
  if (!root) return '';
  const modules = join(root, 'node_modules');
  if (tool === 'codex') return codexBinary(modules);
  if (tool === 'gemini') return geminiScript(modules);
  // The package names its binary claude.exe on every platform.
  const path = join(modules, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  return existsSync(path) ? path : '';
}

/** How to start a tool: a script is run by Node, a binary as it is. */
export const toolCommand = (exe: string, args: string[]): [string, string[]] => (exe.endsWith('.js') ? ['node', [exe, ...args]] : [exe, args]);

/**
 * Installs (or updates) the app's copy of a tool with the user's Node.js and npm, an argument list and no shell.
 * Answers an error code: '' when done, `no-node` without Node.js, `install-failed` when npm failed.
 */
export function installTool(tool: Tool, env: Record<string, string>): Promise<string> {
  const pending = running.get(tool);
  if (pending) return pending;
  const task = queue.then(() => install(tool, env)).finally(() => running.delete(tool));
  queue = task.catch(() => undefined);
  running.set(tool, task);
  return task;
}

async function install(tool: Tool, env: Record<string, string>): Promise<string> {
  if (!root) return 'install-failed';
  const where = await run('node', ['-p', 'process.execPath'], homedir(), env, 15_000);
  const node = where.code === 0 ? where.out.trim().split(/\r?\n/)[0] : '';
  const cli = node ? npmCli(node, '') : '';
  if (!cli) return 'no-node';
  mkdirSync(root, { recursive: true });
  const r = await run(node, [cli, 'install', '--prefix', root, '--no-audit', '--no-fund', '--loglevel=error', `${PACKAGES[tool]}@latest`], root, env, INSTALL_MS);
  return r.code === 0 && localTool(tool) ? '' : 'install-failed';
}
