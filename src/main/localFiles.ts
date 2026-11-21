import type { Stats } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { localFilePath, type LocalFileResult } from '../shared/localFiles';

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};
const safeTypes = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico', '.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.mp3', '.wav', '.ogg', '.flac', '.srt']);
const launchablePackage = /\.(?:app|workflow|bundle|plugin|prefpane|saver|service|wdgt|action)$/i;
const privatePath = (path: string) => path.split(/[\\/]/).some((part) => part.startsWith('.') || launchablePackage.test(part) || /^(?:id_rsa|id_ed25519|credentials|secrets?)(?:[._-]|$)/i.test(part));
export interface LocalFileShell {
  openPath(path: string): Promise<string>;
  showItemInFolder(path: string): void;
}
type LocalFileError = Extract<LocalFileResult, { ok: false }>;

/**
 * A path a message names, checked against the folders it may come from: the workspace it is relative to, then `also`.
 * Gives its canonical path (links resolved) once it is inside one of them and not private. No raw OS errors.
 */
export async function locateLocalFile(workspace: string | undefined, input: unknown, also: string[] = []): Promise<{ ok: true; path: string; info: Stats } | LocalFileError> {
  if (!workspace || typeof input !== 'string') return { ok: false, error: 'invalid' };
  const path = localFilePath(input);
  if (!path || /[%#?]/.test(path) || (process.platform !== 'win32' && /[\\:]/.test(path))) return { ok: false, error: 'invalid' };
  if (process.platform === 'win32') {
    const tail = /^[a-z]:[\\/]/i.test(path) ? path.slice(2) : path;
    // Alternate data streams, device names and Win32 name trimming must not change the checked target.
    if (/[<>:"|*]/.test(tail) || tail.split(/[\\/]/).some((part) => /[. ]$/.test(part) && part !== '.' && part !== '..' || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return { ok: false, error: 'invalid' };
  }
  const target = resolve(resolve(workspace), path);
  const lexicalRoot = [workspace, ...also].map((root) => resolve(root)).find((root) => inside(root, target));
  if (!lexicalRoot) return { ok: false, error: 'outside' };
  if (privatePath(relative(lexicalRoot, target))) return { ok: false, error: 'unsupported' };
  try {
    const root = await realpath(lexicalRoot);
    const canonical = await realpath(target);
    if (!inside(root, canonical)) return { ok: false, error: 'outside' };
    if (launchablePackage.test(canonical) || privatePath(relative(root, canonical))) return { ok: false, error: 'unsupported' };
    return { ok: true, path: canonical, info: await stat(canonical) };
  } catch (error) {
    return { ok: false, error: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'failed' };
  }
}

/**
 * Receives the workspace from session state, never from the renderer. No raw OS errors cross IPC. `also`: folders the
 * hub itself saves files in (the generated videos), opened from any conversation under the same rules.
 */
export async function openLocalFile(
  workspace: string | undefined, input: unknown, action: unknown, shell: LocalFileShell, also: string[] = [],
): Promise<LocalFileResult> {
  if (action !== 'open' && action !== 'reveal') return { ok: false, error: 'invalid' };
  const found = await locateLocalFile(workspace, input, also);
  if (!found.ok) return found;
  const { path: canonical, info } = found;
  if (!info.isDirectory() && (!info.isFile() || !safeTypes.has(extname(canonical).toLowerCase()))) return { ok: false, error: 'unsupported' };
  try {
    if (action === 'reveal') shell.showItemInFolder(canonical);
    else if (await shell.openPath(canonical)) return { ok: false, error: 'failed' };
    return { ok: true };
  } catch {
    return { ok: false, error: 'failed' };
  }
}
