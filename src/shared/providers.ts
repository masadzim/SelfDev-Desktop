import type {
  AppConfig,
  ModelEntry,
  ProviderId,
  ProviderPreset,
  ResolvedEndpoint,
  WireApi,
  WorkspaceMode
} from './types';

export const CUSTOM_ID: ProviderId = 'custom';
export const DEFAULT_PROVIDER_ID: ProviderId = 'groq';

export const DEFAULT_SYSTEM =
  'Kamu adalah SelfDev, AI developer assistant opencode-style dari Adzim. Isaac: jawab ringkas, beri kode yang siap pakai, dan gunakan tools bila perlu (baca/tulis file, jalankan kode, cari web). Gunakan bahasa Indonesia kecuali diminta lain.';

export const DEFAULT_MAX_TOKENS = 2048;

/**
 * Provider catalogue. Base URLs and paths are the Android client's, unchanged,
 * so a key that works there works here.
 */
export const PRESETS: ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    wireApi: 'OPENAI_CHAT',
    suggestedModels: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini'],
    envVar: 'OPENAI_API_KEY',
    isLocal: false,
    billingUrl: 'https://platform.openai.com/settings/organization/billing/overview',
    testModel: 'gpt-4o-mini'
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    wireApi: 'ANTHROPIC_MESSAGES',
    suggestedModels: ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-6'],
    envVar: 'ANTHROPIC_API_KEY',
    isLocal: false,
    billingUrl: 'https://console.anthropic.com/settings/plans',
    testModel: 'claude-haiku-4-5-20251001'
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    wireApi: 'GEMINI_CONTENT',
    suggestedModels: ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'],
    envVar: 'GEMINI_API_KEY',
    isLocal: false,
    billingUrl: 'https://aistudio.google.com/app/apikey',
    testModel: 'gemini-2.5-flash'
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    wireApi: 'OPENAI_CHAT',
    suggestedModels: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
    envVar: 'GROQ_API_KEY',
    isLocal: false,
    billingUrl: 'https://console.groq.com/keys',
    testModel: 'llama-3.1-8b-instant'
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    wireApi: 'OPENAI_CHAT',
    suggestedModels: ['deepseek-chat', 'deepseek-reasoner'],
    envVar: 'DEEPSEEK_API_KEY',
    isLocal: false,
    billingUrl: 'https://platform.deepseek.com/top_up',
    testModel: 'deepseek-chat'
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    wireApi: 'OPENAI_CHAT',
    suggestedModels: [],
    envVar: 'OPENROUTER_API_KEY',
    isLocal: false,
    billingUrl: 'https://openrouter.ai/credits',
    testModel: null
  },
  {
    id: 'together',
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    wireApi: 'OPENAI_CHAT',
    suggestedModels: [],
    envVar: 'TOGETHER_API_KEY',
    isLocal: false,
    billingUrl: 'https://api.together.ai/settings/billing',
    testModel: null
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    wireApi: 'OPENAI_CHAT',
    suggestedModels: [],
    envVar: 'FIREWORKS_API_KEY',
    isLocal: false,
    billingUrl: 'https://fireworks.ai/account/billing',
    testModel: null
  },
  {
    id: 'xai',
    label: 'xAI Grok',
    baseUrl: 'https://api.x.ai/v1',
    wireApi: 'OPENAI_CHAT',
    suggestedModels: ['grok-4', 'grok-3', 'grok-3-mini'],
    envVar: 'XAI_API_KEY',
    isLocal: false,
    billingUrl: 'https://console.x.ai',
    testModel: 'grok-3-mini'
  },
  {
    id: 'mistral',
    label: 'Mistral AI',
    baseUrl: 'https://api.mistral.ai/v1',
    wireApi: 'OPENAI_CHAT',
    suggestedModels: ['mistral-large-latest', 'mistral-small-latest'],
    envVar: 'MISTRAL_API_KEY',
    isLocal: false,
    billingUrl: 'https://console.mistral.ai/billing',
    testModel: 'mistral-small-latest'
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    wireApi: 'OPENAI_CHAT',
    suggestedModels: ['llama-3.3-70b', 'llama-3.1-8b'],
    envVar: 'CEREBRAS_API_KEY',
    isLocal: false,
    billingUrl: 'https://cloud.cerebras.ai',
    testModel: 'llama-3.1-8b'
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    wireApi: 'OPENAI_CHAT',
    suggestedModels: [
      'meta/llama-3.1-8b-instruct',
      'meta/llama-3.3-70b-instruct',
      'qwen/qwen3-coder-480b-a35b-instruct'
    ],
    envVar: 'NVIDIA_API_KEY',
    isLocal: false,
    billingUrl: 'https://build.nvidia.com',
    testModel: 'meta/llama-3.1-8b-instruct'
  },
  {
    id: 'sambanova',
    label: 'SambaNova',
    baseUrl: 'https://api.sambanova.ai/v1',
    wireApi: 'OPENAI_CHAT',
    suggestedModels: [],
    envVar: 'SAMBANOVA_API_KEY',
    isLocal: false,
    billingUrl: 'https://cloud.sambanova.ai',
    testModel: null
  },
  {
    id: 'hyperbolic',
    label: 'Hyperbolic',
    baseUrl: 'https://api.hyperbolic.xyz/v1',
    wireApi: 'OPENAI_CHAT',
    suggestedModels: [],
    envVar: 'HYPERBOLIC_API_KEY',
    isLocal: false,
    billingUrl: 'https://app.hyperbolic.xyz',
    testModel: null
  },
  {
    id: 'novita',
    label: 'Novita AI',
    baseUrl: 'https://api.novita.ai/v3/openai',
    wireApi: 'OPENAI_CHAT',
    suggestedModels: [],
    envVar: 'NOVITA_API_KEY',
    isLocal: false,
    billingUrl: 'https://novita.ai/dashboard',
    testModel: null
  },
  {
    id: 'ollama',
    label: 'Ollama (lokal)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    wireApi: 'OPENAI_CHAT',
    // Local tags are machine specific (`llama3.2:latest` vs `llama3.2:8b`), so
    // guessing them only produces 404s. Discovery is the source of truth.
    suggestedModels: [],
    envVar: '',
    isLocal: true,
    billingUrl: null,
    testModel: null
  },
  {
    id: CUSTOM_ID,
    label: 'Kustom / OpenAI-compatible',
    baseUrl: '',
    wireApi: 'OPENAI_CHAT',
    suggestedModels: [],
    envVar: '',
    isLocal: false,
    billingUrl: null,
    testModel: null
  }
];

const BY_ID: Record<string, ProviderPreset> = Object.fromEntries(PRESETS.map((p) => [p.id, p]));

/** `qwen2.5-coder:14b`, `llama3.2:latest` - Ollama tags, never hosted API ids. */
const LOCAL_TAG = /^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/;

/**
 * True when the id carries an Ollama-style `:tag`. Hosted providers reject these,
 * so a leftover local tag is the usual reason a request fails with "model does
 * not exist or you do not have access to it".
 */
export function looksLikeLocalModelTag(model: string): boolean {
  return LOCAL_TAG.test(model.trim());
}

/** Every wire format the client can speak, for the settings picker. */
export const WIRE_APIS: WireApi[] = ['OPENAI_CHAT', 'ANTHROPIC_MESSAGES', 'GEMINI_CONTENT'];

export const WIRE_API_LABEL: Record<WireApi, string> = {
  OPENAI_CHAT: 'OpenAI Chat',
  ANTHROPIC_MESSAGES: 'Anthropic Messages',
  GEMINI_CONTENT: 'Gemini Content'
};

export function presetFor(id: string | null | undefined): ProviderPreset {
  return (id ? BY_ID[id] : undefined) ?? BY_ID[DEFAULT_PROVIDER_ID];
}

export function isKnownProvider(id: unknown): id is ProviderId {
  return typeof id === 'string' && id in BY_ID;
}

export function labelFor(id: string | null | undefined): string {
  return presetFor(id).label;
}

/** Adds a scheme and drops trailing slashes, so URLs can be concatenated. */
export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  } else if (/^http:\/\//i.test(url)) {
    url = `http://${url.slice(7)}`;
  } else if (/^https:\/\//i.test(url)) {
    url = `https://${url.slice(8)}`;
  }
  return url.replace(/\/+$/, '');
}

export function isLoopback(url: string): boolean {
  const host = url.includes('://') ? url.slice(url.indexOf('://') + 3) : url;
  const name = host.split('/')[0].split(':')[0].toLowerCase();
  return (
    name === 'localhost' ||
    name === '127.0.0.1' ||
    name === '::1' ||
    name === '0.0.0.0' ||
    name === '10.0.2.2' ||
    name === '10.0.3.2' ||
    name.endsWith('.local')
  );
}

// --------------------------------------------------------------- endpoint URLs

export function chatUrl(endpoint: ResolvedEndpoint): string {
  switch (endpoint.wireApi) {
    case 'OPENAI_CHAT':
      return `${endpoint.baseUrl}/chat/completions`;
    case 'ANTHROPIC_MESSAGES':
      return `${endpoint.baseUrl}/messages`;
    case 'GEMINI_CONTENT':
      return `${endpoint.baseUrl}/models/${endpoint.modelId}:generateContent`;
  }
}

/**
 * The streaming form of {@link chatUrl}. Only Gemini needs a different path; the
 * other two stream over the same URL with `stream: true` in the body.
 */
export function streamUrl(endpoint: ResolvedEndpoint): string {
  return endpoint.wireApi === 'GEMINI_CONTENT'
    ? `${endpoint.baseUrl}/models/${endpoint.modelId}:streamGenerateContent?alt=sse`
    : chatUrl(endpoint);
}

export function modelsUrl(endpoint: ResolvedEndpoint): string {
  return `${endpoint.baseUrl}/models`;
}

export function supportsDiscovery(preset: ProviderPreset, customBaseUrl = ''): boolean {
  return preset.id === CUSTOM_ID ? normalizeBaseUrl(customBaseUrl) !== '' : preset.baseUrl !== '';
}

export function resolve(
  providerId: string,
  customBaseUrl: string,
  modelId: string,
  requireModel = true,
  customWireApi: WireApi = 'OPENAI_CHAT'
): ResolvedEndpoint | null {
  const preset = presetFor(providerId);
  const isCustom = preset.id === CUSTOM_ID;
  const base = isCustom ? normalizeBaseUrl(customBaseUrl) : preset.baseUrl;
  if (!base) return null;
  const model = modelId.trim();
  if (requireModel && !model) return null;
  return {
    providerId: preset.id,
    providerLabel: preset.label,
    wireApi: isCustom ? customWireApi : preset.wireApi,
    baseUrl: base,
    modelId: model,
    requiresApiKey: !preset.isLocal && !(isCustom && isLoopback(base)),
    supportsImages: !isCustom
  };
}

export function resolveForDiscovery(
  providerId: string,
  customBaseUrl: string,
  customWireApi: WireApi = 'OPENAI_CHAT'
): ResolvedEndpoint | null {
  return resolve(providerId, customBaseUrl, '', false, customWireApi);
}

// --------------------------------------------------------------- model ranking

/**
 * Families that answer a chat prompt badly or not at all. A connection test
 * that lands on a speech-to-text model reports a broken key on a perfectly good
 * one, and most providers ship these next to the chat models.
 */
const NOT_CHAT = [
  'whisper',
  'tts',
  'stt',
  'transcribe',
  'guard',
  'moderation',
  'embed',
  'rerank',
  'audio',
  'speech',
  'dall-e',
  'stable-diffusion',
  'flux',
  'orpheus',
  'bark',
  'wav2vec',
  'clip',
  'sam',
  'whisper-large'
];

/** Name fragments that mark the small, cheap end of a provider's catalogue. */
const CHEAP_HINTS = ['mini', 'flash', 'instant', 'haiku', 'nano', 'lite', 'small', 'turbo', 'free'];

/**
 * The model a connection test should use, or null to fall back to the active
 * model.
 *
 * Preference order matters: a curated pick is trusted only if the account can
 * actually see it, so a retired model id does not turn into a false alarm. The
 * heuristic exists for providers with no curated pick, where the account's own
 * model list is the only trustworthy source left.
 */
export function cheapTestModel(providerId: string, discovered: string[]): string | null {
  // Not presetFor: an unknown provider must never inherit another provider's
  // model id, which would 404 and read as a dead key.
  const curated = BY_ID[providerId]?.testModel ?? null;
  const match = discovered.find((m) => m.toLowerCase() === curated?.toLowerCase());
  if (curated && match) return match;
  const chatty = discovered.filter((model) => {
    const name = model.toLowerCase();
    return !NOT_CHAT.some((bad) => name.includes(bad));
  });
  for (const hint of CHEAP_HINTS) {
    const hit = chatty.find((m) => m.toLowerCase().includes(hint));
    if (hit) return hit;
  }
  // The account's own catalogue beats a curated id it does not contain, which is
  // what a retired model id looks like. Only with nothing to go on does the
  // curated guess get used, and the caller falls back if it fails.
  return chatty[0] ?? curated;
}

/**
 * Model ids that are useless as the default chat model: speech to text, safety
 * classifiers, and translation-only checkpoints. They show up in real provider
 * catalogues often enough that picking one silently ruins replies.
 */
const NON_CHAT_MARKERS = [
  'whisper',
  'prompt-guard',
  'safeguard',
  'guard',
  'moderation',
  'safety',
  '-english',
  '-arabic',
  'translate',
  'translat',
  'embedding',
  'tts',
  'stt',
  // Generators and non-text endpoints that sit in the same catalogue and would
  // otherwise win the "biggest name" tie.
  'image',
  'vision',
  'audio',
  'speech',
  'voice',
  'omni',
  'robotics',
  'computer-use',
  'computer_use',
  'transcribe',
  'realtime',
  'gemini-live'
];

/**
 * How good a model is as the default for a chat assistant; 0 means never pick it.
 * Bigger coding and instruct models outrank small general ones.
 */
export function chatModelRank(id: string): number {
  const lower = id.trim().toLowerCase();
  if (!lower) return 0;
  if (NON_CHAT_MARKERS.some((marker) => lower.includes(marker))) return 0;
  // An explicit text-generation marker beats a bare name: a family tag is a
  // stronger promise than the size heuristic below.
  const generationHint = lower.includes('instruct') || lower.includes('chat');
  if (lower.includes('120b')) return 6;
  if (lower.includes('gpt-oss-20b')) return 5;
  if (lower.includes('qwen')) return 4;
  if (lower.includes('gpt-4') || lower.includes('gpt-5')) return 4;
  if (lower.includes('claude') || lower.includes('gemini')) return 4;
  if (lower.includes('70b') || lower.includes('32b') || lower.includes('27b')) return 4;
  if (lower.includes('llama-3.3') || lower.includes('llama-3.1')) return 3;
  if (lower.includes('llama')) return 2;
  if (lower.includes('7b') || lower.includes('8b')) return 2;
  if (generationHint) return 2;
  return 1;
}

/** Best general purpose chat model out of a catalogue, or null if there is none. */
export function bestChatModel(candidates: string[]): string | null {
  let best: string | null = null;
  let bestRank = 0;
  for (const raw of candidates) {
    const id = raw.trim();
    const rank = chatModelRank(id);
    if (!rank) continue;
    if (rank > bestRank) {
      best = id;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * Every chat-capable model for `providerId`, best first, so a caller can walk
 * down the list when the provider refuses the top pick - retired, org-blocked,
 * or simply not on the key.
 */
export function chatModelCandidates(providerId: string, discovered: string[]): string[] {
  const preset = presetFor(providerId);
  const pool = [...discovered, ...preset.suggestedModels].map((m) => m.trim()).filter(Boolean);
  return [...new Set(pool)].filter((m) => chatModelRank(m) > 0).sort((a, b) => chatModelRank(b) - chatModelRank(a));
}

/**
 * Models worth listing, in the order the caller asked for: the account's own
 * catalogue first, then the curated suggestions so a provider with no discovery
 * still works, then anything unusable, which stays reachable for anyone who
 * wants to type it in by hand.
 */
export function rankedModels(discovered: string[], suggested: string[]): string[] {
  const cleaned = discovered.map((m) => m.trim()).filter(Boolean);
  const chat = cleaned.filter((m) => chatModelRank(m) > 0);
  const rest = cleaned.filter((m) => chatModelRank(m) <= 0);
  return [...new Set([...chat, ...suggested, ...rest])];
}

/**
 * Best replacement for a model the active provider cannot serve.
 *
 * The account's own catalogue wins: `suggestedModels` is a generic shortlist, and
 * a key is frequently scoped to only some of those.
 */
export function repairModelFor(providerId: string, discovered: string[] = []): string | null {
  const fromCatalogue = bestChatModel(discovered);
  if (fromCatalogue) return fromCatalogue;
  const preset = presetFor(providerId);
  const suggested = preset.suggestedModels.find((m) => m.trim());
  if (suggested) return suggested;
  const first = discovered.find((m) => m.trim());
  return first ? first.trim() : null;
}

export function defaultModelFor(providerId: string, customBaseUrl = ''): string {
  const preset = presetFor(providerId);
  const url = preset.id === CUSTOM_ID ? normalizeBaseUrl(customBaseUrl) : preset.baseUrl;
  if (preset.suggestedModels.length) return preset.suggestedModels[0];
  if (preset.id === CUSTOM_ID && url.includes('generativelanguage')) return 'gemini-2.5-flash';
  return '';
}

/**
 * Whether `model` can plausibly be served by `providerId`.
 *
 * A model discovered from the provider, or one the provider suggests, is always
 * fine. Anything else is only trusted when the provider is local or custom,
 * because those serve whatever the user typed.
 */
export function isModelValidFor(
  providerId: string,
  model: string,
  discovered: string[] = [],
  customBaseUrl = ''
): boolean {
  const id = model.trim();
  if (!id) return false;
  const preset = presetFor(providerId);
  if (discovered.includes(id) || preset.suggestedModels.includes(id)) return true;
  if (preset.isLocal) return true;
  if (preset.id === CUSTOM_ID) {
    // A custom gateway may be local, where tags are normal.
    return !looksLikeLocalModelTag(id) || isLoopback(normalizeBaseUrl(customBaseUrl) || preset.baseUrl);
  }
  return !looksLikeLocalModelTag(id);
}

// --------------------------------------------------------------- key detection

/**
 * Guesses which provider an API key belongs to from its prefix, so pasting a
 * key into the settings dialog can switch the provider for the user.
 */
export function detectProviderForKey(key: string): ProviderId | null {
  const k = key.trim();
  if (!k) return null;
  if (k.startsWith('sk-ant-')) return 'anthropic';
  if (k.startsWith('gsk_')) return 'groq';
  if (k.startsWith('AIza')) return 'gemini';
  if (k.startsWith('sk-or-')) return 'openrouter';
  if (k.startsWith('xai-')) return 'xai';
  if (k.startsWith('csk-')) return 'cerebras';
  if (k.startsWith('sk-')) return 'openai';
  return null;
}

// ------------------------------------------------------------ model catalogue

const GEMINI_NAME_PREFIX = 'models/';

/**
 * `"0.0000005"` means half a dollar per million tokens. Providers write this as a
 * string to dodge float rounding, so it is parsed as text.
 */
function perTokenToPerMillion(raw: unknown): number | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const perToken = Number.parseFloat(raw.trim());
  if (!Number.isFinite(perToken) || perToken < 0) return null;
  const perMillion = perToken * 1_000_000;
  return perMillion > 0 ? perMillion : null;
}

/**
 * Reads a provider `/models` payload, keeping whatever it volunteered about
 * price and context size.
 *
 * Most presets send no pricing at all, which is why both price fields default to
 * null instead of being filled in from a table that would go stale.
 */
export function parseModelCatalog(json: string): ModelEntry[] {
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return [];
  }
  const array = (root.data ?? root.models) as unknown;
  if (!Array.isArray(array)) return [];

  const seen = new Set<string>();
  const out: ModelEntry[] = [];
  for (const raw of array) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const name = typeof entry.id === 'string' && entry.id ? entry.id : (entry.name as string) ?? '';
    if (typeof name !== 'string' || !name.trim()) continue;
    const id = name.startsWith(GEMINI_NAME_PREFIX) ? name.slice(GEMINI_NAME_PREFIX.length) : name;
    if (!id.trim() || seen.has(id)) continue;
    seen.add(id);
    const pricing = (entry.pricing ?? null) as Record<string, unknown> | null;
    const context = typeof entry.context_length === 'number' ? entry.context_length : 0;
    out.push({
      id,
      inputPerMTok: pricing ? perTokenToPerMillion(pricing.prompt) : null,
      outputPerMTok: pricing ? perTokenToPerMillion(pricing.completion) : null,
      contextLength: context > 0 ? context : null
    });
  }
  return out;
}

export function parseModelIds(json: string): string[] {
  return parseModelCatalog(json).map((m) => m.id);
}

// ---------------------------------------------------------------- app config

export function defaultConfig(): AppConfig {
  const preset = presetFor(DEFAULT_PROVIDER_ID);
  return {
    provider: DEFAULT_PROVIDER_ID,
    customBaseUrl: '',
    customWireApi: 'OPENAI_CHAT',
    apiKey: '',
    model: preset.suggestedModels[0] ?? '',
    temperature: 0.6,
    maxTokens: DEFAULT_MAX_TOKENS,
    system: DEFAULT_SYSTEM
  };
}

/** Normalise a config after the user edits the settings form. */
export function normalizeConfig(input: Partial<AppConfig>): AppConfig {
  const provider: ProviderId = isKnownProvider(input.provider) ? input.provider : DEFAULT_PROVIDER_ID;
  const customBaseUrl = normalizeBaseUrl(input.customBaseUrl ?? '');
  const model = (input.model ?? '').trim() || defaultModelFor(provider, customBaseUrl);
  return {
    provider,
    customBaseUrl,
    customWireApi: WIRE_APIS.includes(input.customWireApi as WireApi) ? (input.customWireApi as WireApi) : 'OPENAI_CHAT',
    apiKey: (input.apiKey ?? '').trim(),
    model,
    temperature: clampNum(input.temperature, 0, 2, 0.6),
    maxTokens: clampInt(input.maxTokens, 1, 4096, DEFAULT_MAX_TOKENS),
    system: typeof input.system === 'string' && input.system.trim() ? input.system : DEFAULT_SYSTEM
  };
}

export function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function isValidMode(m: unknown): m is WorkspaceMode {
  return m === 'dev' || m === 'plan';
}

/** Derive a session title from its first user message. */
export function deriveSessionTitle(messages: Array<{ role: string; text?: string }>): string | null {
  const first = messages.find((m) => m.role === 'user' && (m.text ?? '').trim());
  if (!first?.text) return null;
  const title = first.text.replace(/\s+/g, ' ').trim().slice(0, 60);
  return title || null;
}

export type { WireApi };