// The only bridge between the window and the main process. It passes
// requests through; no secret ever comes back the other way (the key
// handlers only answer whether a key is saved).
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import type { SteamGuardRequest, SyncProgress } from '../shared/types';

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('playtimeRoi', {
  games: {
    list: () => ipcRenderer.invoke('games:list'),
    setManualPrice: (appId: number, cents: number | null, currency: string) =>
      ipcRenderer.invoke('games:setManualPrice', appId, cents, currency),
  },
  sync: {
    run: () => ipcRenderer.invoke('sync:run'),
    lastSyncedAt: () => ipcRenderer.invoke('sync:lastSyncedAt'),
    onProgress: (listener: (p: SyncProgress) => void) => subscribe('sync:progress', listener),
  },
  steam: {
    signIn: (accountName: string, password: string) => ipcRenderer.invoke('steam:signIn', accountName, password),
    signOut: () => ipcRenderer.invoke('steam:signOut'),
    onGuard: (listener: (r: SteamGuardRequest) => void) => subscribe('steam:guard', listener),
    sendGuardCode: (code: string) => ipcRenderer.invoke('steam:guardCode', code),
    cancelGuard: () => ipcRenderer.invoke('steam:guardCancel'),
  },
  credentials: {
    status: () => ipcRenderer.invoke('credentials:status'),
    setKey: (name: 'steamWebApiKey' | 'itadApiKey', value: string) => ipcRenderer.invoke('credentials:setKey', name, value),
    removeKey: (name: 'steamWebApiKey' | 'itadApiKey') => ipcRenderer.invoke('credentials:removeKey', name),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    setCountry: (country: string) => ipcRenderer.invoke('settings:setCountry', country),
  },
  dbLocation: {
    get: () => ipcRenderer.invoke('dbLocation:get'),
    browseExisting: () => ipcRenderer.invoke('dbLocation:browseExisting'),
    browseNew: () => ipcRenderer.invoke('dbLocation:browseNew'),
    set: (newPath: string) => ipcRenderer.invoke('dbLocation:set', newPath),
    resetToDefault: () => ipcRenderer.invoke('dbLocation:resetToDefault'),
  },
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    openLink: (which: 'steamKey' | 'itadKey' | 'steamPrivacy' | 'store', appId?: number) =>
      ipcRenderer.invoke('app:openLink', which, appId),
  },
  updates: {
    check: () => ipcRenderer.invoke('updates:check'),
  },
});
