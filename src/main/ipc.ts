import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { promises as fs } from 'node:fs';

import { Store } from './store';
import { runAgent, MISSING_KEY_MESSAGE } from './agent';
import { testConnection } from './llm/chat';
import { toolMetas, walkWorkspaceFiles } from './tools';
import { PROVIDERS, normalizeConfig } from '../shared/providers';
import type { AppConfig, ProviderId, RunEvent, WorkspaceMode } from '../shared/types';
import { windowBg } from '../shared/theme';
import { getUpdaterApi, type UpdateState } from './updater';

const unsupportedState = (): UpdateState => ({
  phase: 'unsupported',
  currentVersion: app.getVersion(),
  availableVersion: null,
  progress: 0,
  message: null
});

const MAIN_CHANNEL = 'main';
const EVENT_CHANNEL = 'run:event';

export interface IpcDeps {
  store: Store;
  getWindow: () => BrowserWindow | null;
}

export function registerIpc({ store, getWindow }: IpcDeps): () => void {
  const controller = { current: null as AbortController | null, running: false };

  const emit = (evt: RunEvent): void => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(EVENT_CHANNEL, evt);
  };

  const handle = <T>(channel: string, fn: (...args: any[]) => Promise<T> | T): void => {
    ipcMain.handle(`${MAIN_CHANNEL}:${channel}`, async (_e, ...args) => {
      try {
        return await fn(...args);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[ipc] ${channel} gagal:`, err);
        throw new Error(message);
      }
    });
  };

  // ------------------------------------------------------------- state
  handle('getState', () => ({
    ...store.getState(),
    tools: toolMetas()
  }));

  // ------------------------------------------------------------ config
  handle('saveConfig', (patch: Partial<AppConfig>) => {
    const cfg = store.updateConfig(patch);
    const session = store.getActiveSession();
    session.model = cfg.model;
    store.touch(session);
    store.sortSessions();
    return store.getState();
  });

  handle('testConnection', async (params: { provider: ProviderId; baseUrl: string; apiKey: string; model: string }) => {
    const cfg = normalizeConfig({
      ...store.getConfig(),
      provider: params.provider,
      baseUrl: params.baseUrl,
      apiKey: params.apiKey,
      model: params.model
    });
    return testConnection({ mode: cfg.mode, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model });
  });

  handle('getProviders', () => PROVIDERS);

  handle('setMode', (mode: WorkspaceMode) => store.setMode(mode === 'plan' ? 'plan' : 'dev'));
  handle('setTheme', (theme: 'light' | 'dark') => {
    const applied = store.setTheme(theme === 'dark' ? 'dark' : 'light');
    getWindow()?.setBackgroundColor(windowBg(applied));
    return applied;
  });

  // -------------------------------------------------------- workspace
  handle('pickWorkspace', async () => {
    const win = getWindow();
    if (!win) return null;
    const res = await dialog.showOpenDialog(win, {
      title: 'Pilih folder workspace SelfDev',
      defaultPath: store.getWorkspaceRoot() ?? undefined,
      properties: ['openDirectory', 'createDirectory']
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const root = res.filePaths[0];
    store.setWorkspaceRoot(root);
    return root;
  });

  handle('revealWorkspace', async () => {
    const root = store.getWorkspaceRoot();
    if (!root) return false;
    const err = await shell.openPath(root);
    return err === '';
  });

  handle('listWorkspaceFiles', async () => {
    const root = store.getWorkspaceRoot();
    if (!root) return [];
    return walkWorkspaceFiles(root);
  });

  // ---------------------------------------------------------- chat run
  handle('sendMessage', async (text: string) => {
    const clean = String(text ?? '').trim();
    if (!clean) return;
    if (controller.running) return;

    const cfg = store.getConfig();
    if (!cfg.apiKey) {
      emit({ type: 'started' });
      emit({ type: 'text', text: MISSING_KEY_MESSAGE });
      emit({ type: 'finished', status: 'error' });
      return;
    }

    const session = store.getActiveSession();
    controller.running = true;
    const abort = new AbortController();
    controller.current = abort;
    try {
      await runAgent({ store, emit }, session.id, clean, abort.signal);
    } finally {
      controller.running = false;
      controller.current = null;
    }
  });

  handle('stopRun', async () => {
    controller.current?.abort();
  });

  // -------------------------------------------------------- sessions
  handle('newSession', () => store.createSession(true));
  handle('switchSession', (id: string) => store.setActiveSession(id));
  handle('deleteSession', (id: string) => {
    store.deleteSession(id);
    return store.listSessions();
  });
  handle('renameSession', (id: string, title: string) => {
    store.renameSession(id, title);
  });
  handle('clearSessions', () => {
    store.clearSessions();
    return store.listSessions();
  });

  // ----------------------------------------------------------- misc
  handle('openExternal', async (url: string) => {
    if (!/^https?:\/\//i.test(String(url))) return;
    await shell.openExternal(String(url));
  });

  handle('flush', async () => {
    await store.flush();
  });

  // ---------------------------------------------------------- auto-update
  handle('update:getState', () => getUpdaterApi()?.getState() ?? unsupportedState());
  handle('update:check', () => getUpdaterApi()?.check() ?? unsupportedState());
  handle('update:download', () => getUpdaterApi()?.download() ?? unsupportedState());
  handle('update:install', () => getUpdaterApi()?.install());
  handle('update:skip', (version: string | null) => getUpdaterApi()?.skip(version ?? null));

  return () => controller.current?.abort();
}

/** Best-effort integrity check of a previously saved workspace root. */
export async function workspaceExists(root: string | null): Promise<string | null> {
  if (!root) return null;
  try {
    const st = await fs.stat(root);
    if (st.isDirectory()) return root;
  } catch {
    /* ignore */
  }
  return null;
}