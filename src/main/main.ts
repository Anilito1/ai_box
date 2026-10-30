import './shellPath';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron';
import { ACCOUNTS_MAX, canonAccount, checkAccount, CUSTOM_SLUG, customSlug, isAccountRef, isLocalUrl, isServerUrl, normalizeAccount, OPENAI_URL, OWN_ACCOUNT } from '../shared/accounts';
import { backgroundTokens } from '../shared/background';
import { APP_ID } from '../shared/brand';
import { capabilitiesText } from '../shared/capabilities';
import { DEEPSEEK_URL, isCustomAccount, isProviderId, MANAGED_NAMES, pickOpenAIModel, chatModels, providerDef, providerOfAccount, type ProviderId, type ProviderMethod, type ProviderState } from '../shared/providers';
import type { Lang } from '../shared/i18n';
import { brewPackage, type CliUpdate } from '../shared/news';
import {
  APP_NAME,
  ATTACH_LIMITS,
  base64Bytes,
  EFFORTS,
  IMAGE_TYPES,
  type Account,
  type AccountStatus,
  type CustomProviderAction,
  type CustomProviderResult,
  type ChatItem,
  type CodexCli,
  type MethodView,
  type ProviderAccountView,
  type ProviderView,
  type Effort,
  type FoundRepo,
  type HubEventKind,
  type SessionPulse,
  type ImageInput,
  type ImageType,
  type Mode,
  type PermissionDecision,
  type SettingsPatch,
  type SettingsView,
  type TeamRole,
} from '../shared/types';
import { isTopicId } from '../shared/topics';
import { UPDATE_CHOICES, type UpdateChoice } from '../shared/update';
import { accountDir, accountEnv, checkAnthropicCompatible, checkCustom, checkOpenAI, claudeLogout, isOpenAIKey, prepareClaudeDir, prepareCodexDir, prepareGeminiDir, removeClaudeDir, removeCodexDir, removeGeminiDir, testChat } from './accounts';
import { agentFiles } from './agents';
import { CapabilityStore } from './capabilities';
import { Dictation } from './dictation';
import { Bridge, type BridgeAccount } from './bridge';
import { McpHub } from './mcpHub';
import { checkGeminiKey, GEMINI_MIN_VERSION, geminiCatalog, geminiExecutable, geminiVersion, googleSignIn, startGoogleLogin } from './providers/gemini/cli';
import { checkCodex, CODEX_MIN_VERSION, codexExecutable, codexLogout, codexVersion, versionAtLeast } from './providers/codex/cli';
import { checkApiKey, claudeEnv, claudeExecutable, claudeStatus, claudeVersion } from './providers/claude/cli';
import { applyPatch, isDir, knownAccounts, loadConfig, mainRepoPath, saveConfig, type HubConfig } from './config';
import { CostLog } from './costLog';
import { errorCode } from './errors';
import { clientIdOf, cloneRepo, DEFAULT_CLIENT_ID, DeviceFlow, ghLogin, ghPath, githubGitEnv, githubLogin, githubRepos, githubSignIn, SLUG } from './github';
import { setLang, t, tn } from './i18n';
import { setGitSignIn } from './git';
import { RepoWatcher } from './repoStatus';
import { findRepos, remoteOf } from './repos';
import { parseAction, readBranches, readDetails, readGraph } from './scm';
import { Secrets } from './secrets';
import { SessionManager } from './sessions';
import { openTerminal } from './terminal';
import { installTool, setToolsDir, type Tool } from './providers/tools';
import { ProviderNewsWatch, resolved } from './news';
import { CliUpdater, realRunner, simulatedRunner } from './cliUpdate';
import { ReleaseNotes } from './releaseNotes';
import { buildIfStale } from './selfBuild';
import { installRunning, Updater } from './updater';

const here = dirname(fileURLToPath(import.meta.url));
const MODES: Mode[] = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
const DECISIONS = ['allow', 'always', 'deny'];
const API_KEY = /^sk-ant-[\w-]{20,300}$/;
const MODEL = /^[\w.:[\]-]{1,80}$/;
/** list_capabilities asks Claude Code again for the servers' state once the last check is this old. */
const CAPS_MAX_AGE = 10 * 60_000;
const GITHUB_TOKEN = /^(gh[pousr]_[A-Za-z0-9_]{20,255}|github_pat_[A-Za-z0-9_]{20,255})$/;

// One folder whatever the build is named (a packaged build takes its productName): settings and conversations follow.
app.setPath(
  'userData',
  app.commandLine.hasSwitch('user-data-dir') ? app.commandLine.getSwitchValue('user-data-dir') : join(app.getPath('appData'), 'claude-hub'),
);

let win: BrowserWindow | null = null;
let manager: SessionManager | undefined;
let updater: Updater | undefined;
let bridge: Bridge | undefined;
let mcpHubRef: McpHub | undefined;
let dictation: Dictation | undefined;
/** A restart from the settings: an update left for the close waits, the new hub starts right away. */
let relaunching = false;
let repoWatchers: RepoWatcher[] = [];
let rendererReady = false;

const send = (channel: string, ...args: unknown[]) => {
  if (win && !win.isDestroyed() && rendererReady) win.webContents.send(channel, ...args);
};

/** The background colour of the settings ("#rrggbb"), empty for the system's appearance. */
let background = '';

/** The renderer gets its language, platform and background in the URL: it builds its whole UI from them before any IPC. */
function loadRenderer(lang: Lang): void {
  void win?.loadFile(join(here, 'renderer', 'index.html'), { query: { lang, platform: process.platform, bg: background } });
}

/** The window's own colours, the page's --bg and --text-3: the user's background, else the system's appearance. */
const chrome = () => {
  if (background) {
    const { vars } = backgroundTokens(background);
    return { color: vars['--bg'], symbolColor: vars['--text-3'], height: 40 };
  }
  return nativeTheme.shouldUseDarkColors ? { color: '#0d0e11', symbolColor: '#8c919b', height: 40 } : { color: '#ebebef', symbolColor: '#5f5f67', height: 40 };
};
/** The window controls sit over a pane's header: they take its colour (--chat). */
const controls = () => ({ ...chrome(), color: background ? backgroundTokens(background).vars['--chat'] : nativeTheme.shouldUseDarkColors ? '#0f1013' : '#ffffff' });

function paintWindow(): void {
  if (!win || win.isDestroyed()) return;
  win.setBackgroundColor(chrome().color);
  if (process.platform !== 'darwin') win.setTitleBarOverlay(controls());
}

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
    titleBarOverlay: controls(),
    // macOS: its window buttons, centred in the 40 px row of the panes' headers.
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 14, y: 13 } } : {}),
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  nativeTheme.on('updated', paintWindow);
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
      // Hidden in full screen, it would leave an empty black Space behind: out of full screen first.
      if (win?.isFullScreen()) {
        win.once('leave-full-screen', () => win?.hide());
        win.setFullScreen(false);
      } else win?.hide();
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
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
const systemLang = (): Lang => ((app.getPreferredSystemLanguages()[0] ?? app.getLocale()).toLowerCase().startsWith('fr') ? 'fr' : 'en');

class Hub {
  readonly dataDir = app.getPath('userData');
  readonly cfg: HubConfig;
  readonly secrets = new Secrets(this.dataDir);
  readonly costLog = new CostLog(this.dataDir);
  readonly mgr: SessionManager;
  readonly caps: CapabilityStore;
  readonly updater: Updater;
  /** Where the sessions of OpenAI accounts send Claude Code's requests. */
  readonly bridge = new Bridge((id) => this.bridgeAccount(id));
  /** The hub's tools for sessions of programs that reach them over HTTP (Codex). */
  readonly mcpHub = new McpHub();
  private readonly device = new DeviceFlow();
  readonly dictation = new Dictation(
    () => this.cfg.dictation,
    (event) => send('dictation:event', event),
  );
  private executable = '';
  private codex = '';
  private gemini = '';
  private readonly news: ProviderNewsWatch;
  private readonly cliUpdates: CliUpdater;
  private readonly releaseNotes: ReleaseNotes;
  /** The Google sign-ins in progress (a browser is open), by account: the way to cancel each. */
  private readonly googleLogins = new Map<string, () => void>();
  private gh = '';
  private masterStarted = false;

  constructor() {
    this.cfg = loadConfig(this.dataDir, systemLang());
    setToolsDir(join(this.dataDir, 'tools'));
    setLang(this.cfg.language);
    this.releaseNotes = new ReleaseNotes(this.dataDir, !this.cfg.onboarded);
    this.news = new ProviderNewsWatch({
      dataDir: this.dataDir,
      toolsDir: join(this.dataDir, 'tools'),
      publish: (news) => this.mgr.setProviderNews(news),
      notify: (toast) => send('hub:news', toast),
    });
    // A dry run for development: the steps are printed, nothing is installed.
    const simulate = process.env.AIBOX_CLI_UPDATE_SIMULATE ?? '';
    this.cliUpdates = new CliUpdater({
      runner: simulate ? simulatedRunner(simulate) : realRunner(() => this.mgr.toolEnv()),
      env: () => this.mgr.toolEnv(),
      home: homedir(),
      tmp: tmpdir(),
      platform: process.platform,
      toolsDir: join(this.dataDir, 'tools'),
      update: (provider) => this.news.update(provider),
      refresh: async () => {
        if (!simulate) await this.providerViews();
      },
      program: (provider) => {
        const p = this.news.program(provider);
        if (simulate) return { path: p?.path ?? '', version: this.news.update(provider)?.latest ?? '', real: join(homedir(), '.local/share/claude/versions/x') };
        return p ? { ...p, real: resolved(p.path) } : null;
      },
      running: (provider) => this.mgr.runningOn(provider === 'openai' ? 'codex' : provider === 'gemini' ? 'gemini' : 'claude'),
      confirmSwitch: (provider, update) => this.confirmCliSwitch(provider, update),
      send: (run) => send('hub:cli-update', run),
    });
    this.mgr = new SessionManager({
      cfg: this.cfg,
      dataDir: this.dataDir,
      executable: () => this.executable,
      codexExecutable: () => this.codex,
      geminiExecutable: () => this.gemini,
      mcpHub: this.mcpHub,
      sessionEnv: (account, model) => this.sessionEnv(account, model),
      persist: () => this.save(),
      costLog: this.costLog,
      capabilities: async () => capabilitiesText(await this.caps.fresh(CAPS_MAX_AGE)),
    });
    this.caps = new CapabilityStore({
      cfg: this.cfg,
      executable: () => this.executable,
      env: () => this.mgr.environment(OWN_ACCOUNT),
      toolEnv: () => this.mgr.toolEnv(),
      openUrl: (url) => void shell.openExternal(url),
      reconnect: (name) => this.mgr.reconnectMcp(name),
    });
    this.updater = new Updater({
      dataDir: this.dataDir,
      cfg: this.cfg,
      sessions: this.mgr,
      repoBusy: () => repoWatchers.some((r) => r.status.busy !== null),
      env: () => this.mgr.toolEnv(),
      window: () => win,
      send: (state) => send('hub:update', state),
      // The user chose (or nothing runs): no second question; sessions cut pick up after the restart.
      restart: (relaunch) => {
        quitting = true;
        if (relaunch) app.relaunch();
        app.quit();
      },
    });
  }

  async init(): Promise<void> {
    setGitSignIn(() => githubSignIn(this.cfg, this.secrets.get('githubToken'), this.gh));
    [this.executable, this.codex, this.gemini, this.gh] = await Promise.all([
      claudeExecutable(this.cfg),
      codexExecutable(this.cfg.codexPath),
      geminiExecutable(),
      this.cfg.github.source === 'gh' ? ghPath() : '',
      this.secrets.load(),
      this.bridge.start(),
      this.mcpHub.start(),
    ]);
  }

  private bridgeAccount(id: string): BridgeAccount | null {
    const a = this.cfg.accounts.find((x) => x.id === id && x.kind === 'openai');
    return a ? { baseUrl: a.baseUrl, key: this.secrets.get(`account:${a.id}`), model: a.model, smallModel: a.smallModel } : null;
  }

  /**
   * The access of a session's account (the Claude access chosen in the settings for "default"), plus the GitHub
   * sign-in when the user shares it with the sessions.
   */
  sessionEnv(account: string, model?: string): { set: Record<string, string>; unset: string[] } {
    const github = this.cfg.github.shareWithSessions ? githubGitEnv(this.cfg, this.secrets.get('githubToken'), this.gh) : {};
    // "default" is the active Anthropic account; "own" is the user's own sign-in, whichever is active.
    const id = canonAccount(account, this.cfg.anthropicActive);
    const extra = this.cfg.accounts.find((a) => a.id === id);
    const access = extra
      ? accountEnv(extra, { dataDir: this.dataDir, key: this.secrets.get(`account:${extra.id}`), bridge: { url: this.bridge.url(extra.id), token: this.bridge.token() }, model })
      : claudeEnv(this.cfg, this.secrets.get('anthropicApiKey'));
    return { set: { ...access.set, ...github }, unset: access.unset };
  }

  /** Which providers are connected, with their models and limits: asked once in the background, then now and then. */
  warmProviders(): void {
    void this.providerViews().catch(() => undefined);
    setInterval(() => void this.providerViews().catch(() => undefined), 10 * 60_000).unref();
  }

  /** The account the hub made for a provider's way of connecting, if there is one. */
  private managed(provider: ProviderId, method: ProviderMethod): Account | undefined {
    const accounts = this.cfg.accounts;
    if (provider === 'openai') return method === 'chatgpt' ? accounts.find((a) => a.kind === 'codex') : accounts.find((a) => a.kind === 'openai' && providerOfAccount(a) === 'openai');
    if (provider === 'gemini') return accounts.find((a) => a.kind === (method === 'google' ? 'gemini' : 'gemini-key'));
    if (provider === 'deepseek') return accounts.find((a) => a.kind === 'anthropic-compatible' && providerOfAccount(a) === 'deepseek');
    return undefined;
  }

  /**
   * The state of every provider's block, checked now (the programs are asked who is signed in, the servers whether
   * the key works), and handed to the session manager: the composer, the roster and the master's tools follow it.
   */
  async providerViews(): Promise<ProviderView[]> {
    const method = async (account: Account | undefined, keyDetail = false): Promise<MethodView> => {
      if (!account) return { connected: false, detail: '', error: '' };
      const st = await this.checkAccount(account.id);
      const noSignIn = (account.kind === 'codex' || account.kind === 'gemini') && !st.ready && !st.error;
      return { connected: st.ready, detail: keyDetail && st.ready ? '' : st.detail, error: noSignIn ? '' : st.error };
    };
    this.codex = (await codexExecutable(this.cfg.codexPath)) || this.codex;
    this.gemini = (await geminiExecutable()) || this.gemini;
    const claudeAccounts = this.cfg.accounts.filter((a) => a.kind === 'claude');
    const customs = this.cfg.accounts.filter(isCustomAccount);
    const [claude, codexVersionText, chatgpt, apikey, deepseek, geminiVersionText, google, geminiKey, others, customViews] = await Promise.all([
      claudeStatus(this.cfg, this.mgr.environment(OWN_ACCOUNT)),
      codexVersion(this.codex, this.mgr.toolEnv()),
      method(this.managed('openai', 'chatgpt')),
      method(this.managed('openai', 'apikey'), true),
      method(this.managed('deepseek', 'apikey'), true),
      geminiVersion(this.gemini, this.mgr.toolEnv()),
      method(this.managed('gemini', 'google')),
      method(this.managed('gemini', 'apikey'), true),
      Promise.all(claudeAccounts.map((a) => claudeStatus(this.cfg, this.mgr.environment(a.id)))),
      Promise.all(customs.map((a) => method(a, true))),
    ]);
    this.executable = claude.executable || this.executable;
    // Ultracode is offered by the plan of each Claude Code sign-in, and by the Claude Code installed.
    const plans: Record<string, string> = { [OWN_ACCOUNT]: claude.status.account?.plan ?? '' };
    claudeAccounts.forEach((a, i) => (plans[a.id] = others[i].status.account?.plan ?? ''));
    const claudeVersionText = await claudeVersion(claude.executable, this.mgr.toolEnv());
    this.mgr.setPlans(plans, claudeVersionText);
    const viewOf = (r: { executable: string; status: { account: { ready: boolean; provider: string; email: string; plan: string; source: string } | null; error: string } }): MethodView => {
      const who = r.status.account;
      return {
        connected: !!who?.ready,
        detail: who ? (who.provider === 'cloud' ? 'Cloud' : [who.email, who.plan].filter(Boolean).join(' · ') || who.source) : '',
        error: !r.executable ? 'no-claude' : who ? '' : r.status.error === 'timeout' ? 'timeout' : r.status.error ? 'probe-failed' : '',
      };
    };
    // Anthropic's accounts: the user's own sign-in, and the ones added beside it. The active one is what "Anthropic" is.
    // With an API key chosen, the user's own access is the key: it is no longer one of the accounts to sign in.
    const own = viewOf(claude);
    const active = this.cfg.anthropicActive;
    const keyMode = this.cfg.provider === 'api-key';
    const accounts: ProviderAccountView[] = [
      ...(keyMode ? [] : [{ id: OWN_ACCOUNT, name: t('account.own'), ...own, active: active === '', removable: false }]),
      ...claudeAccounts.map((a, i) => ({ id: a.id, name: a.name, ...viewOf(others[i]), active: active === a.id, removable: true })),
    ];
    const none: MethodView = { connected: false, detail: '', error: '' };
    const anthropicKey: MethodView = keyMode && this.secrets.has('anthropicApiKey') ? { ...own, detail: '' } : none;
    const anthropic: MethodView = accounts.find((a) => a.active) ?? (keyMode ? none : own);
    const viaKey = keyMode && active === '';
    const anthropicOn = viaKey ? anthropicKey.connected : anthropic.connected;
    const views: ProviderView[] = [
      {
        id: 'anthropic',
        label: providerDef('anthropic').label,
        connected: anthropicOn,
        method: anthropicOn ? (viaKey ? 'apikey' : 'cli') : '',
        methods: { cli: anthropic, apikey: anthropicKey },
        accounts,
        cli: { found: claude.executable !== '', version: claudeVersionText, outdated: false },
      },
      {
        id: 'openai',
        label: providerDef('openai').label,
        connected: chatgpt.connected || apikey.connected,
        method: chatgpt.connected ? 'chatgpt' : apikey.connected ? 'apikey' : '',
        methods: { chatgpt, apikey },
        cli: { found: this.codex !== '', version: codexVersionText, outdated: codexVersionText !== '' && !versionAtLeast(codexVersionText, CODEX_MIN_VERSION) },
      },
      { id: 'deepseek', label: providerDef('deepseek').label, connected: deepseek.connected, method: deepseek.connected ? 'apikey' : '', methods: { apikey: deepseek }, cli: null },
      {
        id: 'gemini',
        label: providerDef('gemini').label,
        connected: google.connected || geminiKey.connected,
        method: google.connected ? 'google' : geminiKey.connected ? 'apikey' : '',
        methods: { google, apikey: geminiKey },
        cli: { found: this.gemini !== '', version: geminiVersionText, outdated: geminiVersionText !== '' && !versionAtLeast(geminiVersionText, GEMINI_MIN_VERSION) },
      },
      // The providers the user added, each an OpenAI-compatible server behind the bridge.
      ...customs.map((a, i) => ({
        id: a.slug,
        label: a.name,
        connected: customViews[i].connected,
        method: customViews[i].connected ? ('apikey' as const) : ('' as const),
        methods: { apikey: customViews[i] },
        cli: null,
        custom: { accountId: a.id, baseUrl: a.baseUrl, models: a.models },
      })),
    ];
    const states: Record<string, ProviderState> = {
      anthropic: { connected: anthropicOn, accountId: 'default', method: anthropicOn ? (viaKey ? 'apikey' : 'cli') : '' },
      openai: chatgpt.connected
        ? { connected: true, accountId: this.managed('openai', 'chatgpt')?.id ?? '', method: 'chatgpt' }
        : apikey.connected
          ? { connected: true, accountId: this.managed('openai', 'apikey')?.id ?? '', method: 'apikey' }
          : { connected: false, accountId: '', method: '' },
      deepseek: deepseek.connected ? { connected: true, accountId: this.managed('deepseek', 'apikey')?.id ?? '', method: 'apikey' } : { connected: false, accountId: '', method: '' },
      gemini: google.connected
        ? { connected: true, accountId: this.managed('gemini', 'google')?.id ?? '', method: 'google' }
        : geminiKey.connected
          ? { connected: true, accountId: this.managed('gemini', 'apikey')?.id ?? '', method: 'apikey' }
          : { connected: false, accountId: '', method: '' },
    };
    customs.forEach((a, i) => (states[a.slug] = customViews[i].connected ? { connected: true, accountId: a.id, method: 'apikey' } : { connected: false, accountId: '', method: '' }));
    this.mgr.setProviderStates(states);
    // What is new at the connected providers (models, program versions): told in the background, never holds the views back.
    void this.news
      .check({
        connected: { anthropic: anthropicOn, openai: states.openai?.connected, deepseek: deepseek.connected, gemini: states.gemini?.connected },
        offered: this.mgr.providerOffers(),
        programs: {
          anthropic: { path: claude.executable, version: claudeVersionText },
          openai: { path: this.codex, version: codexVersionText },
          gemini: { path: this.gemini, version: geminiVersionText },
        },
      })
      .catch(() => undefined);
    return views;
  }

  /** Changing how a provider's program is installed is said in full before anything runs. */
  private async confirmCliSwitch(provider: ProviderId, update: CliUpdate): Promise<boolean> {
    const native = update.switchTo === 'native';
    const brew = update.method === 'brew' ? brewPackage(update.path) : null;
    const detail = native
      ? [t('cliUpdate.native.what'), brew ? t('cliUpdate.native.brew', { command: `brew uninstall ${brew.kind === 'cask' ? '--cask ' : ''}${brew.name}` }) : update.method === 'npm' ? t('cliUpdate.native.npm') : '', t('cliUpdate.native.keep'), t('cliUpdate.sessions')]
      : [t('cliUpdate.app.what', { tool: update.tool }), t('cliUpdate.app.keep'), t('cliUpdate.sessions')];
    const options = {
      type: 'question' as const,
      buttons: [t(native ? 'cliUpdate.native.go' : 'cliUpdate.app.go'), t('close.cancel')],
      defaultId: 0,
      cancelId: 1,
      message: t(native ? 'cliUpdate.native.title' : 'cliUpdate.app.title', { tool: update.tool, latest: update.latest, provider: providerDef(provider).label }),
      detail: detail.filter(Boolean).join('\n\n'),
    };
    const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    return response === 0;
  }

  /** Connects a provider with an API key: the key is checked with its service, then kept in the keychain. */
  async connectProvider(provider: ProviderId, method: ProviderMethod, key: unknown) {
    const out = async (r: { ok: boolean; error: string; field: string }) => ({ ...r, views: await this.providerViews() });
    const typed = isStr(key) ? key.trim() : '';
    if (method !== 'apikey') return out({ ok: false, error: 'unsupported', field: '' });
    if (!typed) return out({ ok: false, error: 'required', field: 'key' });
    if (provider === 'anthropic') {
      // The user's own access: Claude Code runs on this key instead of its own sign-in.
      if (!API_KEY.test(typed)) return out({ ok: false, error: 'format', field: 'key' });
      if (!this.secrets.available()) return out({ ok: false, error: 'no-keychain', field: 'key' });
      const refused = await checkApiKey(typed);
      if (refused) return out({ ok: false, error: refused, field: 'key' });
      await this.secrets.set('anthropicApiKey', typed);
      this.cfg.provider = 'api-key';
      this.cfg.anthropicActive = '';
      this.save();
      this.mgr.accountsChanged();
      return out({ ok: true, error: '', field: '' });
    }
    if (!isOpenAIKey(typed)) return out({ ok: false, error: 'format', field: 'key' });
    if (provider === 'deepseek') {
      // The Anthropic-style address has no model list: the key is checked against DeepSeek's own.
      const st = await checkOpenAI('https://api.deepseek.com', typed);
      if (!st.ready) return out({ ok: false, error: st.error, field: 'key' });
      const existing = this.managed('deepseek', 'apikey');
      const r = await this.saveAccount({ id: existing?.id ?? '', kind: 'anthropic-compatible', name: MANAGED_NAMES.deepseek, baseUrl: DEEPSEEK_URL, model: '', smallModel: '', isolated: false }, typed);
      return out({ ok: r.ok, error: r.error, field: r.field === 'baseUrl' ? 'key' : r.field });
    }
    if (provider === 'gemini') {
      const refused = await checkGeminiKey(typed);
      if (refused) return out({ ok: false, error: refused, field: 'key' });
      const existing = this.managed('gemini', 'apikey');
      const r = await this.saveAccount({ id: existing?.id ?? '', kind: 'gemini-key', name: MANAGED_NAMES.geminiKey, baseUrl: '', model: '', smallModel: '', isolated: true }, typed);
      return out({ ok: r.ok, error: r.error, field: r.field });
    }
    const st = await checkOpenAI(OPENAI_URL, typed);
    if (!st.ready) return out({ ok: false, error: st.error, field: 'key' });
    const model = pickOpenAIModel(st.models);
    if (!model) return out({ ok: false, error: 'no-model', field: 'key' });
    const existing = this.managed('openai', 'apikey');
    const r = await this.saveAccount({ id: existing?.id ?? '', kind: 'openai', name: MANAGED_NAMES.openaiKey, baseUrl: OPENAI_URL, model: existing?.model || model, smallModel: '', isolated: false }, typed);
    return out({ ok: r.ok, error: r.error, field: r.field === 'baseUrl' || r.field === 'model' ? 'key' : r.field });
  }

  /**
   * A provider the user added (any OpenAI-compatible server): its model list read, a short chat call tested, saved,
   * removed. Its key is stored like every other one and never goes back to the renderer.
   */
  async customProvider(action: CustomProviderAction, raw: unknown, key: unknown): Promise<CustomProviderResult> {
    // Listing and testing leave the blocks as they are: only a save or a removal checks them again.
    const out = async (r: { ok: boolean; error: string; field?: string; models?: string[]; detail?: string }, views = false) => ({
      ok: r.ok,
      error: r.error,
      field: r.field ?? '',
      models: r.models ?? [],
      detail: r.detail ?? '',
      views: views ? await this.providerViews() : [],
    });
    const d = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const before = this.cfg.accounts.find((a) => a.id === d.id && isCustomAccount(a));
    if (action === 'remove') {
      if (!before) return out({ ok: true, error: '' }, true);
      const r = await this.deleteAccount(before.id);
      return out({ ok: r.ok, error: r.error }, true);
    }
    const slug = before?.slug ?? customSlug(isStr(d.name) ? d.name : '', this.cfg.accounts.map((a) => a.slug).filter(Boolean));
    const draft = normalizeAccount({ id: before?.id ?? '', kind: 'openai', name: d.name, baseUrl: d.baseUrl, models: d.models, slug, isolated: false });
    const typed = isStr(key) ? key.trim() : '';
    if (action === 'save') {
      const r = await this.saveAccount(draft, typed || null);
      return out({ ok: r.ok, error: r.error, field: r.field }, r.ok);
    }
    if (!isServerUrl(draft.baseUrl)) return out({ ok: false, error: 'format', field: 'baseUrl' });
    if (typed && !isOpenAIKey(typed)) return out({ ok: false, error: 'format', field: 'key' });
    // The stored key goes to the address it was given for, never to another one typed since.
    const k = typed || (before && before.baseUrl === draft.baseUrl ? this.secrets.get(`account:${before.id}`) : '');
    if (!k && !isLocalUrl(draft.baseUrl)) return out({ ok: false, error: 'required', field: 'key' });
    if (action === 'models') {
      const st = await checkOpenAI(draft.baseUrl, k);
      if (st.ready && st.models.length > 0) return out({ ok: true, error: '', models: st.models });
      if (st.ready || /^http-(404|405|501)$/.test(st.error)) return out({ ok: false, error: 'no-list', field: 'models' });
      return out({ ok: false, error: st.error, field: /^(unauthorized|forbidden)$/.test(st.error) ? 'key' : 'baseUrl' });
    }
    if (!draft.model) return out({ ok: false, error: 'required', field: 'models' });
    const r = await testChat(draft.baseUrl, k, draft.model);
    // The address answered but refused the call: most often a model it does not have.
    if (/^http-(400|404|422)$/.test(r.error)) return out({ ok: false, error: 'model-refused', field: 'models', detail: r.detail });
    return out({ ok: r.ok, error: r.error, field: /^(unauthorized|forbidden)$/.test(r.error) ? 'key' : '', detail: r.detail });
  }

  /** Anthropic's accounts: the user's own sign-in and the ones added beside it; one is active (what "Anthropic" runs on). */
  async anthropicAccount(action: 'use' | 'add' | 'login' | 'remove', id: string) {
    const out = async (r: { ok: boolean; error: string; opened?: boolean }) => ({ ok: r.ok, error: r.error, field: '', opened: !!r.opened, views: await this.providerViews() });
    const account = this.cfg.accounts.find((a) => a.id === id && a.kind === 'claude');
    if (action === 'add') {
      if (this.cfg.accounts.length >= ACCOUNTS_MAX) return out({ ok: false, error: 'tooMany' });
      const taken = new Set(this.cfg.accounts.map((a) => a.name.toLowerCase()));
      let n = this.cfg.accounts.filter((a) => a.kind === 'claude').length + 2;
      while (taken.has(`claude ${n}`)) n++;
      // A folder of Claude Code's own for it (its sign-in), the rest shared with the user's: conversations resume across accounts.
      const r = await this.saveAccount({ id: '', kind: 'claude', name: `Claude ${n}`, baseUrl: '', model: '', smallModel: '', isolated: false }, null);
      if (!r.ok) return out({ ok: false, error: r.error });
      return out({ ok: true, error: '', opened: await this.loginAccount(r.id) });
    }
    if (id !== OWN_ACCOUNT && !account) return out({ ok: false, error: 'not-found' });
    if (action === 'login') return out({ ok: true, error: '', opened: id === OWN_ACCOUNT ? await this.loginProvider('anthropic', 'cli') : await this.loginAccount(id) });
    if (action === 'use') {
      this.cfg.anthropicActive = id === OWN_ACCOUNT ? '' : id;
      this.save();
      // Sessions at work keep the account they run on; the next launch of each, and the new ones, use this one.
      this.mgr.accountsChanged();
      return out({ ok: true, error: '' });
    }
    if (action === 'remove') {
      if (!account) return out({ ok: false, error: 'not-found' });
      const r = await this.deleteAccount(id);
      return out({ ok: r.ok, error: r.error });
    }
    return out({ ok: false, error: 'unsupported' });
  }

  /** Opens the program's own sign-in in a terminal window (Claude Code, Codex): the user signs in there, never here. */
  async loginProvider(provider: ProviderId, method: ProviderMethod): Promise<boolean> {
    if (provider === 'anthropic') {
      // Back from an API key to Claude Code's own sign-in: a user already signed in there has nothing more to do.
      if (this.cfg.provider === 'api-key') {
        this.cfg.provider = 'claude-code';
        this.save();
        this.mgr.accountsChanged();
        if ((await claudeStatus(this.cfg, this.mgr.environment(OWN_ACCOUNT))).status.account?.ready) return true;
      }
      const exe = await claudeExecutable(this.cfg);
      return exe !== '' && openTerminal({ title: 'Claude Code', file: exe, args: ['auth', 'login'] }, this.mgr.toolEnv());
    }
    if (provider === 'openai' && method === 'chatgpt') {
      let account = this.managed('openai', 'chatgpt');
      if (!account) {
        // The account the hub keeps for it, in a Codex folder of its own (no MCP servers of the user's, its own sign-in).
        const r = await this.saveAccount({ id: '', kind: 'codex', name: MANAGED_NAMES.chatgpt, baseUrl: '', model: '', smallModel: '', isolated: true }, null);
        account = this.cfg.accounts.find((a) => a.id === r.id);
      }
      return account ? this.loginAccount(account.id) : false;
    }
    if (provider === 'gemini' && method === 'google') {
      let account = this.managed('gemini', 'google');
      if (!account) {
        const r = await this.saveAccount({ id: '', kind: 'gemini', name: MANAGED_NAMES.google, baseUrl: '', model: '', smallModel: '', isolated: true }, null);
        account = this.cfg.accounts.find((a) => a.id === r.id);
      }
      return account ? this.loginAccount(account.id) : false;
    }
    return false;
  }

  /**
   * Installs (or updates) the program a provider's sign-in runs in: the app's own copy, with npm. Claude Code without
   * Node.js comes from Anthropic's installer, in a terminal window (`opened`: the panel then waits for it).
   */
  async installCli(provider: ProviderId) {
    const tool: Tool | null = provider === 'anthropic' ? 'claude' : provider === 'openai' ? 'codex' : provider === 'gemini' ? 'gemini' : null;
    let error = tool ? await installTool(tool, this.mgr.toolEnv()) : 'unsupported';
    let opened = false;
    if (error === 'no-node' && tool === 'claude') {
      opened = await openTerminal({ title: 'Claude Code', installer: 'claude' }, this.mgr.toolEnv());
      if (opened) error = '';
    }
    if (tool === 'claude') this.executable = (await claudeExecutable(this.cfg)) || this.executable;
    return { ok: error === '', error, field: '', opened, views: await this.providerViews() };
  }

  /** Signs a provider out and forgets what the hub kept for it. Claude Code's own sign-out ends it for the terminal too. */
  async disconnectProvider(provider: ProviderId, method: ProviderMethod) {
    const out = async (r: { ok: boolean; error: string }) => ({ ...r, field: '', views: await this.providerViews() });
    if (provider === 'anthropic' && method === 'apikey') {
      await this.secrets.set('anthropicApiKey', null);
      this.cfg.provider = 'claude-code';
      this.save();
      this.mgr.accountsChanged();
      return out({ ok: true, error: '' });
    }
    if (provider === 'anthropic') {
      await claudeLogout(await claudeExecutable(this.cfg), this.mgr.environment());
      return out({ ok: true, error: '' });
    }
    const account = this.managed(provider, method);
    if (!account) return out({ ok: true, error: '' });
    const r = await this.deleteAccount(account.id);
    return out({ ok: r.ok, error: r.error });
  }

  /** The sign-in of an account that has one (Codex, a Claude account), in a terminal window. */
  private async loginAccount(id: string): Promise<boolean> {
    const c = this.cfg.accounts.find((x) => x.id === id && x.kind === 'codex');
    if (c) {
      this.codex = (await codexExecutable(this.cfg.codexPath)) || this.codex;
      if (!this.codex) return false;
      const set = this.mgr.environment(c.id);
      if (c.isolated) prepareCodexDir(accountDir(this.dataDir, c.id));
      // Codex's own sign-in (a browser opens): the user signs in there, through OpenAI's own flow.
      return openTerminal({ title: `Codex · ${c.name}`, file: this.codex, args: ['login'], ...(c.isolated ? { env: { CODEX_HOME: accountDir(this.dataDir, c.id) } } : {}) }, set);
    }
    const g = this.cfg.accounts.find((x) => x.id === id && x.kind === 'gemini');
    if (g) {
      this.gemini = (await geminiExecutable()) || this.gemini;
      if (!this.gemini) return false;
      this.googleLogins.get(g.id)?.();
      prepareGeminiDir(accountDir(this.dataDir, g.id));
      // The CLI runs its own Google sign-in (it opens the browser and keeps the result in the account's folder): the hub waits.
      this.googleLogins.set(
        g.id,
        startGoogleLogin(this.gemini, this.mgr.environment(g.id), () => {
          this.googleLogins.delete(g.id);
          void this.providerViews().catch(() => undefined);
        }),
      );
      return true;
    }
    const a = this.cfg.accounts.find((x) => x.id === id && x.kind === 'claude');
    const exe = a ? await claudeExecutable(this.cfg) : '';
    if (!a || !exe) return false;
    const dir = accountDir(this.dataDir, a.id);
    prepareClaudeDir(dir);
    return openTerminal({ title: `Claude Code · ${a.name}`, file: exe, args: ['auth', 'login'], env: { CLAUDE_CONFIG_DIR: dir } }, this.mgr.environment(a.id));
  }

  /** An account checked now: signed in or not, with what. */
  async checkAccount(id: string): Promise<AccountStatus> {
    const none: AccountStatus = { ready: false, detail: '', error: '', models: [] };
    const a = this.cfg.accounts.find((x) => x.id === id);
    if (!a) return { ...none, error: 'not-found' };
    const key = this.secrets.get(`account:${a.id}`);
    if (a.kind === 'claude') {
      const { executable, status } = await claudeStatus(this.cfg, this.mgr.environment(a.id));
      if (!executable) return { ...none, error: 'no-claude' };
      const who = status.account;
      if (!who) return { ...none, error: status.error === 'timeout' ? 'timeout' : 'probe-failed' };
      return { ...none, ready: who.ready, detail: [who.email, who.plan].filter(Boolean).join(' · ') };
    }
    if (a.kind === 'codex') {
      this.codex = (await codexExecutable(this.cfg.codexPath)) || this.codex;
      const { status, limits, models } = await checkCodex(this.codex, this.mgr.environment(a.id));
      if (limits) this.mgr.setLimits(a.id, limits);
      this.mgr.setCatalog(a.id, models);
      return status;
    }
    if (a.kind === 'gemini' || a.kind === 'gemini-key') {
      this.gemini = (await geminiExecutable()) || this.gemini;
      if (!this.gemini) return { ...none, error: 'no-gemini' };
      this.mgr.setCatalog(a.id, await geminiCatalog(this.gemini));
      if (a.kind === 'gemini-key') {
        if (!key) return { ...none, error: 'no-key' };
        const refused = await checkGeminiKey(key);
        return refused ? { ...none, error: refused } : { ...none, ready: true, detail: 'API key' };
      }
      const who = googleSignIn(accountDir(this.dataDir, a.id));
      return who.signedIn ? { ...none, ready: true, detail: who.email } : none;
    }
    if (a.kind === 'anthropic-key') {
      if (!key) return { ...none, error: 'no-key' };
      const refused = await checkApiKey(key);
      return refused ? { ...none, error: refused } : { ...none, ready: true, detail: `sk-ant-…${key.slice(-4)}` };
    }
    // DeepSeek's Anthropic-style address has no model list: its key is asked against DeepSeek's own.
    const deepseek = providerOfAccount(a) === 'deepseek';
    const custom = isCustomAccount(a);
    const status = deepseek
      ? await checkOpenAI('https://api.deepseek.com', key)
      : a.kind === 'anthropic-compatible'
        ? await checkAnthropicCompatible(a.baseUrl, key)
        : custom
          ? await checkCustom(a.baseUrl, key)
          : await checkOpenAI(a.baseUrl, key);
    // OpenAI's own list: each session picks among its chat models. A provider the user added: among the ones they chose.
    const catalog = custom ? a.models : chatModels(status.models);
    if (a.kind === 'openai' && status.ready) this.mgr.setCatalog(a.id, catalog.map((value) => ({ value, displayName: value, description: '', efforts: [] })));
    return { ...status, detail: [hostOf(a.baseUrl), a.model, status.detail === 'unchecked' ? 'unchecked' : ''].filter(Boolean).join(' · ') };
  }

  /**
   * Creates or changes an account, its key checked with its service before anything is stored. A Claude account
   * gets its folder; its sign-in is the user's, in Claude Code (accounts:login).
   */
  async saveAccount(raw: unknown, key: unknown) {
    const fail = (error: string, field = '') => ({ ...this.view(), ok: false, error, field, id: '', status: null as AccountStatus | null });
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const before = this.cfg.accounts.find((a) => a.id === o.id) ?? null;
    // A kind never changes (another kind is another account), nor the id of a provider the user added.
    const account = normalizeAccount(before ? { ...o, kind: before.kind, slug: before.slug } : o);
    if (!before) account.id = '';
    const bad = checkAccount(account, this.cfg.accounts);
    if (bad) return fail(bad.problem, bad.field);
    const typed = isStr(key) ? key.trim() : null;
    let status: AccountStatus | null = null;
    if (account.kind === 'anthropic-key') {
      if (!typed && !(before && typed === null)) return fail('required', 'key');
      if (typed) {
        if (!API_KEY.test(typed)) return fail('format', 'key');
        const refused = await checkApiKey(typed);
        if (refused) return fail(refused, 'key');
      }
    } else if (account.kind === 'openai' || account.kind === 'anthropic-compatible') {
      if (typed && !isOpenAIKey(typed)) return fail('format', 'key');
      // The stored key goes to the address it was given for: another address needs it typed again.
      if (before && typed === null && before.baseUrl !== account.baseUrl && this.secrets.has(`account:${before.id}`)) return fail('required', 'key');
      const k = typed ?? (before ? this.secrets.get(`account:${before.id}`) : '');
      if (!k && !isLocalUrl(account.baseUrl)) return fail('required', 'key');
      status = isCustomAccount(account) ? await checkCustom(account.baseUrl, k) : account.kind === 'openai' ? await checkOpenAI(account.baseUrl, k) : await checkAnthropicCompatible(account.baseUrl, k);
      if (!status.ready) return fail(status.error, /^(unauthorized|forbidden)$/.test(status.error) ? 'key' : 'baseUrl');
    }
    const storesKey = (account.kind === 'anthropic-key' || account.kind === 'openai' || account.kind === 'anthropic-compatible' || account.kind === 'gemini-key') && typed !== null;
    if (storesKey && typed && !this.secrets.available()) return fail('no-keychain', 'key');
    if (!account.id) account.id = `a-${randomBytes(6).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '0').slice(0, 8)}`;
    if (storesKey) await this.secrets.set(`account:${account.id}`, typed || null);
    this.cfg.accounts = before ? this.cfg.accounts.map((a) => (a.id === account.id ? account : a)) : [...this.cfg.accounts, account];
    if (account.kind === 'claude') prepareClaudeDir(accountDir(this.dataDir, account.id));
    if (account.kind === 'codex' && account.isolated) prepareCodexDir(accountDir(this.dataDir, account.id));
    if (account.kind === 'gemini' || account.kind === 'gemini-key') prepareGeminiDir(accountDir(this.dataDir, account.id));
    this.save();
    this.mgr.accountsChanged();
    return { ...this.view(), ok: true, error: '', field: '', id: account.id, status };
  }

  /** Forgets an account: a Claude one is signed out of Claude Code first. Not while one of its sessions works. */
  async deleteAccount(id: string) {
    const a = this.cfg.accounts.find((x) => x.id === id);
    if (!a) return { ...this.view(), ok: true, error: '' };
    if (this.mgr.workingOn(a.id)) return { ...this.view(), ok: false, error: 'working' };
    const env = this.mgr.environment(a.id);
    this.cfg.accounts = this.cfg.accounts.filter((x) => x.id !== a.id);
    knownAccounts(this.cfg);
    this.save();
    // Its sessions move to their usual account first: none runs on it when it goes.
    this.mgr.accountsChanged();
    if (a.kind === 'claude') {
      await claudeLogout(await claudeExecutable(this.cfg), env);
      removeClaudeDir(this.dataDir, a.id);
    }
    // A Codex account that has a folder of the hub's is signed out and its folder removed; the user's own Codex is never touched.
    if (a.kind === 'codex' && a.isolated) {
      await codexLogout(this.codex, env);
      removeCodexDir(this.dataDir, a.id);
    }
    // A Gemini account's folder holds its sign-in: removing it signs it out.
    if (a.kind === 'gemini' || a.kind === 'gemini-key') {
      this.googleLogins.get(a.id)?.();
      removeGeminiDir(this.dataDir, a.id);
    }
    if (this.secrets.has(`account:${a.id}`)) await this.secrets.set(`account:${a.id}`, null);
    return { ...this.view(), ok: true, error: '' };
  }

  view(): SettingsView {
    return {
      settings: structuredClone(this.cfg),
      apiKeySet: this.secrets.has('anthropicApiKey'),
      accountKeys: this.cfg.accounts.filter((a) => this.secrets.has(`account:${a.id}`)).map((a) => a.id),
      githubTokenSet: this.secrets.has('githubToken'),
      secureStorage: this.secrets.available(),
      defaultClientId: DEFAULT_CLIENT_ID !== '',
      dictationOffered: this.dictation.offered(),
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
    on('session:send', (id, text, images, topic) => {
      if (!isStr(id) || !isStr(text)) return;
      const parsed = parseImages(images);
      if (parsed) mgr.send(id, text, parsed, isTopicId(topic) ? topic : null);
      else mgr.refuse(id, text, t('images.invalid'));
    });
    on('session:interrupt', (id) => isStr(id) && mgr.interrupt(id));
    on('session:model', (id, model) => isStr(id) && isStr(model) && MODEL.test(model) && mgr.setModel(id, model));
    on('session:effort', (id, effort) => isStr(id) && EFFORTS.includes(effort as Effort) && mgr.setEffort(id, effort as Effort));
    on('session:ultracode', (id, on_) => isStr(id) && typeof on_ === 'boolean' && mgr.setUltracode(id, on_));
    on('session:mode', (id, mode) => isStr(id) && MODES.includes(mode as Mode) && mgr.setMode(id, mode as Mode));
    on('session:account', (id, account) => isStr(id) && (account === '' || isAccountRef(account)) && mgr.setAccount(id, account as string));
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
    handle('session:commands', (id) => (isStr(id) ? mgr.commands(id) : []));
    on('session:compact', (id, instructions) => isStr(id) && isStr(instructions) && instructions.length <= 4000 && mgr.compact(id, instructions));
    on('session:clear', (id) => isStr(id) && mgr.clear(id));
    on('topic:delete', (topic) => isTopicId(topic) && mgr.deleteTopic(topic));
    on('topic:move', (topic, group) => isTopicId(topic) && (group === null || (isStr(group) && group.length <= 1000)) && mgr.moveTopic(topic, group ?? undefined));
    on('session:cost', (id) => isStr(id) && void mgr.showCost(id));
    handle('cost:history', async (from, to) => {
      const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
      if (!ok(from) || !ok(to) || from >= to) throw new Error(t('cost.badRange'));
      // Turns logged before their repo was kept: the repo of their session, when it is still known.
      const records = (await this.costLog.read(from, to)).map((r) => (r.repo !== undefined ? r : { ...r, repo: mgr.costRepoOf(r.id) ?? '' }));
      return { records, since: this.costLog.since };
    });
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
      // The master's or the workers' account may have changed.
      mgr.accountsChanged();
      // The page is built in one language: it is reloaded in the new one.
      if (before.lang !== this.cfg.language) setImmediate(() => loadRenderer(this.cfg.language));
      if (background !== this.cfg.background) {
        background = this.cfg.background;
        paintWindow();
      }
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
    handle('group:save', (group) => {
      const r = mgr.saveGroup(group);
      return 'error' in r ? { ...this.view(), ok: false, error: r.error.problem, field: r.error.field } : { ...this.view(), ok: true, error: '', field: '' };
    });
    handle('group:delete', (id) => {
      const ok = isStr(id) && mgr.deleteGroup(id);
      return { ...this.view(), ok, error: '' };
    });
    handle('team:agents', () => agentFiles(this.cfg));
    // The MCP and Skills panels: the list from the files at once, the servers' state when Claude Code has checked them.
    handle('caps:get', () => this.caps.inventory());
    handle('caps:check', async () => {
      await this.caps.check();
      return this.caps.inventory();
    });
    handle('caps:mcp-add', (draft) => this.caps.addMcp(draft));
    handle('caps:mcp-remove', (name, source, project) => this.caps.removeMcp(name, source, project));
    handle('caps:mcp-connect', (name) => this.caps.connectMcp(name));
    handle('caps:mcp-connect-cancel', (name) => this.caps.cancelConnect(name));
    handle('caps:mcp-restart', (name) => this.caps.restartMcp(name));
    handle('caps:skill-move', (dir, enable) => this.caps.moveSkill(dir, enable));
    handle('caps:skill-delete', (dir, disabled) => this.caps.deleteSkill(dir, disabled));
    handle('caps:skill-paste', (name, text) => this.caps.pasteSkill(name, text));
    handle('caps:skill-github', (url, skill) => this.caps.githubSkill(url, skill));
    handle('caps:plugin', (id, on) => this.caps.setPlugin(id, on));
    handle('claude:check', async () => {
      const { executable, status } = await claudeStatus(this.cfg, mgr.environment());
      this.executable = executable;
      return status;
    });
    handle('accounts:save', (account, key) => this.saveAccount(account, key));
    handle('accounts:delete', (id) => (isStr(id) ? this.deleteAccount(id) : this.view()));
    handle('accounts:check', (id) => (isStr(id) ? this.checkAccount(id) : { ready: false, detail: '', error: 'not-found', models: [] }));
    // Claude Code's own sign-in, in that account's folder: the user signs in there, through Anthropic's own flow.
    handle('codex:check', async (): Promise<CodexCli> => {
      this.codex = (await codexExecutable(this.cfg.codexPath)) || this.codex;
      const version = await codexVersion(this.codex, mgr.toolEnv());
      return { found: this.codex !== '', version, outdated: version !== '' && !versionAtLeast(version, CODEX_MIN_VERSION) };
    });
    handle('accounts:login', (id) => (isStr(id) ? this.loginAccount(id) : false));
    // The providers' blocks in Settings › Accounts.
    const methodOf = (v: unknown): ProviderMethod | null => (v === 'cli' || v === 'chatgpt' || v === 'google' || v === 'apikey' ? v : null);
    handle('providers:state', () => this.providerViews());
    handle('cli-update:start', (provider, action) => (isProviderId(provider) && (action === 'upgrade' || action === 'switch') ? this.cliUpdates.start(provider, action) : null));
    handle('cli-update:state', () => this.cliUpdates.view());
    on('cli-update:dismiss', (provider) => isProviderId(provider) && this.cliUpdates.dismiss(provider));
    on('providers:ack-news', (provider) => {
      if (isProviderId(provider)) this.news.acknowledge(provider);
    });
    handle('providers:install', (provider) => (isProviderId(provider) ? this.installCli(provider) : { ok: false, error: 'unsupported', field: '', opened: false, views: [] }));
    handle('providers:connect', (provider, method, key) => {
      const m = methodOf(method);
      return isProviderId(provider) && m ? this.connectProvider(provider, m, key) : { ok: false, error: 'unsupported', field: '', views: [] };
    });
    handle('providers:login', (provider, method) => {
      const m = methodOf(method);
      return isProviderId(provider) && m ? this.loginProvider(provider, m) : false;
    });
    handle('providers:disconnect', (provider, method) => {
      const m = methodOf(method);
      return isProviderId(provider) && m ? this.disconnectProvider(provider, m) : { ok: false, error: 'unsupported', field: '', views: [] };
    });
    handle('providers:anthropicAccount', (action, id) =>
      (action === 'use' || action === 'add' || action === 'login' || action === 'remove') && isStr(id) ? this.anthropicAccount(action, id) : { ok: false, error: 'unsupported', field: '', opened: false, views: [] },
    );
    handle('providers:custom', (action, draft, key) =>
      action === 'models' || action === 'test' || action === 'save' || action === 'remove'
        ? this.customProvider(action, draft, key)
        : { ok: false, error: 'unsupported', field: '', models: [], detail: '', views: [] },
    );
    // A built-in provider or the id of one the user added: the session manager resolves it, or says it is unknown.
    const isProviderRef = (v: unknown): v is string => isProviderId(v) || (isStr(v) && CUSTOM_SLUG.test(v));
    on('session:provider', (id, provider) => isStr(id) && isProviderRef(provider) && mgr.setProvider(id, provider));
    on('session:providerModel', (id, provider, model) => isStr(id) && isProviderRef(provider) && isStr(model) && MODEL.test(model) && mgr.setProviderModel(id, provider, model));
    handle('github:gh-status', async () => {
      const [gh, login] = await Promise.all([ghPath(), ghLogin()]);
      return { installed: gh !== '', login };
    });
    // The GitHub CLI's own sign-in, in a terminal window.
    handle('github:terminal', async () => {
      const gh = await ghPath();
      const args = ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'];
      return gh !== '' && openTerminal({ title: 'GitHub CLI', file: gh, args }, mgr.toolEnv());
    });
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
    handle('update:state', () => this.updater.view());
    handle('update:check', () => this.updater.check(true));
    handle('update:install', (choice) => this.updater.install(UPDATE_CHOICES.includes(choice as UpdateChoice) ? (choice as UpdateChoice) : 'ask'));
    on('update:answer', (go) => typeof go === 'boolean' && this.updater.answer(go));
    on('update:open-folder', () => this.updater.openFolder());
    handle('notes:pending', () => this.releaseNotes.notes());
    on('notes:seen', () => this.releaseNotes.seen());
    handle('dictation:support', () => this.dictation.support());
    handle('dictation:permission', async () => ((await this.dictation.permission()) ? { ok: true, error: '' } : { ok: false, error: 'denied' }));
    handle('dictation:start', async (terms) => ((await this.dictation.start(terms)) ? { ok: true, error: '' } : { ok: false, error: 'unavailable' }));
    // 100 ms of audio is 3.2 kB; a chunk far bigger is not ours.
    on('dictation:audio', (pcm) => pcm instanceof ArrayBuffer && pcm.byteLength <= 1 << 18 && this.dictation.feed(Buffer.from(pcm)));
    on('dictation:stop', () => this.dictation.stop());
    on('dictation:cancel', () => this.dictation.cancel());
    on('app:relaunch', () => {
      // Asked before the relaunch is scheduled: a cancelled quit must not relaunch later.
      if (!confirmQuit(mgr)) return;
      quitting = true;
      relaunching = true;
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
  // An update is installing while the hub is closed: it starts the hub again once done.
  const dataDir = app.getPath('userData');
  if (installRunning(dataDir)) {
    setLang(loadConfig(dataDir, systemLang()).language);
    dialog.showMessageBoxSync({ type: 'info', title: APP_NAME, message: t('update.installing'), buttons: [t('update.ok')] });
    app.quit();
    return;
  }
  const built = app.isPackaged ? null : await buildIfStale(app.getAppPath());
  if (built?.kind === 'rebuilt') {
    app.relaunch();
    app.exit(0);
    return;
  }
  const hub = new Hub();
  dictation = hub.dictation;
  await hub.init();
  hub.warmProviders();
  const mgr = hub.mgr;
  manager = mgr;
  bridge = hub.bridge;
  mcpHubRef = hub.mcpHub;
  mgr.on('changed', () => send('hub:snapshot', mgr.snapshot()));
  mgr.on('items', (id: string, items: ChatItem[], reset: boolean) => send('hub:items', id, items, reset));
  mgr.on('pulse', (pulses: [string, SessionPulse][]) => send('hub:pulse', pulses));
  mgr.on('event', (id: string, kind: HubEventKind) => send('hub:event', id, kind));
  mgr.on('team', (team: TeamRole[]) => send('hub:team', team));
  mgr.on('attention', () => {
    if (win && !win.isFocused()) win.flashFrame(true);
  });
  hub.registerIpc();
  // The microphone, for the hub's own page only and for sound only (dictation); the other permissions keep Electron's defaults.
  const audioOnly = (types: readonly string[] | undefined) => !!types && types.length > 0 && types.every((m) => m === 'audio');
  session.defaultSession.setPermissionRequestHandler((wc, permission, done, details) => {
    if (permission !== 'media') return done(true);
    const d = details as { requestingUrl?: string; mediaTypes?: string[] };
    done(!!win && wc === win.webContents && isPage(d.requestingUrl) && audioOnly(d.mediaTypes));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin, details) => {
    if (permission !== 'media') return true;
    return !!win && wc === win.webContents && isPage((details as { requestingUrl?: string }).requestingUrl ?? origin);
  });
  if (process.platform === 'darwin') {
    // The window menus above are Windows and Linux only; a Mac keeps an app menu, with Edit for Cmd+C/V in the fields.
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
    // Run from source, the Dock would show Electron's icon.
    if (!app.isPackaged) app.dock?.setIcon(join(here, '..', 'assets', 'icon.png'));
  }
  background = hub.cfg.background;
  createWindow(mgr, hub.cfg.language);
  if (built?.kind === 'failed') {
    // The hub runs on its previous build; the raw output is not shown, a button copies it.
    void dialog
      .showMessageBox({ type: 'warning', title: APP_NAME, message: t('startup.buildFailed', { app: APP_NAME }), buttons: [t('update.ok'), t('startup.copy')], defaultId: 0, cancelId: 0 })
      .then(({ response }) => {
        if (response === 1) clipboard.writeText(built.detail);
      });
  }
  // A first run waits for the setup: the master needs Claude access before it starts.
  hub.startMaster();
  hub.setWatchers();
  updater = hub.updater;
  updater.start();
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
  app.on('activate', () => {
    if (win?.isMinimized()) win.restore();
    win?.show();
  });
  app.on('before-quit', (e) => {
    if (quitting) return;
    if (!confirmQuit(manager)) return e.preventDefault();
    quitting = true;
  });
  app.on('will-quit', () => {
    if (!relaunching) updater?.atQuit();
    updater?.stop();
    for (const repo of repoWatchers) repo.stop();
    manager?.killAll();
    dictation?.cancel();
    bridge?.stop();
    mcpHubRef?.stop();
  });
  app
    .whenReady()
    .then(start)
    .catch((err: unknown) => {
      // The raw error is not shown: a button copies it, for whoever helps.
      const copy = dialog.showMessageBoxSync({ type: 'error', title: APP_NAME, message: t('startup.failed', { app: APP_NAME }), buttons: [t('startup.quit'), t('startup.copy')], defaultId: 0, cancelId: 0 });
      if (copy === 1) clipboard.writeText(errorText(err));
      app.quit();
    });
}
