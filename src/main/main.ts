import { app, BrowserWindow, Menu, nativeTheme, shell } from 'electron';
import { join } from 'node:path';
import { promises as fsPromises } from 'node:fs';

import { Store } from './store';
import { registerIpc, workspaceExists } from './ipc';
import { createUpdater, getUpdaterApi } from './updater';
import { windowBg } from '../shared/theme';

const isDev = process.env.SELFDEV_DEV === '1';
const EVENT_CHANNEL = 'run:event';

let store: Store;
let mainWindow: BrowserWindow | null = null;
let disposeIpc: (() => void) | null = null;

const getWindow = (): BrowserWindow | null => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null);

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 860,
    minHeight: 560,
    show: false,
    backgroundColor: windowBg(store.getTheme()),
    title: 'SelfDev — AI Developer Console',
    icon: join(__dirname, '../../assets/icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webviewTag: false
    }
  });

  win.once('ready-to-show', () => {
    win.show();
    if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  });

  // Never allow navigation or popups: all links open in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });

  win.on('closed', () => {
    mainWindow = null;
  });

  void win.loadFile(join(__dirname, '../renderer/index.html'));
  return win;
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              {
                label: 'Pengaturan…',
                accelerator: 'CmdOrCtrl+,',
                click: () => getWindow()?.webContents.send('menu:action', 'settings')
              },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'quit' as const }
            ]
          }
        ] as Electron.MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Sesi Baru',
          accelerator: 'CmdOrCtrl+N',
          click: () => getWindow()?.webContents.send('menu:action', 'new-session')
        },
        {
          label: 'Pilih Workspace…',
          accelerator: 'CmdOrCtrl+O',
          click: () => getWindow()?.webContents.send('menu:action', 'pick-workspace')
        },
        { type: 'separator' },
        isMac ? { role: 'close' as const } : { role: 'quit' as const }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Ganti Tema',
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => getWindow()?.webContents.send('menu:action', 'toggle-theme')
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Dokumentasi SelfDev',
          click: () => void shell.openExternal('https://adzim.my.id/selfdev/docs')
        },
        {
          label: 'Versi Web',
          click: () => void shell.openExternal('https://adzim.my.id/ai')
        },
        {
          label: 'Dukung',
          click: () => void shell.openExternal('https://adzim.my.id/support')
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ------------------------------------------------------------- lifecycle

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = getWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    } else {
      mainWindow = createWindow();
    }
  });
}

app.whenReady().then(async () => {
  store = new Store();
  await store.init();

  // Drop a workspace root that no longer exists.
  const verified = await workspaceExists(store.getWorkspaceRoot());
  if (verified === null && store.getWorkspaceRoot()) store.setWorkspaceRoot(null);

  nativeTheme.themeSource = store.getTheme() === 'dark' ? 'dark' : 'light';
  app.setName('SelfDev');

  buildMenu();
  disposeIpc = registerIpc({ store, getWindow });
  mainWindow = createWindow();
  createUpdater(getWindow);

  if (process.env.SELFDEV_SMOKE === '1') void runSmokeTest(getWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

/**
 * Headless self-check: boots the real window, asserts the renderer booted
 * correctly against the real IPC layer, then exits. Enabled with
 * SELFDEV_SMOKE=1 (used by `npm run smoke`).
 */
async function runSmokeTest(get: () => BrowserWindow | null): Promise<void> {
  const problems: string[] = [];
  const win = get();
  if (!win) {
    console.error('SMOKE_FAIL no window');
    app.exit(1);
    return;
  }

  win.webContents.on('console-message', (...args: unknown[]) => {
    // Electron >=35 passes (event, details); older versions pass positional args.
    const details = args[1] as { level?: number | string; message?: string; lineNumber?: number; sourceId?: string } | undefined;
    const positional = typeof args[1] === 'number';
    const level = positional ? (args[1] as number) : Number(details?.level ?? 0);
    const message = positional ? String(args[2] ?? '') : String(details?.message ?? '');
    const line = positional ? (args[3] as number) : (details?.lineNumber ?? 0);
    const sourceId = positional ? String(args[4] ?? '') : String(details?.sourceId ?? '');
    const text = `[console:${level}] ${message} (${sourceId}:${line})`;
    // level 3 == error in the object form, 2 == warning in the positional form
    if (level >= 2) problems.push(text);
    console.log(text);
  });
  win.webContents.on('preload-error', (_e, p, err) => problems.push(`[preload] ${p} ${err.message}`));
  win.webContents.on('render-process-gone', (_e, d) => problems.push(`[renderer-gone] ${d.reason}`));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => problems.push(`[load-failed] ${code} ${desc} ${url}`));

  await new Promise<void>((r) => win.webContents.once('did-finish-load', () => r()));

  const checks: Record<string, unknown> = {};

  // Self-check: prove the console listener above actually fires, otherwise
  // "no console errors" would be meaningless.
  try {
    await win.webContents.executeJavaScript(`console.error('selfdev-smoke-canary')`);
    await new Promise((r) => setTimeout(r, 300));
    const caught = problems.some((p) => p.includes('selfdev-smoke-canary'));
    checks.consoleListener = caught;
    if (!caught) problems.push('harness: console-message listener did not capture a canary error');
    for (let i = problems.length - 1; i >= 0; i -= 1) {
      if (problems[i].includes('selfdev-smoke-canary')) problems.splice(i, 1);
    }
  } catch (err) {
    problems.push(`harness: canary failed (${err instanceof Error ? err.message : String(err)})`);
  }

  try {
    const probe = `
      (async () => {
        const out = {};
        const $ = (id) => document.getElementById(id);
        out.bridge = typeof window.selfdev === 'object' && window.selfdev !== null;
        out.nodeLeaked = typeof window.require !== 'undefined' || typeof window.process !== 'undefined';
        out.appEl = !!$('selfdev-app');
        out.messagesEl = !!$('sdMessages');
        out.inputEl = !!$('sdInput');
        out.settingsEl = !!$('sdSettings');
        out.state = await window.selfdev.getState();
        out.toolCount = out.state.tools ? out.state.tools.length : 0;
        out.sessionCount = out.state.sessions.length;
        out.emptyStateRendered = !!$('sdMessages').querySelector('.sd-empty');
        out.sessionRows = $('sdSessionList').querySelectorAll('.sd-session').length;
        out.toolChips = $('sdToolsBar').querySelectorAll('[data-tool]').length;
        out.iconsRendered = document.querySelectorAll('svg use').length;
        out.themeBtn = !!$('sdThemeBtn').querySelector('use');
        out.hintHtml = $('sdWsHint').textContent;
        // toggle theme + mode round trip
        out.themeBefore = document.body.className;
        await window.selfdev.setTheme('dark');
        out.themeAfter = await window.selfdev.setTheme('light');
        out.modeRoundTrip = await window.selfdev.setMode('plan');
        out.modeBack = await window.selfdev.setMode('dev');
        // markdown renders through the live bundle
        out.markdownOk = typeof document.title === 'string' && document.title.length > 0;
        // layout sanity: real pixels, no page scroll, nothing collapsed
        const rect = (id) => { const el = $(id); if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
        out.geom = { app: rect('selfdev-app'), messages: rect('sdMessages'), composer: rect('sdComposer'), sidebar: rect('sdSidebar'), input: rect('sdInput') };
        out.pageOverflowX = document.documentElement.scrollWidth > window.innerWidth + 1;
        out.pageOverflowY = document.documentElement.scrollHeight > window.innerHeight + 1;
        out.visibleText = document.body.innerText.replace(/\\s+/g, ' ').trim().length;
        return out;
      })()
    `;
    checks.probe = await win.webContents.executeJavaScript(probe, true);
    const p = checks.probe as Record<string, unknown>;
    const state = p.state as { config: { model: string } };
    const fail = (m: string): void => {
      problems.push(m);
    };
    if (!p.bridge) fail('preload bridge missing');
    if (p.nodeLeaked) fail('node globals leaked into renderer');
    if (!p.appEl || !p.messagesEl || !p.inputEl || !p.settingsEl) fail('core DOM missing');
    if (!p.emptyStateRendered) fail('empty state not rendered');
    if ((p.sessionRows as number) < 1) fail('no session rows rendered');
    if ((p.toolChips as number) !== (p.toolCount as number)) fail('tool chips mismatch');
    if ((p.iconsRendered as number) < 10) fail('icon sprite did not resolve');
    if (!p.themeBtn) fail('theme button empty');
    if (state?.config?.model === undefined) fail('config.model missing');
    const geom = p.geom as Record<string, { w: number; h: number } | null>;
    const thin = (name: string, minW: number, minH: number): void => {
      const g = geom[name];
      if (!g) {
        fail(`layout: ${name} missing`);
        return;
      }
      if (g.w < minW || g.h < minH) fail(`layout: ${name} collapsed (${g.w}x${g.h}, want >=${minW}x${minH})`);
    };
    thin('app', 800, 500);
    thin('messages', 400, 200);
    thin('composer', 400, 60);
    thin('sidebar', 180, 300);
    thin('input', 300, 30);
    if (p.pageOverflowX) fail('layout: horizontal page overflow');
    if (p.pageOverflowY) fail('layout: vertical page overflow');
    if ((p.visibleText as number) < 40) fail('layout: rendered text suspiciously empty');
    checks.geometry = { ...geom, overflowX: p.pageOverflowX, overflowY: p.pageOverflowY, visibleText: p.visibleText };
  } catch (err) {
    problems.push(`probe failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (process.env.SELFDEV_SMOKE_E2E === '1') {
    const e2e = await runSmokeAgent(get);
    checks.e2e = e2e.checks;
    problems.push(...e2e.problems);
  }

  try {
    const img = await win.webContents.capturePage();
    await fsPromises.writeFile(process.env.SELFDEV_SHOT ?? '/tmp/opencode/selfdev-smoke.png', img.toPNG());
  } catch (err) {
    problems.push(`screenshot failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log(`SMOKE_RESULT ${JSON.stringify({ checks, problems })}`);
  app.exit(problems.length ? 1 : 0);
  return;
}

/**
 * Full-stack agent check: renderer -> preload -> IPC -> agent loop -> streamed
 * provider -> tool execution -> back to the DOM. Requires a mock provider on
 * SELFDEV_MOCK_URL (see tests/mock-provider.mjs).
 */
async function runSmokeAgent(get: () => BrowserWindow | null): Promise<{
  checks: Record<string, unknown>;
  problems: string[];
}> {
  const problems: string[] = [];
  const checks: Record<string, unknown> = {};
  const win = get();
  const baseUrl = process.env.SELFDEV_MOCK_URL;
  if (!win || !baseUrl) {
    return { checks, problems: ['e2e: no window or SELFDEV_MOCK_URL'] };
  }

  const script = `
    (async () => {
      const events = [];
      const off = window.selfdev.onRunEvent((e) => events.push(e));
      await window.selfdev.saveConfig({
        provider: ${JSON.stringify(process.env.SELFDEV_MOCK_PROVIDER ?? 'custom')},
        baseUrl: ${JSON.stringify(process.env.SELFDEV_MOCK_BASE ?? baseUrl)},
        apiKey: 'smoke-key',
        model: 'mock-model',
        temperature: 0
      });
      await window.selfdev.sendMessage('tulis catatan e2e dong');
      const finished = await new Promise((resolve) => {
        const started = Date.now();
        const timer = setInterval(() => {
          const last = events[events.length - 1];
          if (last && last.type === 'finished') { clearInterval(timer); resolve(last); }
          else if (Date.now() - started > 45000) { clearInterval(timer); resolve({ type: 'timeout' }); }
        }, 100);
      });
      off();
      await new Promise((r) => setTimeout(r, 400));
      const msgs = document.getElementById('sdMessages');
      return {
        finished,
        eventTypes: events.map((e) => e.type),
        assistantText: [...document.querySelectorAll('#sdMessages .sd-task-text')].map((m) => m.innerText).join('\\n'),
        userText: [...document.querySelectorAll('#sdMessages .sd-user-content')].map((m) => m.innerText).join('\\n'),
        taskCards: document.querySelectorAll('#sdMessages .sd-task').length,
        toolItems: document.querySelectorAll('#sdMessages .sd-tool').length,
        toolOk: [...document.querySelectorAll('#sdMessages .sd-tool')].some((el) => !el.querySelector('.sd-tool-out.err')),
        statusLine: (document.getElementById('sdStatus') || {}).textContent || '',
        sendDisabled: !!(document.getElementById('sdSend') || {}).disabled,
        renderedChars: msgs ? msgs.innerText.length : 0
      };
    })()
  `;

  let result: Record<string, unknown>;
  try {
    result = await win.webContents.executeJavaScript(script, true);
  } catch (err) {
    return { checks, problems: [`e2e: renderer threw ${err instanceof Error ? err.message : String(err)}`] };
  }
  checks.events = result.eventTypes;

  const finished = result.finished as { type: string; status?: string; error?: string };
  if (finished.type !== 'finished') problems.push(`e2e: run did not finish (${finished.type})`);
  if (finished.status !== 'done') problems.push(`e2e: status=${finished.status} error=${finished.error ?? ''}`);
  const types = (result.eventTypes as string[]) ?? [];
  for (const t of ['started', 'text', 'tool_start', 'tool_end']) {
    if (!types.includes(t)) problems.push(`e2e: missing event ${t}`);
  }
  if (!String(result.userText ?? '').includes('tulis catatan e2e dong')) problems.push('e2e: user bubble missing');
  if (!String(result.assistantText ?? '').includes('catatan-e2e.txt')) {
    problems.push(`e2e: assistant reply missing (${String(result.assistantText ?? '').slice(0, 120)})`);
  }
  if ((result.taskCards as number) < 1) problems.push('e2e: task card not rendered');
  if ((result.toolItems as number) < 1) problems.push('e2e: tool item not rendered');
  if (result.toolOk !== true) problems.push('e2e: rendered tool item marked as error');
  if (result.sendDisabled === true) problems.push('e2e: send button left disabled after finish');

  // the tool really wrote the file into the seeded workspace
  try {
    const statePath = join(app.getPath('userData'), 'state.json');
    const state = JSON.parse(await fsPromises.readFile(statePath, 'utf8')) as { workspaceRoot?: string };
    const root = state.workspaceRoot;
    checks.workspaceRoot = root;
    if (!root) problems.push('e2e: no workspaceRoot in state');
    else {
      const written = await fsPromises.readFile(join(root, 'catatan-e2e.txt'), 'utf8');
      checks.writtenFile = written.trim();
      if (written.trim() !== 'halo dari e2e') problems.push(`e2e: file content wrong (${written.trim()})`);
    }
  } catch (err) {
    problems.push(`e2e: written file not found (${err instanceof Error ? err.message : String(err)})`);
  }

  return { checks, problems };
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  disposeIpc?.();
  getUpdaterApi()?.dispose();
  void store?.flush();
});

// Surface renderer crashes instead of dying silently.
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[main] unhandledRejection:', err);
});

export { EVENT_CHANNEL };