import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { defaultConfig, deriveSessionTitle, normalizeConfig, PROVIDERS } from '../shared/providers';
import type { AppConfig, ChatMessage, PersistedState, ProviderId, Session, WorkspaceMode } from '../shared/types';

const STATE_VERSION = 1;
const MAX_SESSIONS = 200;

function defaultState(): PersistedState {
  return {
    version: STATE_VERSION,
    config: defaultConfig(),
    sessions: [],
    activeSessionId: null,
    workspaceRoot: null,
    theme: 'light',
    workspaceMode: 'dev'
  };
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

/**
 * JSON-file backed application state (settings, sessions, workspace root).
 * Writes are debounced and atomic (tmp file + rename) so a crash mid-write
 * can never leave a truncated state file behind.
 */
export class Store {
  private state: PersistedState = defaultState();
  private file = '';
  private writeTimer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();

  async init(): Promise<void> {
    this.file = join(app.getPath('userData'), 'state.json');
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      this.state = this.sanitize(parsed);
    } catch {
      this.state = defaultState();
      await this.flush();
    }
    this.ensureActiveSession();
  }

  private sanitize(raw: Partial<PersistedState>): PersistedState {
    const base = defaultState();
    const cfg = normalizeConfig({ ...base.config, ...(raw.config ?? {}) } as Partial<AppConfig>);
    // Provider must exist, otherwise fall back to defaults entirely.
    if (!PROVIDERS[cfg.provider as ProviderId]) cfg.provider = base.config.provider;
    const sessions = Array.isArray(raw.sessions) ? raw.sessions.filter((s) => this.isSession(s)) : [];
    return {
      version: STATE_VERSION,
      config: cfg,
      sessions: sessions.map((s) => this.normalizeSession(s)).slice(0, MAX_SESSIONS),
      activeSessionId: typeof raw.activeSessionId === 'string' ? raw.activeSessionId : null,
      workspaceRoot: typeof raw.workspaceRoot === 'string' ? raw.workspaceRoot : null,
      theme: raw.theme === 'dark' ? 'dark' : 'light',
      workspaceMode: raw.workspaceMode === 'plan' ? 'plan' : 'dev'
    };
  }

  private isSession(s: unknown): s is Session {
    return !!s && typeof s === 'object' && typeof (s as Session).id === 'string' && Array.isArray((s as Session).messages);
  }

  private normalizeSession(s: Session): Session {
    const messages: ChatMessage[] = (Array.isArray(s.messages) ? s.messages : [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => ({
        role: m.role,
        text: typeof m.text === 'string' ? m.text : '',
        tool_calls: Array.isArray(m.tool_calls) ? m.tool_calls : undefined,
        tool_results: Array.isArray(m.tool_results) ? m.tool_results : undefined,
        createdAt: typeof m.createdAt === 'number' ? m.createdAt : Date.now()
      }));
    return {
      id: s.id,
      title: (typeof s.title === 'string' && s.title.trim()) || 'Percakapan baru',
      model: typeof s.model === 'string' && s.model ? s.model : defaultConfig().model,
      messages,
      createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
      updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now()
    };
  }

  // ---------- persistence ----------

  private scheduleWrite(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.flush();
    }, 250);
  }

  /** Atomic write; serialised so concurrent calls cannot interleave. */
  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    const run = async (): Promise<void> => {
      const payload = JSON.stringify(this.state, null, 2);
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.mkdir(dirname(this.file), { recursive: true });
      await fs.writeFile(tmp, payload, 'utf8');
      await fs.rename(tmp, this.file);
    };
    this.writing = this.writing.then(run, run);
    try {
      await this.writing;
    } catch (err) {
      console.error('[store] gagal menyimpan state:', err);
    }
  }

  // ---------- accessors ----------

  getState(): PersistedState {
    return JSON.parse(JSON.stringify(this.state)) as PersistedState;
  }

  getConfig(): AppConfig {
    return this.state.config;
  }

  updateConfig(patch: Partial<AppConfig>): AppConfig {
    this.state.config = normalizeConfig({ ...this.state.config, ...patch });
    this.scheduleWrite();
    return this.state.config;
  }

  getTheme(): 'light' | 'dark' {
    return this.state.theme;
  }

  setTheme(theme: 'light' | 'dark'): 'light' | 'dark' {
    this.state.theme = theme;
    this.scheduleWrite();
    return theme;
  }

  getMode(): WorkspaceMode {
    return this.state.workspaceMode;
  }

  setMode(mode: WorkspaceMode): WorkspaceMode {
    this.state.workspaceMode = mode;
    this.scheduleWrite();
    return mode;
  }

  getWorkspaceRoot(): string | null {
    return this.state.workspaceRoot;
  }

  setWorkspaceRoot(root: string | null): string | null {
    this.state.workspaceRoot = root;
    this.scheduleWrite();
    return root;
  }

  // ---------- sessions ----------

  listSessions(): Session[] {
    return this.state.sessions.map((s) => ({ ...s, messages: s.messages }));
  }

  getSession(id: string): Session | undefined {
    return this.state.sessions.find((s) => s.id === id);
  }

  createSession(activate = true): Session {
    const now = Date.now();
    const session: Session = {
      id: newId('s'),
      title: 'Percakapan baru',
      model: this.state.config.model,
      messages: [],
      createdAt: now,
      updatedAt: now
    };
    this.state.sessions.unshift(session);
    if (this.state.sessions.length > MAX_SESSIONS) this.state.sessions.length = MAX_SESSIONS;
    if (activate) this.state.activeSessionId = session.id;
    this.scheduleWrite();
    return session;
  }

  /** Returns the active session, creating one when the pointer is dangling. */
  ensureActiveSession(): Session {
    const found = this.state.activeSessionId
      ? this.state.sessions.find((s) => s.id === this.state.activeSessionId)
      : undefined;
    if (found) return found;
    const created = this.createSession(true);
    return created;
  }

  getActiveSession(): Session {
    return this.ensureActiveSession();
  }

  setActiveSession(id: string): Session | null {
    const found = this.state.sessions.find((s) => s.id === id);
    if (!found) return null;
    this.state.activeSessionId = id;
    this.scheduleWrite();
    return found;
  }

  deleteSession(id: string): void {
    this.state.sessions = this.state.sessions.filter((s) => s.id !== id);
    if (this.state.activeSessionId === id) {
      this.state.activeSessionId = this.state.sessions[0]?.id ?? null;
    }
    if (!this.state.sessions.length) this.createSession(true);
    this.scheduleWrite();
  }

  renameSession(id: string, title: string): void {
    const s = this.state.sessions.find((x) => x.id === id);
    if (!s) return;
    const t = title.trim();
    if (t) s.title = t.slice(0, 120);
    s.updatedAt = Date.now();
    this.scheduleWrite();
  }

  clearSessions(): void {
    this.state.sessions = [];
    this.createSession(true);
    this.scheduleWrite();
  }

  /** Persist a mutation made directly on the session object. */
  touch(session: Session): void {
    const stored = this.state.sessions.find((s) => s.id === session.id);
    if (!stored) return;
    stored.messages = session.messages;
    stored.model = session.model;
    stored.updatedAt = Date.now();
    if (!stored.title || stored.title === 'Percakapan baru') {
      const derived = deriveSessionTitle(stored.messages);
      if (derived) stored.title = derived;
    }
    // keep list sorted by recency without reordering the array mid-iteration
    this.scheduleWrite();
  }

  /** Re-sort sessions by updatedAt desc, safely. */
  sortSessions(): void {
    this.state.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}