import { contextBridge, ipcRenderer } from 'electron';
import type { ChatItem, HubApi, HubEventKind, HubSnapshot, RepoStatus, TeamRole } from '../shared/types';

const api: HubApi = {
  onSnapshot: (cb) => {
    ipcRenderer.on('hub:snapshot', (_e, snapshot: HubSnapshot) => cb(snapshot));
  },
  onItems: (cb) => {
    ipcRenderer.on('hub:items', (_e, id: string, items: ChatItem[], reset: boolean) => cb(id, items, reset));
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
  send: (id, text, images) => ipcRenderer.send('session:send', id, text, images),
  interrupt: (id) => ipcRenderer.send('session:interrupt', id),
  setModel: (id, model) => ipcRenderer.send('session:model', id, model),
  setEffort: (id, effort) => ipcRenderer.send('session:effort', id, effort),
  setMode: (id, mode) => ipcRenderer.send('session:mode', id, mode),
  decide: (id, requestId, decision) => ipcRenderer.send('session:decide', id, requestId, decision),
  stop: (id) => ipcRenderer.send('session:stop', id),
  resume: (id) => ipcRenderer.send('session:resume', id),
  remove: (id) => ipcRenderer.send('session:remove', id),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  setApiKey: (key) => ipcRenderer.invoke('settings:api-key', key),
  checkClaude: () => ipcRenderer.invoke('claude:check'),
  ghLogin: () => ipcRenderer.invoke('github:gh-login'),
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
  agentFiles: () => ipcRenderer.invoke('team:agents'),
  finishSetup: () => ipcRenderer.invoke('setup:finish'),
  relaunch: () => ipcRenderer.send('app:relaunch'),
};

contextBridge.exposeInMainWorld('hub', api);
