import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * An app started from the Finder, the Dock or a desktop launcher gets a minimal PATH, without the folders where
 * claude, gh or git usually live. The user's login shell knows the real one: it is merged in, once, before any other
 * module reads the environment (main.ts imports this module first).
 */
function loadShellPath(): void {
  if (process.platform === 'win32') return;
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
  const mark = '__HUB_PATH__';
  let found = '';
  try {
    // A shell that loads nvm, conda or oh-my-zsh can take a few seconds on a cold start.
    const out = execFileSync(shell, ['-ilc', `printf '${mark}%s${mark}' "$PATH"`], { encoding: 'utf8', timeout: 6000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'] });
    found = new RegExp(`${mark}(.*)${mark}`).exec(out)?.[1] ?? '';
  } catch {
    // Shell missing, slow or broken: the inherited PATH stays, with the usual folders below.
  }
  // Where Homebrew and the native installers put claude, gh and git, last: the shell's own order wins.
  const usual = process.platform === 'darwin' ? ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', join(homedir(), '.local', 'bin')] : [join(homedir(), '.local', 'bin')];
  process.env.PATH = [...new Set([...found.split(':'), ...(process.env.PATH ?? '').split(':'), ...usual].filter(Boolean))].join(':');
}

loadShellPath();
