import { execFileSync } from 'node:child_process';

/**
 * An app started from the Finder, the Dock or a desktop launcher gets a minimal PATH, without the folders where
 * claude, gh or git usually live. The user's login shell knows the real one: it is merged in, once, before any other
 * module reads the environment (main.ts imports this module first).
 */
function loadShellPath(): void {
  if (process.platform === 'win32') return;
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
  const mark = '__HUB_PATH__';
  try {
    const out = execFileSync(shell, ['-ilc', `printf '${mark}%s${mark}' "$PATH"`], { encoding: 'utf8', timeout: 3000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'] });
    const found = new RegExp(`${mark}(.*)${mark}`).exec(out)?.[1];
    if (!found) return;
    process.env.PATH = [...new Set([...found.split(':'), ...(process.env.PATH ?? '').split(':')].filter(Boolean))].join(':');
  } catch {
    // Shell missing, slow or broken: the inherited PATH stays.
  }
}

loadShellPath();
