import type { ToolMeta, ToolResult } from '../../shared/types';
import { editFile, glob, grep, listDir, readFile, toRelative, walkFiles, writeFile } from './fsTools';
import { runCode } from './codeRunner';
import { webFetch, webSearch } from './webTools';

interface JsonSchema {
  type: 'object';
  properties: Record<string, { type: string; description?: string }>;
  required?: string[];
}

interface ToolDefinition extends ToolMeta {
  input_schema: JsonSchema;
  /** Workspace-scoped tools need the current root; network/code tools do not. */
  needsWorkspace?: boolean;
  run(root: string | null, args: Record<string, unknown>): Promise<ToolResult>;
}

export const TOOLS: ToolDefinition[] = [
  {
    name: 'read_file',
    icon: 'fa-file-lines',
    openDesc: 'Baca isi file dari workspace',
    description:
      'Baca isi sebuah file teks dari workspace yang dipilih. Path relatif terhadap folder root (misal src/app.js).',
    needsWorkspace: true,
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path file' },
        start: { type: 'integer', description: 'Baris awal (0-based)' },
        limit: { type: 'integer', description: 'Jumlah baris maksimal' }
      },
      required: ['path']
    },
    run: (root, args) => readFile(requireRoot(root), args)
  },
  {
    name: 'write_file',
    icon: 'fa-file-pen',
    openDesc: 'Tulis / buat file baru',
    description:
      'Tulis atau buat file baru di workspace. Membuat direktori induk bila diperlukan. Gunakan untuk membuat file baru atau menimpa seluruh isi.',
    needsWorkspace: true,
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content']
    },
    run: (root, args) => writeFile(requireRoot(root), args)
  },
  {
    name: 'edit_file',
    icon: 'fa-pen-to-square',
    openDesc: 'Edit bagian file',
    description:
      'Ganti sebagian isi file dengan mencocokkan old_string lalu menggantinya dengan new_string (string replace). Set replace_all:true untuk mengganti semua kemunculan.',
    needsWorkspace: true,
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' }
      },
      required: ['path', 'old_string', 'new_string']
    },
    run: (root, args) => editFile(requireRoot(root), args)
  },
  {
    name: 'list_dir',
    icon: 'fa-folder-open',
    openDesc: 'Daftar file & folder',
    description: 'Daftar isi direktori di workspace (path default: root).',
    needsWorkspace: true,
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } }
    },
    run: (root, args) => listDir(requireRoot(root), args)
  },
  {
    name: 'grep',
    icon: 'fa-magnifying-glass',
    openDesc: 'Cari teks dalam file',
    description:
      'Cari pola teks (regex) di seluruh file teks workspace, menampilkan path:baris:isi.',
    needsWorkspace: true,
    input_schema: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'Regex / pola teks' }, path: { type: 'string' } },
      required: ['pattern']
    },
    run: (root, args) => grep(requireRoot(root), args)
  },
  {
    name: 'glob',
    icon: 'fa-diagram-project',
    openDesc: 'Temukan file berdasarkan pola',
    description: 'Temukan file di workspace berdasarkan pola glob (contoh: **/*.js, src/**).',
    needsWorkspace: true,
    input_schema: {
      type: 'object',
      properties: { pattern: { type: 'string' } },
      required: ['pattern']
    },
    run: (root, args) => glob(requireRoot(root), args)
  },
  {
    name: 'run_code',
    icon: 'fa-terminal',
    openDesc: 'Jalankan kode (Node.js sandbox)',
    description:
      'Jalankan JavaScript di proses Node.js terpisah (aman, otomatis dihentikan setelah 10 detik). Output console.log/print dikembalikan. Gunakan top-level await.',
    input_schema: {
      type: 'object',
      properties: { code: { type: 'string', description: 'Kode JavaScript yang dijalankan' } },
      required: ['code']
    },
    run: (_root, args) => runCode(args)
  },
  {
    name: 'web_search',
    icon: 'fa-globe',
    openDesc: 'Cari di web',
    description: 'Cari informasi terbaru di web (DuckDuckGo Instant Answer + Wikipedia).',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query']
    },
    run: (_root, args) => webSearch(args)
  },
  {
    name: 'web_fetch',
    icon: 'fa-link',
    openDesc: 'Ambil konten URL',
    description: 'Ambil (fetch) konten teks dari sebuah URL publik dan bersihkan HTML-nya.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url']
    },
    run: (_root, args) => webFetch(args)
  }
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);

export function toolDef(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}

export function toolMetas(): ToolMeta[] {
  return TOOLS.map(({ name, icon, openDesc, description }) => ({ name, icon, openDesc, description }));
}

/** Schema-only payload sent to the model (no local functions attached). */
export function toolSchemas(): Array<{ name: string; description: string; input_schema: JsonSchema }> {
  return TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
}

function requireRoot(root: string | null): string {
  if (!root) {
    throw new Error('Workspace belum dipilih. Minta pengguna memilih folder workspace lewat tombol "Workspace" di header.');
  }
  return root;
}

/** Relative file list for the workspace picker / status bar. */
export async function walkWorkspaceFiles(root: string): Promise<Array<{ path: string }>> {
  const files = await walkFiles(root);
  return files.slice(0, 500).map((f) => ({ path: toRelative(root, f) }));
}

/** Dispatch a tool call by name. Never throws — errors come back as results. */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  root: string | null
): Promise<ToolResult> {
  const def = toolDef(name);
  if (!def) return { content: `Tool tidak dikenal: ${name}`, isError: true };
  if (def.needsWorkspace && !root) {
    return { content: `Workspace belum dipilih — tool "${name}" butuh folder workspace.`, isError: true };
  }
  try {
    const res = await def.run(root, args);
    return { content: String(res?.content ?? ''), isError: Boolean(res?.isError) };
  } catch (err) {
    return { content: `Error menjalankan ${name}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}