import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  defaultConfig,
  deriveSessionTitle,
  isKnownProvider,
  normalizeBaseUrl,
  normalizeConfig,
  presetFor,
  resolve,
  WIRE_APIS
} from '../shared/providers';
import type { AppConfig, PersistedState, Project, ProviderId, Session, WireApi, WorkspaceMode } from '../shared/types';
import { DEFAULT_MODE, isValidWorkspaceMode } from '../shared/modes';
import { open as unseal, seal } from './keyVault';

const STATE_VERSION = 3;
const MAX_SESSIONS = 200;
const MAX_PROJECTS = 100;

function defaultState(): PersistedState {
  return {
    version: STATE_VERSION,
    config: defaultConfig(),
    sessions: [],
    activeSessionId: null,
    workspaceRoot: null,
    theme: 'light',
    workspaceMode: DEFAULT_MODE,
    activeProjectId: null,
    projects: [],
    onboarded: false,
    toolsEnabled: true,
    speakReplies: false,
    language: 'id'
  };
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

/**
 * v1 stored a per-provider `baseUrl` the user could edit. v2 keeps the base URL
 * with the provider it belongs to: an endpoint that differs from the preset's is
 * the user's own gateway, so it becomes a custom provider rather than being
 * silently overwritten on the next save.
 */
function migrateConfig(raw: Record<string, unknown>): Partial<AppConfig> {
  const legacy = {
    ...(raw as Partial<AppConfig>),
    provider: raw.provider as ProviderId,
    customBaseUrl: typeof raw.customBaseUrl === 'string' ? raw.customBaseUrl : '',
    customWireApi: WIRE_APIS.includes(raw.customWireApi as WireApi)
      ? (raw.customWireApi as WireApi)
      : ('OPENAI_CHAT' as WireApi)
  };
  const legacyBaseUrl = typeof raw.baseUrl === 'string' ? normalizeBaseUrl(raw.baseUrl) : '';

  if (!isKnownProvider(legacy.provider)) {
    // An id from a build that knew a provider we no longer ship: keep the
    // endpoint rather than stranding it on the default provider.
    return legacyBaseUrl ? { ...legacy, provider: 'custom', customBaseUrl: legacyBaseUrl } : legacy;
  }
  if (legacy.provider === 'custom') {
    return { ...legacy, customBaseUrl: legacy.customBaseUrl || legacyBaseUrl };
  }
  if (legacyBaseUrl && legacyBaseUrl !== presetFor(legacy.provider).baseUrl) {
    return { ...legacy, provider: 'custom', customBaseUrl: legacyBaseUrl };
  }
  return { ...legacy, customBaseUrl: '' };
}

/**
 * JSON-file backed application state (settings, sessions, workspace root).
 * Writes are debounced and atomic (tmp file + rename) so a crash mid-write
 * can never leave a truncated state file behind.
 *
 * The API key is the one secret in here, so it is written sealed and only ever
 * read back through `keyVault`.
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
      const parsed = JSON.parse(raw) as Partial<PersistedState> & { config?: Record<string, unknown> };
      this.state = this.sanitize(parsed);
    } catch {
      this.state = defaultState();
      await this.flush();
    }
    this.ensureActiveSession();
  }

  private sanitize(raw: Partial<PersistedState> & { config?: Record<string, unknown> }): PersistedState {
    const base = defaultState();
    const migrated = migrateConfig((raw.config ?? {}) as Record<string, unknown>);
    const cfg = normalizeConfig({ ...base.config, ...migrated });
    const sessions = Array.isArray(raw.sessions) ? raw.sessions.filter((s) => this.isSession(s)) : [];
    return {
      version: STATE_VERSION,
      // Sealed at rest; `getConfig`/`getState` unseal for the caller.
      config: { ...cfg, apiKey: seal(cfg.apiKey) },
      sessions: sessions.map((s) => this.normalizeSession(s)).slice(0, MAX_SESSIONS),
      activeSessionId: typeof raw.activeSessionId === 'string' ? raw.activeSessionId : null,
      workspaceRoot: typeof raw.workspaceRoot === 'string' ? raw.workspaceRoot : null,
      theme: raw.theme === 'dark' ? 'dark' : 'light',
      workspaceMode: isValidWorkspaceMode(raw.workspaceMode) ? raw.workspaceMode : DEFAULT_MODE,
      activeProjectId: typeof raw.activeProjectId === 'string' ? raw.activeProjectId : null,
      projects: (Array.isArray(raw.projects) ? raw.projects : [])
        .filter((p) => this.isProject(p))
        .slice(0, MAX_PROJECTS)
        .map((p) => this.normalizeProject(p)),
      onboarded: raw.onboarded === true,
      toolsEnabled: raw.toolsEnabled !== false,
      speakReplies: raw.speakReplies === true,
      language: raw.language === 'en' ? 'en' : 'id'
    };
  }

  private isProject(p: unknown): p is Project {
    return !!p && typeof p === 'object' && typeof (p as Project).id === 'string' && typeof (p as Project).name === 'string';
  }

  private normalizeProject(p: Project): Project {
    const status = ['idea', 'active', 'paused', 'done'].includes(p.status) ? p.status : 'active';
    return {
      id: p.id,
      name: p.name.trim().slice(0, 80) || 'Proyek baru',
      description: typeof p.description === 'string' ? p.description.slice(0, 400) : '',
      language: typeof p.language === 'string' ? p.language.slice(0, 40) : '',
      status: status as Project['status'],
      createdAt: typeof p.createdAt === 'number' ? p.createdAt : Date.now(),
      updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : Date.now()
    };
  }

  private isSession(s: unknown): s is Session {
    return !!s && typeof s === 'object' && typeof (s as Session).id === 'string' && Array.isArray((s as Session).messages);
  }

  private normalizeSession(s: Session): Session {
    const messages = (Array.isArray(s.messages) ? s.messages : [])
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
      projectId: typeof s.projectId === 'string' ? s.projectId : null,
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

  /** Whole state for the renderer, with the API key unsealed for the form. */
  getState(): PersistedState {
    const copy = JSON.parse(JSON.stringify(this.state)) as PersistedState;
    copy.config.apiKey = unseal(this.state.config.apiKey);
    return copy;
  }

  /** Runtime config for the agent, with the API key in plaintext in memory. */
  getConfig(): AppConfig {
    return { ...this.state.config, apiKey: unseal(this.state.config.apiKey) };
  }

  updateConfig(patch: Partial<AppConfig>): AppConfig {
    const next = normalizeConfig({ ...this.getConfig(), ...patch });
    this.state.config = { ...next, apiKey: seal(next.apiKey) };
    this.scheduleWrite();
    return this.getConfig();
  }

  /** True when the saved provider + model can actually be called. */
  isConfigured(): boolean {
    const cfg = this.getConfig();
    const endpoint = resolve(cfg.provider, cfg.customBaseUrl, cfg.model, true, cfg.customWireApi);
    return Boolean(endpoint) && (!endpoint?.requiresApiKey || cfg.apiKey !== '');
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
    this.state.workspaceMode = isValidWorkspaceMode(mode) ? mode : DEFAULT_MODE;
    this.scheduleWrite();
    return this.state.workspaceMode;
  }

  getToolsEnabled(): boolean {
    return this.state.toolsEnabled;
  }

  setToolsEnabled(on: boolean): boolean {
    this.state.toolsEnabled = Boolean(on);
    this.scheduleWrite();
    return this.state.toolsEnabled;
  }

  getSpeakReplies(): boolean {
    return this.state.speakReplies;
  }

  setSpeakReplies(on: boolean): boolean {
    this.state.speakReplies = Boolean(on);
    this.scheduleWrite();
    return this.state.speakReplies;
  }

  getLanguage(): 'id' | 'en' {
    return this.state.language;
  }

  setLanguage(lang: 'id' | 'en'): 'id' | 'en' {
    this.state.language = lang === 'en' ? 'en' : 'id';
    this.scheduleWrite();
    return this.state.language;
  }

  setOnboarded(done: boolean): boolean {
    this.state.onboarded = done;
    this.scheduleWrite();
    return done;
  }

  // ---------- projects ----------

  listProjects(): Project[] {
    return this.state.projects.map((p) => ({ ...p }));
  }

  getProject(id: string): Project | undefined {
    return this.state.projects.find((p) => p.id === id);
  }

  upsertProject(input: Partial<Project> & { name: string }): Project {
    const now = Date.now();
    const existing = input.id ? this.getProject(input.id) : undefined;
    const project: Project = this.normalizeProject({
      id: existing?.id ?? newId('p'),
      name: input.name,
      description: input.description ?? existing?.description ?? '',
      language: input.language ?? existing?.language ?? '',
      status: input.status ?? existing?.status ?? 'active',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    });
    if (existing) {
      Object.assign(existing, project);
    } else {
      this.state.projects.unshift(project);
      if (this.state.projects.length > MAX_PROJECTS) this.state.projects.length = MAX_PROJECTS;
    }
    this.scheduleWrite();
    return project;
  }

  deleteProject(id: string): void {
    this.state.projects = this.state.projects.filter((p) => p.id !== id);
    if (this.state.activeProjectId === id) this.state.activeProjectId = null;
    this.scheduleWrite();
  }

  setActiveProject(id: string | null): string | null {
    this.state.activeProjectId = id && this.getProject(id) ? id : null;
    this.scheduleWrite();
    return this.state.activeProjectId;
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

  /** Sessions belonging to one project, newest first. Ungrouped is the empty id. */
  sessionsForProject(projectId: string | null): Session[] {
    return this.state.sessions.filter((s) => (s.projectId ?? null) === projectId);
  }

  createSession(activate = true, projectId?: string | null): Session {
    const now = Date.now();
    const session: Session = {
      id: newId('s'),
      title: 'Percakapan baru',
      model: this.state.config.model,
      projectId: projectId !== undefined ? projectId : this.state.activeProjectId,
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
    return this.createSession(true);
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
    this.scheduleWrite();
  }

  /** Re-sort sessions by updatedAt desc, safely. */
  sortSessions(): void {
    this.state.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}