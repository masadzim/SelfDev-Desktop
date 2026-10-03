import { Store } from './store';
import { executeTool, toolSchemas } from './tools';
import { streamChat } from './llm/chat';
import { DEFAULT_SYSTEM } from '../shared/providers';
import type { ChatMessage, RunEvent, RunStatus, ToolCallRecord, ToolResultRecord } from '../shared/types';

const MAX_ITERATIONS = 12;

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
  const useTools = store.getMode() === 'dev';

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

      const result = await streamChat(
        cfg,
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
      const msg = `**Error:** ${(err as Error).message}`;
      assistantMessage.text += assistantMessage.text ? `\n\n${msg}` : msg;
      emit({ type: 'text', text: `\n\n${msg}` });
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
export const MISSING_KEY_MESSAGE = `API key belum diatur. Buka **Pengaturan Model** (ikon ⚙ di header), pilih provider, lalu isi API key kamu.\n\nSystem prompt bawaan:\n> ${DEFAULT_SYSTEM}`;