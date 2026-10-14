import { renderMarkdown, escapeHtml } from './markdown';
import { economiesFor, estimateEconomy, formatPrice, isBadgeWorthy, tierGlyph } from '../shared/economy';
import {
  WIRE_APIS,
  WIRE_API_LABEL,
  defaultModelFor,
  detectProviderForKey,
  isLoopback,
  isModelValidFor,
  normalizeBaseUrl,
  presetFor,
  rankedModels,
  repairModelFor,
  supportsDiscovery
} from '../shared/providers';
import type {
  AppConfig,
  ModelEntry,
  ProviderId,
  ProviderPreset,
  RunEvent,
  Session,
  ToolMeta,
  ToolCallRecord,
  ToolResultRecord,
  WireApi,
  WorkspaceMode
} from '../shared/types';

/* -------------------------------------------------------------- bridge -- */

interface StatePayload {
  config: AppConfig;
  sessions: Session[];
  activeSessionId: string | null;
  workspaceRoot: string | null;
  theme: 'light' | 'dark';
  workspaceMode: WorkspaceMode;
  tools: ToolMeta[];
  keyProtection: 'keychain' | 'plain';
}

interface ConnectionReport {
  ok: boolean;
  message: string;
  kind: string | null;
  billingUrl: string | null;
  suggestedModel: string | null;
}

interface ModelsReport {
  ok: boolean;
  message: string;
  kind: string | null;
  billingUrl: string | null;
  models: ModelEntry[];
}

interface UpdatePayload {
  phase: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error' | 'up-to-date' | 'unsupported';
  currentVersion: string;
  availableVersion: string | null;
  progress: number;
  message: string | null;
}

interface Bridge {
  getState(): Promise<StatePayload>;
  saveConfig(patch: Partial<AppConfig>): Promise<StatePayload>;
  getProviders(): Promise<ProviderPreset[]>;
  testConnection(p: {
    provider: ProviderId;
    customBaseUrl: string;
    customWireApi: WireApi;
    apiKey: string;
    model: string;
  }): Promise<ConnectionReport>;
  fetchModels(p: {
    provider: ProviderId;
    customBaseUrl: string;
    customWireApi: WireApi;
    apiKey: string;
  }): Promise<ModelsReport>;
  setMode(mode: WorkspaceMode): Promise<WorkspaceMode>;
  setTheme(theme: 'light' | 'dark'): Promise<'light' | 'dark'>;
  pickWorkspace(): Promise<string | null>;
  revealWorkspace(): Promise<boolean>;
  listWorkspaceFiles(): Promise<Array<{ path: string }>>;
  sendMessage(text: string): Promise<void>;
  stopRun(): Promise<void>;
  newSession(): Promise<Session>;
  switchSession(id: string): Promise<Session | null>;
  deleteSession(id: string): Promise<Session[]>;
  renameSession(id: string, title: string): Promise<void>;
  clearSessions(): Promise<Session[]>;
  flush(): Promise<void>;
  openExternal(url: string): Promise<void>;
  getUpdateState(): Promise<UpdatePayload>;
  checkForUpdates(): Promise<UpdatePayload>;
  downloadUpdate(): Promise<UpdatePayload>;
  installUpdate(): Promise<void>;
  skipUpdateVersion(version: string | null): Promise<void>;
  onUpdateEvent(cb: (s: UpdatePayload) => void): () => void;
  onRunEvent(cb: (e: RunEvent) => void): () => void;
  onMenuAction(cb: (action: string) => void): () => void;
  platform: string;
}

declare global {
  interface Window {
    selfdev: Bridge;
  }
}

const bridge = window.selfdev;

/* ---------------------------------------------------------------- state -- */

interface UiState {
  config: AppConfig;
  sessions: Session[];
  activeSessionId: string | null;
  workspaceRoot: string | null;
  workspaceMode: WorkspaceMode;
  tools: ToolMeta[];
  keyProtection: 'keychain' | 'plain';
  presets: ProviderPreset[];
  running: boolean;
  runSessionId: string | null;
  raw: string;
}

const ui: UiState = {
  config: {
    provider: 'groq',
    customBaseUrl: '',
    customWireApi: 'OPENAI_CHAT',
    apiKey: '',
    model: '',
    temperature: 0.6,
    maxTokens: 2048,
    system: ''
  },
  sessions: [],
  activeSessionId: null,
  workspaceRoot: null,
  workspaceMode: 'dev',
  tools: [],
  keyProtection: 'keychain',
  presets: [],
  running: false,
  runSessionId: null,
  raw: ''
};

const el = {} as Record<string, HTMLElement>;

/* ------------------------------------------------------------------ dom -- */

function grab(): void {
  const ids = [
    'sdStatus', 'sdModeToggle', 'sdSideToggle', 'sdClearSessions', 'sdNewSession', 'sdSettingsBtn',
    'sdSidebar', 'sdSessionList', 'sdSessionCount', 'sdMessages', 'sdInput', 'sdSend', 'sdStop',
    'sdToolsBar', 'sdToolPop', 'sdModelLabel', 'sdWsHint', 'sdThemeBtn', 'sdWorkspaceBtn',
    'sdWorkspaceLabel', 'sdModelList', 'sdToast',
    'sdUpdate', 'sdUpdateText', 'sdUpdateBar', 'sdUpdateAction', 'sdUpdateDismiss',
    'sdUpdateCheck', 'sdUpdateVersion', 'sdUpdateNote',
    // settings dialog
    'sdSettings', 'sdSettingsClose', 'sdSettingsLock', 'sdSettingsLockText',
    'sdProviderList', 'sdProviderSub', 'sdCustomWrap', 'sdCustomBaseUrl', 'sdWirePills',
    'sdKeySub', 'sdKeyBadge', 'sdApiKey', 'sdKeyToggle', 'sdKeyNote', 'sdKeyClear',
    'sdSave', 'sdSaveMain', 'sdTest', 'sdTestResult',
    'sdNotice', 'sdNoticeIcon', 'sdNoticeText', 'sdNoticeAction',
    'sdModelSub', 'sdFetchModels', 'sdModelCount', 'sdModel', 'sdModelAdd', 'sdModelListBox', 'sdModelNote',
    'sdSystem', 'sdMaxTokens', 'sdTemp',
    'sdThemeSub', 'sdThemeLight', 'sdThemeDark', 'sdModeDev', 'sdModePlan',
    'sdKeyProtection'
  ];
  for (const id of ids) {
    const node = document.getElementById(id);
    if (node) el[id] = node;
  }
}

/* --------------------------------------------------------------- helpers - */

function icon(name: string, cls = 'ic'): string {
  return `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}" /></svg>`;
}

/**
 * The SelfDev mark, drawn from res/drawable/ic_selfdev_logo.xml.
 *
 * Deliberately not part of the inline icon sprite: a gradient referenced from
 * inside a `display:none` <svg> never paints, so the badge has to arrive as a
 * visible <svg> carrying its own paint server. Every instance gets its own
 * gradient id so several can coexist on one page.
 */
let markSeq = 0;
function logoSvg(cls = 'sd-mark-empty'): string {
  const id = `sdLogoGradient${(markSeq += 1)}`;
  return `<svg class="${cls}" viewBox="0 0 100 100" aria-hidden="true">
    <defs>
      <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#4F46E5" />
        <stop offset="0.5" stop-color="#2563EB" />
        <stop offset="1" stop-color="#06B6D4" />
      </linearGradient>
    </defs>
    <path d="M28 0h44c15.46 0 28 12.54 28 28v44c0 15.46-12.54 28-28 28H28C12.54 100 0 87.46 0 72V28C0 12.54 12.54 0 28 0Z" fill="url(#${id})" />
    <path d="M26 50 36 38M26 50l10 12M74 50 64 38M74 50 64 62" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M50 28 52.2 39.5 63 42 52.2 44.5 50 56 47.8 44.5 37 42 47.8 39.5Z" fill="#F8FAFC" />
    <circle cx="50" cy="68" r="3.5" fill="#A5F3FC" />
  </svg>`;
}

/** Fills every `[data-mark]` placeholder in the static markup. */
function paintMarks(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-mark]').forEach((node) => {
    if (node.querySelector('svg')) return;
    node.innerHTML = logoSvg('sd-mark-plain');
  });
}

function setStatus(text: string, busy = false): void {
  const node = el.sdStatus as HTMLElement | undefined;
  if (!node) return;
  node.textContent = text;
  node.classList.toggle('busy', busy);
}

let toastTimer: NodeJS.Timeout | null = null;
function toast(message: string, kind: 'ok' | 'bad' | 'plain' = 'plain'): void {
  const node = el.sdToast as HTMLElement | undefined;
  if (!node) return;
  node.textContent = message;
  node.className = `sd-toast show${kind === 'plain' ? '' : ` ${kind}`}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.className = 'sd-toast';
  }, 2600);
}

function shortPath(p: string): string {
  const home = /^\/home\/[^/]+/;
  return p.replace(home, '~').length > 46 ? `…${p.slice(-44)}` : p.replace(home, '~');
}

function nearBottom(): boolean {
  const m = el.sdMessages as HTMLElement | undefined;
  if (!m) return true;
  return m.scrollHeight - m.scrollTop - m.clientHeight < 120;
}

function scrollToBottom(force = false): void {
  const m = el.sdMessages as HTMLElement | undefined;
  if (!m) return;
  if (force || nearBottom()) m.scrollTop = m.scrollHeight;
}

function activeSession(): Session | undefined {
  return ui.sessions.find((s) => s.id === ui.activeSessionId);
}

function autosize(): void {
  const ta = el.sdInput as HTMLTextAreaElement | undefined;
  if (!ta) return;
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(160, Math.max(42, ta.scrollHeight))}px`;
}

/* ---------------------------------------------------------------- render - */

function renderWorkspace(): void {
  const btn = el.sdWorkspaceBtn as HTMLButtonElement | undefined;
  const label = el.sdWorkspaceLabel as HTMLElement | undefined;
  const hint = el.sdWsHint as HTMLElement | undefined;
  if (btn && label) {
    if (ui.workspaceRoot) {
      label.textContent = shortPath(ui.workspaceRoot);
      btn.title = `${ui.workspaceRoot}\nKlik untuk ganti · klik kanan untuk buka di file manager`;
      btn.classList.remove('sd-chip-warn');
    } else {
      label.textContent = 'Pilih workspace…';
      btn.title = 'Tools baca/tulis/edit/grep/glob butuh folder workspace';
      btn.classList.add('sd-chip-warn');
    }
  }
  if (hint) {
    hint.innerHTML = ui.workspaceRoot
      ? ` · workspace: <b>${escapeHtml(shortPath(ui.workspaceRoot))}</b>`
      : ' · <span class="sd-hint-warn">workspace belum dipilih</span>';
  }
}

function renderHeader(): void {
  const label = el.sdModelLabel as HTMLElement | undefined;
  if (label) label.textContent = ui.config.model || '—';
  const toggle = el.sdModeToggle as HTMLButtonElement | undefined;
  if (toggle) {
    toggle.textContent = ui.workspaceMode === 'dev' ? 'Dev' : 'Plan';
    toggle.classList.toggle('plan', ui.workspaceMode === 'plan');
    toggle.title =
      ui.workspaceMode === 'dev'
        ? 'Mode Dev — tools aktif. Klik untuk pindah ke Plan (tanya-jawab saja).'
        : 'Mode Plan — tanya-jawab saja. Klik untuk kembali ke Dev (tools aktif).';
  }
  const send = el.sdSend as HTMLButtonElement | undefined;
  const stop = el.sdStop as HTMLButtonElement | undefined;
  if (send && stop) {
    stop.style.display = ui.running ? 'inline-flex' : 'none';
    send.style.display = ui.running ? 'none' : 'inline-flex';
  }
}

function renderSessions(): void {
  const list = el.sdSessionList as HTMLElement | undefined;
  const count = el.sdSessionCount as HTMLElement | undefined;
  if (!list) return;
  if (count) count.textContent = String(ui.sessions.length);

  if (!ui.sessions.length) {
    list.innerHTML = '<div class="sd-session-empty">Belum ada sesi</div>';
    return;
  }

  list.innerHTML = '';
  for (const s of ui.sessions) {
    const row = document.createElement('div');
    row.className = `sd-session${s.id === ui.activeSessionId ? ' active' : ''}`;
    row.title = `${s.title}\n${s.model} · ${new Date(s.updatedAt).toLocaleString('id-ID')}\nKlik untuk buka · klik ganda untuk rename`;
    row.innerHTML = `
      <div class="sd-session-main">
        <div class="sd-session-title">${escapeHtml(s.title)}</div>
        <div class="sd-session-meta">${escapeHtml(s.model)} · ${new Date(s.updatedAt).toLocaleDateString('id-ID', { day: '2-digit', month: 'short' })}</div>
      </div>
      <button class="sd-session-del" type="button" title="Hapus sesi">${icon('trash', 'ic ic-sm')}</button>`;

    row.querySelector('.sd-session-main')?.addEventListener('click', () => void switchTo(s.id));
    row.querySelector<HTMLButtonElement>('.sd-session-del')?.addEventListener('click', (e) => {
      e.stopPropagation();
      void removeSession(s);
    });
    row.addEventListener('dblclick', (e) => {
      e.preventDefault();
      void renameSession(s);
    });
    list.appendChild(row);
  }
}

function renderEmpty(): void {
  const m = el.sdMessages as HTMLElement | undefined;
  if (!m) return;
  const ws = ui.workspaceRoot ? shortPath(ui.workspaceRoot) : 'belum dipilih';
  m.innerHTML = `
    <div class="sd-empty">
      <div class="sd-empty-badge">${logoSvg()}</div>
      <h3>SelfDev · AI Developer Console</h3>
      <p>Asisten coding opencode-style. API key disimpan lokal (BYOK), tools berjalan di proses native.</p>
      <div class="sd-empty-suggest">
        <button type="button" data-prompt="Jelaskan struktur project ini: gunakan list_dir lalu ringkas isinya">🔍 Eksplorasi workspace</button>
        <button type="button" data-prompt="Buat function debounce di JavaScript beserta contoh penggunaannya">⚡ Tulis snippet kode</button>
        <button type="button" data-prompt="Buat file hello.py berisi program hello world, lalu jalankan dengan run_code">▶️ Buat &amp; jalankan kode</button>
        <button type="button" data-prompt="Jelaskan cara kerja RAG untuk chatbot, lengkap dengan sumber yang jelas">📚 Jelaskan konsep</button>
      </div>
      <div class="sd-empty-note">
        mode: <b>${ui.workspaceMode === 'dev' ? 'Dev — tools aktif' : 'Plan — tanya-jawab saja'}</b> ·
        model: <b>${escapeHtml(ui.config.model || '—')}</b> ·
        workspace: <b>${escapeHtml(ws)}</b>
      </div>
    </div>`;

  m.querySelectorAll<HTMLButtonElement>('.sd-empty-suggest button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ta = el.sdInput as HTMLTextAreaElement;
      ta.value = btn.dataset.prompt ?? '';
      autosize();
      ta.focus();
    });
  });
}

function toolItem(call: ToolCallRecord, result?: ToolResultRecord): HTMLElement {
  const item = document.createElement('div');
  item.className = 'sd-tool';
  item.dataset.callId = call.id;
  item.innerHTML = `
    <div class="sd-tool-row">
      <span class="sd-tool-icon">${icon(iconFor(call.name), 'ic ic-sm')}</span>
      <span class="sd-tool-name">${escapeHtml(call.name)}</span>
      <span class="sd-tool-state">${result ? '' : `<span class="sd-spin">${icon('spinner', 'ic')}</span>`}</span>
      <button class="sd-tool-toggle" type="button" title="Lihat detail">${icon('chevron', 'ic ic-sm')}</button>
    </div>
    <div class="sd-tool-detail">
      <b>arguments</b><pre>${escapeHtml(JSON.stringify(call.arguments ?? {}, null, 2))}</pre>
      <b>result</b><pre class="sd-tool-out"></pre>
    </div>`;
  item.querySelector('.sd-tool-toggle')?.addEventListener('click', () => item.classList.toggle('open'));
  if (result) {
    const out = item.querySelector('.sd-tool-out');
    if (out) {
      out.textContent = result.content ?? '';
      out.classList.toggle('err', Boolean(result.isError));
    }
    paintToolState(item, result.isError ? 'bad' : 'ok');
  }
  return item;
}

function paintToolState(item: HTMLElement, kind: 'ok' | 'bad' | 'run'): void {
  const node = item.querySelector('.sd-tool-state');
  if (!node) return;
  if (kind === 'run') {
    node.innerHTML = `<span class="sd-spin">${icon('spinner', 'ic')}</span>`;
  } else if (kind === 'ok') {
    node.innerHTML = `<span class="ok">${icon('check', 'ic')}</span>`;
  } else {
    node.innerHTML = `<span class="bad">${icon('x', 'ic')}</span>`;
  }
}

function taskCard(text: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'sd-task';
  const title = text ? text.replace(/\s+/g, ' ').trim().slice(0, 90) : 'Mengerjakan tugas…';
  card.innerHTML = `
    <div class="sd-task-head">
      <span class="sd-task-avatar">◆</span>
      <span class="sd-task-title" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
      <span class="sd-task-state thinking">berpikir…</span>
      <button class="sd-task-copy" type="button" title="Salin jawaban">${icon('copy', 'ic ic-sm')}</button>
    </div>
    <div class="sd-tools-list"></div>
    <div class="sd-task-text"></div>`;
  card.querySelector('.sd-task-copy')?.addEventListener('click', () => {
    const raw = (card.querySelector('.sd-task-text') as HTMLElement | null)?.dataset.raw ?? '';
    void navigator.clipboard.writeText(raw).then(
      () => toast('Jawaban disalin', 'ok'),
      () => toast('Gagal menyalin', 'bad')
    );
  });
  return card;
}

function setTaskState(card: HTMLElement, state: string, text: string): void {
  const chip = card.querySelector('.sd-task-state');
  if (!chip) return;
  chip.className = `sd-task-state ${state}`;
  chip.textContent = text;
}

function appendTaskText(card: HTMLElement, chunk: string): void {
  const box = card.querySelector('.sd-task-text') as HTMLElement | null;
  if (!box) return;
  box.dataset.raw = `${box.dataset.raw ?? ''}${chunk}`;
  box.innerHTML = renderMarkdown(box.dataset.raw);
  scrollToBottom();
}

function renderMessages(): void {
  const m = el.sdMessages as HTMLElement | undefined;
  if (!m) return;
  const session = activeSession();

  if (!session || !session.messages.length) {
    renderEmpty();
    return;
  }

  m.innerHTML = '';
  for (const msg of session.messages) {
    if (msg.role === 'user') {
      m.insertAdjacentHTML(
        'beforeend',
        `<div class="sd-user"><div class="sd-user-label">${icon('user', 'ic ic-xs')} Anda</div><div class="sd-user-content">${renderMarkdown(msg.text)}</div></div>`
      );
      continue;
    }
    const card = taskCard(msg.text ?? '');
    const errored = (msg.tool_results ?? []).some((r) => r.isError);
    setTaskState(card, 'done', 'selesai');
    appendTaskText(card, msg.text ?? '');
    const list = card.querySelector('.sd-tools-list');
    for (const call of msg.tool_calls ?? []) {
      const res = (msg.tool_results ?? []).find((r) => r.tool_call_id === call.id);
      list?.appendChild(toolItem(call, res));
    }
    if (errored) setTaskState(card, 'done', 'selesai (ada tool error)');
    m.appendChild(card);
  }
  scrollToBottom(true);
}

function renderToolChips(): void {
  const bar = el.sdToolsBar as HTMLElement | undefined;
  if (!bar) return;
  if (ui.workspaceMode === 'plan') {
    bar.innerHTML = `<span class="sd-chip" style="cursor:default;opacity:.7">Mode Plan — tools dinonaktifkan</span>`;
    return;
  }
  bar.innerHTML = ui.tools
    .map((t) => `<button class="sd-chip" type="button" data-tool="${escapeHtml(t.name)}" title="${escapeHtml(t.description)}">${icon(iconFor(t.name), 'ic ic-sm')}${escapeHtml(t.name)}</button>`)
    .join('');
  bar.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ta = el.sdInput as HTMLTextAreaElement;
      ta.value += `${ta.value && !ta.value.endsWith(' ') ? ' ' : ''}@${btn.dataset.tool} `;
      autosize();
      ta.focus();
    });
  });
}

function iconFor(tool: string): string {
  const map: Record<string, string> = {
    read_file: 'file',
    write_file: 'file-pen',
    edit_file: 'edit-square',
    list_dir: 'folder-open',
    grep: 'search',
    glob: 'graph',
    run_code: 'terminal',
    web_search: 'globe',
    web_fetch: 'link'
  };
  return map[tool] ?? 'wrench';
}

/* --------------------------------------------------------------- actions - */

async function refresh(fromMain = true): Promise<void> {
  if (fromMain) {
    const state = await bridge.getState();
    ui.config = state.config;
    ui.sessions = state.sessions;
    ui.activeSessionId = state.activeSessionId;
    ui.workspaceRoot = state.workspaceRoot;
    ui.workspaceMode = state.workspaceMode;
    ui.keyProtection = state.keyProtection ?? ui.keyProtection;
    if (state.tools?.length) ui.tools = state.tools;
  }
  renderSessions();
  renderHeader();
  renderWorkspace();
  renderToolChips();
  renderMessages();
}

async function send(text: string): Promise<void> {
  const clean = text.trim();
  if (!clean || ui.running) return;

  const session = activeSession();
  if (!session) return;

  // optimistic local echo so the bubble appears instantly
  ui.raw = '';
  session.messages.push({ role: 'user', text: clean, createdAt: Date.now() });
  session.updatedAt = Date.now();
  ui.running = true;
  ui.runSessionId = session.id;

  renderSessions();
  renderMessages();

  const m = el.sdMessages as HTMLElement;
  const card = taskCard('');
  m.appendChild(card);
  const textBox = card.querySelector('.sd-task-text') as HTMLElement;
  textBox.classList.add('sd-cursor');
  scrollToBottom(true);

  renderHeader();
  setStatus('mengirim…', true);

  try {
    await bridge.sendMessage(clean);
  } catch (err) {
    toast(`Gagal mengirim: ${messageOf(err)}`, 'bad');
    ui.running = false;
    renderHeader();
    await refresh();
  }
}

async function stopRun(): Promise<void> {
  await bridge.stopRun();
  setStatus('menghentikan…', true);
}

async function switchTo(id: string): Promise<void> {
  if (id === ui.activeSessionId) return;
  ui.activeSessionId = id;
  await bridge.switchSession(id);
  await refresh(false);
}

async function removeSession(session: Session): Promise<void> {
  if (ui.sessions.length <= 1) {
    toast('Minimal satu sesi harus ada', 'bad');
    return;
  }
  ui.sessions = ui.sessions.filter((s) => s.id !== session.id);
  await bridge.deleteSession(session.id);
  if (ui.activeSessionId === session.id) ui.activeSessionId = ui.sessions[0]?.id ?? null;
  await refresh(false);
}

async function renameSession(session: Session): Promise<void> {
  const next = window.prompt('Judul sesi', session.title);
  if (next === null) return;
  const title = next.trim();
  if (!title) return;
  session.title = title.slice(0, 120);
  await bridge.renameSession(session.id, title);
  await refresh(false);
}

async function newSession(): Promise<void> {
  const created = await bridge.newSession();
  ui.sessions.unshift(created);
  ui.activeSessionId = created.id;
  await refresh(false);
  (el.sdInput as HTMLTextAreaElement).focus();
}

async function pickWorkspace(): Promise<void> {
  const root = await bridge.pickWorkspace();
  if (!root) return;
  ui.workspaceRoot = root;
  renderWorkspace();
  toast(`Workspace: ${shortPath(root)}`, 'ok');
}

async function toggleTheme(): Promise<void> {
  const dark = !document.body.classList.contains('dark');
  applyTheme(dark);
  await bridge.setTheme(dark ? 'dark' : 'light');
}

function applyTheme(dark: boolean): void {
  document.body.classList.toggle('dark', dark);
  const btn = el.sdThemeBtn as HTMLElement | undefined;
  if (btn) btn.innerHTML = icon(dark ? 'sun' : 'moon', 'ic');
}

/* ------------------------------------------------------------------ run -- */

function handleRunEvent(evt: RunEvent): void {
  const m = el.sdMessages as HTMLElement;
  const card = m.querySelector('.sd-task:last-of-type') as HTMLElement | null;

  switch (evt.type) {
    case 'started': {
      ui.running = true;
      renderHeader();
      setStatus('berpikir…', true);
      break;
    }
    case 'text': {
      if (ui.activeSessionId !== ui.runSessionId) break;
      const box = card?.querySelector('.sd-task-text') as HTMLElement | null;
      if (box) {
        box.dataset.raw = `${box.dataset.raw ?? ''}${evt.text}`;
        box.innerHTML = renderMarkdown(box.dataset.raw);
      }
      if (card) setTaskState(card, 'thinking', 'menulis…');
      setStatus('mengambil respons…', true);
      scrollToBottom();
      break;
    }
    case 'tool_start': {
      if (ui.activeSessionId !== ui.runSessionId || !card) break;
      if (card.querySelector(`.sd-tool[data-call-id="${cssEscape(evt.id)}"]`)) break;
      card.querySelector('.sd-tools-list')?.appendChild(
        toolItem({ id: evt.id, name: evt.name, arguments: {} })
      );
      setTaskState(card, 'tool', `memakai ${evt.name}…`);
      setStatus(`menjalankan ${evt.name}…`, true);
      scrollToBottom();
      break;
    }
    case 'tool_end': {
      if (ui.activeSessionId !== ui.runSessionId || !card) break;
      const item = card.querySelector(`.sd-tool[data-call-id="${cssEscape(evt.id)}"]`) as HTMLElement | null;
      if (item) {
        if (evt.arguments) {
          const pre = item.querySelector('.sd-tool-detail pre') as HTMLElement | null;
          if (pre) pre.textContent = JSON.stringify(evt.arguments, null, 2);
        }
        const out = item.querySelector('.sd-tool-out') as HTMLElement | null;
        if (out) {
          out.textContent = evt.content;
          out.classList.toggle('err', evt.isError);
        }
        paintToolState(item, evt.isError ? 'bad' : 'ok');
      }
      scrollToBottom();
      break;
    }
    case 'finished': {
      ui.running = false;
      ui.runSessionId = null;
      renderHeader();
      if (card) {
        card.querySelector('.sd-task-text')?.classList.remove('sd-cursor');
        const label =
          evt.status === 'error'
            ? 'error'
            : evt.status === 'stopped'
              ? 'dihentikan'
              : evt.status === 'max_iterations'
                ? 'maks iterasi tercapai'
                : 'selesai';
        setTaskState(card, evt.status === 'error' ? 'error' : evt.status === 'stopped' ? 'stopped' : evt.status === 'max_iterations' ? 'max_iterations' : 'done', label);
      }
      setStatus(evt.status === 'error' ? 'error' : evt.status === 'stopped' ? 'dihentikan' : 'idle', evt.status === 'error');
      // pull the authoritative, persisted conversation back from main
      void refresh().catch((err) => toast(`Gagal refresh: ${messageOf(err)}`, 'bad'));
      break;
    }
  }
}

/* -------------------------------------------------------------- settings - */

/**
 * Everything the settings dialog edits, kept apart from `ui.config` so a
 * half-finished setup never leaks into the running app before it is saved.
 */
interface SettingsForm {
  provider: ProviderId;
  customBaseUrl: string;
  customWireApi: WireApi;
  apiKey: string;
  /** The saved key, so KEY SAVED stays truthful while a new one is being typed. */
  savedKey: string;
  keyDirty: boolean;
  keyVisible: boolean;
  model: string;
  catalogue: ModelEntry[];
  busy: 'save' | 'test' | 'models' | null;
}

const form: SettingsForm = {
  provider: 'groq',
  customBaseUrl: '',
  customWireApi: 'OPENAI_CHAT',
  apiKey: '',
  savedKey: '',
  keyDirty: false,
  keyVisible: false,
  model: '',
  catalogue: [],
  busy: null
};

function settingsOpen(): boolean {
  return el.sdSettings.classList.contains('open');
}

/** True while a request is in flight; the dialog may not be dismissed then. */
function settingsBusy(): boolean {
  return form.busy !== null;
}

function setBusy(kind: SettingsForm['busy'], label = 'memproses…'): void {
  form.busy = kind;
  const lock = el.sdSettingsLock as HTMLElement | undefined;
  const text = el.sdSettingsLockText as HTMLElement | undefined;
  if (lock) lock.hidden = kind === null;
  if (text) text.textContent = label;
  el.sdSettings.classList.toggle('busy', kind !== null);
  const save = el.sdSave as HTMLButtonElement | undefined;
  const saveMain = el.sdSaveMain as HTMLButtonElement | undefined;
  const test = el.sdTest as HTMLButtonElement | undefined;
  const fetchBtn = el.sdFetchModels as HTMLButtonElement | undefined;
  const add = el.sdModelAdd as HTMLButtonElement | undefined;
  const clear = el.sdKeyClear as HTMLButtonElement | undefined;
  if (save) save.disabled = kind !== null;
  if (saveMain) saveMain.disabled = kind !== null;
  if (test) test.disabled = kind !== null;
  if (fetchBtn) fetchBtn.disabled = kind !== null;
  if (add) add.disabled = kind !== null;
  if (clear) clear.disabled = kind !== null;
}

type NoticeLevel = 'info' | 'ok' | 'warn' | 'bad' | 'billing';

const NOTICE_ICON: Record<NoticeLevel, string> = {
  info: 'info',
  ok: 'check-circle',
  warn: 'alert',
  bad: 'x',
  billing: 'wallet'
};

let noticeUrl: string | null = null;

/** One inline line under the API key, with an optional action (e.g. billing). */
function notice(level: NoticeLevel, text: string, actionLabel?: string, actionUrl?: string): void {
  const box = el.sdNotice as HTMLElement | undefined;
  const iconNode = el.sdNoticeIcon as HTMLElement | undefined;
  const textNode = el.sdNoticeText as HTMLElement | undefined;
  const action = el.sdNoticeAction as HTMLButtonElement | undefined;
  if (!box || !iconNode || !textNode || !action) return;
  noticeUrl = actionUrl ?? null;
  box.hidden = false;
  box.className = `sd-notice ${level}`;
  iconNode.innerHTML = icon(NOTICE_ICON[level], 'ic ic-sm');
  textNode.textContent = text;
  if (actionLabel && actionUrl) {
    action.hidden = false;
    action.textContent = actionLabel;
  } else {
    action.hidden = true;
  }
}

function clearNotice(): void {
  noticeUrl = null;
  const box = el.sdNotice as HTMLElement | undefined;
  if (box) box.hidden = true;
}

function setTestResult(text: string, kind: 'ok' | 'bad' | ''): void {
  const node = el.sdTestResult as HTMLElement | undefined;
  if (!node) return;
  node.textContent = text;
  node.className = `sd-test-result${kind ? ` ${kind}` : ''}`;
}

function currentPreset(): ProviderPreset {
  return presetFor(form.provider);
}

function requiresKey(): boolean {
  const preset = currentPreset();
  if (preset.isLocal) return false;
  return preset.id !== 'custom' || !isLoopback(normalizeBaseUrl(form.customBaseUrl));
}

function activeBaseUrl(): string {
  const preset = currentPreset();
  return preset.id === 'custom' ? normalizeBaseUrl(form.customBaseUrl) : preset.baseUrl;
}

// ------------------------------------------------------------- provider list

function renderProviders(): void {
  const list = el.sdProviderList as HTMLElement | undefined;
  if (!list) return;

  list.innerHTML = ui.presets
    .map((preset) => {
      const on = preset.id === form.provider;
      const badge = preset.isLocal
        ? '<span class="sd-chip-mini local">LOKAL</span>'
        : preset.envVar
          ? `<span class="sd-chip-mini env">${escapeHtml(preset.envVar)}</span>`
          : '';
      const sub = preset.isLocal || preset.id === 'custom' ? escapeHtml(preset.baseUrl || 'base URL diisi manual') : '';
      return `
        <button class="sd-radio${on ? ' on' : ''}" type="button" role="radio" aria-checked="${on}" data-provider="${preset.id}">
          <span class="sd-radio-mark">${on ? icon('check', 'ic ic-xs') : ''}</span>
          <span class="sd-radio-main">
            <span class="sd-radio-label">${escapeHtml(preset.label)} ${badge}</span>
            ${sub ? `<span class="sd-radio-sub">${sub}</span>` : ''}
          </span>
          <span class="sd-radio-wire">${escapeHtml(preset.wireApi.replace('_', ' '))}</span>
        </button>`;
    })
    .join('');

  list.querySelectorAll<HTMLButtonElement>('[data-provider]').forEach((btn) => {
    btn.addEventListener('click', () => selectProvider(btn.dataset.provider as ProviderId));
  });

  const wrap = el.sdCustomWrap as HTMLElement | undefined;
  if (wrap) wrap.hidden = currentPreset().id !== 'custom';
  renderWirePills();

  const sub = el.sdProviderSub as HTMLElement | undefined;
  if (sub) {
    const preset = currentPreset();
    sub.textContent = preset.id === 'custom' ? activeBaseUrl() || 'base URL belum diisi' : preset.label;
  }
}

/**
 * Switching provider resets the model and the discovered catalogue, because both
 * belong to the provider that was just left.
 */
function selectProvider(id: ProviderId): void {
  if (!ui.presets.some((p) => p.id === id) || id === form.provider) return;
  form.provider = id;
  form.catalogue = [];
  form.model = defaultModelFor(id, form.customBaseUrl);
  (el.sdModel as HTMLInputElement).value = form.model;
  clearNotice();
  setTestResult('', '');
  renderProviders();
  renderModels();
  renderKeyBadge();
}

/** The wire format of a custom gateway, which is not implied by its URL. */
function renderWirePills(): void {
  const box = el.sdWirePills as HTMLElement | undefined;
  if (!box) return;
  box.innerHTML = WIRE_APIS.map(
    (wire) => `<button class="sd-pill${wire === form.customWireApi ? ' is-on' : ''}" type="button" role="radio" aria-checked="${
      wire === form.customWireApi
    }" data-wire="${wire}">${escapeHtml(WIRE_API_LABEL[wire])}</button>`
  ).join('');
  box.querySelectorAll<HTMLButtonElement>('[data-wire]').forEach((btn) => {
    btn.addEventListener('click', () => {
      form.customWireApi = btn.dataset.wire as WireApi;
      renderWirePills();
    });
  });
}

function renderKeyBadge(): void {
  const badge = el.sdKeyBadge as HTMLElement | undefined;
  const sub = el.sdKeySub as HTMLElement | undefined;
  const note = el.sdKeyNote as HTMLElement | undefined;
  const clear = el.sdKeyClear as HTMLButtonElement | undefined;
  if (!badge) return;

  const needed = requiresKey();
  const saved = form.savedKey !== '';

  badge.hidden = !needed;
  badge.textContent = saved ? 'KEY SAVED' : 'KEY EMPTY';
  badge.className = `sd-badge${saved ? ' ok' : ' empty'}`;

  if (sub) {
    sub.textContent = !needed
      ? 'provider lokal — tanpa API key'
      : saved
        ? `${currentPreset().label} · tersimpan`
        : `${currentPreset().label} · belum diisi`;
  }
  if (clear) clear.hidden = !saved;

  if (note) {
    note.textContent = ui.keyProtection === 'keychain'
      ? 'Disimpan terenkripsi lewat keychain sistem (safeStorage) di state.json. Tidak pernah dikirim ke server kami.'
      : 'Keychain sistem tidak tersedia di mesin ini, jadi key disimpan apa adanya di state.json folder data aplikasi.';
  }
}

// --------------------------------------------------------------- model list

function modelCatalogue(): ModelEntry[] {
  return form.catalogue;
}

function renderModels(): void {
  const box = el.sdModelListBox as HTMLElement | undefined;
  const list = el.sdModelList as HTMLDataListElement | undefined;
  if (!box) return;

  const preset = currentPreset();
  const catalogue = modelCatalogue();
  const entries = new Map(catalogue.map((m) => [m.id, m]));
  // One pass: every model is ranked against the same peer price set.
  const economies = economiesFor(catalogue);
  const ids = rankedModels(catalogue.map((m) => m.id), preset.suggestedModels);

  if (list) list.innerHTML = ids.map((m) => `<option value="${escapeHtml(m)}"></option>`).join('');

  const sub = el.sdModelSub as HTMLElement | undefined;
  if (sub) sub.textContent = form.model || 'belum dipilih';

  const count = el.sdModelCount as HTMLElement | undefined;
  if (count) {
    count.hidden = !catalogue.length;
    count.textContent = `${catalogue.length} diambil`;
    count.className = 'sd-badge';
  }

  const note = el.sdModelNote as HTMLElement | undefined;
  if (note) {
    note.textContent = catalogue.length
      ? 'Harga & konteks dibaca dari /models provider saat ini.'
      : 'Klik model untuk aktifkan, atau ketik id lalu tekan tambah.';
  }

  if (!ids.length) {
    box.innerHTML = `<p class="sd-empty-note">${
      supportsDiscovery(preset, form.customBaseUrl)
        ? 'Klik "Ambil daftar model" untuk membaca katalog provider.'
        : 'Provider ini tidak punya daftar bawaan — ketik id model secara manual.'
    }</p>`;
    return;
  }

  box.innerHTML = ids
    .map((id) => {
      const entry = entries.get(id);
      const on = id === form.model;
      // Suggested models the provider did not price still get an id estimate.
      const economy = economies.get(id) ?? estimateEconomy(id);
      const live = economy.basis === 'LIVE_PRICE';
      const priceIn = formatPrice(economy.inputPerMTok, live);
      const priceOut = formatPrice(economy.outputPerMTok, live);
      const price = priceIn && priceOut ? `${priceIn} / ${priceOut}` : priceIn ?? priceOut;
      const tier = isBadgeWorthy(economy) ? `<span class="sd-tier ${economy.tier.toLowerCase()}">${tierGlyph(economy.tier)}</span>` : '';
      const ctx = entry?.contextLength ? ` · ${Math.round(entry.contextLength / 1024)}k ctx` : '';
      const title = [
        id,
        price ? `harga $${price} per juta token` : 'harga tidak dipublikasikan',
        economy.basis === 'SIZE_ESTIMATE' ? 'perkiraan dari nama model' : economy.basis === 'UNKNOWN' ? '' : '',
        entry?.contextLength ? `konteks ${entry.contextLength} token` : ''
      ]
        .filter(Boolean)
        .join('\n');
      return `
        <button class="sd-model-row${on ? ' on' : ''}" type="button" data-model="${escapeHtml(id)}" title="${escapeHtml(title)}">
          <span class="sd-radio-mark">${on ? icon('check', 'ic ic-xs') : ''}</span>
          <span class="sd-model-id">${escapeHtml(id)}</span>
          <span class="sd-model-meta">${escapeHtml(price ?? '')}${escapeHtml(ctx)}</span>
          ${tier}
          ${on ? '<span class="sd-model-active">AKTIF</span>' : ''}
        </button>`;
    })
    .join('');

  box.querySelectorAll<HTMLButtonElement>('[data-model]').forEach((btn) => {
    btn.addEventListener('click', () => {
      form.model = btn.dataset.model ?? '';
      (el.sdModel as HTMLInputElement).value = form.model;
      form.keyDirty = false;
      clearNotice();
      renderModels();
      syncManualModelState();
    });
  });
}

function syncManualModelState(): void {
  const manual = (el.sdModel as HTMLInputElement | undefined)?.value.trim() ?? '';
  const add = el.sdModelAdd as HTMLButtonElement | undefined;
  if (add) add.hidden = !manual || manual === form.model;
}

// ------------------------------------------------------------------ actions

function readForm(): Partial<AppConfig> {
  return {
    provider: form.provider,
    customBaseUrl: form.customBaseUrl,
    customWireApi: form.customWireApi,
    apiKey: form.apiKey,
    model: form.model,
    maxTokens: Number((el.sdMaxTokens as HTMLInputElement).value),
    temperature: Number((el.sdTemp as HTMLInputElement).value),
    system: (el.sdSystem as HTMLTextAreaElement).value
  };
}

async function saveSettings(): Promise<void> {
  if (settingsBusy()) return;
  const preset = currentPreset();
  if (preset.id === 'custom' && !activeBaseUrl()) {
    notice('bad', 'Base URL gateway kustom masih kosong.');
    setTestResult('', '');
    return;
  }

  setBusy('save', 'menyimpan…');
  try {
    const state = await bridge.saveConfig(readForm());
    ui.config = state.config;
    ui.sessions = state.sessions;
    ui.activeSessionId = state.activeSessionId;
    ui.keyProtection = state.keyProtection;
    // Normalisation happens in the main process; adopt what it decided.
    form.savedKey = state.config.apiKey;
    form.apiKey = state.config.apiKey;
    form.customBaseUrl = state.config.customBaseUrl;
    form.customWireApi = state.config.customWireApi;
    form.model = state.config.model;
    form.keyDirty = false;
    (el.sdCustomBaseUrl as HTMLInputElement).value = state.config.customBaseUrl;
    (el.sdApiKey as HTMLInputElement).value = state.config.apiKey;
    (el.sdModel as HTMLInputElement).value = state.config.model;
    (el.sdMaxTokens as HTMLInputElement).value = String(state.config.maxTokens);
    (el.sdTemp as HTMLInputElement).value = String(state.config.temperature);
    renderProviders();
    renderModels();
    renderKeyBadge();
    setTestResult('✔ Pengaturan tersimpan', 'ok');
    toast('Pengaturan disimpan', 'ok');
    closeSettings();
    renderHeader();
    renderSessions();
  } catch (err) {
    notice('bad', `Gagal menyimpan: ${messageOf(err)}`);
    setTestResult(`✘ ${messageOf(err)}`, 'bad');
  } finally {
    setBusy(null);
  }
}

async function testConnection(): Promise<void> {
  if (settingsBusy()) return;
  if (requiresKey() && !form.apiKey.trim()) {
    notice('warn', 'Isi API key dulu, atau pilih provider lokal.');
    setTestResult('', '');
    return;
  }
  const preset = currentPreset();
  if (preset.id === 'custom' && !activeBaseUrl()) {
    notice('bad', 'Base URL gateway kustom masih kosong.');
    setTestResult('', '');
    return;
  }

  setBusy('test', 'menguji…');
  setTestResult('', '');
  clearNotice();
  const test = el.sdTest as HTMLButtonElement | undefined;
  if (test) test.innerHTML = `<span class="sd-spin">${icon('spinner', 'ic ic-sm')}</span> Menguji…`;

  try {
    const res = await bridge.testConnection({
      provider: form.provider,
      customBaseUrl: form.customBaseUrl,
      customWireApi: form.customWireApi,
      apiKey: form.apiKey,
      model: form.model
    });
    setTestResult(`${res.ok ? '✔' : '✘'} ${res.message}`, res.ok ? 'ok' : 'bad');

    if (res.ok) {
      notice('ok', `Koneksi berhasil ke ${preset.label}.`);
      return;
    }
    switch (res.kind) {
      case 'AUTH':
        notice('bad', `API key ditolak. ${res.message}`);
        break;
      case 'BILLING':
        notice('billing', `Saldo atau kuota habis. ${res.message}`, 'Buka billing', res.billingUrl ?? undefined);
        break;
      case 'RATE_LIMIT':
        notice('warn', `Rate limit. ${res.message}`);
        break;
      case 'MODEL':
        notice(
          'warn',
          res.suggestedModel ? `Model tidak tersedia di key ini. Coba ${res.suggestedModel}.` : `Model ditolak. ${res.message}`,
          res.suggestedModel ? `Pakai ${res.suggestedModel}` : undefined,
          undefined
        );
        if (res.suggestedModel) el.sdNoticeAction!.dataset.model = res.suggestedModel;
        break;
      case 'TIMEOUT':
        notice('warn', `Koneksi timeout. ${res.message}`);
        break;
      case 'NETWORK':
      case 'TLS':
        notice('bad', `Tidak bisa menghubungi provider. ${res.message}`);
        break;
      case 'SERVER':
        notice('warn', `Provider sedang bermasalah. ${res.message}`);
        break;
      default:
        notice('bad', res.message);
    }
  } catch (err) {
    setTestResult(`✘ ${messageOf(err)}`, 'bad');
    notice('bad', messageOf(err));
  } finally {
    if (test) test.innerHTML = `${icon('speed', 'ic ic-sm')} Tes Koneksi`;
    setBusy(null);
  }
}

async function fetchModels(): Promise<void> {
  if (settingsBusy()) return;
  const preset = currentPreset();
  if (!supportsDiscovery(preset, form.customBaseUrl)) {
    notice('bad', 'Base URL gateway kustom masih kosong.');
    return;
  }
  if (requiresKey() && !form.apiKey.trim()) {
    notice('warn', 'Isi API key dulu — katalog provider butuh autentikasi.');
    return;
  }

  setBusy('models', 'mengambil model…');
  clearNotice();
  const btn = el.sdFetchModels as HTMLButtonElement | undefined;
  if (btn) btn.innerHTML = `<span class="sd-spin">${icon('spinner', 'ic ic-sm')}</span> Mengambil…`;

  try {
    const res = await bridge.fetchModels({
      provider: form.provider,
      customBaseUrl: form.customBaseUrl,
      customWireApi: form.customWireApi,
      apiKey: form.apiKey
    });
    if (res.ok) {
      form.catalogue = res.models;
      const best = repairModelFor(form.provider, res.models.map((m) => m.id));
      if (best && !isModelValidFor(form.provider, form.model, res.models.map((m) => m.id), form.customBaseUrl)) {
        form.model = best;
        (el.sdModel as HTMLInputElement).value = best;
        notice('warn', `Model sebelumnya tidak ada di katalog ini, diganti ke ${best}.`);
      } else {
        notice('ok', `${res.message}.`);
      }
    } else {
      form.catalogue = [];
      if (res.kind === 'BILLING' && res.billingUrl) {
        notice('billing', `Gagal ambil katalog: ${res.message}`, 'Buka billing', res.billingUrl);
      } else {
        notice('bad', `Gagal ambil katalog: ${res.message}`);
      }
    }
    renderModels();
  } catch (err) {
    notice('bad', messageOf(err));
  } finally {
    if (btn) btn.innerHTML = `${icon('refresh', 'ic ic-sm')} Ambil daftar model`;
    setBusy(null);
  }
}

function applyModel(id: string): void {
  form.model = id;
  (el.sdModel as HTMLInputElement).value = id;
  renderModels();
}

function applyThemeButtons(): void {
  const dark = document.body.classList.contains('dark');
  const light = el.sdThemeLight as HTMLButtonElement | undefined;
  const darkBtn = el.sdThemeDark as HTMLButtonElement | undefined;
  if (light) light.classList.toggle('is-on', !dark);
  if (darkBtn) darkBtn.classList.toggle('is-on', dark);
  const sub = el.sdThemeSub as HTMLElement | undefined;
  if (sub) sub.textContent = dark ? 'Tema gelap' : 'Tema terang';
}

function syncModeButtons(): void {
  const dev = el.sdModeDev as HTMLButtonElement | undefined;
  const plan = el.sdModePlan as HTMLButtonElement | undefined;
  if (dev) dev.classList.toggle('is-on', ui.workspaceMode === 'dev');
  if (plan) plan.classList.toggle('is-on', ui.workspaceMode === 'plan');
}

async function openSettings(): Promise<void> {
  const c = ui.config;
  form.provider = c.provider;
  form.customBaseUrl = c.customBaseUrl;
  form.customWireApi = c.customWireApi;
  form.apiKey = c.apiKey;
  form.savedKey = c.apiKey;
  form.keyDirty = false;
  form.keyVisible = false;
  form.model = c.model;
  form.catalogue = [];

  if (!ui.presets.length) {
    try {
      ui.presets = await bridge.getProviders();
    } catch {
      ui.presets = [presetFor(c.provider)];
    }
  }

  (el.sdCustomBaseUrl as HTMLInputElement).value = c.customBaseUrl;
  (el.sdApiKey as HTMLInputElement).value = c.apiKey;
  (el.sdApiKey as HTMLInputElement).type = 'password';
  (el.sdModel as HTMLInputElement).value = c.model;
  (el.sdMaxTokens as HTMLInputElement).value = String(c.maxTokens);
  (el.sdTemp as HTMLInputElement).value = String(c.temperature);
  (el.sdSystem as HTMLTextAreaElement).value = c.system;

  const protection = el.sdKeyProtection as HTMLElement | undefined;
  if (protection) protection.textContent = ui.keyProtection === 'keychain' ? 'Keychain aman' : 'Tanpa keychain';

  clearNotice();
  setTestResult('', '');
  renderProviders();
  renderModels();
  renderKeyBadge();
  paintMarks(el.sdSettings);
  syncManualModelState();
  applyThemeButtons();
  syncModeButtons();
  renderUpdateState(el.sdUpdateVersion ? (update.state ?? blankUpdateState()) : blankUpdateState());

  el.sdSettings.classList.add('open');
  // Always reopen at the top, and take focus without scrolling: a leftover scroll
  // position would hide the provider section, which is where people start, and
  // focusing the model field would scroll straight past it.
  const scroll = el.sdSettings.querySelector('.sd-settings-scroll') as HTMLElement | null;
  if (scroll) scroll.scrollTop = 0;
  setTimeout(() => {
    (el.sdSettings.querySelector('.sd-settings-card') as HTMLElement | null)?.focus({ preventScroll: true });
    if (scroll) scroll.scrollTop = 0;
  }, 30);
}

function closeSettings(): void {
  if (settingsBusy()) return;
  el.sdSettings.classList.remove('open');
}

function blankUpdateState(): UpdatePayload {
  return { phase: 'unsupported', currentVersion: '—', availableVersion: null, progress: 0, message: null };
}

/* ------------------------------------------------------------- tool pop -- */

function updateToolPop(): void {
  const ta = el.sdInput as HTMLTextAreaElement;
  const pop = el.sdToolPop as HTMLElement;
  if (ui.workspaceMode === 'plan') {
    pop.classList.remove('open');
    return;
  }
  const val = ta.value;
  const lastAt = val.lastIndexOf('@');
  const tail = lastAt === -1 ? null : val.slice(lastAt + 1);

  if (tail === null || !/^\w*$/.test(tail)) {
    pop.classList.remove('open');
    return;
  }
  const q = tail.toLowerCase();
  const matches = ui.tools.filter((t) => t.name.toLowerCase().includes(q));
  if (!matches.length) {
    pop.classList.remove('open');
    return;
  }

  pop.innerHTML = matches
    .map(
      (t) =>
        `<button type="button" data-tool="${escapeHtml(t.name)}">${icon(iconFor(t.name), 'ic ic-sm')}${escapeHtml(t.name)}<span>${escapeHtml(t.openDesc)}</span></button>`
    )
    .join('');

  pop.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((btn) => {
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      const name = btn.dataset.tool ?? '';
      const pos = ta.value.lastIndexOf('@');
      ta.value = `${ta.value.slice(0, pos)}@${name} `;
      pop.classList.remove('open');
      autosize();
      ta.focus();
    });
  });
  pop.classList.add('open');
}

/* ---------------------------------------------------------------- utils -- */

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/["\\]/g, '\\$&');
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ------------------------------------------------------------ auto-update -- */

const update = {
  state: null as UpdatePayload | null,
  dismissedVersion: null as string | null
};

function renderUpdateState(s: UpdatePayload): void {
  update.state = s;

  const banner = el.sdUpdate as HTMLElement | undefined;
  const text = el.sdUpdateText as HTMLElement | undefined;
  const bar = el.sdUpdateBar as HTMLElement | undefined;
  const action = el.sdUpdateAction as HTMLButtonElement | undefined;
  const note = el.sdUpdateNote as HTMLElement | undefined;
  const versionLabel = el.sdUpdateVersion as HTMLElement | undefined;

  if (versionLabel) versionLabel.textContent = `v${s.currentVersion}`;
  if (note) {
    note.textContent =
      s.phase === 'unsupported'
        ? 'Pembaruan otomatis tidak tersedia untuk build ini.'
        : s.phase === 'error'
          ? `Gagal cek: ${s.message ?? 'tidak diketahui'}`
          : 'Startup + tiap 6 jam. Klik untuk memasang saat diunduh.';
  }

  if (!banner || !text || !action || !bar) return;

  const show = (label: string, button: string | null, progress: number | null): void => {
    banner.hidden = false;
    text.textContent = label;
    if (button === null) {
      action.hidden = true;
    } else {
      action.hidden = false;
      action.textContent = button;
      action.disabled = false;
    }
    if (progress === null) {
      bar.classList.remove('on');
    } else {
      bar.classList.add('on');
      (bar.firstElementChild as HTMLElement).style.width = `${Math.round(progress * 100)}%`;
    }
  };

  const hide = (): void => {
    banner.hidden = true;
    bar.classList.remove('on');
  };

  switch (s.phase) {
    case 'available': {
      const v = s.availableVersion ?? '';
      if (update.dismissedVersion === v) {
        hide();
        return;
      }
      show(`SelfDev ${v} tersedia`, 'Unduh', null);
      action.onclick = () => void bridge.downloadUpdate();
      return;
    }
    case 'downloading': {
      const pct = Math.round(s.progress * 100);
      action.hidden = true;
      banner.hidden = false;
      text.textContent = `Mengunduh ${s.availableVersion ?? ''}… ${pct}%`;
      bar.classList.add('on');
      (bar.firstElementChild as HTMLElement).style.width = `${pct}%`;
      return;
    }
    case 'downloaded': {
      show(`${s.availableVersion ?? ''} siap dipasang`, 'Mulai ulang & pasang', null);
      action.onclick = () => void bridge.installUpdate();
      return;
    }
    case 'checking': {
      show('Memeriksa pembaruan…', null, null);
      return;
    }
    default:
      hide();
  }
}

async function checkForUpdates(manual: boolean): Promise<void> {
  const btn = el.sdUpdateCheck as HTMLButtonElement | undefined;
  if (btn) btn.disabled = true;
  try {
    const s = await bridge.checkForUpdates();
    if (manual) {
      renderUpdateState(s);
      if (s.phase === 'checking') toast('Memeriksa pembaruan…');
    }
  } catch {
    if (manual) toast('Gagal memeriksa pembaruan', 'bad');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ----------------------------------------------------------------- init -- */

function wireEvents(): void {
  paintMarks();
  const ta = el.sdInput as HTMLTextAreaElement;

  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void sendCurrent();
      return;
    }
    if (e.key === 'Escape') (el.sdToolPop as HTMLElement).classList.remove('open');
  });
  ta.addEventListener('input', () => {
    autosize();
    updateToolPop();
  });
  ta.addEventListener('blur', () => setTimeout(() => (el.sdToolPop as HTMLElement).classList.remove('open'), 180));

  (el.sdSend as HTMLButtonElement).addEventListener('click', () => void sendCurrent());
  (el.sdStop as HTMLButtonElement).addEventListener('click', () => void stopRun());

  (el.sdUpdateCheck as HTMLButtonElement)?.addEventListener('click', () => void checkForUpdates(true));
  (el.sdUpdateDismiss as HTMLButtonElement)?.addEventListener('click', () => {
    const v = update.state?.availableVersion ?? null;
    update.dismissedVersion = v;
    void bridge.skipUpdateVersion(v);
    renderUpdateState({ ...(update.state as UpdatePayload), phase: 'idle', availableVersion: null });
  });

  (el.sdNewSession as HTMLButtonElement).addEventListener('click', () => void newSession());
  (el.sdClearSessions as HTMLButtonElement).addEventListener('click', () => {
    if (ui.running) {
      toast('Hentikan proses dulu', 'bad');
      return;
    }
    if (!window.confirm('Hapus semua sesi dan riwayat chat?')) return;
    void bridge.clearSessions().then(async () => {
      await refresh();
      toast('Semua sesi dihapus', 'ok');
    });
  });

  (el.sdSideToggle as HTMLButtonElement).addEventListener('click', () => {
    (el.sdSidebar as HTMLElement).classList.toggle('hidden');
  });

  (el.sdModeToggle as HTMLButtonElement).addEventListener('click', () => {
    const next: WorkspaceMode = ui.workspaceMode === 'dev' ? 'plan' : 'dev';
    ui.workspaceMode = next;
    void bridge.setMode(next);
    renderHeader();
    renderToolChips();
    renderMessages();
  });

  (el.sdWorkspaceBtn as HTMLButtonElement).addEventListener('click', () => void pickWorkspace());
  el.sdWorkspaceBtn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (ui.workspaceRoot) void bridge.revealWorkspace();
  });

  (el.sdThemeBtn as HTMLButtonElement).addEventListener('click', () => void toggleTheme());

  /* ----------------------------------------------------------- settings -- */

  (el.sdSettingsBtn as HTMLButtonElement).addEventListener('click', () => void openSettings());
  (el.sdSettingsClose as HTMLButtonElement).addEventListener('click', closeSettings);

  // A click on the backdrop must never dismiss the dialog: losing a half-typed
  // API key because the pointer slipped is the bug this guards against.
  el.sdSettings.addEventListener('mousedown', (e) => {
    if (e.target === el.sdSettings) e.preventDefault();
  });

  (el.sdSave as HTMLButtonElement).addEventListener('click', () => void saveSettings());
  (el.sdSaveMain as HTMLButtonElement).addEventListener('click', () => void saveSettings());
  (el.sdTest as HTMLButtonElement).addEventListener('click', () => void testConnection());
  (el.sdFetchModels as HTMLButtonElement).addEventListener('click', () => void fetchModels());

  // Collapsible sections: the provider, key and model panels start open.
  document.querySelectorAll<HTMLElement>('.sd-sec').forEach((sec) => {
    sec.querySelector('.sd-sec-head')?.addEventListener('click', () => {
      const open = sec.classList.toggle('open');
      sec.querySelector('.sd-sec-head')?.setAttribute('aria-expanded', String(open));
    });
  });

  (el.sdCustomBaseUrl as HTMLInputElement).addEventListener('input', (e) => {
    form.customBaseUrl = (e.target as HTMLInputElement).value;
    renderProviders();
    renderKeyBadge();
  });

  (el.sdApiKey as HTMLInputElement).addEventListener('input', (e) => {
    form.apiKey = (e.target as HTMLInputElement).value;
    form.keyDirty = true;
    clearNotice();
    setTestResult('', '');
    renderKeyBadge();

    // A pasted key usually identifies its own provider, so switch to it rather
    // than making the user remember which tab it came from.
    const guessed = detectProviderForKey(form.apiKey);
    if (guessed && guessed !== form.provider && ui.presets.some((p) => p.id === guessed)) {
      selectProvider(guessed);
      toast(`Key dikenali sebagai ${presetFor(guessed).label}`, 'ok');
    }
  });

  (el.sdKeyToggle as HTMLButtonElement).addEventListener('click', () => {
    form.keyVisible = !form.keyVisible;
    const input = el.sdApiKey as HTMLInputElement;
    input.type = form.keyVisible ? 'text' : 'password';
    const btn = el.sdKeyToggle as HTMLButtonElement;
    btn.innerHTML = icon(form.keyVisible ? 'eye-off' : 'eye', 'ic ic-sm');
    btn.setAttribute('aria-label', form.keyVisible ? 'Sembunyikan key' : 'Tampilkan key');
  });

  (el.sdKeyClear as HTMLButtonElement).addEventListener('click', () => {
    form.apiKey = '';
    form.savedKey = '';
    form.keyDirty = true;
    (el.sdApiKey as HTMLInputElement).value = '';
    clearNotice();
    setTestResult('', '');
    renderKeyBadge();
  });

  (el.sdModel as HTMLInputElement).addEventListener('input', syncManualModelState);
  (el.sdModelAdd as HTMLButtonElement).addEventListener('click', () => {
    const manual = (el.sdModel as HTMLInputElement).value.trim();
    if (!manual) return;
    applyModel(manual);
    syncManualModelState();
  });

  (el.sdNoticeAction as HTMLButtonElement).addEventListener('click', () => {
    const btn = el.sdNoticeAction as HTMLButtonElement;
    const model = btn.dataset.model;
    if (model) {
      delete btn.dataset.model;
      applyModel(model);
      toast(`Model diganti ke ${model}`, 'ok');
      return;
    }
    if (noticeUrl) void bridge.openExternal(noticeUrl);
  });

  (el.sdThemeLight as HTMLButtonElement).addEventListener('click', () => {
    applyTheme(false);
    void bridge.setTheme('light');
    applyThemeButtons();
  });
  (el.sdThemeDark as HTMLButtonElement).addEventListener('click', () => {
    applyTheme(true);
    void bridge.setTheme('dark');
    applyThemeButtons();
  });
  (el.sdModeDev as HTMLButtonElement).addEventListener('click', () => {
    ui.workspaceMode = 'dev';
    void bridge.setMode('dev');
    syncModeButtons();
    renderHeader();
    renderToolChips();
    renderMessages();
  });
  (el.sdModePlan as HTMLButtonElement).addEventListener('click', () => {
    ui.workspaceMode = 'plan';
    void bridge.setMode('plan');
    syncModeButtons();
    renderHeader();
    renderToolChips();
    renderMessages();
  });

  document.addEventListener('keydown', (e) => {
    // Escape closes only when the dialog is idle: dismissing mid-request would
    // hide the result the user is waiting for.
    if (e.key === 'Escape' && settingsOpen() && !settingsBusy()) {
      e.preventDefault();
      closeSettings();
    }
  });

  // external links
  document.querySelectorAll<HTMLAnchorElement>('[data-ext]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const url = a.dataset.ext;
      if (url) void bridge.openExternal(url);
    });
  });

  // drag & drop text files into the window -> drop content into the composer
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const ta = el.sdInput as HTMLTextAreaElement;
      ta.value = `${ta.value}${text.slice(0, 20000)}`;
      autosize();
      toast(`Dimuat: ${file.name}`, 'ok');
    } catch {
      toast('Gagal membaca file', 'bad');
    }
  });

  bridge.onRunEvent(handleRunEvent);
  bridge.onUpdateEvent(renderUpdateState);
  bridge.onMenuAction((action) => {
    switch (action) {
      case 'new-session':
        void newSession();
        break;
      case 'pick-workspace':
        void pickWorkspace();
        break;
      case 'settings':
        void openSettings();
        break;
      case 'toggle-theme':
        void toggleTheme();
        break;
    }
  });
}

async function sendCurrent(): Promise<void> {
  const ta = el.sdInput as HTMLTextAreaElement;
  const text = ta.value;
  if (!text.trim() || ui.running) return;
  ta.value = '';
  (el.sdToolPop as HTMLElement).classList.remove('open');
  autosize();
  await send(text);
}

async function init(): Promise<void> {
  grab();
  if (!bridge) {
    document.body.innerHTML = '<p style="padding:2rem;font-family:sans-serif">Preload bridge tidak tersedia.</p>';
    return;
  }
  wireEvents();

  // Reflect whatever the main process already knows (may be mid-download from
  // a previous session) without triggering a fresh network check.
  try {
    renderUpdateState(await bridge.getUpdateState());
  } catch {
    /* updates are optional; never block boot on them */
  }

  try {
    const state = await bridge.getState();
    applyTheme(state.theme === 'dark');
  } catch {
    applyTheme(false);
  }
  applyThemeButtons();

  try {
    ui.presets = await bridge.getProviders();
  } catch {
    ui.presets = [];
  }

  await refresh();
  autosize();
  (el.sdInput as HTMLTextAreaElement).focus();

  if (!ui.config.apiKey && !isLocalProvider(ui.config.provider)) {
    toast('API key belum diatur — buka Pengaturan', 'bad');
  }
}

function isLocalProvider(id: ProviderId): boolean {
  return presetFor(id).isLocal;
}

document.addEventListener('DOMContentLoaded', () => {
  void init();
});

window.addEventListener('beforeunload', () => {
  void bridge?.flush();
});