import { contextBridge, ipcRenderer } from 'electron';

const MAIN_CHANNEL = 'main';
const EVENT_CHANNEL = 'run:event';
const MENU_CHANNEL = 'menu:action';
const UPDATE_CHANNEL = 'update:event';

type Invoke = (channel: string, ...args: unknown[]) => Promise<any>;

const invoke = ((channel: string, ...args: unknown[]) =>
  ipcRenderer.invoke(`${MAIN_CHANNEL}:${channel}`, ...args)) as Invoke;

const api = {
  getState: () => invoke('getState'),
  saveConfig: (patch: unknown) => invoke('saveConfig', patch),
  testConnection: (params: unknown) => invoke('testConnection', params),
  fetchModels: (params: unknown) => invoke('fetchModels', params),
  getProviders: () => invoke('getProviders'),

  setMode: (mode: string) => invoke('setMode', mode),
  setTheme: (theme: string) => invoke('setTheme', theme),

  pickWorkspace: () => invoke('pickWorkspace'),
  revealWorkspace: () => invoke('revealWorkspace'),
  listWorkspaceFiles: () => invoke('listWorkspaceFiles'),

  sendMessage: (text: string) => invoke('sendMessage', text),
  stopRun: () => invoke('stopRun'),

  newSession: () => invoke('newSession'),
  switchSession: (id: string) => invoke('switchSession', id),
  deleteSession: (id: string) => invoke('deleteSession', id),
  renameSession: (id: string, title: string) => invoke('renameSession', id, title),
  clearSessions: () => invoke('clearSessions'),

  flush: () => invoke('flush'),
  openExternal: (url: string) => invoke('openExternal', url),

  /** Auto-update (electron-updater). No-ops in dev or unsupported builds. */
  getUpdateState: () => invoke('update:getState'),
  checkForUpdates: () => invoke('update:check'),
  downloadUpdate: () => invoke('update:download'),
  installUpdate: () => invoke('update:install'),
  skipUpdateVersion: (version: string | null) => invoke('update:skip', version),

  /** Subscribe to auto-update state changes. Returns an unsubscribe function. */
  onUpdateEvent: (cb: (state: any) => void): (() => void) => {
    const listener = (_e: unknown, state: unknown): void => cb(state);
    ipcRenderer.on(UPDATE_CHANNEL, listener);
    return () => ipcRenderer.removeListener(UPDATE_CHANNEL, listener);
  },

  /** Subscribe to agent-loop events. Returns an unsubscribe function. */
  onRunEvent: (cb: (evt: any) => void): (() => void) => {
    const listener = (_e: unknown, evt: unknown): void => cb(evt);
    ipcRenderer.on(EVENT_CHANNEL, listener);
    return () => ipcRenderer.removeListener(EVENT_CHANNEL, listener);
  },

  /** Subscribe to application-menu actions. Returns an unsubscribe function. */
  onMenuAction: (cb: (action: string) => void): (() => void) => {
    const listener = (_e: unknown, action: unknown): void => cb(String(action));
    ipcRenderer.on(MENU_CHANNEL, listener);
    return () => ipcRenderer.removeListener(MENU_CHANNEL, listener);
  },

  platform: process.platform
};

contextBridge.exposeInMainWorld('selfdev', api);

export type PreloadApi = typeof api;