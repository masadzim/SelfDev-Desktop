import type { ProviderId, ProviderInfo, AppConfig, WorkspaceMode } from './types';

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    mode: 'anthropic',
    models: [
      'claude-sonnet-4-5',
      'claude-opus-4-1',
      'claude-haiku-4-5',
      'claude-3-7-sonnet-latest'
    ]
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    mode: 'openai',
    models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini', 'o3']
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    mode: 'openai',
    models: [
      'anthropic/claude-sonnet-4.5',
      'openai/gpt-5',
      'google/gemini-2.5-pro',
      'meta-llama/llama-3.3-70b-instruct'
    ]
  },
  groq: {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    mode: 'openai',
    models: ['llama-3.3-70b-versatile', 'qwen-2.5-coder-32b']
  },
  custom: {
    id: 'custom',
    name: 'Custom (OpenAI-compatible)',
    baseUrl: 'http://localhost:3001/v1',
    mode: 'openai',
    models: ['qwen2.5-coder-32b-instruct', 'deepseek-coder']
  }
};

export const DEFAULT_SYSTEM =
  'Kamu adalah SelfDev, AI developer assistant opencode-style dari Adzim. Isaac: jawab ringkas, beri kode yang siap pakai, dan gunakan tools bila perlu (baca/tulis file, jalankan kode, cari web). Gunakan bahasa Indonesia kecuali diminta lain.';

export const DEFAULT_MAX_TOKENS = 4096;

export function defaultConfig(): AppConfig {
  const p = PROVIDERS.anthropic;
  return {
    provider: 'anthropic',
    baseUrl: p.baseUrl,
    apiKey: '',
    model: p.models[0],
    temperature: 0.6,
    maxTokens: DEFAULT_MAX_TOKENS,
    system: DEFAULT_SYSTEM,
    mode: p.mode
  };
}

/** Normalise a config after the user edits the settings form. */
export function normalizeConfig(input: Partial<AppConfig>): AppConfig {
  const out: AppConfig = { ...defaultConfig(), ...input };
  const ref = PROVIDERS[out.provider] ?? PROVIDERS.custom;
  out.mode = ref.mode;
  out.baseUrl = (out.baseUrl || ref.baseUrl).trim();
  if (out.mode === 'anthropic') {
    out.baseUrl = out.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  } else {
    out.baseUrl = out.baseUrl.replace(/\/+$/, '');
    if (!/\/v1$/.test(out.baseUrl) && /api\.(openai|groq)\.com|openrouter\.ai/.test(out.baseUrl)) {
      out.baseUrl += '/v1';
    }
  }
  out.apiKey = (out.apiKey || '').trim();
  out.model = (out.model || ref.models[0]).trim();
  out.maxTokens = clampInt(out.maxTokens, 128, 200000, DEFAULT_MAX_TOKENS);
  out.temperature = clampNum(out.temperature, 0, 2, 0.6);
  out.system = typeof out.system === 'string' ? out.system : DEFAULT_SYSTEM;
  return out;
}

export function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Endpoint for a chat request, given the config. */
export function endpointFor(cfg: AppConfig): string {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  return cfg.mode === 'anthropic' ? `${base}/v1/messages` : `${base}/chat/completions`;
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