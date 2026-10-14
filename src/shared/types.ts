/** Shared contract between main process, preload and renderer. */

/**
 * Wire format spoken by a provider. Mirrors the Android client's `WireApi`
 * exactly, because the three formats disagree about far more than field names:
 * the auth header, the streaming verb, the tool-call shape and the usage
 * reporting all differ per format.
 */
export type WireApi = 'OPENAI_CHAT' | 'ANTHROPIC_MESSAGES' | 'GEMINI_CONTENT';

export type ProviderId =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'groq'
  | 'deepseek'
  | 'openrouter'
  | 'together'
  | 'fireworks'
  | 'xai'
  | 'mistral'
  | 'cerebras'
  | 'nvidia'
  | 'sambanova'
  | 'hyperbolic'
  | 'novita'
  | 'ollama'
  | 'custom';

/**
 * What a workspace is for. Matches the Android client's seven modes; the
 * instruction each one appends lives in `shared/modes.ts`.
 */
export type WorkspaceMode = 'general' | 'code' | 'media' | 'alert' | 'writing' | 'research' | 'music';

/** One catalogue entry. `custom` carries a user-typed base URL instead. */
export interface ProviderPreset {
  id: ProviderId;
  label: string;
  baseUrl: string;
  wireApi: WireApi;
  suggestedModels: string[];
  envVar: string;
  /** Local gateways need no key, so the security section hides the field. */
  isLocal: boolean;
  /** Where the user tops up or checks credits; opened from a billing notice. */
  billingUrl: string | null;
  /**
   * A small, fast, non-reasoning model used only to prove a key works.
   *
   * The connection test must not run on whatever model the user happens to have
   * selected: a reasoning model can spend the whole budget thinking and answer
   * nothing, and an expensive one charges the user for a test. Null means "no
   * model here is known well enough to guess", and the test falls back to the
   * active model rather than failing.
   */
  testModel: string | null;
}

/** A provider + model pair reduced to everything the transport needs. */
export interface ResolvedEndpoint {
  providerId: ProviderId;
  providerLabel: string;
  wireApi: WireApi;
  baseUrl: string;
  modelId: string;
  requiresApiKey: boolean;
  /** False when the provider cannot read images, so attachments are refused up front. */
  supportsImages: boolean;
}

/** One row of a provider `/models` payload, with whatever price it volunteered. */
export interface ModelEntry {
  id: string;
  inputPerMTok: number | null;
  outputPerMTok: number | null;
  contextLength: number | null;
}

/**
 * Why a request failed. Providers disagree about what a status code means, so
 * the body is read too; the kind is what the UI turns into a next step.
 */
export type ApiErrorKind =
  | 'BILLING'
  | 'RATE_LIMIT'
  | 'AUTH'
  | 'MODEL'
  | 'NETWORK'
  | 'SERVER'
  | 'PARSE'
  | 'UNKNOWN'
  | 'TIMEOUT'
  | 'TLS';

export interface AppConfig {
  provider: ProviderId;
  /** Base URL of the custom gateway. Every other provider uses its preset's. */
  customBaseUrl: string;
  /**
   * Wire format of the custom gateway. Defaults to `OPENAI_CHAT`, which is what
   * every preset provider except Anthropic and Gemini speaks, and what the
   * Android client assumes. A self-hosted Anthropic-compatible gateway needs the
   * other two.
   */
  customWireApi: WireApi;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  system: string;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  /** False when the provider reported no usage block at all. */
  isKnown: boolean;
}

/** Result of a settings connection test, rich enough to suggest a next step. */
export interface ConnectionReport {
  ok: boolean;
  message: string;
  kind: ApiErrorKind | null;
  billingUrl: string | null;
  /** A model the account can actually reach, when the active one is refused. */
  suggestedModel: string | null;
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
  /** The project this session belongs to, or null for the ungrouped workspace. */
  projectId?: string | null;
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
  /** A project groups sessions; null is the ungrouped workspace. */
  activeProjectId: string | null;
  projects: Project[];
  /** First run shows the welcome screen until this is dismissed. */
  onboarded: boolean;
  /** The master switch for local tools, independent of which mode is active. */
  toolsEnabled: boolean;
  /** Speak replies aloud through the OS voice engine. */
  speakReplies: boolean;
  /** Interface language. */
  language: 'id' | 'en';
}

/** The three shapes a user actually asks for. No image API takes free dimensions. */
export type ImageSize = 'SQUARE' | 'LANDSCAPE' | 'PORTRAIT';

/** Which of the two Google endpoints a model is reached through. */
export type ImageGenKind = 'OPENAI_IMAGE' | 'GEMINI_IMAGE' | 'IMAGEN';

export interface ImageGenModel {
  providerId: ProviderId;
  model: string;
  kind: ImageGenKind;
  label: string;
}

export interface ImageRequest {
  prompt: string;
  size: ImageSize;
  count: number;
}

export interface GeneratedImage {
  /** Base64, no data: prefix. */
  data: string;
  mimeType: string;
  model: string;
  /** What the model says it drew; several of them rewrite the prompt. */
  revisedPrompt: string | null;
}

export interface BackupSettings {
  config: AppConfig;
  workspaceMode: WorkspaceMode;
  toolsEnabled: boolean;
  speakReplies: boolean;
  language: 'id' | 'en';
  onboarded: boolean;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  language: string;
  status: 'idea' | 'active' | 'paused' | 'done';
  createdAt: number;
  updatedAt: number;
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
  getProviders(): Promise<ProviderPreset[]>;
  testConnection(cfg: {
    provider: ProviderId;
    customBaseUrl: string;
    apiKey: string;
    model: string;
  }): Promise<ConnectionReport>;
  fetchModels(cfg: {
    provider: ProviderId;
    customBaseUrl: string;
    apiKey: string;
  }): Promise<{ ok: boolean; message: string; models: ModelEntry[] }>;
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