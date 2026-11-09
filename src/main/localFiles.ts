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
/** Receives the workspace from session state, never from the renderer. No raw OS errors cross IPC. */
export async function openLocalFile(
  workspace: string | undefined, input: unknown, action: unknown, shell: LocalFileShell,
): Promise<LocalFileResult> {
  if (!workspace || typeof input !== 'string' || (action !== 'open' && action !== 'reveal')) return { ok: false, error: 'invalid' };
  const path = localFilePath(input);
  if (!path || /[%#?]/.test(path) || (process.platform !== 'win32' && /[\\:]/.test(path))) return { ok: false, error: 'invalid' };
  if (process.platform === 'win32') {
    const tail = /^[a-z]:[\\/]/i.test(path) ? path.slice(2) : path;
    // Alternate data streams, device names and Win32 name trimming must not change the checked target.
    if (/[<>:"|*]/.test(tail) || tail.split(/[\\/]/).some((part) => /[. ]$/.test(part) && part !== '.' && part !== '..' || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return { ok: false, error: 'invalid' };
  }
  const lexicalRoot = resolve(workspace);
  const target = resolve(lexicalRoot, path);
  if (!inside(lexicalRoot, target)) return { ok: false, error: 'outside' };
  if (privatePath(relative(lexicalRoot, target))) return { ok: false, error: 'unsupported' };
  try {
    const root = await realpath(lexicalRoot);
    const canonical = await realpath(target);
    if (!inside(root, canonical)) return { ok: false, error: 'outside' };
    if (launchablePackage.test(canonical) || privatePath(relative(root, canonical))) return { ok: false, error: 'unsupported' };
    const info = await stat(canonical);
    if (!info.isDirectory() && (!info.isFile() || !safeTypes.has(extname(canonical).toLowerCase()))) return { ok: false, error: 'unsupported' };
    if (action === 'reveal') shell.showItemInFolder(canonical);
    else if (await shell.openPath(canonical)) return { ok: false, error: 'failed' };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'failed' };
  }
}
