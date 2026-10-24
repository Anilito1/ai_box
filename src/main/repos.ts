import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { t } from './i18n';

export interface RepoInfo {
  name: string;
  path: string;
  remote: string;
  branch: string;
  /** Main folder of the repo when this one is a linked worktree, else empty. */
  worktreeOf: string;
}

const SKIP = new Set(['node_modules', 'dist', 'build', 'out', 'vendor', 'target']);
const MAX_DEPTH = 4;

/** Git repositories under `root` (a repo's own subfolders are not searched). */
export function findRepos(root: string): RepoInfo[] {
  const repos: RepoInfo[] = [];
  const walk = (dir: string, depth: number) => {
    const gitPath = join(dir, '.git');
    if (existsSync(gitPath)) {
      try {
        repos.push(describe(dir, gitPath));
      } catch {
        repos.push({ name: basename(dir), path: dir, remote: '', branch: t('repos.unreadable'), worktreeOf: '' }); // locked or placeholder .git
      }
      return;
    }
    if (depth >= MAX_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Unreadable folder (permissions): skip it.
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name)) walk(join(dir, e.name), depth + 1);
    }
  };
  walk(resolve(root), 0);
  return repos;
}

/** host/path of the origin remote of a checkout (credentials removed), or empty. */
export function remoteOf(dir: string): string {
  try {
    return describe(dir, join(dir, '.git')).remote;
  } catch {
    return '';
  }
}

/** Root of the git repository containing `dir`, or null. */
export function repoRootOf(dir: string): string | null {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d;
    if (dirname(d) === d) return null;
  }
}

function describe(dir: string, gitPath: string): RepoInfo {
  // A linked worktree has a `.git` file pointing at its git dir; its config lives in the common dir.
  const gitDir = statSync(gitPath).isFile() ? resolve(dir, readFileSync(gitPath, 'utf8').replace(/^gitdir:\s*/, '').trim()) : gitPath;
  const read = (file: string) => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  };
  const common = read(join(gitDir, 'commondir')).trim();
  const commonDir = common ? resolve(gitDir, common) : gitDir;
  const config = read(join(commonDir, 'config'));
  const head = read(join(gitDir, 'HEAD')).trim();
  return {
    name: basename(dir),
    path: dir,
    remote: cleanRemote(remoteUrl(config)),
    branch: head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : t('repos.detached', { sha: head.slice(0, 8) }),
    worktreeOf: common ? dirname(commonDir) : '',
  };
}

/** `url` of the origin remote (else the first remote); `pushurl` is ignored. */
function remoteUrl(config: string): string {
  const remotes = config.split(/^\s*\[/m).filter((section) => /^remote\s+"/.test(section));
  const section = remotes.find((r) => /^remote\s+"origin"/.test(r)) ?? remotes[0];
  return section ? (/^\s*url\s*=\s*(.+?)\s*$/m.exec(section)?.[1] ?? '') : '';
}

/** host/path of a remote, with any credentials removed: they must never reach a model's context. */
function cleanRemote(raw: string): string {
  let url = raw.replace(/^"(.*)"$/, '$1');
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(url);
  if (scheme) {
    url = url.slice(scheme[0].length);
    const slash = url.indexOf('/');
    const at = (slash === -1 ? url : url.slice(0, slash)).lastIndexOf('@');
    if (at !== -1) url = url.slice(at + 1);
  } else {
    url = url.replace(/^[^@/]+@([^:/]+):/, '$1/'); // scp-like git@host:org/repo
  }
  return url.replace(/\.git$/, '');
}
