/** Minimal, allocation-light Server-Sent Events reader over a fetch response. */

export interface SseEvent {
  event: string;
  data: string;
}

export async function* readSse(response: Response): AsyncGenerator<SseEvent> {
  const body = response.body;
  if (!body) throw new Error('Respons tidak punya body (stream tidak didukung)');

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const emit = (raw: string): SseEvent | null => {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of raw.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (!dataLines.length) return null;
    return { event, data: dataLines.join('\n') };
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // normalise CRLF so the delimiter search is uniform
      buffer = buffer.replace(/\r\n/g, '\n');
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const parsed = emit(block);
        if (parsed) yield parsed;
      }
    }
    buffer += decoder.decode();
    const tail = emit(buffer.replace(/\r\n/g, '\n'));
    if (tail) yield tail;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}