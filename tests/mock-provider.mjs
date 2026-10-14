/**
 * Mock OpenAI-compatible provider used by the end-to-end smoke test.
 *
 *   turn 1 -> streams text, then requests a write_file tool call
 *   turn 2 -> streams the final answer
 *
 * Every request body is appended to SELFDEV_MOCK_LOG for assertions.
 */
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

const PORT = Number(process.env.SELFDEV_MOCK_PORT ?? 8765);

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', () => {
    if (!req.url?.startsWith('/v1/')) {
      res.writeHead(404).end('not found');
      return;
    }
    try {
      appendFileSync(process.env.SELFDEV_MOCK_LOG ?? '/tmp/opencode/mock-requests.log', `${body}\n`);
    } catch {
      /* ignore */
    }

    let parsed = {};
    try {
      parsed = JSON.parse(body || '{}');
    } catch {
      /* ignore */
    }

    console.log(`[mock] ${req.method} ${req.url} keys=${Object.keys(parsed).join(',')} auth=${Boolean(req.headers['x-api-key'] || req.headers.authorization)}`);
    // A slow answer, so the smoke test can assert the settings dialog stays put
    // while a request is still in flight.
    if (req.url?.includes('/slow') && req.url?.includes('/chat/completions')) return slowStream(res);
    if (req.url?.includes('/slow') && req.url?.includes('/messages')) return slowStream(res, true);
    if (req.url?.includes('/messages')) return anthropicStream(res, parsed);
    return openAiStream(res, parsed);
  });
});

function slowStream(res, anthropic = false) {
  setTimeout(() => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (anthropic) {
      anth(res, 'message_start', { message: { id: 'msg_slow', type: 'message', role: 'assistant', content: [] } });
      anth(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } });
      anth(res, 'message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } });
      anth(res, 'message_stop', {});
    } else {
      sse(res, { choices: [{ delta: { content: 'ok' } }] });
      sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }] });
      res.write('data: [DONE]\n\n');
    }
    res.end();
  }, 2500);
}

/** True once the model has been shown a tool_result (Anthropic shape). */
function sawToolResult(messages = []) {
  return messages.some(
    (m) =>
      m.role === 'tool' ||
      (Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_result'))
  );
}

function openAiStream(res, parsed) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });

  if (!sawToolResult(parsed.messages)) {
    sse(res, { choices: [{ delta: { role: 'assistant', content: 'Saya akan menulis file. ' } }] });
    sse(res, { choices: [{ delta: { content: 'Sebentar.' } }] });
    sse(res, {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_e2e_1',
                type: 'function',
                function: {
                  name: 'write_file',
                  arguments: JSON.stringify({ path: 'catatan-e2e.txt', content: 'halo dari e2e\n' })
                }
              }
            ]
          }
        }
      ]
    });
    sse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
  } else {
    sse(res, { choices: [{ delta: { role: 'assistant', content: 'Selesai! File `' } }] });
    sse(res, { choices: [{ delta: { content: 'catatan-e2e.txt` sudah ditulis.' } }] });
    sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }] });
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

function anth(res, type, payload) {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
}

function anthropicStream(res, parsed) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });

  anth(res, 'message_start', {
    message: { id: 'msg_e2e', type: 'message', role: 'assistant', model: 'mock', content: [], stop_reason: null }
  });

  if (!sawToolResult(parsed.messages)) {
    anth(res, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    anth(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Saya akan menulis file. Sebentar.' } });
    anth(res, 'content_block_stop', { index: 0 });
    anth(res, 'content_block_start', {
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_e2e_1', name: 'write_file', input: {} }
    });
    anth(res, 'content_block_delta', {
      index: 1,
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify({ path: 'catatan-e2e.txt', content: 'halo dari e2e\n' })
      }
    });
    anth(res, 'content_block_stop', { index: 1 });
    anth(res, 'message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } });
  } else {
    anth(res, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    anth(res, 'content_block_delta', {
      index: 0,
      delta: { type: 'text_delta', text: 'Selesai! File `catatan-e2e.txt` sudah ditulis.' }
    });
    anth(res, 'content_block_stop', { index: 0 });
    anth(res, 'message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } });
  }
  anth(res, 'message_stop', {});
  res.end();
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] listening on http://127.0.0.1:${PORT}/v1`);
});