import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { t } from './i18n';

/**
 * A command of a tool the user installed (Claude Code, the GitHub CLI) run in a terminal window the user sees and
 * types in: their own sign-in flow, which the hub never sees. `file` is an absolute path found by the hub, the
 * arguments are the hub's own constant words. The PowerShell or sh line of an installer is a constant too.
 */
export type TerminalCommand = { title: string; file: string; args: string[]; env?: Record<string, string> } | { title: string; installer: 'claude' };

const INSTALLER = {
  win32: 'irm https://claude.ai/install.ps1 | iex',
  other: 'curl -fsSL https://claude.ai/install.sh | bash',
};
const LINUX_TERMINALS = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm'];

/** Opens the terminal window; false when none could be started (the screen then shows the command to type). */
export async function openTerminal(cmd: TerminalCommand, env: Record<string, string>): Promise<boolean> {
  try {
    if (process.platform === 'win32') return windows(cmd, env);
    const script = scriptFile(cmd);
    if (process.platform === 'darwin') return await run('open', ['-a', 'Terminal', script], env);
    for (const term of LINUX_TERMINALS) {
      if (!(await run('which', [term], env))) continue;
      const child = spawn(term, term === 'gnome-terminal' ? ['--', script] : ['-e', script], { env, detached: true, stdio: 'ignore' });
      child.on('error', () => undefined);
      child.unref();
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * `start` opens a new console window; `cmd /k` keeps it open once the command is over, so the user reads how it
 * ended. The outer cmd reads the path outside its quotes: a path with a character it would act on (a quote, % that it
 * expands, & | < > ^ that split or redirect the line) is refused, and the screen shows the command to type instead.
 */
function windows(cmd: TerminalCommand, env: Record<string, string>): boolean {
  let line: string;
  if ('installer' in cmd) {
    line = `start "${cmd.title}" powershell.exe -NoProfile -NoExit -Command "${INSTALLER.win32}"`;
  } else {
    if (/["%&|<>^]/.test(cmd.file) || cmd.args.some((a) => !/^[\w.:/-]+$/.test(a))) return false;
    line = `start "${cmd.title}" cmd.exe /d /k ""${cmd.file}" ${cmd.args.join(' ')}"`;
  }
  const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
    cwd: homedir(),
    env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
  child.on('error', () => undefined);
  child.unref();
  return true;
}

/** A shell script of its own (macOS opens .command files in Terminal), removed once the terminal has read it. */
function scriptFile(cmd: TerminalCommand): string {
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const command = 'installer' in cmd ? INSTALLER.other : [cmd.file, ...cmd.args].map(quote).join(' ');
  // Terminal starts the script in a shell of its own, not with the hub's environment: what the command needs is set here.
  const exports = 'installer' in cmd ? [] : Object.entries(cmd.env ?? {}).filter(([k]) => /^[A-Z_][A-Z0-9_]*$/.test(k)).map(([k, v]) => `export ${k}=${quote(v)}`);
  const path = join(tmpdir(), `claude-hub-${randomBytes(6).toString('hex')}.command`);
  const lines = ['#!/bin/bash', 'cd ~', ...exports, `printf '\\033]0;%s\\007' ${quote(cmd.title)}`, command, 'echo', `printf '%s' ${quote(t('terminal.close'))}`, 'read -r _'];
  // A new file of its own (never one already there, in a /tmp shared with other accounts), readable by the user alone.
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o700, flag: 'wx' });
  setTimeout(() => rmSync(path, { force: true }), 10 * 60_000).unref();
  return path;
}

const run = (file: string, args: string[], env: Record<string, string>) =>
  new Promise<boolean>((resolve) => execFile(file, args, { env, timeout: 10_000 }, (err) => resolve(!err)));
