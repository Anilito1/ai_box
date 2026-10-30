import { contextBridge, ipcRenderer } from 'electron';
import type { DictationEvent } from '../shared/dictation';
import type { ChatItem, HubApi, HubEventKind, HubSnapshot, RepoStatus, SessionPulse, TeamRole } from '../shared/types';
import type { NewsToast } from '../shared/news';
import type { CliRun } from '../shared/cliUpdate';
import type { UpdateState } from '../shared/update';

const api: HubApi = {
  onSnapshot: (cb) => {
    ipcRenderer.on('hub:snapshot', (_e, snapshot: HubSnapshot) => cb(snapshot));
  },
  onItems: (cb) => {
    ipcRenderer.on('hub:items', (_e, id: string, items: ChatItem[], reset: boolean) => cb(id, items, reset));
  },
  onPulse: (cb) => {
    ipcRenderer.on('hub:pulse', (_e, pulses: [string, SessionPulse][]) => cb(pulses));
  },
  onRepo: (cb) => {
    ipcRenderer.on('hub:repo', (_e, status: RepoStatus) => cb(status));
  },
  onEvent: (cb) => {
    ipcRenderer.on('hub:event', (_e, id: string, kind: HubEventKind) => cb(id, kind));
  },
  onRepos: (cb) => {
    ipcRenderer.on('hub:repos', (_e, paths: string[]) => cb(paths));
  },
  onTeam: (cb) => {
    ipcRenderer.on('hub:team', (_e, team: TeamRole[]) => cb(team));
  },
  ready: () => ipcRenderer.send('hub:ready'),
  repoGraph: (path, filter, limit) => ipcRenderer.invoke('repo:graph', path, filter, limit),
  repoDetails: (path, id) => ipcRenderer.invoke('repo:details', path, id),
  repoBranches: (path) => ipcRenderer.invoke('repo:branches', path),
  repoAction: (path, action) => ipcRenderer.invoke('repo:action', path, action),
  open: (id) => ipcRenderer.send('session:open', id),
  send: (id, text, images, topic) => ipcRenderer.send('session:send', id, text, images, topic),
  interrupt: (id) => ipcRenderer.send('session:interrupt', id),
  setModel: (id, model) => ipcRenderer.send('session:model', id, model),
  setEffort: (id, effort) => ipcRenderer.send('session:effort', id, effort),
  setUltracode: (id, on) => ipcRenderer.send('session:ultracode', id, on),
  setMode: (id, mode) => ipcRenderer.send('session:mode', id, mode),
  setAccount: (id, account) => ipcRenderer.send('session:account', id, account),
  setProvider: (id, provider) => ipcRenderer.send('session:provider', id, provider),
  setProviderModel: (id, provider, model) => ipcRenderer.send('session:providerModel', id, provider, model),
  decide: (id, requestId, decision) => ipcRenderer.send('session:decide', id, requestId, decision),
  stop: (id) => ipcRenderer.send('session:stop', id),
  resume: (id) => ipcRenderer.send('session:resume', id),
  remove: (id) => ipcRenderer.send('session:remove', id),
  sessionCommands: (id) => ipcRenderer.invoke('session:commands', id),
  compact: (id, instructions) => ipcRenderer.send('session:compact', id, instructions),
  clear: (id) => ipcRenderer.send('session:clear', id),
  deleteTopic: (topic) => ipcRenderer.send('topic:delete', topic),
  moveTopic: (topic, group) => ipcRenderer.send('topic:move', topic, group ?? null),
  showCost: (id) => ipcRenderer.send('session:cost', id),
  costHistory: (from, to) => ipcRenderer.invoke('cost:history', from, to),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  checkClaude: () => ipcRenderer.invoke('claude:check'),
  checkCodex: () => ipcRenderer.invoke('codex:check'),
  providers: () => ipcRenderer.invoke('providers:state'),
  connectProvider: (provider, method, key) => ipcRenderer.invoke('providers:connect', provider, method, key),
  loginProvider: (provider, method) => ipcRenderer.invoke('providers:login', provider, method),
  disconnectProvider: (provider, method) => ipcRenderer.invoke('providers:disconnect', provider, method),
  installProvider: (provider) => ipcRenderer.invoke('providers:install', provider),
  anthropicAccount: (action, id) => ipcRenderer.invoke('providers:anthropicAccount', action, id),
  customProvider: (action, draft, key) => ipcRenderer.invoke('providers:custom', action, draft, key),
  saveAccount: (account, key) => ipcRenderer.invoke('accounts:save', account, key),
  deleteAccount: (id) => ipcRenderer.invoke('accounts:delete', id),
  checkAccount: (id) => ipcRenderer.invoke('accounts:check', id),
  accountLogin: (id) => ipcRenderer.invoke('accounts:login', id),
  ghStatus: () => ipcRenderer.invoke('github:gh-status'),
  githubTerminal: () => ipcRenderer.invoke('github:terminal'),
  githubDeviceStart: () => ipcRenderer.invoke('github:device-start'),
  githubDeviceWait: () => ipcRenderer.invoke('github:device-wait'),
  githubCancel: () => ipcRenderer.send('github:cancel'),
  githubUseToken: (token) => ipcRenderer.invoke('github:use-token', token),
  githubUseGh: () => ipcRenderer.invoke('github:use-gh'),
  githubDisconnect: () => ipcRenderer.invoke('github:disconnect'),
  githubCheck: () => ipcRenderer.invoke('github:check'),
  pickFolder: () => ipcRenderer.invoke('dialog:folder'),
  scanRepos: (roots) => ipcRenderer.invoke('repos:scan', roots),
  githubRepos: () => ipcRenderer.invoke('github:repos'),
  cloneRepo: (slug, root) => ipcRenderer.invoke('repos:clone', slug, root),
  saveRole: (role) => ipcRenderer.invoke('team:save', role),
  deleteRole: (id) => ipcRenderer.invoke('team:delete', id),
  moveRole: (id, delta) => ipcRenderer.invoke('team:move', id, delta),
  saveGroup: (group) => ipcRenderer.invoke('group:save', group),
  deleteGroup: (id) => ipcRenderer.invoke('group:delete', id),
  agentFiles: () => ipcRenderer.invoke('team:agents'),
  capabilities: () => ipcRenderer.invoke('caps:get'),
  checkCapabilities: () => ipcRenderer.invoke('caps:check'),
  addMcp: (draft) => ipcRenderer.invoke('caps:mcp-add', draft),
  removeMcp: (name, source, project) => ipcRenderer.invoke('caps:mcp-remove', name, source, project),
  connectMcp: (name) => ipcRenderer.invoke('caps:mcp-connect', name),
  cancelConnectMcp: (name) => ipcRenderer.invoke('caps:mcp-connect-cancel', name),
  restartMcp: (name) => ipcRenderer.invoke('caps:mcp-restart', name),
  moveSkill: (dir, enable) => ipcRenderer.invoke('caps:skill-move', dir, enable),
  deleteSkill: (dir, disabled) => ipcRenderer.invoke('caps:skill-delete', dir, disabled),
  pasteSkill: (name, text) => ipcRenderer.invoke('caps:skill-paste', name, text),
  githubSkill: (url, skill) => ipcRenderer.invoke('caps:skill-github', url, skill),
  setPlugin: (id, on) => ipcRenderer.invoke('caps:plugin', id, on),
  finishSetup: () => ipcRenderer.invoke('setup:finish'),
  relaunch: () => ipcRenderer.send('app:relaunch'),
  onUpdate: (cb) => {
    ipcRenderer.on('hub:update', (_e, state: UpdateState) => cb(state));
  },
  onNews: (cb) => {
    ipcRenderer.on('hub:news', (_e, toast: NewsToast) => cb(toast));
  },
  ackNews: (provider) => ipcRenderer.send('providers:ack-news', provider),
  updateCli: (provider, action) => ipcRenderer.invoke('cli-update:start', provider, action),
  cliUpdates: () => ipcRenderer.invoke('cli-update:state'),
  dismissCliUpdate: (provider) => ipcRenderer.send('cli-update:dismiss', provider),
  onCliUpdate: (cb) => {
    ipcRenderer.on('hub:cli-update', (_e, run: CliRun) => cb(run));
  },
  updateState: () => ipcRenderer.invoke('update:state'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: (choice) => ipcRenderer.invoke('update:install', choice),
  answerUpdate: (go) => ipcRenderer.send('update:answer', go),
  openUpdateFolder: () => ipcRenderer.send('update:open-folder'),
  releaseNotes: () => ipcRenderer.invoke('notes:pending'),
  releaseNotesSeen: () => ipcRenderer.send('notes:seen'),
  dictationSupport: () => ipcRenderer.invoke('dictation:support'),
  dictationPermission: () => ipcRenderer.invoke('dictation:permission'),
  dictationStart: (terms) => ipcRenderer.invoke('dictation:start', terms),
  dictationAudio: (pcm) => ipcRenderer.send('dictation:audio', pcm),
  dictationStop: () => ipcRenderer.send('dictation:stop'),
  dictationCancel: () => ipcRenderer.send('dictation:cancel'),
  onDictation: (cb) => {
    ipcRenderer.on('dictation:event', (_e, event: DictationEvent) => cb(event));
  },
};

contextBridge.exposeInMainWorld('hub', api);
