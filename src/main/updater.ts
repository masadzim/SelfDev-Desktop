import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { BrowserWindow } from 'electron';

const EVENT_CHANNEL = 'update:event';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 15_000;
const STATE_FILE = 'update-state.json';

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'up-to-date'
  | 'unsupported';

export interface UpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  availableVersion: string | null;
  /** 0..1, only meaningful while phase === 'downloading' */
  progress: number;
  message: string | null;
}

type Updater = import('electron-updater').AppUpdater;

/*
 * electron-updater must not be inlined by esbuild (dynamic requires + it reads
 * its own metadata at runtime), so it is required lazily here. A broken or
 * partial install then degrades to "updates unsupported" instead of stopping
 * the app from launching.
 */
function loadUpdater(): Updater | null {
  try {
    return (require('electron-updater') as typeof import('electron-updater')).autoUpdater;
  } catch (err) {
    console.error('[updater] electron-updater unavailable:', err);
    return null;
  }
}

/**
 * Whether this build can update itself, and through which updater.
 *
 * - Dev runs have no app-update.yml and must not phone home.
 * - Linux selects its updater from the `package-type` marker electron-builder
 *   writes into resources/: deb -> DebUpdater, AppImage -> AppImageUpdater.
 *   Without the marker electron-updater falls back to AppImageUpdater and fails
 *   with "APPIMAGE env is not defined".
 */
function detectSupport():
  | { ok: true; kind: 'deb' | 'appimage' | 'nsis' }
  | { ok: false; reason: string } {
  if (!app.isPackaged) return { ok: false, reason: 'dev-run' };
  if (!existsSync(join(process.resourcesPath, 'app-update.yml'))) {
    return { ok: false, reason: 'no-app-update.yml' };
  }

  if (process.platform === 'linux') {
    const marker = join(process.resourcesPath, 'package-type');
    if (!existsSync(marker)) return { ok: false, reason: 'no-package-type' };
    const kind = readFileSync(marker, 'utf8').trim();
    if (kind === 'deb') return { ok: true, kind: 'deb' };
    if (process.env.APPIMAGE) return { ok: true, kind: 'appimage' };
    return { ok: false, reason: `package-type=${kind || 'empty'}` };
  }

  return { ok: true, kind: 'nsis' };
}

/* --------------------------------------------------------------- persistence */

function stateFile(): string {
  return join(app.getPath('userData'), STATE_FILE);
}

function readSkipped(): string | null {
  try {
    const raw = JSON.parse(readFileSync(stateFile(), 'utf8')) as { skippedVersion?: string | null };
    return raw.skippedVersion ?? null;
  } catch {
    return null;
  }
}

function writeSkipped(version: string | null): void {
  try {
    const file = stateFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ skippedVersion: version }));
  } catch (err) {
    console.error('[updater] cannot persist state:', err);
  }
}

/* ---------------------------------------------------------------- controller */

export interface UpdaterApi {
  getState(): UpdateState;
  check(): Promise<UpdateState>;
  download(): Promise<UpdateState>;
  install(): void;
  skip(version: string | null): void;
  dispose(): void;
}

let instance: UpdaterApi | null = null;

/**
 * Creates the updater controller. Called once during app startup; the ipc layer
 * reaches the same instance through {@link getUpdaterApi}.
 */
export function createUpdater(getWindow: () => BrowserWindow | null): UpdaterApi {
  if (instance) return instance;

  const state: UpdateState = {
    phase: 'idle',
    currentVersion: app.getVersion(),
    availableVersion: null,
    progress: 0,
    message: null
  };

  const emit = (): void => {
    getWindow()?.webContents.send(EVENT_CHANNEL, state);
  };
  const set = (patch: Partial<UpdateState>): UpdateState => {
    Object.assign(state, patch);
    emit();
    return state;
  };

  const support = detectSupport();
  const updater = support.ok ? loadUpdater() : null;

  if (!support.ok || !updater) {
    const reason = support.ok ? 'module-missing' : support.reason;
    console.log(`[updater] disabled (${reason})`);
    set({ phase: 'unsupported' });
    instance = {
      getState: () => ({ ...state }),
      check: async () => ({ ...state }),
      download: async () => ({ ...state }),
      install: () => undefined,
      skip: () => writeSkipped(null),
      dispose: () => undefined
    };
    return instance;
  }

  // Notify first, let the user press the button: a silent download can surprise
  // someone on a metered connection, and .deb installs need an auth prompt anyway.
  updater.autoDownload = false;
  // Stay explicit: the update is only ever installed by `install()`, never as a
  // side effect of quitting.
  updater.autoInstallOnAppQuit = false;
  updater.allowDowngrade = false;

  updater.on('checking-for-update', () => set({ phase: 'checking', message: null }));
  updater.on('update-available', (info: { version: string }) => {
    if (readSkipped() === info.version) {
      console.log(`[updater] ${info.version} skipped by user, staying quiet`);
      return;
    }
    set({ phase: 'available', availableVersion: info.version, message: null });
  });
  updater.on('update-not-available', () => set({ phase: 'up-to-date', availableVersion: null }));
  updater.on('download-progress', (p: { percent?: number }) =>
    set({ phase: 'downloading', progress: Math.max(0, Math.min(1, (p.percent ?? 0) / 100)) })
  );
  updater.on('update-downloaded', (info: { version: string }) =>
    set({ phase: 'downloaded', availableVersion: info.version, progress: 1 })
  );
  updater.on('error', (err: Error) => {
    console.error('[updater]', err);
    set({ phase: 'error', message: err?.message ?? String(err) });
  });

  const guard = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      console.error('[updater]', err);
      set({ phase: 'error', message: (err as Error)?.message ?? String(err) });
      return null;
    }
  };

  // Install is always explicit (see `install`), so there is no pending-update
  // state to re-apply on startup in electron-updater 6.x.

  const firstCheck = setTimeout(() => {
    void guard(() => updater.checkForUpdates());
  }, FIRST_CHECK_DELAY_MS);
  const timer = setInterval(() => {
    void guard(() => updater.checkForUpdates());
  }, CHECK_INTERVAL_MS);

  console.log(`[updater] ready (${support.kind}) on ${state.currentVersion}`);

  instance = {
    getState: () => ({ ...state }),

    check: async () => {
      set({ phase: 'checking', message: null });
      await guard(() => updater.checkForUpdates());
      return { ...state };
    },

    download: async () => {
      set({ phase: 'downloading', progress: 0, message: null });
      await guard(() => updater.downloadUpdate());
      return { ...state };
    },

    /*
     * .deb / rpm can never self-install silently: dpkg always elevates.
     * DebUpdater shells out to pkexec, so the user gets one ordinary password
     * prompt and the app restarts itself afterwards. NSIS (per-user) is silent.
     */
    install: () => {
      set({ phase: 'downloaded', message: 'Memasang update…' });
      setImmediate(() => {
        try {
          updater.quitAndInstall(false, true);
        } catch (err) {
          console.error('[updater] install failed:', err);
          set({ phase: 'error', message: (err as Error)?.message ?? String(err) });
        }
      });
    },

    skip: (version) => {
      writeSkipped(version);
      set({ phase: 'idle', availableVersion: null });
    },

    dispose: () => {
      clearTimeout(firstCheck);
      clearInterval(timer);
      instance = null;
    }
  };

  return instance;
}

export function getUpdaterApi(): UpdaterApi | null {
  return instance;
}

export { EVENT_CHANNEL as UPDATE_EVENT_CHANNEL };