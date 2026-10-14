import type { ChatMessage } from './types';

/**
 * Attachment shapes shared by the main process (which reads files) and the
 * renderer (which shows them and turns them into a message).
 */

export interface Attachment {
  path: string;
  name: string;
  bytes: number;
  kind: string;
  mimeType: string;
  text: string;
  /** True when the bytes are the only way to carry this file. */
  native: boolean;
  note: string | null;
}

/**
 * The most one request will carry inline, to keep a turn inside a budget.
 *
 * Roughly what a provider will accept before it starts truncating or refusing,
 * and comfortably under the request size limit.
 */
export const MAX_INLINE_BYTES = 18 * 1024 * 1024;

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * What the composer sends for one parsed file.
 *
 * The header matters as much as the body: without it a model asked to "explain
 * this" has no idea which of six pasted files is the subject.
 */
export function composeAttachmentText(file: Attachment): string {
  const header = `\n\n--- ${file.name} (${file.kind}, ${humanBytes(file.bytes)}) ---`;
  if (file.text.trim()) return `${header}\n${file.text.trim()}`;
  if (file.note) return `${header}\n${file.note}`;
  return '';
}

/** The message a batch of attachments turns into. */
export function messageFor(text: string, files: Attachment[], carried: ChatMessage['attachments']): ChatMessage {
  const parsed = files.filter((f) => f.text.trim());
  const body = [text.trim(), ...parsed.map(composeAttachmentText)].filter(Boolean).join('\n');
  const message: ChatMessage = {
    role: 'user',
    text: body || files.map((f) => `\n\n--- ${f.name} ---`).join(''),
    createdAt: Date.now()
  };
  if (carried?.length) message.attachments = carried;
  return message;
}