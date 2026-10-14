import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_SYSTEM,
  chatUrl,
  cheapTestModel,
  modelsUrl,
  parseModelCatalog,
  presetFor,
  repairModelFor,
  resolve,
  resolveForDiscovery,
  streamUrl
} from '../../shared/providers';
import type {
  ApiErrorKind,
  AppConfig,
  ChatMessage,
  LlmUsage,
  ModelEntry,
  ResolvedEndpoint,
  ToolCallRecord
} from '../../shared/types';

/* ------------------------------------------------------------------ errors */

/** A failure that already knows what kind of problem it is. */
export class LlmError extends Error {
  readonly kind: ApiErrorKind;
  readonly statusCode: number;

  constructor(message: string, kind: ApiErrorKind = 'UNKNOWN', statusCode = 0) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind;
    this.statusCode = statusCode;
  }
}

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_RETRY_BUDGET = 2048;
const MAX_RESPONSE_CHARS = 1_000_000;
const CONNECT_TIMEOUT_MS = 30_000;
const STREAM_GAP_TIMEOUT_MS = 60_000;
const MODELS_TIMEOUT_MS = 30_000;
const TEST_TOKENS_TIGHT = 256;
const TEST_TOKENS_ROOMY = 2048;

const TEST_PING = 'Hi';

/* ------------------------------------------------------------ error reading */

/** Status code plus body text, because providers disagree on what means what. */
export function classifyError(code: number, body: string): ApiErrorKind {
  const lower = body.toLowerCase();
  const says = (...markers: string[]): boolean => markers.some((m) => lower.includes(m));

  const billingWords = says(
    'quota',
    'credit',
    'billing',
    'balance',
    'insufficient',
    'payment',
    'top up',
    'topup',
    'kredit',
    'saldo'
  );
  // A model the key cannot reach answers like an auth failure, but the fix is
  // another model, not another key, so it must not read as AUTH.
  const accessWords = says(
    'do not have access',
    "don't have access",
    'not have access',
    'no access',
    'does not exist or you',
    'not available to your',
    'blocked at the organization',
    'blocked for',
    'not enabled for your',
    'not authorized for this model'
  );
  // A 400 that names the model, rather than the request, is the provider
  // refusing this model - "Multiturn chat is not enabled for this model" is the
  // free tier talking, not a malformed body.
  const modelWords = says(
    'for this model',
    'this model does not',
    'model not',
    'not enabled',
    'not supported for',
    'does not support',
    'tidak mendukung',
    'tidak diaktifkan',
    // NVIDIA NIM says a model cannot chat as a templating failure, and a
    // classifier answers the same way. Both mean "pick another model".
    'template',
    'failed to render',
    'render text',
    'text output',
    'classification model',
    'text classification',
    'unsupported model',
    'invalid model',
    'unknown model'
  );
  // The same refusal, but NIM does not always send it as a 4xx.
  const chatUnfit = says('failed to template', 'failed to render text output', 'text classification');

  if (code === 402 || (code === 429 && billingWords)) return 'BILLING';
  if (accessWords) return 'MODEL';
  if (code === 401 || code === 403) return 'AUTH';
  if (code === 429) return 'RATE_LIMIT';
  // 410 is how NVIDIA NIM retires a model - "reached its end of life".
  if (code === 404 || code === 410) return 'MODEL';
  if (chatUnfit) return 'MODEL';
  if (code >= 500) return 'SERVER';
  if (billingWords && (code === 400 || code === 409)) return 'BILLING';
  if (modelWords && code >= 400 && code <= 499) return 'MODEL';
  return 'UNKNOWN';
}

const MEANINGLESS_JSON = new Set(['', '{}', '[]', 'null']);

/** Pulls the human sentence out of a provider error envelope. */
export function buildError(body: string): string {
  let detail = body;
  try {
    const root = JSON.parse(body) as Record<string, unknown>;
    const error = root.error;
    if (error && typeof error === 'object') {
      const message = (error as Record<string, unknown>).message;
      detail = typeof message === 'string' && message.trim() ? message : JSON.stringify(error);
    } else if (typeof error === 'string') {
      detail = error;
    } else if (typeof root.message === 'string' && root.message.trim()) {
      detail = root.message;
    }
  } catch {
    detail = body;
  }
  const trimmed = detail.trim();
  if (MEANINGLESS_JSON.has(trimmed) || trimmed.startsWith('<')) return 'Kesonakan tidak diketahui';
  return trimmed.slice(0, 200);
}

/** Reads the token ceiling out of "max_tokens must be less than or equal to 512". */
export function maxTokensCeiling(message: string): number | null {
  const text = message.toLowerCase();
  const near = /max[_\s-]*(?:completion[_\s-]*)?tokens?[^0-9]{0,40}?(\d{1,6})/.exec(text);
  const fallback = /\b(\d{1,6})\b/.exec(text);
  const value = Number.parseInt(near?.[1] ?? fallback?.[1] ?? '', 10);
  return Number.isFinite(value) && value >= 1 && value <= 4096 ? value : null;
}

/**
 * True when the provider refused the request only because it was asked to stream.
 * Streaming is a transport preference, so the client falls back to one plain
 * completion rather than reporting a failure the user cannot act on.
 */
export function isStreamingUnsupported(message: string): boolean {
  const text = message.toLowerCase();
  if (!text.includes('stream')) return false;
  return ['not support', 'unsupported', 'does not support', 'cannot', 'can not', 'not enabled'].some((m) =>
    text.includes(m)
  );
}

/** True when `max_tokens` / `temperature` have to be swapped for newer names. */
export function shouldRetryWithAlternateParams(message: string): boolean {
  const text = message.toLowerCase();
  if (text.includes('max_completion_tokens') || text.includes('max_tokens is not supported')) return true;
  return text.includes('unsupported_value') && text.includes('temperature');
}

/** True when the provider rejected the `tools` field rather than the request. */
export function isToolUnsupported(message: string): boolean {
  const text = message.toLowerCase();
  const mentionsTools =
    text.includes('tool') ||
    text.includes('function call') ||
    text.includes('function_call') ||
    text.includes('function declaration');
  const rejected = ['unsupported', 'not supported', 'invalid', 'unknown', 'unrecognized'].some((m) =>
    text.includes(m)
  );
  return mentionsTools && rejected;
}

/* ------------------------------------------------------------ request shape */

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

export interface StreamHandlers {
  onText(chunk: string): void;
  onToolStart(call: { id: string; name: string }): void;
  onUsage?(usage: LlmUsage): void;
}

export interface StreamResult {
  text: string;
  toolCalls: ToolCallRecord[];
  stopReason: string;
  usage: LlmUsage;
}

/** Auth header per wire format. A blank key sends nothing, for local gateways. */
export function authHeaders(wireApi: ResolvedEndpoint['wireApi'], apiKey: string): Record<string, string> {
  const key = apiKey.trim();
  if (!key) return {};
  switch (wireApi) {
    case 'OPENAI_CHAT':
      return { Authorization: `Bearer ${key}` };
    case 'ANTHROPIC_MESSAGES':
      return { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION };
    case 'GEMINI_CONTENT':
      return { 'x-goog-api-key': key };
  }
}

function toolsJson(wireApi: ResolvedEndpoint['wireApi'], tools: ToolSchema[]): unknown[] {
  switch (wireApi) {
    case 'OPENAI_CHAT':
      return tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema }
      }));
    case 'ANTHROPIC_MESSAGES':
      return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
    case 'GEMINI_CONTENT':
      return [
        {
          functionDeclarations: tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.input_schema
          }))
        }
      ];
  }
}

/**
 * Asks for a streamed answer.
 *
 * The flag is not universal: Gemini spells streaming as a different verb on the
 * URL, and its body schema has no `stream` field at all, so sending one there is
 * answered with `Unknown name "stream": Cannot find field`.
 */
export function streamingBody(
  wireApi: ResolvedEndpoint['wireApi'],
  body: Record<string, unknown>
): Record<string, unknown> {
  return wireApi === 'GEMINI_CONTENT' ? { ...body } : { ...body, stream: true };
}

// ------------------------------------------------------------- conversations

interface OpenAiMessage {
  role: string;
  content: string | Array<Record<string, unknown>> | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

/**
 * A file riding along with a turn.
 *
 * Images travel as their own block type, which every format spells differently.
 * A document that could be parsed is never sent this way — only bytes that would
 * otherwise be lost.
 */
export interface InlineAttachment {
  name: string;
  mimeType: string;
  base64: string;
}

/** The most one request will carry inline, to keep a turn inside a budget. */
const MAX_INLINE_BYTES = 18 * 1024 * 1024;

/**
 * Drops attachments that would not fit, in order, rather than letting one
 * oversized file fail the whole turn.
 */
export function fitAttachments(attachments: InlineAttachment[]): InlineAttachment[] {
  const kept: InlineAttachment[] = [];
  let used = 0;
  for (const a of attachments) {
    const size = Math.ceil((a.base64.length * 3) / 4);
    if (used + size > MAX_INLINE_BYTES) break;
    kept.push(a);
    used += size;
  }
  return kept;
}

/** OpenAI blocks for a user turn: plain text, or the array form with files in it. */
function openAiBlocks(text: string, attachments: InlineAttachment[]): string | Array<Record<string, unknown>> {
  if (!attachments.length) return text;
  const blocks: Array<Record<string, unknown>> = [];
  if (text) blocks.push({ type: 'text', text });
  for (const a of attachments) {
    blocks.push(
      a.mimeType.startsWith('image/')
        ? { type: 'image_url', image_url: { url: `data:${a.mimeType};base64,${a.base64}` } }
        : { type: 'file', file: { filename: a.name, file_data: `data:${a.mimeType};base64,${a.base64}` } }
    );
  }
  return blocks;
}

function anthropicBlocks(text: string, attachments: InlineAttachment[]): AnthropicBlock[] {
  const blocks: AnthropicBlock[] = [];
  if (text) blocks.push({ type: 'text', text });
  for (const a of attachments) {
    blocks.push(
      (a.mimeType.startsWith('image/')
        ? { type: 'image', source: { type: 'base64', media_type: a.mimeType, data: a.base64 } }
        : { type: 'document', source: { type: 'base64', media_type: a.mimeType, data: a.base64 } }) as AnthropicBlock
    );
  }
  return blocks;
}

function geminiPartsFor(text: string, attachments: InlineAttachment[]): GeminiPart[] {
  const parts: GeminiPart[] = [];
  if (text) parts.push({ text });
  for (const a of attachments) {
    parts.push({ inlineData: { mimeType: a.mimeType, data: a.base64 } });
  }
  return parts;
}

function openAiMessages(system: string, history: ChatMessage[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];
  if (system.trim()) out.push({ role: 'system', content: system });

  for (const m of history) {
    if (m.role === 'user') {
      const content = openAiBlocks(m.text ?? '', m.attachments ?? []);
      if (m.text || (Array.isArray(content) && content.length)) {
        out.push({ role: 'user', content: content as OpenAiMessage['content'] });
      }
    } else if (m.tool_calls?.length) {
      out.push({
        role: 'assistant',
        content: m.text || null,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) }
        }))
      });
    } else if (m.text) {
      out.push({ role: 'assistant', content: m.text });
    }
    // Tool results always follow the assistant turn that requested them. They
    // are read off whichever turn carries them, because a stored history may
    // keep them on the assistant message or on the user turn after it.
    for (const tr of m.tool_results ?? []) {
      out.push({ role: 'tool', tool_call_id: tr.tool_call_id, content: String(tr.content ?? '') });
    }
  }

  // Drop a leading orphan "tool" message (no preceding assistant tool_calls).
  while (out.length && out[0].role === 'tool') out.shift();
  return out;
}

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: string; data: string } };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicBlock[];
}

/** Anthropic requires strict role alternation starting with `user`. */
function anthropicMessages(history: ChatMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  const push = (role: 'user' | 'assistant', content: AnthropicBlock[]): void => {
    if (!content.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content = last.content.concat(content);
    else out.push({ role, content });
  };

  for (const m of history) {
    if (m.role === 'user') {
      push('user', anthropicBlocks(m.text ?? '', m.attachments ?? []));
    } else {
      const blocks: AnthropicBlock[] = [];
      if (m.text) blocks.push({ type: 'text', text: m.text });
      for (const tc of m.tool_calls ?? []) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments ?? {} });
      }
      push('assistant', blocks);
    }
    // tool_result blocks live in a user turn right after the assistant tool_use
    // turn, whichever turn the stored history carries them on.
    for (const tr of m.tool_results ?? []) {
      push('user', [{ type: 'tool_result', tool_use_id: tr.tool_call_id, content: String(tr.content ?? '') }]);
    }
  }

  while (out.length && out[0].role === 'assistant') out.shift();
  return out;
}

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | GeminiResponsePart
  | { inlineData: { mimeType: string; data: string } };

interface GeminiResponsePart {
  functionResponse: { name: string; response: { result: string } };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

function geminiResponse(name: string, output: string): GeminiResponsePart {
  return { functionResponse: { name, response: { result: output } } };
}

/** Gemini wants alternating `user`/`model` turns that begin with the user. */
function geminiContents(history: ChatMessage[]): GeminiContent[] {
  const out: GeminiContent[] = [];
  const push = (role: 'user' | 'model', parts: GeminiPart[]): void => {
    if (!parts.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts = last.parts.concat(parts);
    else out.push({ role, parts });
  };

  for (const m of history) {
    if (m.role === 'user') {
      push('user', geminiPartsFor(m.text ?? '', m.attachments ?? []));
    } else {
      const parts: GeminiPart[] = [];
      if (m.text) parts.push({ text: m.text });
      for (const tc of m.tool_calls ?? []) {
        parts.push({ functionCall: { name: tc.name, args: tc.arguments ?? {} } });
      }
      push('model', parts);
    }
    // Gemini answers a function call with a user turn carrying functionResponse.
    for (const tr of m.tool_results ?? []) {
      push('user', [geminiResponse(tr.name, String(tr.content ?? ''))]);
    }
  }

  while (out.length && out[0].role === 'model') out.shift();
  return out;
}

/**
 * Android-compatible history shaping: only user/assistant turns survive, a
 * trailing assistant turn gets a continuation prompt, and a leading assistant
 * turn is dropped.
 */
export function normalizeHistory(history: ChatMessage[], continueHint = 'Lanjutkan.'): ChatMessage[] {
  const valid = history.filter((m) => m.role === 'user' || m.role === 'assistant');
  const trimmed =
    !valid.length || valid[valid.length - 1].role !== 'user'
      ? [...valid, { role: 'user' as const, text: continueHint }]
      : valid;
  return trimmed[0]?.role === 'assistant' ? trimmed.slice(1) : trimmed;
}

function buildBody(
  wireApi: ResolvedEndpoint['wireApi'],
  endpoint: ResolvedEndpoint,
  history: ChatMessage[],
  system: string,
  maxTokens: number,
  temperature: number,
  compatMode: boolean
): Record<string, unknown> {
  const budget = Math.min(4096, Math.max(1, maxTokens));
  switch (wireApi) {
    case 'OPENAI_CHAT': {
      const body: Record<string, unknown> = {
        model: endpoint.modelId,
        messages: openAiMessages(system, history)
      };
      // Compatibility mode swaps the retired parameter names, and drops the
      // temperature that some reasoning models reject outright.
      if (!compatMode) body.temperature = temperature;
      body[compatMode ? 'max_completion_tokens' : 'max_tokens'] = budget;
      return body;
    }
    case 'ANTHROPIC_MESSAGES':
      return {
        model: endpoint.modelId,
        max_tokens: budget,
        system,
        messages: anthropicMessages(history)
      };
    case 'GEMINI_CONTENT': {
      const body: Record<string, unknown> = { contents: geminiContents(history) };
      if (system.trim()) body.system_instruction = { parts: [{ text: system }] };
      body.generationConfig = { maxOutputTokens: budget };
      return body;
    }
  }
}

/** Adds the tool declarations under the field name each format uses. */
function withTools(
  wireApi: ResolvedEndpoint['wireApi'],
  body: Record<string, unknown>,
  tools: ToolSchema[]
): Record<string, unknown> {
  return tools.length ? { ...body, tools: toolsJson(wireApi, tools) } : body;
}

// ------------------------------------------------------------------- reading

export function readUsage(root: Record<string, unknown>): LlmUsage {
  const usage = (root.usage ?? root.usageMetadata) as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== 'object') return { promptTokens: 0, completionTokens: 0, isKnown: false };
  const pick = (...names: string[]): number => {
    for (const name of names) {
      const value = usage[name];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return 0;
  };
  return {
    promptTokens: pick('prompt_tokens', 'promptTokenCount', 'input_tokens'),
    completionTokens: pick('completion_tokens', 'candidatesTokenCount', 'output_tokens'),
    isKnown: true
  };
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function geminiParts(candidate: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  const content = candidate?.content as Record<string, unknown> | undefined;
  const parts = content?.parts as Array<Record<string, unknown>> | undefined;
  return Array.isArray(parts) ? parts : [];
}

function geminiBlockReason(root: Record<string, unknown>): string {
  const feedback = root.promptFeedback as Record<string, unknown> | undefined;
  if (typeof feedback?.blockReason === 'string') return feedback.blockReason;
  const candidates = root.candidates as Array<Record<string, unknown>> | undefined;
  const reason = candidates?.[0]?.finishReason;
  return typeof reason === 'string' ? reason : 'unknown';
}

function readText(wireApi: ResolvedEndpoint['wireApi'], root: Record<string, unknown>): string {
  let text = '';
  let reason = '';
  try {
    switch (wireApi) {
      case 'OPENAI_CHAT': {
        const choices = root.choices as Array<Record<string, unknown>> | undefined;
        const message = choices?.[0]?.message as Record<string, unknown> | undefined;
        if (typeof message?.content === 'string') text = message.content.trim();
        reason = String(choices?.[0]?.finish_reason ?? '');
        break;
      }
      case 'ANTHROPIC_MESSAGES': {
        const content = root.content as Array<Record<string, unknown>> | undefined;
        text = (content ?? [])
          .filter((b) => b.type === 'text' && typeof b.text === 'string')
          .map((b) => String(b.text))
          .join('')
          .trim();
        reason = String(root.stop_reason ?? '');
        break;
      }
      case 'GEMINI_CONTENT': {
        const candidates = root.candidates as Array<Record<string, unknown>> | undefined;
        text = geminiParts(candidates?.[0])
          .filter((p) => typeof p.text === 'string')
          .map((p) => String(p.text))
          .join('')
          .trim();
        reason = geminiBlockReason(root);
        break;
      }
    }
  } catch {
    text = '';
  }
  if (!text) throw new LlmError(`Respons kosong dari provider${reason ? ` (${reason})` : ''}.`, 'PARSE');
  return text;
}

/** Tool calls out of a complete (non-streamed) response body. */
export function parseToolCalls(
  wireApi: ResolvedEndpoint['wireApi'],
  root: Record<string, unknown>
): ToolCallRecord[] {
  switch (wireApi) {
    case 'OPENAI_CHAT': {
      const choices = root.choices as Array<Record<string, unknown>> | undefined;
      const message = choices?.[0]?.message as Record<string, unknown> | undefined;
      const calls = message?.tool_calls as Array<Record<string, unknown>> | undefined;
      return (calls ?? [])
        .map((call) => {
          const fn = call.function as Record<string, unknown> | undefined;
          return {
            id: String(call.id ?? ''),
            name: String(fn?.name ?? ''),
            arguments: parseArguments(fn?.arguments)
          };
        })
        .filter((call) => call.name);
    }
    case 'ANTHROPIC_MESSAGES': {
      const content = root.content as Array<Record<string, unknown>> | undefined;
      return (content ?? [])
        .filter((b) => b.type === 'tool_use')
        .map((b, i) => ({
          id: String(b.id ?? `tool_${i}`),
          name: String(b.name ?? ''),
          arguments: (b.input ?? {}) as Record<string, unknown>
        }))
        .filter((call) => call.name);
    }
    case 'GEMINI_CONTENT':
      return geminiParts((root.candidates as Array<Record<string, unknown>> | undefined)?.[0])
        .map((part, i) => {
          const call = part.functionCall as Record<string, unknown> | undefined;
          return {
            // Gemini mints no call id, so name plus position is used; it is
            // stable within one response and is what functionResponse matches on.
            id: call?.name ? `gemini_${i}_${String(call.name)}` : `gemini_${i}`,
            name: String(call?.name ?? ''),
            arguments: (call?.args ?? {}) as Record<string, unknown>
          };
        })
        .filter((call) => call.name);
  }
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  return safeJson(raw) ?? {};
}

/* ---------------------------------------------------------------- transport */

/**
 * One deadline for a whole request: the connect budget first, then a gap budget
 * refreshed by every chunk that arrives, so a stalled stream fails on its own.
 */
function deadline(signal: AbortSignal): { signal: AbortSignal; touch: () => void; dispose: () => void } {
  const ctrl = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  const arm = (ms: number): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(new LlmError('Koneksi timeout', 'TIMEOUT')), ms);
  };
  const onOuterAbort = (): void => ctrl.abort(signal.reason);
  if (signal.aborted) ctrl.abort(signal.reason);
  else signal.addEventListener('abort', onOuterAbort, { once: true });
  arm(CONNECT_TIMEOUT_MS);
  return {
    signal: ctrl.signal,
    touch: () => arm(STREAM_GAP_TIMEOUT_MS),
    dispose: () => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', onOuterAbort);
    }
  };
}

function transportError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';
  if (name === 'AbortError' || /timeout|timed? ?out/i.test(message)) return new LlmError(message || 'Koneksi timeout', 'TIMEOUT');
  if (/certificate|self.signed|TLS|SSL/i.test(message)) return new LlmError(message, 'TLS');
  return new LlmError(message || 'Jaringan tidak tersedia', 'NETWORK');
}

const STRINGS = {
  apiKeyMissing: 'API key belum diisi',
  emptyResponse: 'Provider tidak mengembalikan teks',
  noModels: 'Tidak ada model yang bisa dibaca dari provider ini'
};

/** Android's `API error (<detail>)`, plus the code the detail never carries. */
function apiError(status: number, detail: string): string {
  return `API error (HTTP ${status}): ${detail}`;
}

async function postChat(
  endpoint: ResolvedEndpoint,
  apiKey: string,
  body: Record<string, unknown>,
  streaming: boolean,
  dl: ReturnType<typeof deadline>
): Promise<Response> {
  const url = streaming ? streamUrl(endpoint) : chatUrl(endpoint);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream, application/json',
        'Content-Type': 'application/json',
        ...authHeaders(endpoint.wireApi, apiKey)
      },
      body: JSON.stringify(body),
      signal: dl.signal
    });
  } catch (err) {
    throw transportError(err);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new LlmError(
      apiError(response.status, buildError(detail)),
      classifyError(response.status, detail),
      response.status
    );
  }
  if (!response.body) throw new LlmError('Provider tidak mengirim body (stream tidak didukung)', 'PARSE');
  return response;
}

/**
 * One round trip, with the Android client's self-healing retries: a provider that
 * refuses to stream is asked once more for a plain completion, and an OpenAI body
 * that names a retired parameter is resent with its modern spelling.
 */
async function exchange(
  endpoint: ResolvedEndpoint,
  apiKey: string,
  body: Record<string, unknown>,
  tools: ToolSchema[],
  dl: ReturnType<typeof deadline>
): Promise<Response> {
  const withDecls = withTools(endpoint.wireApi, body, tools);
  try {
    return await postChat(endpoint, apiKey, streamingBody(endpoint.wireApi, withDecls), true, dl);
  } catch (first) {
    const message = first instanceof Error ? first.message : '';

    if (isStreamingUnsupported(message)) {
      return postChat(endpoint, apiKey, withDecls, false, dl);
    }
    // A provider that will not accept tool declarations can still answer, so the
    // turn is retried plainly rather than lost.
    if (tools.length && first instanceof LlmError && isToolUnsupported(message)) {
      return postChat(endpoint, apiKey, streamingBody(endpoint.wireApi, body), true, dl);
    }
    // Only the OpenAI shape has something to change. Anthropic and Gemini never
    // send max_tokens, so resending their body buys a slower version of the error.
    if (endpoint.wireApi !== 'OPENAI_CHAT' || !shouldRetryWithAlternateParams(message)) throw first;
    const retry: Record<string, unknown> = { ...body };
    delete retry.temperature;
    delete retry.max_tokens;
    // The caller's own budget, not a fixed one: a connection test deliberately
    // asks for a small one, and raising it here would spend eight times the
    // budget it was told to spend.
    retry.max_completion_tokens = typeof body.max_tokens === 'number' ? body.max_tokens : DEFAULT_RETRY_BUDGET;
    return postChat(endpoint, apiKey, streamingBody(endpoint.wireApi, withTools(endpoint.wireApi, retry, tools)), true, dl);
  }
}

/* -------------------------------------------------------------- SSE decoding */

interface SseFrame {
  event: string;
  data: string;
}

function parseFrame(raw: string): SseFrame | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  return dataLines.length ? { event, data: dataLines.join('\n') } : null;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string' && message) return message;
  }
  if (typeof error === 'string' && error) return error;
  return fallback;
}

/**
 * Streams an SSE response, calling `onText` per delta.
 *
 * The raw text is kept alongside: a proxy that ignored `stream` answers with one
 * plain JSON object and no `data:` line, and the caller can still read it.
 */
async function consumeResponse(
  response: Response,
  endpoint: ResolvedEndpoint,
  handlers: StreamHandlers,
  dl: ReturnType<typeof deadline>
): Promise<StreamResult> {
  const reader = response.body?.getReader();
  if (!reader) throw new LlmError('Respons tidak punya body', 'PARSE');
  const wireApi = endpoint.wireApi;

  const decoder = new TextDecoder();
  let buffer = '';
  let raw = '';
  let frames = 0;
  let text = '';
  let stopReason = wireApi === 'ANTHROPIC_MESSAGES' ? 'end_turn' : 'stop';
  let usage: LlmUsage = { promptTokens: 0, completionTokens: 0, isKnown: false };

  // index -> accumulating tool call
  const acc = new Map<number, { id: string; name: string; json: string; started: boolean }>();
  const announce = (entry: { id: string; name: string; started: boolean } | undefined): void => {
    if (!entry || entry.started || !entry.name) return;
    entry.started = true;
    handlers.onToolStart({ id: entry.id, name: entry.name });
  };

  const handleFrame = (frame: SseFrame): void => {
    frames++;
    if (frame.data === '[DONE]') return;
    const d = safeJson(frame.data);
    if (!d) return;

    if (wireApi === 'OPENAI_CHAT') {
      if (d.error) throw new LlmError(`Provider error: ${errorMessage(d.error, frame.data)}`, 'SERVER');
      const choice = (d.choices as Array<Record<string, unknown>> | undefined)?.[0];
      if (choice) {
        const delta = choice.delta as Record<string, unknown> | undefined;
        if (typeof delta?.content === 'string' && delta.content) {
          text += delta.content;
          handlers.onText(delta.content);
        }
        for (const call of (delta?.tool_calls as Array<Record<string, unknown>> | undefined) ?? []) {
          const index = typeof call.index === 'number' ? call.index : 0;
          let entry = acc.get(index);
          if (!entry) {
            entry = { id: String(call.id || `call_${index}`), name: '', json: '', started: false };
            acc.set(index, entry);
          }
          if (call.id) entry.id = String(call.id);
          const fn = call.function as Record<string, unknown> | undefined;
          if (fn?.name) entry.name = String(fn.name);
          if (typeof fn?.arguments === 'string') entry.json += fn.arguments;
          announce(entry);
        }
        if (choice.finish_reason) stopReason = String(choice.finish_reason);
      }
      if (d.usage) usage = readUsage(d);
      return;
    }

    if (wireApi === 'ANTHROPIC_MESSAGES') {
      const type = String(d.type ?? frame.event);
      if (type === 'content_block_start') {
        const block = d.content_block as Record<string, unknown> | undefined;
        if (block?.type === 'tool_use') {
          const index = typeof d.index === 'number' ? d.index : 0;
          acc.set(index, {
            id: String(block.id ?? `tool_${index}`),
            name: String(block.name ?? ''),
            json: '',
            started: false
          });
        }
      } else if (type === 'content_block_delta') {
        const delta = d.delta as Record<string, unknown> | undefined;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          text += delta.text;
          handlers.onText(delta.text);
        } else if (delta?.type === 'input_json_delta') {
          const entry = acc.get(typeof d.index === 'number' ? d.index : 0);
          if (entry) entry.json += String(delta.partial_json ?? '');
        }
      } else if (type === 'content_block_stop') {
        announce(acc.get(typeof d.index === 'number' ? d.index : 0));
      } else if (type === 'message_delta') {
        const reason = (d.delta as Record<string, unknown> | undefined)?.stop_reason;
        if (reason) stopReason = String(reason);
        if (d.usage) usage = readUsage(d);
      } else if (type === 'message_start') {
        const message = d.message as Record<string, unknown> | undefined;
        if (message?.usage) usage = readUsage(message);
      } else if (type === 'error') {
        throw new LlmError(`Stream error: ${errorMessage(d.error, frame.data)}`, 'SERVER');
      }
      return;
    }

    // Gemini
    const candidate = (d.candidates as Array<Record<string, unknown>> | undefined)?.[0];
    const parts = geminiParts(candidate);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (typeof part.text === 'string' && part.text) {
        text += part.text;
        handlers.onText(part.text);
      }
      const call = part.functionCall as Record<string, unknown> | undefined;
      if (call?.name) {
        let entry = acc.get(i);
        if (!entry) {
          entry = { id: `gemini_${i}_${String(call.name)}`, name: '', json: '', started: false };
          acc.set(i, entry);
        }
        entry.name = String(call.name);
        // Gemini streams a call's args across several parts.
        entry.json += JSON.stringify(call.args ?? {});
        announce(entry);
      }
    }
    if (typeof candidate?.finishReason === 'string') stopReason = String(candidate.finishReason);
    if (d.usageMetadata) usage = readUsage(d);
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      dl.touch();
      const chunk = decoder.decode(value, { stream: true });
      raw += chunk;
      buffer += chunk;
      if (raw.length > MAX_RESPONSE_CHARS) throw new LlmError('Respons provider terlalu besar', 'PARSE');
      buffer = buffer.replace(/\r\n/g, '\n');
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const frame = parseFrame(block);
        if (frame) handleFrame(frame);
      }
    }
  } catch (err) {
    throw transportError(err);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }

  const toolCalls: ToolCallRecord[] = [];
  for (const entry of acc.values()) {
    announce(entry);
    const args = entry.json ? safeJson(entry.json) ?? {} : {};
    toolCalls.push({ id: entry.id, name: entry.name, arguments: args as Record<string, unknown> });
  }

  // No `data:` line at all: the provider ignored `stream` and sent one plain
  // completion, which is still a readable answer.
  if (!frames) {
    const body = safeJson(raw.trim());
    if (!body) throw new LlmError('Respons provider tidak bisa dibaca', 'PARSE');
    text = readText(wireApi, body);
    handlers.onText(text);
    usage = readUsage(body);
    toolCalls.push(...parseToolCalls(wireApi, body));
    switch (wireApi) {
      case 'OPENAI_CHAT':
        stopReason = String((body.choices as Array<Record<string, unknown>> | undefined)?.[0]?.finish_reason ?? 'stop');
        break;
      case 'ANTHROPIC_MESSAGES':
        stopReason = String(body.stop_reason ?? 'end_turn');
        break;
      case 'GEMINI_CONTENT':
        stopReason = String(
          (body.candidates as Array<Record<string, unknown>> | undefined)?.[0]?.finishReason ?? 'stop'
        );
        break;
    }
  }

  if (wireApi === 'ANTHROPIC_MESSAGES' && toolCalls.length && stopReason === 'end_turn') stopReason = 'tool_use';
  if (wireApi !== 'ANTHROPIC_MESSAGES' && toolCalls.length && stopReason === 'stop') stopReason = 'tool_calls';

  // A turn that carries neither prose nor a tool call is an empty completion,
  // and must read as one: that is what earns a second attempt with a bigger
  // budget, and a reasoning model can produce exactly this while thinking.
  if (!text.trim() && !toolCalls.length) {
    throw new LlmError(`Respons kosong dari provider${stopReason ? ` (${stopReason})` : ''}.`, 'PARSE');
  }

  handlers.onUsage?.(usage);
  return { text, toolCalls, stopReason, usage };
}

/* ------------------------------------------------------------------- public */

export interface ChatOptions {
  /** Start the request with tools enabled, so they can be dropped on refusal. */
  tools?: ToolSchema[];
  handlers: StreamHandlers;
  signal: AbortSignal;
  system?: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * One streamed completion. Provider-agnostic: Anthropic, Gemini and any
 * OpenAI-compatible endpoint share this entry point, each with its own wire
 * format.
 */
export async function chat(
  endpoint: ResolvedEndpoint,
  apiKey: string,
  history: ChatMessage[],
  opts: ChatOptions
): Promise<StreamResult> {
  if (!apiKey.trim() && endpoint.requiresApiKey) throw new LlmError(STRINGS.apiKeyMissing, 'AUTH');
  const tools = opts.tools ?? [];
  const dl = deadline(opts.signal);
  try {
    const body = buildBody(
      endpoint.wireApi,
      endpoint,
      normalizeHistory(history),
      opts.system ?? DEFAULT_SYSTEM,
      opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      opts.temperature ?? 0.6,
      false
    );
    const response = await exchange(endpoint, apiKey, body, tools, dl);
    return await consumeResponse(response, endpoint, opts.handlers, dl);
  } finally {
    dl.dispose();
  }
}

/** Config-shaped facade used by the agent loop. */
export async function streamChat(
  cfg: AppConfig,
  messages: ChatMessage[],
  tools: ToolSchema[],
  handlers: StreamHandlers,
  signal: AbortSignal
): Promise<StreamResult> {
  const endpoint = resolve(cfg.provider, cfg.customBaseUrl, cfg.model, true, cfg.customWireApi);
  if (!endpoint) throw new LlmError('Provider atau model belum diatur', 'MODEL');
  return chat(endpoint, cfg.apiKey, messages, {
    tools,
    handlers,
    signal,
    system: cfg.system,
    maxTokens: cfg.maxTokens,
    temperature: cfg.temperature
  });
}

/* -------------------------------------------------------------- discovery */

/**
 * The full `/models` payload, including any price the provider volunteered.
 *
 * Re-fetched whenever the user asks for a fresh list, so pricing is never read
 * from a table baked into the app.
 */
export async function listModelCatalog(
  providerId: string,
  customBaseUrl: string,
  apiKey: string,
  signal: AbortSignal,
  customWireApi: ResolvedEndpoint['wireApi'] = 'OPENAI_CHAT'
): Promise<ModelEntry[]> {
  const endpoint = resolveForDiscovery(providerId, customBaseUrl, customWireApi);
  if (!endpoint) throw new LlmError('Base URL belum diisi', 'MODEL');
  if (!apiKey.trim() && endpoint.requiresApiKey) throw new LlmError(STRINGS.apiKeyMissing, 'AUTH');

  const url = modelsUrl(endpoint);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new LlmError('Koneksi timeout', 'TIMEOUT')), MODELS_TIMEOUT_MS);
  const onOuterAbort = (): void => ctrl.abort(signal.reason);
  if (signal.aborted) ctrl.abort(signal.reason);
  else signal.addEventListener('abort', onOuterAbort, { once: true });

  let raw = '';
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...authHeaders(endpoint.wireApi, apiKey) },
      signal: ctrl.signal
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new LlmError(
        apiError(response.status, buildError(detail)),
        classifyError(response.status, detail),
        response.status
      );
    }
    raw = await response.text();
  } catch (err) {
    throw transportError(err);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onOuterAbort);
  }

  const models = parseModelCatalog(raw);
  if (!models.length) throw new LlmError(STRINGS.noModels, 'PARSE');
  return models;
}

/* ------------------------------------------------------- connection testing */

export interface TestReport {
  ok: boolean;
  message: string;
  kind: ApiErrorKind | null;
  billingUrl: string | null;
  suggestedModel: string | null;
}

/** Only an empty completion earns a second attempt; a rejected key fails twice. */
export function isRetryableBlank(err: unknown): boolean {
  return err instanceof LlmError && err.kind === 'PARSE';
}

/**
 * Proves a key works, on a cheap non-reasoning model.
 *
 * The test deliberately does not run on whatever model the user has selected: a
 * reasoning model can spend the whole budget thinking and answer nothing, and an
 * expensive one charges the user for a test.
 */
export async function testConnection(
  providerId: string,
  customBaseUrl: string,
  apiKey: string,
  activeModel: string,
  signal: AbortSignal,
  customWireApi: ResolvedEndpoint['wireApi'] = 'OPENAI_CHAT'
): Promise<TestReport> {
  const preset = presetFor(providerId);
  const billingUrl = preset.billingUrl ?? null;
  const fail = (err: unknown): TestReport => ({
    ok: false,
    message: err instanceof Error ? err.message : String(err),
    kind: err instanceof LlmError ? err.kind : 'UNKNOWN',
    billingUrl,
    suggestedModel: null
  });

  // A curated pick is only worth trying when the account can actually see it;
  // otherwise the discovered catalogue decides.
  let probeModel = '';
  try {
    const discovered = await listModelCatalog(providerId, customBaseUrl, apiKey, signal, customWireApi);
    probeModel = cheapTestModel(providerId, discovered.map((m) => m.id)) ?? '';
  } catch {
    probeModel = activeModel.trim();
  }
  probeModel = probeModel || activeModel.trim();
  if (!probeModel) {
    return { ok: false, message: 'Isi model terlebih dahulu', kind: 'MODEL', billingUrl, suggestedModel: null };
  }

  const endpoint = resolve(providerId, customBaseUrl, probeModel, true, customWireApi);
  if (!endpoint) {
    return { ok: false, message: 'Base URL belum diisi', kind: 'MODEL', billingUrl, suggestedModel: null };
  }

  const attempt = async (maxTokens: number): Promise<string | null> => {
    try {
      const result = await chat(endpoint, apiKey, [{ role: 'user', text: TEST_PING }], {
        handlers: { onText: () => undefined, onToolStart: () => undefined },
        signal,
        system: 'Jawab singkat.',
        maxTokens,
        temperature: 0.6
      });
      return result.text.trim() || null;
    } catch (err) {
      if (isRetryableBlank(err)) return null;
      throw err;
    }
  };

  try {
    const first = await attempt(TEST_TOKENS_TIGHT);
    // Still empty means the thinking did not get the room it needed, so one more
    // try with a real budget before telling the user anything went wrong.
    const reply = first ?? (await attempt(TEST_TOKENS_ROOMY));
    if (reply) {
      return {
        ok: true,
        message: `Koneksi berhasil · ${preset.label} · ${probeModel}`,
        kind: null,
        billingUrl,
        suggestedModel: null
      };
    }
    return {
      ok: false,
      message: STRINGS.emptyResponse,
      kind: 'PARSE',
      billingUrl,
      suggestedModel: repairModelFor(providerId)
    };
  } catch (err) {
    const report = fail(err);
    // A refused model is the one failure with a concrete next step.
    if (report.kind === 'MODEL' && probeModel !== activeModel.trim()) {
      report.suggestedModel = repairModelFor(providerId, [activeModel]);
    }
    return report;
  }
}