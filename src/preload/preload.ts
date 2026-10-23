import { contextBridge, ipcRenderer } from 'electron';
import type { ChatItem, HubApi, HubSnapshot, RepoStatus } from '../shared/types';

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
  ready: () => ipcRenderer.send('hub:ready'),
  refreshRepo: (path) => ipcRenderer.send('repo:refresh', path),
  pullRepo: (path) => ipcRenderer.send('repo:pull', path),
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
};

contextBridge.exposeInMainWorld('hub', api);
