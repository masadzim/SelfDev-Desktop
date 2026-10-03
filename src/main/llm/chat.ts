import { endpointFor, DEFAULT_MAX_TOKENS } from '../../shared/providers';
import type { AppConfig, ChatMessage, ToolCallRecord } from '../../shared/types';
import { readSse } from './sse';

export interface StreamHandlers {
  onText(chunk: string): void;
  onToolStart(call: { id: string; name: string }): void;
}

export interface StreamResult {
  text: string;
  toolCalls: ToolCallRecord[];
  stopReason: string;
}

interface ToolSchema {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

function trim(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n… [truncated]` : s;
}

/**
 * Send one chat completion request and stream the response back through the
 * handlers. Provider-agnostic: Anthropic and any OpenAI-compatible endpoint
 * (OpenAI, OpenRouter, Groq, Ollama, LM Studio…) share this entry point.
 */
export async function streamChat(
  cfg: AppConfig,
  messages: ChatMessage[],
  tools: ToolSchema[],
  handlers: StreamHandlers,
  signal: AbortSignal
): Promise<StreamResult> {
  const maxTokens = cfg.maxTokens || DEFAULT_MAX_TOKENS;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let body: Record<string, unknown>;

  if (cfg.mode === 'anthropic') {
    headers['x-api-key'] = cfg.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    body = {
      model: cfg.model,
      max_tokens: maxTokens,
      temperature: cfg.temperature,
      system: cfg.system,
      messages: toAnthropicMessages(messages),
      tools: tools.length ? tools : undefined,
      stream: true
    };
  } else {
    headers.Authorization = `Bearer ${cfg.apiKey}`;
    body = {
      model: cfg.model,
      temperature: cfg.temperature,
      max_tokens: maxTokens,
      messages: toOpenAIMessages(cfg, messages),
      tools: tools.length
        ? tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }))
        : undefined,
      stream: true
    };
  }

  const response = await fetch(endpointFor(cfg), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok || !response.body) {
    let detail = '';
    try {
      detail = trim(await response.text(), 600);
    } catch {
      /* ignore */
    }
    throw new Error(`HTTP ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`);
  }

  return cfg.mode === 'anthropic'
    ? parseAnthropic(response, handlers)
    : parseOpenAI(response, handlers);
}

// --------------------------------------------------------------- Anthropic

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicBlock[] | string;
}

/** Anthropic requires strict role alternation starting with `user`. */
function toAnthropicMessages(messages: ChatMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];

  const push = (role: 'user' | 'assistant', content: AnthropicBlock[]): void => {
    if (!content.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) {
      const prev = Array.isArray(last.content) ? last.content : [{ type: 'text', text: last.content } as AnthropicBlock];
      last.content = prev.concat(content);
    } else {
      out.push({ role, content });
    }
  };

  for (const m of messages) {
    if (m.role === 'user') {
      const blocks: AnthropicBlock[] = [];
      if (m.text) blocks.push({ type: 'text', text: m.text });
      push('user', blocks);
    } else {
      const blocks: AnthropicBlock[] = [];
      if (m.text) blocks.push({ type: 'text', text: m.text });
      for (const tc of m.tool_calls ?? []) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments ?? {} });
      }
      push('assistant', blocks);
    }
    // tool_result blocks must live in a user turn right after the assistant tool_use turn.
    if (m.tool_results?.length) {
      push(
        'user',
        m.tool_results.map(
          (tr): AnthropicBlock => ({ type: 'tool_result', tool_use_id: tr.tool_call_id, content: String(tr.content ?? '') })
        )
      );
    }
  }

  // The first turn must come from the user.
  while (out.length && out[0].role === 'assistant') out.shift();
  return out;
}

async function parseAnthropic(response: Response, handlers: StreamHandlers): Promise<StreamResult> {
  let text = '';
  let stopReason = 'end_turn';
  const toolCalls: ToolCallRecord[] = [];
  // content-block index -> accumulating tool_use
  const acc = new Map<number, { id: string; name: string; json: string; started: boolean }>();

  for await (const evt of readSse(response)) {
    if (evt.data === '[DONE]') continue;
    let d: Record<string, any>;
    try {
      d = JSON.parse(evt.data) as Record<string, any>;
    } catch {
      continue;
    }
    const type = d.type ?? evt.event;

    if (type === 'content_block_start') {
      const block = d.content_block as { type?: string; id?: string; name?: string } | undefined;
      if (block?.type === 'tool_use') {
        const index = d.index as number;
        acc.set(index, { id: block.id ?? `tool_${index}`, name: block.name ?? '', json: '', started: false });
      }
    } else if (type === 'content_block_delta') {
      const delta = d.delta as { type?: string; text?: string; partial_json?: string } | undefined;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        text += delta.text;
        handlers.onText(delta.text);
      } else if (delta?.type === 'input_json_delta') {
        const entry = acc.get(d.index as number);
        if (entry) entry.json += delta.partial_json ?? '';
      }
    } else if (type === 'content_block_stop') {
      const entry = acc.get(d.index as number);
      if (entry && !entry.started) {
        entry.started = true;
        handlers.onToolStart({ id: entry.id, name: entry.name });
      }
    } else if (type === 'message_delta') {
      const reason = (d.delta as { stop_reason?: string } | undefined)?.stop_reason;
      if (reason) stopReason = reason;
    } else if (type === 'message_stop') {
      break;
    } else if (type === 'error') {
      throw new Error(`Anthropic stream error: ${(d.error as { message?: string })?.message ?? evt.data}`);
    }
  }

  for (const entry of acc.values()) {
    let args: Record<string, unknown> = {};
    try {
      args = entry.json ? (JSON.parse(entry.json) as Record<string, unknown>) : {};
    } catch {
      args = {};
    }
    if (!entry.started) handlers.onToolStart({ id: entry.id, name: entry.name });
    toolCalls.push({ id: entry.id, name: entry.name, arguments: args });
  }

  if (toolCalls.length && stopReason === 'end_turn') stopReason = 'tool_use';
  return { text, toolCalls, stopReason };
}

// ----------------------------------------------------------------- OpenAI

interface OpenAiMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

function toOpenAIMessages(cfg: AppConfig, messages: ChatMessage[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];
  if (cfg.system) out.push({ role: 'system', content: cfg.system });

  for (const m of messages) {
    if (m.role === 'user') {
      if (m.text) out.push({ role: 'user', content: m.text });
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
    // Tool results always follow the assistant turn that requested them.
    for (const tr of m.tool_results ?? []) {
      out.push({ role: 'tool', tool_call_id: tr.tool_call_id, content: String(tr.content ?? '') });
    }
  }

  // Drop a leading orphan "tool" message (no preceding assistant tool_calls).
  while (out.length && out[0].role === 'tool') out.shift();
  return out;
}

async function parseOpenAI(response: Response, handlers: StreamHandlers): Promise<StreamResult> {
  let text = '';
  let stopReason = 'stop';
  const toolCalls: ToolCallRecord[] = [];
  // tool-call index -> accumulating call
  const acc = new Map<number, { id: string; name: string; json: string; started: boolean }>();

  for await (const evt of readSse(response)) {
    if (evt.data === '[DONE]') {
      stopReason = toolCalls.length ? 'tool_calls' : stopReason;
      break;
    }
    let d: Record<string, any>;
    try {
      d = JSON.parse(evt.data) as Record<string, any>;
    } catch {
      continue;
    }
    if (d.error) {
      throw new Error(`Provider error: ${(d.error as { message?: string }).message ?? evt.data}`);
    }
    const choice = (d.choices as Array<Record<string, any>> | undefined)?.[0];
    if (!choice) continue;

    const delta = choice.delta as
      | { content?: string | null; tool_calls?: Array<Record<string, any>> }
      | undefined;

    if (typeof delta?.content === 'string' && delta.content) {
      text += delta.content;
      handlers.onText(delta.content);
    }

    for (const call of delta?.tool_calls ?? []) {
      const index = (call.index as number) ?? 0;
      let entry = acc.get(index);
      if (!entry) {
        entry = { id: (call.id as string) || `call_${index}`, name: '', json: '', started: false };
        acc.set(index, entry);
      }
      if (call.id) entry.id = call.id as string;
      const fn = call.function as { name?: string; arguments?: string } | undefined;
      if (fn?.name) entry.name = fn.name;
      if (fn?.arguments) entry.json += fn.arguments;
      // Announce as soon as we know the tool name.
      if (!entry.started && entry.name) {
        entry.started = true;
        handlers.onToolStart({ id: entry.id, name: entry.name });
      }
    }

    if (choice.finish_reason) stopReason = choice.finish_reason as string;
  }

  for (const entry of acc.values()) {
    let args: Record<string, unknown> = {};
    try {
      args = entry.json ? (JSON.parse(entry.json) as Record<string, unknown>) : {};
    } catch (err) {
      args = {};
      if (entry.json) {
        handlers.onText(`\n\n> ⚠ Arguments tool \`${entry.name}\` bukan JSON valid: ${(err as Error).message}\n`);
      }
    }
    if (!entry.started) handlers.onToolStart({ id: entry.id, name: entry.name });
    toolCalls.push({ id: entry.id, name: entry.name, arguments: args });
  }

  if (toolCalls.length && stopReason === 'stop') stopReason = 'tool_calls';
  return { text, toolCalls, stopReason };
}

// -------------------------------------------------------------- connection

/** Tiny connectivity probe used by the settings dialog. */
export async function testConnection(params: {
  mode: 'anthropic' | 'openai';
  baseUrl: string;
  apiKey: string;
  model: string;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; message: string }> {
  if (!params.apiKey) return { ok: false, message: 'API key kosong' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  const signal = params.signal ?? ctrl.signal;

  try {
    const url =
      params.mode === 'anthropic'
        ? `${params.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/messages`
        : `${params.baseUrl.replace(/\/+$/, '')}/chat/completions`;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const payload: Record<string, unknown> = {
      model: params.model || 'test',
      max_tokens: 8,
      messages: [{ role: 'user', content: 'hi' }]
    };
    if (params.mode === 'anthropic') {
      headers['x-api-key'] = params.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers.Authorization = `Bearer ${params.apiKey}`;
    }

    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal });
    if (!res.ok) {
      const detail = trim(await res.text().catch(() => ''), 300);
      return { ok: false, message: `HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}` };
    }
    // Drain so the socket closes cleanly.
    await res.text().catch(() => '');
    return { ok: true, message: 'Koneksi berhasil, API key valid.' };
  } catch (err) {
    const e = err as Error;
    return { ok: false, message: e.name === 'AbortError' ? 'Timeout 20 detik' : e.message };
  } finally {
    clearTimeout(timer);
  }
}