import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron';
import {
  ATTACH_LIMITS,
  base64Bytes,
  IMAGE_TYPES,
  type ChatItem,
  type Effort,
  type HubEventKind,
  type ImageInput,
  type ImageType,
  type Mode,
  type PermissionDecision,
} from '../shared/types';
import { loadConfig, mainRepoPath } from './config';
import { RepoWatcher } from './repoStatus';
import { parseAction, readBranches, readDetails, readGraph } from './scm';
import { SessionManager } from './sessions';

const here = dirname(fileURLToPath(import.meta.url));
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODES: Mode[] = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
const DECISIONS = ['allow', 'always', 'deny'];

let win: BrowserWindow | null = null;
let manager: SessionManager | undefined;
let repoWatchers: RepoWatcher[] = [];
let rendererReady = false;

const send = (channel: string, ...args: unknown[]) => {
  if (win && !win.isDestroyed() && rendererReady) win.webContents.send(channel, ...args);
};

function createWindow(mgr: SessionManager): void {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    title: 'Claude Hub',
    icon: join(here, '..', 'assets', 'icon.ico'),
    backgroundColor: '#0c0d0f',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0c0d0f', symbolColor: '#8b9099', height: 36 },
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('did-start-loading', () => {
    rendererReady = false;
  });
  win.webContents.on('context-menu', (_e, p) => {
    const items: MenuItemConstructorOptions[] = [];
    if (p.isEditable) {
      items.push(
        { role: 'cut', label: 'Couper', enabled: p.editFlags.canCut },
        { role: 'copy', label: 'Copier', enabled: p.editFlags.canCopy },
        { role: 'paste', label: 'Coller', enabled: p.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', label: 'Tout sélectionner' },
      );
    } else if (p.selectionText.trim()) {
      items.push({ role: 'copy', label: 'Copier' });
    }
    if (p.mediaType === 'image') items.push({ label: "Copier l'image", click: () => win?.webContents.copyImageAt(p.x, p.y) });
    if (/^https?:\/\//i.test(p.linkURL)) items.push({ label: 'Copier le lien', click: () => clipboard.writeText(p.linkURL) });
    if (win && items.length > 0) Menu.buildFromTemplate(items).popup({ window: win });
  });
  win.on('focus', () => win?.flashFrame(false));
  win.on('close', (e) => {
    const busy = mgr.busySessions();
    if (busy === 0 || !win) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Fermer', 'Annuler'],
      defaultId: 1,
      cancelId: 1,
      message: `${busy} session${busy > 1 ? 's' : ''} au travail`,
      detail: 'Leur tour en cours et leurs tâches de fond seront interrompus. Les conversations reprennent au prochain lancement.',
    });
    if (choice !== 0) e.preventDefault();
  });
  void win.loadFile(join(here, 'renderer', 'index.html'));
}

const isStr = (v: unknown): v is string => typeof v === 'string';

/** Images from the renderer, or null when any is malformed, of an unsupported type or over the per-message limits. */
function parseImages(value: unknown): ImageInput[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > ATTACH_LIMITS.count) return null;
  const images: ImageInput[] = [];
  let total = 0;
  for (const v of value) {
    const { mediaType, data } = (v ?? {}) as Record<string, unknown>;
    if (!IMAGE_TYPES.includes(mediaType as ImageType) || !isStr(data)) return null;
    total += base64Bytes(data);
    if (base64Bytes(data) > ATTACH_LIMITS.imageBytes || total > ATTACH_LIMITS.totalBytes) return null;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
    images.push({ mediaType: mediaType as ImageType, data });
  }
  return images;
}

function registerIpc(mgr: SessionManager, repos: RepoWatcher[]): void {
  ipcMain.on('hub:ready', (e) => {
    e.sender.send('hub:snapshot', mgr.snapshot());
    for (const [id, items] of mgr.allItems()) e.sender.send('hub:items', id, items, true);
    for (const repo of repos) e.sender.send('hub:repo', repo.status);
    rendererReady = true;
  });
  ipcMain.on('session:send', (_e, id: unknown, text: unknown, images: unknown) => {
    if (!isStr(id) || !isStr(text)) return;
    const parsed = parseImages(images);
    if (parsed) mgr.send(id, text, parsed);
    else mgr.refuse(id, text, 'images invalides ou trop lourdes');
  });
  ipcMain.on('session:interrupt', (_e, id: unknown) => {
    if (isStr(id)) mgr.interrupt(id);
  });
  ipcMain.on('session:model', (_e, id: unknown, model: unknown) => {
    if (isStr(id) && isStr(model)) mgr.setModel(id, model);
  });
  ipcMain.on('session:effort', (_e, id: unknown, effort: unknown) => {
    if (isStr(id) && EFFORTS.includes(effort as Effort)) mgr.setEffort(id, effort as Effort);
  });
  ipcMain.on('session:mode', (_e, id: unknown, mode: unknown) => {
    if (isStr(id) && MODES.includes(mode as Mode)) mgr.setMode(id, mode as Mode);
  });
  ipcMain.on('session:decide', (_e, id: unknown, requestId: unknown, decision: unknown) => {
    const d = decision as PermissionDecision | null;
    if (isStr(id) && isStr(requestId) && d && DECISIONS.includes(d.behavior) && (d.message === undefined || isStr(d.message))) {
      mgr.decide(id, requestId, { behavior: d.behavior, message: d.message });
    }
  });
  ipcMain.on('session:stop', (_e, id: unknown) => {
    if (isStr(id)) mgr.stop(id);
  });
  ipcMain.on('session:resume', (_e, id: unknown) => {
    if (isStr(id)) mgr.resume(id);
  });
  ipcMain.on('session:remove', (_e, id: unknown) => {
    if (isStr(id)) mgr.remove(id);
  });
  ipcMain.on('session:open', (_e, id: unknown) => {
    if (isStr(id)) mgr.open(id);
  });
  // Only a checkout (main folder or worktree) listed by one of the configured repos: no other folder ever reaches git.
  const checkout = (path: unknown) => {
    const repo = repos.find((r) => r.tree(path));
    if (!repo || !isStr(path)) throw new Error('Dossier inconnu du Hub');
    return { repo, path };
  };
  ipcMain.handle('repo:graph', (_e, path: unknown, filter: unknown, limit: unknown) => {
    const c = checkout(path);
    if ((filter !== 'auto' && filter !== 'all') || typeof limit !== 'number' || !Number.isFinite(limit)) throw new Error('Requête invalide');
    return readGraph(c.path, filter, limit);
  });
  ipcMain.handle('repo:details', (_e, path: unknown, id: unknown) => {
    const c = checkout(path);
    if (!isStr(id)) throw new Error('Requête invalide');
    return readDetails(c.path, id);
  });
  ipcMain.handle('repo:branches', (_e, path: unknown) => readBranches(checkout(path).path));
  ipcMain.handle('repo:action', (_e, path: unknown, action: unknown) => {
    const c = checkout(path);
    const parsed = parseAction(action);
    if (!parsed) throw new Error('Action invalide');
    return c.repo.act(c.path, parsed);
  });
  ipcMain.on('open-external', (_e, url: unknown) => {
    if (isStr(url) && /^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
}

function start(): void {
  const cfg = loadConfig(app.getPath('userData'));
  const mgr = new SessionManager({ cfg, dataDir: app.getPath('userData') });
  manager = mgr;
  mgr.on('changed', () => send('hub:snapshot', mgr.snapshot()));
  mgr.on('items', (id: string, items: ChatItem[], reset: boolean) => send('hub:items', id, items, reset));
  mgr.on('event', (id: string, kind: HubEventKind) => send('hub:event', id, kind));
  mgr.on('attention', () => {
    if (win && !win.isFocused()) win.flashFrame(true);
  });
  repoWatchers = cfg.mainRepos.map((r) => new RepoWatcher(mainRepoPath(cfg, r)));
  for (const repo of repoWatchers) repo.on('changed', (status) => send('hub:repo', status));

  registerIpc(mgr, repoWatchers);
  createWindow(mgr);
  mgr.startMaster();
  for (const repo of repoWatchers) repo.start();
}

// Groups the taskbar button under the app's own identity and icon instead of Electron's.
app.setAppUserModelId('ClaudeHub');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    for (const repo of repoWatchers) repo.stop();
    manager?.killAll();
  });
  app
    .whenReady()
    .then(start)
    .catch((err: unknown) => {
      dialog.showErrorBox('Claude Hub', err instanceof Error ? err.message : String(err));
      app.quit();
    });
}
