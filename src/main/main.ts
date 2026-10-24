import './shellPath';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron';
import { APP_ID } from '../shared/brand';
import type { Lang } from '../shared/i18n';
import {
  APP_NAME,
  ATTACH_LIMITS,
  base64Bytes,
  EFFORTS,
  IMAGE_TYPES,
  type ChatItem,
  type Effort,
  type FoundRepo,
  type HubEventKind,
  type ImageInput,
  type ImageType,
  type Mode,
  type PermissionDecision,
  type SettingsPatch,
  type SettingsView,
  type TeamRole,
} from '../shared/types';
import { agentFiles } from './agents';
import { checkApiKey, claudeEnv, claudeExecutable, claudeStatus } from './claude';
import { applyPatch, isDir, loadConfig, mainRepoPath, saveConfig, type HubConfig } from './config';
import { errorCode } from './errors';
import { clientIdOf, cloneRepo, DEFAULT_CLIENT_ID, DeviceFlow, ghLogin, ghPath, githubGitEnv, githubLogin, githubRepos, githubSignIn, SLUG } from './github';
import { setLang, t, tn } from './i18n';
import { setGitSignIn } from './git';
import { RepoWatcher } from './repoStatus';
import { findRepos, remoteOf } from './repos';
import { parseAction, readBranches, readDetails, readGraph } from './scm';
import { Secrets } from './secrets';
import { SessionManager } from './sessions';

const here = dirname(fileURLToPath(import.meta.url));
const MODES: Mode[] = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
const DECISIONS = ['allow', 'always', 'deny'];
const API_KEY = /^sk-ant-[\w-]{20,300}$/;
const MODEL = /^[\w.:[\]-]{1,80}$/;
const GITHUB_TOKEN = /^(gh[pousr]_[A-Za-z0-9_]{20,255}|github_pat_[A-Za-z0-9_]{20,255})$/;

// One folder whatever the build is named (a packaged build takes its productName): settings and conversations follow.
app.setPath(
  'userData',
  app.commandLine.hasSwitch('user-data-dir') ? app.commandLine.getSwitchValue('user-data-dir') : join(app.getPath('appData'), 'claude-hub'),
);

let win: BrowserWindow | null = null;
let manager: SessionManager | undefined;
let repoWatchers: RepoWatcher[] = [];
let rendererReady = false;

const send = (channel: string, ...args: unknown[]) => {
  if (win && !win.isDestroyed() && rendererReady) win.webContents.send(channel, ...args);
};

/** The renderer gets its language and platform in the URL: it builds its whole UI from them before any IPC. */
function loadRenderer(lang: Lang): void {
  void win?.loadFile(join(here, 'renderer', 'index.html'), { query: { lang, platform: process.platform } });
}

/** The window's own colours, the page's --bg and --text-3 in the system's appearance (light or dark). */
const chrome = () => (nativeTheme.shouldUseDarkColors ? { color: '#0d0e11', symbolColor: '#8c919b', height: 36 } : { color: '#ebebef', symbolColor: '#5f5f67', height: 36 });

function createWindow(mgr: SessionManager, lang: Lang): void {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    title: APP_NAME,
    icon: join(here, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    backgroundColor: chrome().color,
    titleBarStyle: 'hidden',
    titleBarOverlay: chrome(),
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  nativeTheme.on('updated', () => {
    if (!win || win.isDestroyed()) return;
    win.setBackgroundColor(chrome().color);
    if (process.platform !== 'darwin') win.setTitleBarOverlay(chrome());
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('did-start-loading', () => {
    rendererReady = false;
  });
  win.webContents.on('context-menu', (_e, p) => {
    const items: MenuItemConstructorOptions[] = [];
    if (p.isEditable) {
      items.push(
        { role: 'cut', label: t('menu.cut'), enabled: p.editFlags.canCut },
        { role: 'copy', label: t('menu.copy'), enabled: p.editFlags.canCopy },
        { role: 'paste', label: t('menu.paste'), enabled: p.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', label: t('menu.selectAll') },
      );
    } else if (p.selectionText.trim()) {
      items.push({ role: 'copy', label: t('menu.copy') });
    }
    if (p.mediaType === 'image') items.push({ label: t('menu.copyImage'), click: () => win?.webContents.copyImageAt(p.x, p.y) });
    if (/^https?:\/\//i.test(p.linkURL)) items.push({ label: t('menu.copyLink'), click: () => clipboard.writeText(p.linkURL) });
    if (win && items.length > 0) Menu.buildFromTemplate(items).popup({ window: win });
  });
  win.on('focus', () => win?.flashFrame(false));
  win.on('close', (e) => {
    if (quitting) return; // Confirmed by before-quit.
    if (process.platform === 'darwin') {
      // The Mac way: the window goes, the app and its sessions stay (Dock icon brings it back, Cmd+Q quits).
      e.preventDefault();
      win?.hide();
      return;
    }
    if (!confirmQuit(mgr)) return e.preventDefault();
    quitting = true;
  });
  loadRenderer(lang);
}

const isStr = (v: unknown): v is string => typeof v === 'string';

/** Quitting cuts the sessions at work: asked once, whichever way the quit started (window, Cmd+Q, relaunch). */
let quitting = false;
function confirmQuit(mgr: SessionManager | undefined): boolean {
  const busy = mgr?.busySessions() ?? 0;
  if (busy === 0 || !win) return true;
  if (!win.isVisible()) win.show();
  const choice = dialog.showMessageBoxSync(win, {
    type: 'question',
    buttons: [t('close.quit'), t('close.cancel')],
    defaultId: 1,
    cancelId: 1,
    message: tn('close.busy', busy),
    detail: t('close.detail'),
  });
  return choice === 0;
}

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

/** The hub's own window, showing its own page: nothing else may drive sessions, settings or secrets. */
const PAGE = join(here, 'renderer', 'index.html');
/** Compared as file paths: URL encoding (spaces in an install folder) and drive-letter case may differ. */
function isPage(url: string | undefined): boolean {
  if (!url?.startsWith('file:')) return false;
  try {
    const path = fileURLToPath(url.split(/[?#]/)[0]);
    return process.platform === 'win32' ? path.toLowerCase() === PAGE.toLowerCase() : path === PAGE;
  } catch {
    return false;
  }
}
const trusted = (e: IpcMainEvent | IpcMainInvokeEvent) => !!win && e.sender === win.webContents && isPage(e.senderFrame?.url);
const on = (channel: string, fn: (...args: unknown[]) => void) =>
  ipcMain.on(channel, (e, ...args: unknown[]) => {
    if (trusted(e)) fn(...args);
  });
const handle = <T>(channel: string, fn: (...args: unknown[]) => T | Promise<T>) =>
  ipcMain.handle(channel, (e, ...args: unknown[]) => {
    if (!trusted(e)) throw new Error('untrusted sender');
    return fn(...args);
  });

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

class Hub {
  readonly dataDir = app.getPath('userData');
  readonly cfg: HubConfig;
  readonly secrets = new Secrets(this.dataDir);
  readonly mgr: SessionManager;
  private readonly device = new DeviceFlow();
  private executable = '';
  private gh = '';
  private masterStarted = false;

  constructor() {
    const system = app.getPreferredSystemLanguages()[0] ?? app.getLocale();
    this.cfg = loadConfig(this.dataDir, system.toLowerCase().startsWith('fr') ? 'fr' : 'en');
    setLang(this.cfg.language);
    this.mgr = new SessionManager({
      cfg: this.cfg,
      dataDir: this.dataDir,
      executable: () => this.executable,
      sessionEnv: () => this.sessionEnv(),
      persist: () => this.save(),
    });
  }

  async init(): Promise<void> {
    setGitSignIn(() => githubSignIn(this.cfg, this.secrets.get('githubToken'), this.gh));
    [this.executable, this.gh] = await Promise.all([
      claudeExecutable(this.cfg),
      this.cfg.github.source === 'gh' ? ghPath() : '',
      this.secrets.load(),
    ]);
  }

  /** Claude access chosen in the settings, plus the GitHub sign-in when the user shares it with the sessions. */
  sessionEnv(): { set: Record<string, string>; unset: string[] } {
    const claude = claudeEnv(this.cfg, this.secrets.get('anthropicApiKey'));
    const github = this.cfg.github.shareWithSessions ? githubGitEnv(this.cfg, this.secrets.get('githubToken'), this.gh) : {};
    return { set: { ...claude.set, ...github }, unset: claude.unset };
  }

  view(): SettingsView {
    return {
      settings: structuredClone(this.cfg),
      apiKeySet: this.secrets.has('anthropicApiKey'),
      githubTokenSet: this.secrets.has('githubToken'),
      secureStorage: this.secrets.available(),
      defaultClientId: DEFAULT_CLIENT_ID !== '',
      platform: process.platform,
      version: app.getVersion(),
    };
  }

  save(): void {
    saveConfig(this.dataDir, this.cfg);
  }

  startMaster(): void {
    if (this.masterStarted || !this.cfg.onboarded) return;
    this.masterStarted = true;
    this.mgr.startMaster();
  }

  /** Watchers of the followed repos: a repo still followed keeps its own (no new fetch, its checkouts stay known). */
  setWatchers(): void {
    const paths = this.cfg.mainRepos.map((r) => mainRepoPath(this.cfg, r));
    for (const repo of repoWatchers) if (!paths.includes(repo.path)) repo.stop();
    const added: RepoWatcher[] = [];
    repoWatchers = paths.map((path) => {
      const kept = repoWatchers.find((r) => r.path === path);
      if (kept) return kept;
      const repo = new RepoWatcher(path);
      added.push(repo);
      return repo;
    });
    send('hub:repos', paths);
    for (const repo of added) {
      repo.on('changed', (status) => send('hub:repo', status));
      repo.start();
    }
  }

  registerIpc(): void {
    const mgr = this.mgr;
    // Only a checkout (main folder or worktree) listed by one of the configured repos: no other folder ever reaches git.
    const checkout = (path: unknown) => {
      const repo = repoWatchers.find((r) => r.tree(path));
      if (!repo || !isStr(path)) throw new Error(t('repo.unknownFolder'));
      return { repo, path };
    };
    on('hub:ready', () => {
      const sender = win?.webContents;
      if (!sender) return;
      sender.send('hub:snapshot', mgr.snapshot());
      for (const [id, items] of mgr.allItems()) sender.send('hub:items', id, items, true);
      sender.send('hub:repos', repoWatchers.map((r) => r.path));
      for (const repo of repoWatchers) sender.send('hub:repo', repo.status);
      rendererReady = true;
    });
    on('session:send', (id, text, images) => {
      if (!isStr(id) || !isStr(text)) return;
      const parsed = parseImages(images);
      if (parsed) mgr.send(id, text, parsed);
      else mgr.refuse(id, text, t('images.invalid'));
    });
    on('session:interrupt', (id) => isStr(id) && mgr.interrupt(id));
    on('session:model', (id, model) => isStr(id) && isStr(model) && MODEL.test(model) && mgr.setModel(id, model));
    on('session:effort', (id, effort) => isStr(id) && EFFORTS.includes(effort as Effort) && mgr.setEffort(id, effort as Effort));
    on('session:mode', (id, mode) => isStr(id) && MODES.includes(mode as Mode) && mgr.setMode(id, mode as Mode));
    on('session:decide', (id, requestId, decision) => {
      const d = decision as PermissionDecision | null;
      if (isStr(id) && isStr(requestId) && d && DECISIONS.includes(d.behavior) && (d.message === undefined || isStr(d.message))) {
        mgr.decide(id, requestId, { behavior: d.behavior, message: d.message });
      }
    });
    on('session:stop', (id) => isStr(id) && mgr.stop(id));
    on('session:resume', (id) => isStr(id) && mgr.resume(id));
    on('session:remove', (id) => isStr(id) && mgr.remove(id));
    on('session:open', (id) => isStr(id) && mgr.open(id));
    handle('repo:graph', (path, filter, limit) => {
      const c = checkout(path);
      if ((filter !== 'auto' && filter !== 'all') || typeof limit !== 'number' || !Number.isFinite(limit)) throw new Error(t('repo.badRequest'));
      return readGraph(c.path, filter, limit);
    });
    handle('repo:details', (path, id) => {
      const c = checkout(path);
      if (!isStr(id)) throw new Error(t('repo.badRequest'));
      return readDetails(c.path, id);
    });
    handle('repo:branches', (path) => readBranches(checkout(path).path));
    handle('repo:action', (path, action) => {
      const c = checkout(path);
      const parsed = parseAction(action);
      if (!parsed) throw new Error(t('repo.badAction'));
      return c.repo.act(c.path, parsed);
    });
    on('open-external', (url) => {
      if (isStr(url) && /^https?:\/\//i.test(url)) void shell.openExternal(url);
    });

    handle('settings:get', () => this.view());
    handle('settings:save', (patch) => {
      const before = { lang: this.cfg.language, repos: this.cfg.mainRepos.join('\n'), master: JSON.stringify([this.cfg.master, this.cfg.workspaces[0]]) };
      const bad = applyPatch(this.cfg, (patch ?? {}) as SettingsPatch);
      if (bad) return { ...this.view(), ok: false, error: bad };
      this.save();
      setLang(this.cfg.language);
      mgr.forgetRepos();
      if (before.repos !== this.cfg.mainRepos.join('\n')) this.setWatchers();
      if (this.masterStarted && before.master !== JSON.stringify([this.cfg.master, this.cfg.workspaces[0]])) mgr.updateMaster();
      // The page is built in one language: it is reloaded in the new one.
      if (before.lang !== this.cfg.language) setImmediate(() => loadRenderer(this.cfg.language));
      return { ...this.view(), ok: true, error: '' };
    });
    handle('settings:api-key', async (key) => {
      if (key === null) {
        await this.secrets.set('anthropicApiKey', null);
        if (this.cfg.provider === 'api-key') this.cfg.provider = 'claude-code';
        this.save();
        return { ...this.view(), ok: true, error: '' };
      }
      if (!isStr(key) || !API_KEY.test(key.trim())) return { ...this.view(), ok: false, error: 'format' };
      if (!this.secrets.available()) return { ...this.view(), ok: false, error: 'no-keychain' };
      const refused = await checkApiKey(key.trim());
      if (refused) return { ...this.view(), ok: false, error: refused };
      await this.secrets.set('anthropicApiKey', key.trim());
      this.cfg.provider = 'api-key';
      this.save();
      return { ...this.view(), ok: true, error: '' };
    });
    // The team, one post at a time, with the checks of the master's tools (sessions.ts); the master hears of it next.
    handle('team:save', (role) => {
      const r = mgr.saveRole(role, 'user');
      if (!('error' in r)) return { ...this.view(), ok: true, error: '', field: '' };
      return r.error === 'working'
        ? { ...this.view(), ok: false, error: 'working', field: '' }
        : { ...this.view(), ok: false, error: r.error.problem, field: r.error.field };
    });
    handle('team:delete', (id) => {
      const ok = isStr(id) && mgr.deleteRole(id);
      return { ...this.view(), ok, error: ok ? '' : 'working' };
    });
    handle('team:move', (id, delta) => {
      if (isStr(id) && (delta === -1 || delta === 1)) mgr.moveRole(id, delta);
      return this.view();
    });
    handle('team:agents', () => agentFiles(this.cfg));
    handle('claude:check', async () => {
      const { executable, status } = await claudeStatus(this.cfg, mgr.environment());
      this.executable = executable;
      return status;
    });
    handle('github:gh-login', () => ghLogin());
    // Whether the saved sign-in still works: a token may have expired or been revoked, gh may be signed out.
    handle('github:check', async () => {
      const { source, login } = this.cfg.github;
      try {
        if (source === 'gh') return (await ghLogin()) === login ? { ok: true, error: '' } : { ok: false, error: 'gh-signed-out' };
        if (source === 'oauth' || source === 'token') await githubLogin(this.secrets.get('githubToken'));
        return { ok: true, error: '' };
      } catch (err) {
        return { ok: false, error: errorCode(err) };
      }
    });
    handle('github:device-start', async () => {
      const clientId = clientIdOf(this.cfg);
      const none = { userCode: '', verificationUri: '', expiresIn: 0 };
      if (!clientId) return { ...none, ok: false, error: 'no-client-id' };
      try {
        return { ...(await this.device.start(clientId)), ok: true, error: '' };
      } catch (err) {
        return { ...none, ok: false, error: errorCode(err) };
      }
    });
    handle('github:device-wait', async () => {
      try {
        const token = await this.device.wait();
        return await this.useGithubToken('oauth', token);
      } catch (err) {
        return { ...this.view(), ok: false, error: errorCode(err) };
      }
    });
    on('github:cancel', () => this.device.cancel());
    handle('github:use-token', async (token) => {
      if (!isStr(token) || !GITHUB_TOKEN.test(token.trim())) return { ...this.view(), ok: false, error: 'format' };
      try {
        return await this.useGithubToken('token', token.trim());
      } catch (err) {
        return { ...this.view(), ok: false, error: errorCode(err) };
      }
    });
    handle('github:use-gh', async () => {
      const [gh, login] = await Promise.all([ghPath(), ghLogin()]);
      if (!gh || !login) return { ...this.view(), ok: false, error: 'gh-signed-out' };
      this.gh = gh;
      if (this.secrets.has('githubToken')) await this.secrets.set('githubToken', null);
      Object.assign(this.cfg.github, { source: 'gh', login });
      this.save();
      return { ...this.view(), ok: true, error: '' };
    });
    handle('github:disconnect', async () => {
      if (this.secrets.has('githubToken')) await this.secrets.set('githubToken', null);
      Object.assign(this.cfg.github, { source: 'none', login: '' });
      this.save();
      return this.view();
    });
    handle('dialog:folder', async () => {
      if (!win) return null;
      const r = await dialog.showOpenDialog(win, { title: t('dialog.pickFolder'), properties: ['openDirectory'] });
      return r.canceled ? null : (r.filePaths[0] ?? null);
    });
    handle('repos:scan', (roots): FoundRepo[] => {
      const dirs = Array.isArray(roots) ? roots.filter((r): r is string => isStr(r) && isAbsolute(r) && isDir(r)).slice(0, 20) : [];
      const seen = new Set<string>();
      return dirs
        .flatMap(findRepos)
        .filter((r) => !r.worktreeOf && !seen.has(r.path) && seen.add(r.path))
        .slice(0, 300)
        .map((r) => ({ name: r.name, path: r.path, remote: r.remote }));
    });
    handle('github:repos', async () => {
      try {
        const gh = this.cfg.github.source === 'gh' ? this.gh || (this.gh = await ghPath()) : '';
        return { ok: true, error: '', repos: await githubRepos(this.cfg.github.source, this.secrets.get('githubToken'), gh) };
      } catch (err) {
        return { ok: false, error: errorCode(err), repos: [] };
      }
    });
    handle('repos:clone', async (slug, root) => {
      if (!isStr(slug) || !SLUG.test(slug) || !isStr(root) || !this.cfg.workspaces.includes(root)) return { ...this.view(), ok: false, error: 'format' };
      const dest = join(root, slug.split('/')[1]);
      // Already cloned there: it is only added. Any other folder of that name is left alone.
      if (existsSync(dest) && remoteOf(dest).toLowerCase() !== `github.com/${slug}`.toLowerCase()) {
        return { ...this.view(), ok: false, error: existsSync(join(dest, '.git')) ? 'exists-other' : 'exists' };
      }
      if (!existsSync(dest)) {
        try {
          await cloneRepo(slug, root, dest);
        } catch (err) {
          return { ...this.view(), ok: false, error: errorCode(err) };
        }
      }
      if (!this.cfg.mainRepos.includes(dest)) {
        const bad = applyPatch(this.cfg, { mainRepos: [...this.cfg.mainRepos, dest] });
        if (bad) return { ...this.view(), ok: false, error: bad };
        this.save();
        mgr.forgetRepos();
        this.setWatchers();
      }
      return { ...this.view(), ok: true, error: '' };
    });
    handle('setup:finish', () => {
      this.cfg.onboarded = true;
      this.save();
      this.startMaster();
    });
    on('app:relaunch', () => {
      // Asked before the relaunch is scheduled: a cancelled quit must not relaunch later.
      if (!confirmQuit(mgr)) return;
      quitting = true;
      app.relaunch();
      app.quit();
    });
  }

  /** Keeps a GitHub token only once GitHub accepted it, and only encrypted. */
  private async useGithubToken(source: 'oauth' | 'token', token: string) {
    const login = await githubLogin(token);
    if (!this.secrets.available()) return { ...this.view(), ok: false, error: 'no-keychain' };
    await this.secrets.set('githubToken', token);
    Object.assign(this.cfg.github, { source, login });
    this.save();
    return { ...this.view(), ok: true, error: '' };
  }
}

async function start(): Promise<void> {
  const hub = new Hub();
  await hub.init();
  const mgr = hub.mgr;
  manager = mgr;
  mgr.on('changed', () => send('hub:snapshot', mgr.snapshot()));
  mgr.on('items', (id: string, items: ChatItem[], reset: boolean) => send('hub:items', id, items, reset));
  mgr.on('event', (id: string, kind: HubEventKind) => send('hub:event', id, kind));
  mgr.on('team', (team: TeamRole[]) => send('hub:team', team));
  mgr.on('attention', () => {
    if (win && !win.isFocused()) win.flashFrame(true);
  });
  hub.registerIpc();
  createWindow(mgr, hub.cfg.language);
  // A first run waits for the setup: the master needs Claude access before it starts.
  hub.startMaster();
  hub.setWatchers();
}

// Groups the taskbar button under the app's own identity and icon instead of Electron's.
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('activate', () => win?.show());
  app.on('before-quit', (e) => {
    if (quitting) return;
    if (!confirmQuit(manager)) return e.preventDefault();
    quitting = true;
  });
  app.on('will-quit', () => {
    for (const repo of repoWatchers) repo.stop();
    manager?.killAll();
  });
  app
    .whenReady()
    .then(start)
    .catch((err: unknown) => {
      dialog.showMessageBoxSync({ type: 'error', title: APP_NAME, message: t('startup.failed', { app: APP_NAME }), detail: errorText(err) });
      app.quit();
    });
}
