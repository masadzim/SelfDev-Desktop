import { renderMarkdown, escapeHtml } from './markdown';
import type {
  AppConfig,
  ProviderId,
  RunEvent,
  Session,
  ToolMeta,
  ToolCallRecord,
  ToolResultRecord,
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
  testConnection(p: { provider: ProviderId; baseUrl: string; apiKey: string; model: string }): Promise<{ ok: boolean; message: string }>;
  getProviders(): Promise<Record<ProviderId, { name: string; baseUrl: string; models: string[] }>>;
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
  running: boolean;
  runSessionId: string | null;
  raw: string;
}

const ui: UiState = {
  config: {
    provider: 'anthropic',
    baseUrl: '',
    apiKey: '',
    model: '',
    temperature: 0.6,
    maxTokens: 4096,
    system: '',
    mode: 'anthropic'
  },
  sessions: [],
  activeSessionId: null,
  workspaceRoot: null,
  workspaceMode: 'dev',
  tools: [],
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
    'sdWorkspaceLabel', 'sdSettings', 'sdProvider', 'sdBaseUrl', 'sdApiKey', 'sdModel',
    'sdMaxTokens', 'sdTemp', 'sdSystem', 'sdSave', 'sdTest', 'sdTestResult', 'sdSettingsClose',
    'sdModelList', 'sdToast',
    'sdUpdate', 'sdUpdateText', 'sdUpdateBar', 'sdUpdateAction', 'sdUpdateDismiss',
    'sdUpdateCheck', 'sdUpdateVersion', 'sdUpdateNote'
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
      <div class="sd-empty-badge">◆</div>
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

function applyProviderToForm(): void {
  const provider = (el.sdProvider as HTMLSelectElement).value as ProviderId;
  void bridge.getProviders().then((providers) => {
    const p = providers[provider];
    if (!p) return;
    (el.sdBaseUrl as HTMLInputElement).value = p.baseUrl;
    if (p.models.length) (el.sdModel as HTMLInputElement).value = p.models[0];
    fillModelList(provider);
  });
}

function fillModelList(provider: ProviderId): void {
  void bridge.getProviders().then((providers) => {
    const dl = el.sdModelList as HTMLDataListElement | undefined;
    if (!dl) return;
    const models = providers[provider]?.models ?? [];
    dl.innerHTML = models.map((m) => `<option value="${escapeHtml(m)}"></option>`).join('');
  });
}

function openSettings(): void {
  const c = ui.config;
  (el.sdProvider as HTMLSelectElement).value = c.provider;
  (el.sdBaseUrl as HTMLInputElement).value = c.baseUrl;
  (el.sdApiKey as HTMLInputElement).value = c.apiKey;
  (el.sdModel as HTMLInputElement).value = c.model;
  (el.sdMaxTokens as HTMLInputElement).value = String(c.maxTokens);
  (el.sdTemp as HTMLInputElement).value = String(c.temperature);
  (el.sdSystem as HTMLTextAreaElement).value = c.system;
  el.sdTestResult.textContent = '';
  el.sdTestResult.className = 'sd-test-result';
  fillModelList(c.provider);
  el.sdSettings.classList.add('open');
  setTimeout(() => (el.sdModel as HTMLInputElement).focus(), 30);
}

function closeSettings(): void {
  el.sdSettings.classList.remove('open');
}

async function saveSettings(): Promise<void> {
  const patch: Partial<AppConfig> = {
    provider: (el.sdProvider as HTMLSelectElement).value as ProviderId,
    baseUrl: (el.sdBaseUrl as HTMLInputElement).value.trim(),
    apiKey: (el.sdApiKey as HTMLInputElement).value.trim(),
    model: (el.sdModel as HTMLInputElement).value.trim(),
    maxTokens: Number((el.sdMaxTokens as HTMLInputElement).value),
    temperature: Number((el.sdTemp as HTMLInputElement).value),
    system: (el.sdSystem as HTMLTextAreaElement).value
  };
  try {
    const state = await bridge.saveConfig(patch);
    ui.config = state.config;
    ui.sessions = state.sessions;
    ui.activeSessionId = state.activeSessionId;
    // reflect provider normalisation (base URL / api mode) back into the form
    (el.sdBaseUrl as HTMLInputElement).value = state.config.baseUrl;
    (el.sdModel as HTMLInputElement).value = state.config.model;
    closeSettings();
    renderHeader();
    renderSessions();
    toast('Pengaturan disimpan', 'ok');
  } catch (err) {
    toast(`Gagal menyimpan: ${messageOf(err)}`, 'bad');
  }
}

async function testConnection(): Promise<void> {
  const btn = el.sdTest as HTMLButtonElement;
  const out = el.sdTestResult;
  btn.disabled = true;
  btn.textContent = 'Menguji…';
  out.textContent = '';
  out.className = 'sd-test-result';
  try {
    const res = await bridge.testConnection({
      provider: (el.sdProvider as HTMLSelectElement).value as ProviderId,
      baseUrl: (el.sdBaseUrl as HTMLInputElement).value.trim(),
      apiKey: (el.sdApiKey as HTMLInputElement).value.trim(),
      model: (el.sdModel as HTMLInputElement).value.trim()
    });
    out.textContent = `${res.ok ? '✔' : '✘'} ${res.message}`;
    out.className = `sd-test-result ${res.ok ? 'ok' : 'bad'}`;
    toast(res.ok ? 'Koneksi berhasil' : 'Koneksi gagal', res.ok ? 'ok' : 'bad');
  } catch (err) {
    out.textContent = `✘ ${messageOf(err)}`;
    out.className = 'sd-test-result bad';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Tes Koneksi';
  }
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

  (el.sdSettingsBtn as HTMLButtonElement).addEventListener('click', openSettings);
  (el.sdSettingsClose as HTMLButtonElement).addEventListener('click', closeSettings);
  el.sdSettings.addEventListener('click', (e) => {
    if (e.target === el.sdSettings) closeSettings();
  });
  (el.sdSave as HTMLButtonElement).addEventListener('click', () => void saveSettings());
  (el.sdTest as HTMLButtonElement).addEventListener('click', () => void testConnection());
  el.sdProvider.addEventListener('change', applyProviderToForm);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && el.sdSettings.classList.contains('open')) closeSettings();
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
        openSettings();
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

  await refresh();
  autosize();
  (el.sdInput as HTMLTextAreaElement).focus();

  if (!ui.config.apiKey) {
    toast('API key belum diatur — buka Pengaturan Model', 'bad');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  void init();
});

window.addEventListener('beforeunload', () => {
  void bridge?.flush();
});