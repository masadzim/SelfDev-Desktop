/** Shared contract between main process, preload and renderer. */

export type ProviderId = 'anthropic' | 'openai' | 'openrouter' | 'groq' | 'custom';
export type ApiMode = 'anthropic' | 'openai';
export type WorkspaceMode = 'dev' | 'plan';

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  baseUrl: string;
  mode: ApiMode;
  models: string[];
}

export interface AppConfig {
  provider: ProviderId;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  system: string;
  mode: ApiMode;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResultRecord {
  tool_call_id: string;
  name: string;
  content: string;
  isError?: boolean;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  tool_calls?: ToolCallRecord[];
  tool_results?: ToolResultRecord[];
  createdAt?: number;
}

export interface Session {
  id: string;
  title: string;
  model: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

/** Persisted app state (settings + sessions + workspace root). */
export interface PersistedState {
  version: number;
  config: AppConfig;
  sessions: Session[];
  activeSessionId: string | null;
  workspaceRoot: string | null;
  theme: 'light' | 'dark';
  workspaceMode: WorkspaceMode;
}

export type RunStatus =
  | 'thinking'
  | 'tool'
  | 'done'
  | 'error'
  | 'stopped'
  | 'max_iterations';

/** Events streamed from main -> renderer while the agent loop runs. */
export type RunEvent =
  | { type: 'started' }
  | { type: 'text'; text: string }
  | { type: 'tool_start'; id: string; name: string }
  | {
      type: 'tool_end';
      id: string;
      name: string;
      arguments?: Record<string, unknown>;
      content: string;
      isError: boolean;
    }
  | { type: 'finished'; status: RunStatus; error?: string };

export interface ToolMeta {
  name: string;
  icon: string;
  openDesc: string;
  description: string;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

/** The API surface exposed on `window.selfdev` by the preload bridge. */
export interface SelfDevBridge {
  getState(): Promise<PersistedState>;
  saveConfig(patch: Partial<AppConfig>): Promise<PersistedState>;
  testConnection(cfg: {
    provider: ProviderId;
    baseUrl: string;
    apiKey: string;
    model: string;
  }): Promise<{ ok: boolean; message: string }>;
  setMode(mode: WorkspaceMode): Promise<WorkspaceMode>;
  setTheme(theme: 'light' | 'dark'): Promise<'light' | 'dark'>;

  pickWorkspace(): Promise<string | null>;
  revealWorkspace(): Promise<boolean>;
  listWorkspaceFiles(): Promise<{ path: string }[]>;

  sendMessage(text: string): Promise<void>;
  stopRun(): Promise<void>;
  newSession(): Promise<Session>;
  switchSession(id: string): Promise<Session | null>;
  deleteSession(id: string): Promise<Session[]>;
  renameSession(id: string, title: string): Promise<void>;
  clearSessions(): Promise<Session[]>;

  onRunEvent(cb: (evt: RunEvent) => void): () => void;
  openExternal(url: string): Promise<void>;
  platform: string;
}