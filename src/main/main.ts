import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type { ChatItem, Effort, Mode, PermissionDecision } from '../shared/types';
import { loadConfig } from './config';
import { RepoWatcher } from './repoStatus';
import { SessionManager } from './sessions';

const here = dirname(fileURLToPath(import.meta.url));
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODES: Mode[] = ['default', 'acceptEdits', 'plan', 'auto'];
const DECISIONS = ['allow', 'always', 'deny'];

let win: BrowserWindow | null = null;
let manager: SessionManager | undefined;
let repoWatcher: RepoWatcher | undefined;
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
  win.on('focus', () => win?.flashFrame(false));
  win.on('close', (e) => {
    const busy = mgr.busyWorkers();
    if (busy === 0 || !win) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Fermer', 'Annuler'],
      defaultId: 1,
      cancelId: 1,
      message: `${busy} worker${busy > 1 ? 's' : ''} en cours`,
      detail: 'Ils seront interrompus. Leurs conversations restent reprenables au prochain lancement.',
    });
    if (choice !== 0) e.preventDefault();
  });
  void win.loadFile(join(here, 'renderer', 'index.html'));
}

const isStr = (v: unknown): v is string => typeof v === 'string';

function registerIpc(mgr: SessionManager, repo: RepoWatcher): void {
  ipcMain.on('hub:ready', (e) => {
    e.sender.send('hub:snapshot', mgr.snapshot());
    for (const [id, items] of mgr.allItems()) e.sender.send('hub:items', id, items, true);
    e.sender.send('hub:repo', repo.status);
    rendererReady = true;
  });
  ipcMain.on('session:send', (_e, id: unknown, text: unknown) => {
    if (isStr(id) && isStr(text)) mgr.send(id, text);
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
  ipcMain.on('repo:refresh', () => void repo.fetch());
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
  mgr.on('attention', () => {
    if (win && !win.isFocused()) win.flashFrame(true);
  });
  const repo = new RepoWatcher(cfg.pinnedRepo);
  repoWatcher = repo;
  repo.on('changed', (status) => send('hub:repo', status));

  registerIpc(mgr, repo);
  createWindow(mgr);
  mgr.startMaster();
  repo.start();
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
    repoWatcher?.stop();
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
