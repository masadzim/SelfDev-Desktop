import { promises as fs } from 'node:fs';
import { extname, basename } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';



/**
 * Turning a file into something a language model can read.
 *
 * Text is preferred over shipping the bytes: a 40-page report becomes a few
 * thousand tokens the model can quote, while the same file as a data URL costs a
 * fortune and often comes back truncated. Binary formats are parsed natively
 * first, and handed over as bytes only when the text layer is empty or the
 * model is one that reads the original.
 */

export type ExtractionKind = 'text' | 'markdown' | 'code' | 'json' | 'csv' | 'pdf' | 'docx' | 'xlsx' | 'image' | 'binary';

export type ExtractedFile = import('../../shared/attachments').Attachment & { kind: ExtractionKind };

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'rst', 'log', 'txtl', 'env', 'ini', 'toml', 'cfg', 'conf', 'gitignore'
]);
const CODE_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'jsonc', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'swift', 'php', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'sql', 'html',
  'htm', 'css', 'scss', 'less', 'vue', 'svelte', 'graphql', 'gql', 'proto', 'tf', 'yaml', 'yml', 'lua',
  'pl', 'r', 'jl', 'dart', 'ex', 'exs', 'erl', 'hs', 'ml', 'clj', 'scala', 'gradle', 'make', 'mk', 'cmake'
]);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif']);

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  csv: 'text/csv',
  json: 'application/json',
  md: 'text/markdown'
};

export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;

export function kindFor(path: string): ExtractionKind {
  const ext = extname(path).slice(1).toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (ext === 'xlsx') return 'xlsx';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (ext === 'json' || ext === 'jsonc') return 'json';
  if (ext === 'csv') return 'csv';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (CODE_EXTENSIONS.has(ext)) return 'code';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return 'binary';
}

export function mimeFor(path: string): string {
  const ext = extname(path).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] ?? (TEXT_EXTENSIONS.has(ext) || CODE_EXTENSIONS.has(ext) ? 'text/plain' : 'application/octet-stream');
}

/* ------------------------------------------------------------- text files -- */

async function readText(path: string): Promise<string> {
  const handle = await fs.open(path, 'r');
  try {
    const stat = await handle.stat();
    const length = Math.min(stat.size, MAX_TEXT_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    // A NUL byte early on means this is not the text file its extension claims.
    const probe = buffer.subarray(0, 4096);
    if (probe.includes(0)) throw new Error('binary');
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

/* --------------------------------------------------------------- OOXML ---- */

/**
 * The smallest ZIP reader that can do the job: OOXML files are stored or
 * deflated, and only one member is ever wanted, so a full unzip is overkill.
 */
function readZipEntry(buffer: Buffer, wanted: string): Buffer | null {
  // The end-of-central-directory record lives in the last 64 KiB.
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd === -1) return null;
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) return null;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;

    if (name !== wanted) continue;
    // Walk the local header to find where the data really starts.
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(start, start + compressedSize);
    try {
      return method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
    } catch {
      return null;
    }
  }
  return null;
}

/** `<w:t>` runs out of a WordprocessingML body, one paragraph per line. */
function docxText(xml: Buffer): string {
  const body = xml.toString('utf8');
  const paragraphs = body.match(/<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g) ?? [];
  const lines: string[] = [];
  for (const p of paragraphs) {
    const runs = [...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) =>
      decodeXmlEntities(m[1])
    );
    const line = runs.join('').trim();
    if (line) lines.push(line);
  }
  return lines.join('\n');
}

/** Sheet data out of a SpreadsheetML workbook, tab-separated. */
function xlsxText(buffer: Buffer): string {
  const shared = new Map<string, string>();
  const sharedXml = readZipEntry(buffer, 'xl/sharedStrings.xml');
  if (sharedXml) {
    const raw = sharedXml.toString('utf8');
    const items = raw.match(/<si>[\s\S]*?<\/si>/g) ?? [];
    items.forEach((item, i) => {
      const runs = [...item.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodeXmlEntities(m[1]));
      shared.set(String(i), runs.join(''));
    });
  }

  const sheet = readZipEntry(buffer, 'xl/worksheets/sheet1.xml');
  if (!sheet) return '';
  const rows = sheet.toString('utf8').match(/<row[\s\S]*?<\/row>/g) ?? [];
  const lines: string[] = [];
  for (const row of rows) {
    const cells: string[] = [];
    for (const cell of row.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cell[1];
      const body = cell[2];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? 'n';
      if (type === 'inlineStr') {
        cells.push([...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodeXmlEntities(m[1])).join(''));
        continue;
      }
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
      cells.push(type === 's' ? shared.get(v) ?? '' : decodeXmlEntities(v));
    }
    if (cells.some((c) => c !== '')) lines.push(cells.join('\t'));
  }
  return lines.join('\n');
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

/* ---------------------------------------------------------------- PDF ----- */

/** The text-showing operators inside one content stream, and the escapes they use. */
function pdfTextOperators(content: string): string {
  const lines: string[] = [];
  let current = '';

  const push = (): void => {
    const line = current.trim();
    if (line) lines.push(line);
    current = '';
  };

  // TJ arrays are the common case, so they are read as one unit.
  for (const match of content.matchAll(/\[((?:[^\]\\]|\\.)*)\]\s*TJ|\(((?:[^)\\]|\\.)*)\)\s*Tj|(T\*|Td|TD|ET)/g)) {
    if (match[1] !== undefined) {
      for (const piece of match[1].matchAll(/\(((?:[^)\\]|\\.)*)\)/g)) current += unescapePdf(piece[1]);
    } else if (match[2] !== undefined) {
      current += unescapePdf(match[2]);
    } else if (match[3]) {
      push();
    }
  }
  push();
  return lines.join('\n');
}

function unescapePdf(value: string): string {
  return value.replace(/\\(n|r|t|b|f|\(|\)|\\|[0-7]{1,3})/g, (_, esc: string) => {
    if (esc === 'n') return '\n';
    if (esc === 'r') return '\r';
    if (esc === 't') return '\t';
    if (esc === 'b' || esc === 'f') return '';
    if (esc === '(' || esc === ')' || esc === '\\') return esc;
    return String.fromCharCode(Number.parseInt(esc, 8));
  });
}

/**
 * The text layer of a PDF.
 *
 * Only the uncompressed and FlateDecode cases are handled, which covers what a
 * document exporter produces. A scanned PDF has no text layer at all, and that
 * is reported as such rather than returning an empty string — the caller then
 * hands the file over as bytes to a model that can read it.
 */
function pdfText(buffer: Buffer): string {
  const raw = buffer.toString('latin1');
  const chunks: string[] = [];
  const streamPattern = /stream\r?\n?([\s\S]*?)\r?\n?endstream/g;
  let match: RegExpExecArray | null;
  while ((match = streamPattern.exec(raw)) !== null) {
    const slice = Buffer.from(match[1], 'latin1');
    let content: string;
    try {
      content = inflateSync(slice).toString('latin1');
    } catch {
      // Not deflate: it may be stored plain, which is still readable.
      content = slice.toString('latin1');
    }
    // Content streams carry the text; font and image streams do not.
    if (!/\bBT\b/.test(content)) continue;
    chunks.push(pdfTextOperators(content));
  }
  return chunks.join('\n\n');
}

/* --------------------------------------------------------------- public ---- */

export async function extractFile(path: string): Promise<ExtractedFile> {
  const name = basename(path);
  const kind = kindFor(path);
  const mimeType = mimeFor(path);
  const stat = await fs.stat(path);
  const base: ExtractedFile = { path, name, bytes: stat.size, kind, mimeType, text: '', native: false, note: null };

  switch (kind) {
    case 'pdf':
    case 'docx':
    case 'xlsx': {
      const buffer = await fs.readFile(path);
      let text = '';
      try {
        if (kind === 'pdf') text = pdfText(buffer);
        else if (kind === 'docx') text = docxText(readZipEntry(buffer, 'word/document.xml') ?? Buffer.alloc(0));
        else text = xlsxText(buffer);
      } catch {
        text = '';
      }
      const usable = text.trim().length >= 40;
      return {
        ...base,
        text: usable ? text : '',
        native: !usable,
        note: usable
          ? null
          : kind === 'pdf'
            ? 'PDF ini tidak punya lapisan teks — akan dikirim apa adanya ke model yang bisa membacanya.'
            : `Tidak berhasil membaca isi ${name} — akan dikirim apa adanya.`
      };
    }
    case 'image':
      return {
        ...base,
        native: stat.size <= MAX_INLINE_IMAGE_BYTES,
        note: stat.size > MAX_INLINE_IMAGE_BYTES ? 'Gambar terlalu besar untuk dikirim inline.' : null
      };
    case 'binary':
      return { ...base, native: false, note: `Tipe berkas ${kind} belum punya pembaca teks.` };
    default: {
      try {
        const text = await readText(path);
        return {
          ...base,
          text,
          native: false,
          note: stat.size > MAX_TEXT_BYTES ? `Dipotong pada ${Math.round(MAX_TEXT_BYTES / 1024)} KB.` : null
        };
      } catch {
        return { ...base, native: false, note: 'Isi berkas bukan teks yang bisa dibaca.' };
      }
    }
  }
}

export async function extractFiles(paths: string[]): Promise<ExtractedFile[]> {
  const out: ExtractedFile[] = [];
  for (const path of paths) {
    try {
      out.push(await extractFile(path));
    } catch (err) {
      out.push({
        path,
        name: basename(path),
        bytes: 0,
        kind: 'binary',
        mimeType: 'application/octet-stream',
        text: '',
        native: false,
        note: `Gagal dibaca: ${err instanceof Error ? err.message : String(err)}`
      });
    }
  }
  return out;
}

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}