import { Store } from './store';
import { executeTool, toolSchemas } from './tools';
import { LlmError, maxTokensCeiling, streamChat } from './llm/chat';
import { DEFAULT_SYSTEM, repairModelFor } from '../shared/providers';
import { modeFor, modeUsesTools, promptFor } from '../shared/modes';
import type { ChatMessage, RunEvent, RunStatus, ToolCallRecord, ToolResultRecord } from '../shared/types';

const MAX_ITERATIONS = 12;

/** One line the user can act on, per failure kind. */
function explain(err: unknown, cfg: ReturnType<Store['getConfig']>): string {
  if (!(err instanceof LlmError)) return err instanceof Error ? err.message : String(err);
  const detail = err.message;
  switch (err.kind) {
    case 'AUTH':
      return `**API key ditolak** (${detail}). Cek ulang key di provider yang dipilih.`;
    case 'BILLING':
      return `**Saldo/kredit habis** (${detail}). Top up dulu di halaman billing provider.`;
    case 'RATE_LIMIT':
      return `**Rate limit** (${detail}). Tunggu sebentar lalu coba lagi.`;
    case 'MODEL': {
      const better = repairModelFor(cfg.provider);
      const hint = better && better !== cfg.model ? ` Coba model \`${better}\`.` : '';
      return `**Model tidak bisa dipakai** (${detail}).${hint}`;
    }
    case 'TIMEOUT':
      return `**Koneksi timeout** (${detail}). Periksa jaringan atau ganti provider.`;
    case 'NETWORK':
    case 'TLS':
      return `**Tidak bisa menghubungi provider** (${detail}).`;
    case 'SERVER':
      return `**Provider sedang bermasalah** (${detail}).`;
    default:
      return `**Error:** ${detail}`;
  }
}

export interface RunContext {
  store: Store;
  emit: (evt: RunEvent) => void;
}

/**
 * Execute a single user turn: stream the model response, run any requested
 * tools, feed the results back, and repeat until the model stops asking for
 * tools or the iteration budget runs out.
 */
export async function runAgent(ctx: RunContext, sessionId: string, userText: string, signal: AbortSignal): Promise<RunStatus> {
  const { store, emit } = ctx;
  const cfg = store.getConfig();
  const workspaceRoot = store.getWorkspaceRoot();
  const mode = store.getMode();
  // A mode decides which tools the agent may reach for; the prompt it appends
  // goes out with the request, so the model is told which way it is meant to work.
  const useTools = store.getToolsEnabled() && modeUsesTools(mode);
  const system = promptFor(cfg.system, mode);
  void modeFor(mode);

  const session = store.getSession(sessionId);
  if (!session) {
    emit({ type: 'finished', status: 'error', error: 'Sesi tidak ditemukan' });
    return 'error';
  }

  const userMessage: ChatMessage = { role: 'user', text: userText.trim(), createdAt: Date.now() };
  session.messages.push(userMessage);
  store.touch(session);

  const assistantMessage: ChatMessage = {
    role: 'assistant',
    text: '',
    tool_calls: [],
    tool_results: [],
    createdAt: Date.now()
  };
  session.messages.push(assistantMessage);

  const apiHistory: ChatMessage[] = session.messages.slice(0, -1);
  const schemas = useTools ? toolSchemas() : [];

  emit({ type: 'started' });

  let status: RunStatus = 'done';
  let iterations = 0;

  try {
    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      if (signal.aborted) {
        status = 'stopped';
        break;
      }
      iterations = iter + 1;

      const turnText: string[] = [];
      const turnCalls: ToolCallRecord[] = [];
      const turnResults: ToolResultRecord[] = [];

      // A model with a smaller window than the requested budget rejects it by
      // naming its own ceiling, so the budget is lowered and the turn retried.
      let tokenBudget = cfg.maxTokens;
      let result;
      for (;;) {
        try {
          result = await streamChat(
            { ...cfg, maxTokens: tokenBudget, system },
            apiHistory,
            schemas,
            {
              onText(chunk) {
                turnText.push(chunk);
                assistantMessage.text += chunk;
                emit({ type: 'text', text: chunk });
              },
              onToolStart(call) {
                emit({ type: 'tool_start', id: call.id, name: call.name });
              }
            },
            signal
          );
          break;
        } catch (err) {
          const ceiling = maxTokensCeiling(err instanceof Error ? err.message : '');
          if (ceiling === null || ceiling >= tokenBudget) throw err;
          tokenBudget = ceiling;
        }
      }

      turnCalls.push(...result.toolCalls);
      for (const tc of result.toolCalls) {
        if (!assistantMessage.tool_calls?.some((x) => x.id === tc.id)) {
          assistantMessage.tool_calls = [...(assistantMessage.tool_calls ?? []), tc];
        }
      }

      const turnTextValue = turnText.join('');
      const needsTools = result.toolCalls.length > 0 && result.stopReason !== 'end_turn' && useTools;

      if (!needsTools) {
        apiHistory.push({
          role: 'assistant',
          text: turnTextValue,
          tool_calls: result.toolCalls.length ? result.toolCalls : undefined,
          tool_results: result.toolCalls.length ? turnResults : undefined
        });
        status = 'done';
        break;
      }

      // Execute every requested tool, in order.
      for (const tc of result.toolCalls) {
        if (signal.aborted) break;
        const res = await executeTool(tc.name, tc.arguments ?? {}, workspaceRoot);
        const record: ToolResultRecord = {
          tool_call_id: tc.id,
          name: tc.name,
          content: res.content,
          isError: res.isError
        };
        turnResults.push(record);
        assistantMessage.tool_results = [...(assistantMessage.tool_results ?? []), record];
        emit({
          type: 'tool_end',
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
          content: res.content,
          isError: Boolean(res.isError)
        });
        store.touch(session);
      }

      apiHistory.push({ role: 'assistant', text: turnTextValue, tool_calls: result.toolCalls, tool_results: turnResults });

      if (signal.aborted) {
        status = 'stopped';
        break;
      }
    }

    if (status !== 'stopped' && iterations >= MAX_ITERATIONS) status = 'max_iterations';
  } catch (err) {
    if (signal.aborted || (err as Error).name === 'AbortError') {
      status = 'stopped';
    } else {
      status = 'error';
      const msg = `\n\n${explain(err, cfg)}`;
      assistantMessage.text += assistantMessage.text ? msg : msg.trim();
      emit({ type: 'text', text: msg });
    }
  }

  if (status === 'stopped') {
    assistantMessage.text += assistantMessage.text ? '\n\n' : '';
    assistantMessage.text += '_(dihentikan pengguna)_';
  }

  if (!assistantMessage.text.trim() && status === 'done') {
    assistantMessage.text = '_(model tidak mengembalikan teks)_';
  }

  store.touch(session);
  await store.flush();
  emit({ type: 'finished', status });
  return status;
}

/** Prompt used when no API key has been configured yet. */
export const MISSING_KEY_MESSAGE = `API key belum diatur. Buka **Pengaturan** (ikon sliders di header), pilih provider, lalu isi API key kamu.\n\nSystem prompt bawaan:\n> ${DEFAULT_SYSTEM}`;