import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

import type { ToolResult } from '../../shared/types';

export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.cache',
  '.next',
  '.nuxt',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  'vendor',
  'coverage',
  'dist',
  'build',
  'out',
  '.gradle',
  '.idea',
  '.vscode',
  '.kotlin'
]);

export const MAX_READ_BYTES = 5 * 1024 * 1024;
export const MAX_WALK_ENTRIES = 20000;
export const MAX_GREP_RESULTS = 200;
export const MAX_GLOB_RESULTS = 500;
const BINARY_SNIFF_BYTES = 8192;

export function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n… [truncated]` : s;
}

export class WorkspaceError extends Error {}

/**
 * Resolve a user/model supplied path against the workspace root and refuse
 * anything that escapes it. Absolute paths are only allowed when they are
 * already inside the workspace.
 */
export function safeResolve(root: string, p: unknown): string {
  const raw = String(p ?? '').trim();
  if (!raw) throw new WorkspaceError('path kosong');
  if (raw.includes('\0')) throw new WorkspaceError('path tidak valid');

  // A leading slash means "root of the workspace", matching agent-tool
  // conventions; Windows drive letters still resolve to an absolute path.
  const cleaned = raw.replace(/^[/\\]+/, '');
  const candidate = isAbsolute(cleaned) ? resolve(cleaned) : resolve(root, normalize(cleaned));

  const rel = relative(root, candidate);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new WorkspaceError(`path di luar workspace: ${raw}`);
  }
  // Reject sibling directories that share a prefix (e.g. /root-evil vs /root)
  if (rel.split(sep).includes('..')) throw new WorkspaceError(`path di luar workspace: ${raw}`);
  return candidate;
}

export function toRelative(root: string, abs: string): string {
  const rel = relative(root, abs);
  return rel === '' ? '.' : rel.split(sep).join('/');
}

export async function statSafe(p: string) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

export async function isDirectory(p: string): Promise<boolean> {
  const s = await statSafe(p);
  return !!s && s.isDirectory();
}

/** Resolve a path that must exist as a directory. */
async function dirAt(root: string, p: unknown): Promise<string> {
  const abs = safeResolve(root, p ?? '.');
  const target = abs === root ? root : abs;
  if (!(await isDirectory(target))) {
    throw new WorkspaceError(`bukan direktori: ${String(p ?? '.')}`);
  }
  return target;
}

async function looksBinary(file: string): Promise<boolean> {
  let fh;
  try {
    fh = await fs.open(file, 'r');
    const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, BINARY_SNIFF_BYTES, 0);
    if (bytesRead === 0) return false;
    const slice = buf.subarray(0, bytesRead);
    if (slice.includes(0)) return true;
    // strict UTF-8 decode: throws on invalid byte sequences
    new TextDecoder('utf-8', { fatal: true }).decode(slice);
    return false;
  } catch (err) {
    // a decoding error means binary; any I/O error we treat as "not binary"
    return err instanceof TypeError;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

async function readTextFile(file: string, maxBytes = MAX_READ_BYTES): Promise<string> {
  const st = await statSafe(file);
  if (!st || !st.isFile()) throw new WorkspaceError('file tidak ditemukan');
  if (st.size > maxBytes) {
    throw new WorkspaceError(`file terlalu besar (${(st.size / 1048576).toFixed(1)} MB, maks ${(maxBytes / 1048576).toFixed(0)} MB)`);
  }
  if (await looksBinary(file)) throw new WorkspaceError('file biner — tidak bisa dibaca sebagai teks');
  return fs.readFile(file, 'utf8');
}

/** Recursively collect file paths, skipping ignored folders. */
export async function walkFiles(root: string, max = MAX_WALK_ENTRIES): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length && out.length < max) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (out.length >= max) break;
      const name = entry.name;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(name) || name.startsWith('.')) continue;
        stack.push(join(dir, name));
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        out.push(join(dir, name));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- read_file

export async function readFile(root: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const abs = safeResolve(root, args.path);
    let text = await readTextFile(abs);
    if (args.start != null || args.limit != null) {
      const lines = text.split('\n');
      const start = Math.max(0, toInt(args.start, 0));
      const limit = args.limit != null ? Math.max(1, toInt(args.limit, lines.length)) : lines.length;
      text = lines
        .slice(start, start + limit)
        .map((l, i) => `${i + start + 1}: ${l}`)
        .join('\n');
    }
    const meta = await fs.stat(abs);
    return {
      content: `${toRelative(root, abs)}  (${meta.size} bytes, ${text.split('\n').length} baris)\n\n${trunc(text || '(file kosong)', 30000)}`
    };
  } catch (err) {
    return { content: `Gagal membaca "${String(args.path)}": ${message(err)}`, isError: true };
  }
}

// --------------------------------------------------------------- write_file

export async function writeFile(root: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const abs = safeResolve(root, args.path);
    const content = args.content == null ? '' : String(args.content);
    await fs.mkdir(join(abs, '..'), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
    return { content: `✔ File ditulis: ${toRelative(root, abs)} (${content.length} chars)` };
  } catch (err) {
    return { content: `Gagal menulis "${String(args.path)}": ${message(err)}`, isError: true };
  }
}

// ---------------------------------------------------------------- edit_file

export async function editFile(root: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const abs = safeResolve(root, args.path);
    const oldStr = args.old_string == null ? '' : String(args.old_string);
    const newStr = args.new_string == null ? '' : String(args.new_string);
    if (!oldStr) return { content: 'old_string tidak boleh kosong', isError: true };

    let text = await readTextFile(abs);
    const occurrences = countOccurrences(text, oldStr);
    if (occurrences === 0) {
      return {
        content: `old_string tidak ditemukan di ${toRelative(root, abs)}. Baca file dulu, atau pakai replace_all.`,
        isError: true
      };
    }
    if (!args.replace_all && occurrences > 1) {
      return {
        content: `old_string muncul ${occurrences}× di ${toRelative(root, abs)}. Berikan lebih banyak konteks, atau set replace_all:true.`,
        isError: true
      };
    }
    text = args.replace_all ? text.split(oldStr).join(newStr) : text.replace(oldStr, newStr);
    await fs.writeFile(abs, text, 'utf8');
    return {
      content: `✔ File diedit: ${toRelative(root, abs)} (${args.replace_all ? `${occurrences} kemunculan` : '1 kemunculan'})`
    };
  } catch (err) {
    return { content: `Gagal mengedit "${String(args.path)}": ${message(err)}`, isError: true };
  }
}

// ---------------------------------------------------------------- list_dir

export async function listDir(root: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const target = await dirAt(root, args.path ?? '.');
    const entries = await fs.readdir(target, { withFileTypes: true });
    const rows = await Promise.all(
      entries
        .filter((e) => !e.name.startsWith('.'))
        .map(async (e) => {
          const abs = join(target, e.name);
          let size = '';
          let mtime = '';
          const st = await statSafe(abs);
          if (st) {
            size = st.isDirectory() ? '<dir>' : `${(st.size / 1024).toFixed(1)} KB`;
            mtime = new Date(st.mtimeMs).toISOString().slice(0, 10);
          }
          return { dir: e.isDirectory(), name: e.name, size, mtime };
        })
    );
    rows.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    const prefix = toRelative(root, target);
    const body = rows
      .map((r) => `${r.dir ? '📁' : '📄'} ${r.name.padEnd(38)} ${r.size.padStart(11)}  ${r.mtime}`)
      .join('\n');
    return { content: `${prefix}/\n${body || '(direktori kosong)'}` };
  } catch (err) {
    return { content: `Gagal list direktori: ${message(err)}`, isError: true };
  }
}

// -------------------------------------------------------------------- grep

export async function grep(root: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const pattern = String(args.pattern ?? '');
    if (!pattern) return { content: 'pattern kosong', isError: true };

    let re: RegExp;
    try {
      re = new RegExp(pattern, 'i');
    } catch {
      re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }

    const scope = args.path ? await dirAt(root, args.path) : root;
    const files = await walkFiles(scope);

    const results: string[] = [];
    let scanned = 0;
    for (const file of files) {
      if (results.length >= MAX_GREP_RESULTS) break;
      const st = await statSafe(file);
      if (!st || st.size > MAX_READ_BYTES || st.size === 0) continue;
      let text: string;
      try {
        if (await looksBinary(file)) continue;
        text = await fs.readFile(file, 'utf8');
      } catch {
        continue;
      }
      scanned++;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (results.length >= MAX_GREP_RESULTS) break;
        if (re.test(lines[i])) {
          results.push(`${toRelative(root, file)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        }
      }
    }
    if (!results.length) return { content: `Tidak ada kecocokan "${pattern}" (${scanned} file dipindai)` };
    const header = `${results.length} kecocokan di ${scanned} file dipindai${results.length >= MAX_GREP_RESULTS ? ' (dipotong)' : ''}`;
    return { content: `${header}\n${results.join('\n')}` };
  } catch (err) {
    return { content: `Gagal grep: ${message(err)}`, isError: true };
  }
}

// -------------------------------------------------------------------- glob

/**
 * Translate a glob pattern into an anchored RegExp.
 *   double-star         -> matches across directory separators
 *   double-star + slash -> optional leading directories
 *   single star         -> any run of characters inside one path segment
 *   question mark       -> exactly one character inside one path segment
 */
export function globRegExp(pattern: string): RegExp {
  const p = String(pattern).replace(/^\.\//, '');
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        i += 1;
        if (p[i + 1] === '/') {
          i += 1;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

export async function glob(root: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const pattern = String(args.pattern ?? '');
    if (!pattern) return { content: 'pattern kosong', isError: true };
    const re = globRegExp(pattern);
    const files = await walkFiles(root);
    const matches = files
      .map((f) => toRelative(root, f))
      .filter((p) => re.test(p))
      .slice(0, MAX_GLOB_RESULTS)
      .sort();
    if (!matches.length) return { content: `Tidak ada file cocok dengan "${pattern}"` };
    const suffix = files.length >= MAX_WALK_ENTRIES ? ' (pencarian dipotong)' : '';
    return { content: `${matches.length} file cocok${suffix}\n${matches.join('\n')}` };
  } catch (err) {
    return { content: `Gagal glob: ${message(err)}`, isError: true };
  }
}

// ------------------------------------------------------------------ helpers

export function toInt(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

export function message(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Sensible default workspace suggestion: the user's home directory. */
export function defaultWorkspaceHint(): string {
  return homedir();
}