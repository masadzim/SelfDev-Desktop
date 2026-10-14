/* SelfDev Desktop — logic tests. Run with `npm test`. */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  safeResolve,
  readFile,
  writeFile,
  editFile,
  listDir,
  grep,
  glob,
  globRegExp,
  toRelative,
  walkFiles
} from '../src/main/tools/fsTools';
import { runCode } from '../src/main/tools/codeRunner';
import { executeTool, TOOL_NAMES as toolNames } from '../src/main/tools/index';
import { streamChat } from '../src/main/llm/chat';
import {
  authHeaders,
  buildError,
  classifyError,
  isStreamingUnsupported,
  isToolUnsupported,
  maxTokensCeiling,
  shouldRetryWithAlternateParams,
  streamingBody
} from '../src/main/llm/chat';
import { runAgent } from '../src/main/agent';
import { renderMarkdown } from '../src/renderer/markdown';
import { economyFor, tierGlyph } from '../src/shared/economy';
import {
  DEFAULT_SYSTEM,
  bestChatModel,
  chatModelRank,
  chatUrl,
  cheapTestModel,
  defaultConfig,
  deriveSessionTitle,
  detectProviderForKey,
  isLoopback,
  isModelValidFor,
  modelsUrl,
  normalizeBaseUrl,
  normalizeConfig,
  parseModelCatalog,
  presetFor,
  PRESETS,
  rankedModels,
  repairModelFor,
  resolve,
  resolveForDiscovery,
  streamUrl
} from '../src/shared/providers';
import type { AppConfig, ChatMessage, ProviderId, RunEvent, Session, WireApi, WorkspaceMode } from '../src/shared/types';
import { DEFAULT_MODE, MODES, modeFor, modeUsesTools, promptFor } from '../src/shared/modes';
import {
  IMAGE_SIZES,
  allImageModels,
  buildImagenBody,
  buildOpenAiBody,
  canGenerate,
  extensionFor,
  findImageModel,
  imageModels,
  imageProviderIds,
  imageUrl,
  looksLikeImageModel,
  parseGemini,
  parseImagen,
  parseOpenAi
} from '../src/shared/imagegen';
import { EXTENSION, FORMAT, VERSION, buildPayload, parsePayload, suggestedFilename } from '../src/shared/backupFormat';
import { sealPayload, openPayload } from '../src/main/backup';
import { DOCS } from '../src/shared/docs';
import { composeAttachmentText, humanBytes, messageFor } from '../src/shared/attachments';
import { extractFile, kindFor, mimeFor } from '../src/main/tools/extract';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.error(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Array comparison by value; Object.is never holds for two distinct arrays. */
function eqList(name: string, actual: unknown, expected: unknown): void {
  check(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );
}

function section(title: string): void {
  console.log(`\n▸ ${title}`);
}

function docxXml(...paragraphs: string[]): string {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`)
    .join('');
  return `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`;
}

/** The smallest valid ZIP: one stored member plus the central directory. */
function buildStoredZip(name: string, content: string): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const data = Buffer.from(content, 'utf8');
  const crc = zlibCrc32(data);

  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8); // stored
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  nameBuf.copy(local, 30);

  const central = Buffer.alloc(46 + nameBuf.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  nameBuf.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length + data.length, 16);

  return Buffer.concat([local, data, central, eocd]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function zlibCrc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'selfdev-test-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- path safety

section('path safety');
{
  const root = '/tmp/ws';
  eq('safeResolve relative', safeResolve(root, 'src/app.js'), '/tmp/ws/src/app.js');
  eq('safeResolve nested', safeResolve(root, './a/b/c.txt'), '/tmp/ws/a/b/c.txt');
  let threw = false;
  try {
    safeResolve(root, '../escape.txt');
  } catch {
    threw = true;
  }
  check('rejects ../ traversal', threw);

  threw = false;
  try {
    safeResolve(root, '../../etc/passwd');
  } catch {
    threw = true;
  }
  check('rejects deep traversal', threw);

  // a leading slash is workspace-rooted, so the real root is never reachable
  eq('leading slash is workspace-rooted', safeResolve(root, '/src/x.js'), '/tmp/ws/src/x.js');
  check('leading slash cannot escape', (() => {
    try {
      safeResolve(root, '/../../etc/passwd');
      return false;
    } catch {
      return true;
    }
  })());
  eq('drive-style absolute stays rejected', (() => {
    try {
      safeResolve(root, '/etc/shadow');
      return 'inside-workspace';
    } catch {
      return 'rejected';
    }
  })(), 'inside-workspace');

  threw = false;
  try {
    safeResolve(root, 'node_modules/../..');
  } catch {
    threw = true;
  }
  check('rejects traversal via nested segment', threw);

  threw = false;
  try {
    safeResolve(root, 'ok.txt\0bad');
  } catch {
    threw = true;
  }
  check('rejects null byte', threw);

  eq('toRelative root', toRelative('/tmp/ws', '/tmp/ws'), '.');
  eq('toRelative nested', toRelative('/tmp/ws', '/tmp/ws/a/b.txt'), 'a/b.txt');
}

// ---------------------------------------------------------------------- glob

section('glob patterns');
{
  const cases: Array<[string, string, boolean]> = [
    ['**/*.js', 'src/app.js', true],
    ['**/*.js', 'app.js', true],
    ['**/*.js', 'src/app.ts', false],
    ['*.js', 'app.js', true],
    ['*.js', 'src/app.js', false],
    ['src/**/*.ts', 'src/a/b/c.ts', true],
    ['src/*', 'src/app.js', true],
    ['src/*', 'src/a/b.js', false],
    ['**/test?.js', 'a/test1.js', true],
    ['**/test?.js', 'a/test12.js', false],
    ['**', 'a/b/c.txt', true]
  ];
  for (const [pattern, path, expected] of cases) {
    check(`glob ${pattern} ~ ${path}`, globRegExp(pattern).test(path) === expected);
  }
}

async function main(): Promise<void> {

// ----------------------------------------------------------------- fs tools

section('filesystem tools');
await withTempDir(async (root) => {
  await fs.mkdir(join(root, 'src'), { recursive: true });
  await fs.mkdir(join(root, 'node_modules', 'junk'), { recursive: true });
  await fs.writeFile(join(root, 'node_modules', 'junk', 'index.js'), 'should be ignored');
  await fs.writeFile(join(root, 'src', 'app.js'), 'export const answer = 42;\nconst greet = () => `hi`;\n');
  await fs.writeFile(join(root, 'src', 'app.ts'), 'export type A = string;\n');
  await fs.writeFile(join(root, 'README.md'), '# Judul\n\nHalo dunia\n');
  await fs.writeFile(join(root, 'a.log'), 'needle here\nnothing\nNEEDLE again\n');
  await fs.writeFile(join(root, '.env'), 'SECRET=1\n');

  // write_file (creates nested dirs)
  const w = await writeFile(root, { path: 'deep/nested/new.txt', content: 'halo\n' });
  check('write_file creates nested dirs', !w.isError, w.content);
  eq('write_file wrote content', (await fs.readFile(join(root, 'deep/nested/new.txt'), 'utf8')), 'halo\n');

  // read_file
  const r = await readFile(root, { path: 'src/app.js' });
  check('read_file ok', !r.isError && r.content.includes('answer = 42'), r.content);
  const rr = await readFile(root, { path: 'src/app.js', start: 1, limit: 1 });
  check('read_file honours start/limit', rr.content.includes('2:'), rr.content);

  const missing = await readFile(root, { path: 'nope.txt' });
  check('read_file missing -> error result', missing.isError === true);

  const escape = await readFile(root, { path: '../../etc/passwd' });
  check('read_file blocks traversal', escape.isError === true, escape.content);

  // binary detection
  await fs.writeFile(join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));
  const bin = await readFile(root, { path: 'blob.bin' });
  check('read_file detects binary', bin.isError === true && /biner/i.test(bin.content), bin.content);

  // edit_file
  const e1 = await editFile(root, { path: 'src/app.js', old_string: '42', new_string: '43' });
  check('edit_file single replace', !e1.isError, e1.content);
  check('edit_file applied', (await fs.readFile(join(root, 'src/app.js'), 'utf8')).includes('answer = 43'));

  await fs.writeFile(join(root, 'dup.txt'), 'x\nx\nx\n');
  const ambiguous = await editFile(root, { path: 'dup.txt', old_string: 'x', new_string: 'y' });
  check('edit_file refuses ambiguous match', ambiguous.isError === true && /muncul/.test(ambiguous.content), ambiguous.content);
  const all = await editFile(root, { path: 'dup.txt', old_string: 'x', new_string: 'y', replace_all: true });
  check('edit_file replace_all works', !all.isError && (await fs.readFile(join(root, 'dup.txt'), 'utf8')) === 'y\ny\ny\n');
  const nohit = await editFile(root, { path: 'dup.txt', old_string: 'zzz', new_string: 'y' });
  check('edit_file reports missing old_string', nohit.isError === true);

  // list_dir
  const l = await listDir(root, {});
  check('list_dir shows files', !l.isError && l.content.includes('src') && l.content.includes('README.md'), l.content);
  check('list_dir hides dotfiles', !l.content.includes('.env'), l.content);
  check('list_dir shows normal dirs', l.content.includes('node_modules'));
  const lBad = await listDir(root, { path: 'src/app.js' });
  check('list_dir on file -> error', lBad.isError === true);

  // grep
  const g = await grep(root, { pattern: 'NEEDLE' });
  check('grep case-insensitive', !g.isError && g.content.includes('a.log:3'), g.content);
  const gScope = await grep(root, { pattern: 'answer', path: 'src' });
  check('grep scoped to subdir', !gScope.isError && gScope.content.includes('src/app.js'), gScope.content);
  const gNone = await grep(root, { pattern: 'zzz-not-there' });
  check('grep no match', !gNone.isError && /Tidak ada kecocokan/.test(gNone.content));
  const gBadRe = await grep(root, { pattern: '([' });  // invalid regex -> literal fallback
  check('grep survives invalid regex', !gBadRe.isError, gBadRe.content);

  // glob
  const gl = await glob(root, { pattern: '**/*.ts' });
  check('glob finds ts files', !gl.isError && gl.content.includes('src/app.ts'), gl.content);
  const glNone = await glob(root, { pattern: '**/*.zig' });
  check('glob no match', /Tidak ada file/.test(glNone.content));

  // walk skips ignored dirs
  const files = await walkFiles(root);
  check('walk ignores node_modules', !files.some((f) => f.includes('node_modules')));
  check('walk finds nested file', files.some((f) => f.endsWith('deep/nested/new.txt')));
});

// -------------------------------------------------------------- tool dispatch

section('tool dispatch');
{
  await withTempDir(async (root) => {
    eq('nine tools registered', toolNames.length, 9);
    const unknown = await executeTool('does_not_exist', {}, root);
    check('unknown tool -> error result', unknown.isError === true);
    const noWs = await executeTool('read_file', { path: 'a.txt' }, null);
    check('workspace tool without workspace -> friendly error', noWs.isError === true && /workspace/i.test(noWs.content), noWs.content);
    await fs.writeFile(join(root, 'a.txt'), 'ok');
    const ok = await executeTool('read_file', { path: 'a.txt' }, root);
    check('dispatch read_file works', !ok.isError && ok.content.includes('ok'), ok.content);
  });
}

// ------------------------------------------------------------- code runner

section('code sandbox');
{
  const basic = await runCode({ code: 'print("halo", 1 + 1); return 40 + 2;' });
  check('run_code captures print', basic.content.includes('halo 2'), basic.content);
  check('run_code returns value', basic.content.includes('=> 42'), basic.content);
  check('run_code not error', !basic.isError);

  const awaited = await runCode({ code: 'const v = await new Promise(r => setTimeout(() => r(7), 10)); print(v);' });
  check('run_code supports top-level await', awaited.content.includes('7'), awaited.content);

  const thrown = await runCode({ code: 'throw new Error("boom")' });
  check('run_code surfaces errors', thrown.isError === true && /boom/.test(thrown.content), thrown.content);

  const empty = await runCode({ code: '   ' });
  check('run_code rejects empty code', empty.isError === true);

  const loop = await runCode({ code: 'while (true) {}' }, 1500);
  check('run_code kills infinite loops', loop.isError === true && /Timeout/i.test(loop.content), loop.content);

  const crash = await runCode({ code: 'process.exit(3)' });
  check('run_code survives process.exit', typeof crash.content === 'string');

  const json = await runCode({ code: 'return {a:1,b:[1,2],c:"x"}' });
  check('run_code stringifies objects', json.content.includes('"a": 1'), json.content);
}

// ----------------------------------------------------------------- markdown

section('markdown renderer');
{
  check('escapes html', !renderMarkdown('<script>alert(1)</script>').includes('<script>'));
  check('renders bold', renderMarkdown('**tebal**').includes('<strong>tebal</strong>'));
  check('renders italic', renderMarkdown('*miring*').includes('<em>miring</em>'));
  const code = renderMarkdown('```js\nconst a = 1 < 2;\n```');
  check('renders fenced code', code.includes('<pre class="sd-code">'), code);
  check('escapes code contents', code.includes('1 &lt; 2'), code);
  const inlineCode = renderMarkdown('use `a < b` here');
  check('inline code is escaped', inlineCode.includes('<code>a &lt; b</code>'), inlineCode);
  check('does not format inside inline code', !renderMarkdown('`**not bold**`').includes('<strong>'));
  check('renders links', renderMarkdown('[x](https://a.test)').includes('href="https://a.test"'));
  check('renders unordered list', renderMarkdown('- a\n- b').includes('<ul>'));
  check('renders ordered list', renderMarkdown('1. a\n2. b').includes('<ol>'));
  check('renders heading', renderMarkdown('## Judul').includes('<h2>Judul</h2>'));
  check('renders blockquote', renderMarkdown('> kutip').includes('<blockquote>'));
  check('does not duplicate fences', renderMarkdown('```\n```\n```\nx\n```').includes('sd-code'));
  check('paragraph keeps single break', renderMarkdown('a\nb').includes('<br />'));
  check('empty input', renderMarkdown('') === '');
  check('handles table pipe as text', renderMarkdown('| a | b |').includes('| a | b |'));
}

// -------------------------------------------------------------------- config

section('provider registry');
{
  eq('seventeen presets', PRESETS.length, 17);
  eq('default provider is groq', defaultConfig().provider, 'groq');

  // Base URLs and wire formats are the Android client's, verbatim: a key that
  // works there has to work here.
  const expected: Array<[ProviderId, string, WireApi]> = [
    ['openai', 'https://api.openai.com/v1', 'OPENAI_CHAT'],
    ['anthropic', 'https://api.anthropic.com/v1', 'ANTHROPIC_MESSAGES'],
    ['gemini', 'https://generativelanguage.googleapis.com/v1beta', 'GEMINI_CONTENT'],
    ['groq', 'https://api.groq.com/openai/v1', 'OPENAI_CHAT'],
    ['deepseek', 'https://api.deepseek.com/v1', 'OPENAI_CHAT'],
    ['openrouter', 'https://openrouter.ai/api/v1', 'OPENAI_CHAT'],
    ['together', 'https://api.together.xyz/v1', 'OPENAI_CHAT'],
    ['fireworks', 'https://api.fireworks.ai/inference/v1', 'OPENAI_CHAT'],
    ['xai', 'https://api.x.ai/v1', 'OPENAI_CHAT'],
    ['mistral', 'https://api.mistral.ai/v1', 'OPENAI_CHAT'],
    ['cerebras', 'https://api.cerebras.ai/v1', 'OPENAI_CHAT'],
    ['nvidia', 'https://integrate.api.nvidia.com/v1', 'OPENAI_CHAT'],
    ['sambanova', 'https://api.sambanova.ai/v1', 'OPENAI_CHAT'],
    ['hyperbolic', 'https://api.hyperbolic.xyz/v1', 'OPENAI_CHAT'],
    ['novita', 'https://api.novita.ai/v3/openai', 'OPENAI_CHAT'],
    ['ollama', 'http://127.0.0.1:11434/v1', 'OPENAI_CHAT'],
    ['custom', '', 'OPENAI_CHAT']
  ];
  for (const [id, baseUrl, wireApi] of expected) {
    const preset = presetFor(id);
    eq(`${id} base url`, preset.baseUrl, baseUrl);
    eq(`${id} wire api`, preset.wireApi, wireApi);
  }
  check('ollama needs no key', presetFor('ollama').isLocal === true);
  check('every preset has a billing page or is local', PRESETS.every((p) => p.billingUrl !== null || p.isLocal || p.id === 'custom'));
}

section('endpoint URLs');
{
  const anth = resolve('anthropic', '', 'claude-sonnet-5');
  eq('anthropic chat url', chatUrl(anth!), 'https://api.anthropic.com/v1/messages');
  eq('anthropic streams on the same path', streamUrl(anth!), chatUrl(anth!));
  eq('anthropic models url', modelsUrl(anth!), 'https://api.anthropic.com/v1/models');

  const gem = resolve('gemini', '', 'gemini-2.5-flash');
  eq('gemini chat url', chatUrl(gem!), 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
  eq('gemini stream url', streamUrl(gem!), 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
  eq('gemini models url', modelsUrl(gem!), 'https://generativelanguage.googleapis.com/v1beta/models');

  const oai = resolve('openai', '', 'gpt-4o-mini');
  eq('openai chat url', chatUrl(oai!), 'https://api.openai.com/v1/chat/completions');
  eq('openai stream url is the chat url', streamUrl(oai!), chatUrl(oai!));

  const custom = resolve('custom', 'my.gateway.dev/v1/', 'qwen');
  eq('custom url adds scheme and trims slash', custom!.baseUrl, 'https://my.gateway.dev/v1');
  eq('custom chat url', chatUrl(custom!), 'https://my.gateway.dev/v1/chat/completions');
  check('hosted custom gateway needs a key', custom!.requiresApiKey === true);
  eq('custom loopback needs no key', resolve('custom', 'http://localhost:11434/v1', 'qwen')!.requiresApiKey, false);

  // A custom gateway can speak any of the three formats; a preset cannot be
  // redirected, because its base URL belongs to the provider.
  const anthGateway = resolve('custom', 'http://127.0.0.1:4000/v1', 'claude', true, 'ANTHROPIC_MESSAGES');
  eq('custom gateway wire format', anthGateway!.wireApi, 'ANTHROPIC_MESSAGES');
  eq('custom anthropic gateway url', chatUrl(anthGateway!), 'http://127.0.0.1:4000/v1/messages');
  const gemGateway = resolve('custom', 'http://127.0.0.1:4000/v1', 'gemini-2.5-flash', true, 'GEMINI_CONTENT');
  eq('custom gemini gateway stream url', streamUrl(gemGateway!), 'http://127.0.0.1:4000/v1/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
  eq('custom defaults to the OpenAI format', resolve('custom', 'http://x.dev/v1', 'm')!.wireApi, 'OPENAI_CHAT');
  eq('preset wire format is never overridden', resolve('anthropic', 'http://x.dev/v1', 'm', true, 'GEMINI_CONTENT')!.wireApi, 'ANTHROPIC_MESSAGES');
  eq('custom ignores images too', resolve('custom', 'http://x.dev/v1', 'm')!.supportsImages, false);
  check('unresolved without a model', resolve('openai', '', '') === null);
  eq('discovery does not need a model', resolveForDiscovery('ollama', '')!.modelId, '');
  eq('local provider needs no key', resolve('ollama', '', 'llama3.2')!.requiresApiKey, false);
}

section('url + key helpers');
{
  eq('scheme added', normalizeBaseUrl('api.anthropic.com'), 'https://api.anthropic.com');
  eq('http preserved', normalizeBaseUrl('HTTP://localhost:11434/v1'), 'http://localhost:11434/v1');
  eq('trailing slashes trimmed', normalizeBaseUrl('https://x.dev/v1///'), 'https://x.dev/v1');
  eq('blank stays blank', normalizeBaseUrl('   '), '');

  check('localhost is loopback', isLoopback('http://localhost:11434/v1'));
  check('127.0.0.1 is loopback', isLoopback('https://127.0.0.1:443'));
  check('*.local is loopback', isLoopback('http://nas.local/v1'));
  check('a public host is not loopback', !isLoopback('https://api.openai.com/v1'));

  eq('anthropic key prefix', detectProviderForKey('sk-ant-abc'), 'anthropic');
  eq('groq key prefix', detectProviderForKey('gsk_abc'), 'groq');
  eq('gemini key prefix', detectProviderForKey('AIzaSyABC'), 'gemini');
  eq('openrouter key prefix', detectProviderForKey('sk-or-abc'), 'openrouter');
  eq('xai key prefix', detectProviderForKey('xai-abc'), 'xai');
  eq('cerebras key prefix', detectProviderForKey('csk-abc'), 'cerebras');
  eq('openai key prefix', detectProviderForKey('sk-abc'), 'openai');
  eq('unknown prefix', detectProviderForKey('nope-abc'), null);
  eq('blank key', detectProviderForKey('  '), null);
}

section('model catalogue parsing');
{
  const openaiStyle = parseModelCatalog(
    JSON.stringify({
      object: 'list',
      data: [
        { id: 'gpt-4o', context_length: 128000, pricing: { prompt: '0.0000025', completion: '0.00001' } },
        { id: 'whisper-1', pricing: { prompt: '0.0000001', completion: '0.0000001' } }
      ]
    })
  );
  eq('catalogue size', openaiStyle.length, 2);
  eq('model id', openaiStyle[0].id, 'gpt-4o');
  eq('input price is per million', openaiStyle[0].inputPerMTok, 2.5);
  eq('output price is per million', openaiStyle[0].outputPerMTok, 10);
  eq('context length', openaiStyle[0].contextLength, 128000);

  const geminiStyle = parseModelCatalog(JSON.stringify({ models: [{ name: 'models/gemini-2.5-flash' }] }));
  eq('gemini name prefix stripped', geminiStyle[0].id, 'gemini-2.5-flash');
  eq('missing pricing stays null', geminiStyle[0].inputPerMTok, null);
  eq('missing context stays null', geminiStyle[0].contextLength, null);

  eq('bad json yields nothing', parseModelCatalog('not json').length, 0);
  eq('wrong shape yields nothing', parseModelCatalog('{"foo":1}').length, 0);
  eq('negative price ignored', parseModelCatalog('{"data":[{"id":"m","pricing":{"prompt":"-1"}}]}')[0].inputPerMTok, null);
}

section('model ranking');
{
  eq('whisper is never a chat model', chatModelRank('whisper-large-v3'), 0);
  eq('embedding is never a chat model', chatModelRank('text-embedding-3-large'), 0);
  check('70b outranks 8b', chatModelRank('llama-3.3-70b-versatile') > chatModelRank('llama-3.1-8b-instant'));
  check('gemini ranks', chatModelRank('gemini-2.5-flash') > 0);

  eq('best chat model', bestChatModel(['whisper-1', 'llama-3.1-8b-instant', 'llama-3.3-70b-versatile']), 'llama-3.3-70b-versatile');
  eq('best chat model ignores noise', bestChatModel(['whisper-1']), null);

  const ranked = rankedModels(['gpt-4o', 'whisper-1'], ['gpt-4o-mini']);
  eq('discovered chat models first', ranked[0], 'gpt-4o');
  eq('suggestions come next', ranked[1], 'gpt-4o-mini');
  eq('unusable models stay reachable', ranked[2], 'whisper-1');

  eq('repair prefers the account catalogue', repairModelFor('openai', ['gpt-4.1']), 'gpt-4.1');
  eq('repair falls back to suggestions', repairModelFor('openai', []), 'gpt-4o');
  // An unknown id falls back to the default preset, matching the provider picker.
  eq('unknown provider inherits the default preset', repairModelFor('nope', []), presetFor('groq').suggestedModels[0]);

  const curated = ['gpt-4o-mini', 'gpt-4o'];
  eq('curated test model trusted when visible', cheapTestModel('openai', curated), 'gpt-4o-mini');
  eq('cheap hint wins for openrouter', cheapTestModel('openrouter', ['expensive-large', 'gpt-4o-mini']), 'gpt-4o-mini');
  // Nothing chat-shaped on offer, so the curated pick is probed rather than a
  // speech-to-text model that would report a dead key on a working one.
  eq('non-chat entries are never probed', cheapTestModel('groq', ['whisper-large-v3']), 'llama-3.1-8b-instant');
  eq('curated id ignored when the account cannot see it', cheapTestModel('openai', ['gpt-4o']), 'gpt-4o');
  eq('provider without a curated pick', cheapTestModel('novita', []), null);

  check('local tag rejected for hosted providers', !isModelValidFor('openai', 'llama3.2:8b'));
  check('local tag fine for local gateway', isModelValidFor('ollama', 'llama3.2:8b'));
  check('local tag fine on a loopback custom gateway', isModelValidFor('custom', 'llama3.2:8b', [], 'http://localhost:11434/v1'));
  check('discovered model always valid', isModelValidFor('openai', 'brand-new', ['brand-new']));
}

section('config normalisation');
{
  const a = normalizeConfig({ provider: 'anthropic', model: 'claude-sonnet-5' });
  eq('a preset provider keeps no custom base url', a.customBaseUrl, '');
  eq('anthropic endpoint', chatUrl(resolve('anthropic', '', a.model)!), 'https://api.anthropic.com/v1/messages');

  const custom = normalizeConfig({ provider: 'custom', customBaseUrl: 'http://localhost:1234/v1/' });
  eq('custom trailing slash trimmed', custom.customBaseUrl, 'http://localhost:1234/v1');
  eq('custom model falls back to default', custom.model, '');

  const clamped = normalizeConfig({ provider: 'groq', maxTokens: 99_999, temperature: 99 });
  eq('maxTokens clamped to the wire ceiling', clamped.maxTokens, 4096);
  eq('temperature clamped', clamped.temperature, 2);
  eq('NaN maxTokens falls back', normalizeConfig({ provider: 'groq', maxTokens: Number.NaN }).maxTokens, 2048);
  eq('unknown provider falls back to the default', normalizeConfig({ provider: 'nope' as ProviderId }).provider, 'groq');
  eq('default system prompt kept', normalizeConfig({ provider: 'groq', system: '' }).system, DEFAULT_SYSTEM);
  eq('custom wire format defaults', normalizeConfig({ provider: 'groq' }).customWireApi, 'OPENAI_CHAT');
  eq('custom wire format kept', normalizeConfig({ provider: 'groq', customWireApi: 'GEMINI_CONTENT' }).customWireApi, 'GEMINI_CONTENT');
  eq('bogus wire format rejected', normalizeConfig({ provider: 'groq', customWireApi: 'NOPE' as WireApi }).customWireApi, 'OPENAI_CHAT');
  eq('custom system prompt kept', normalizeConfig({ provider: 'groq', system: 'hi' }).system, 'hi');

  eq('title derived from first user message', deriveSessionTitle([{ role: 'assistant', text: 'x' }, { role: 'user', text: '  halo\n  dunia  ' }]), 'halo dunia');
  eq('title derived is length-capped', deriveSessionTitle([{ role: 'user', text: 'z'.repeat(120) }])?.length, 60);
  eq('title null when no user message', deriveSessionTitle([{ role: 'assistant', text: 'x' }]), null);
}

// ----------------------------------------------------------------- sse parse

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    }
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const baseConfig: AppConfig = normalizeConfig({
  provider: 'anthropic',
  apiKey: 'k',
  model: 'm',
  system: 'sys'
});

section('stream parsing');
{
  const original = globalThis.fetch;
  try {
    // Anthropic SSE, split across awkward chunk boundaries
    globalThis.fetch = async () =>
      sseResponse([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Halo"}}\n\nevent: content_block_delta\ndata: {"type":"content_',
        'block_delta","index":0,"delta":{"type":"text_delta","text":" dunia"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'
      ]);

    let acc = '';
    const res = await streamChat(baseConfig, [{ role: 'user', text: 'hi' }], [], { onText: (c) => (acc += c), onToolStart: () => undefined }, new AbortController().signal);
    eq('anthropic text assembled', acc, 'Halo dunia');
    eq('anthropic text field', res.text, 'Halo dunia');
    eq('anthropic no tool calls', res.toolCalls.length, 0);
    eq('anthropic stop reason', res.stopReason, 'end_turn');

    // Anthropic tool_use
    globalThis.fetch = async () =>
      sseResponse([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"list_dir"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"src\\"}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n'
      ]);
    let started: string[] = [];
    const res2 = await streamChat(baseConfig, [{ role: 'user', text: 'hi' }], [{ name: 'list_dir', description: '', input_schema: { type: 'object', properties: {} } }], { onText: () => undefined, onToolStart: (c) => started.push(c.name) }, new AbortController().signal);
    eq('anthropic tool name', res2.toolCalls[0]?.name, 'list_dir');
    eq('anthropic tool args parsed', JSON.stringify(res2.toolCalls[0]?.arguments), '{"path":"src"}');
    eq('anthropic tool_start emitted', started.join(','), 'list_dir');
    eq('anthropic tool_use stop reason', res2.stopReason, 'tool_use');

    // OpenAI SSE with split tool_call deltas
    const openaiCfg = normalizeConfig({ provider: 'openai', apiKey: 'k', model: 'gpt-5', system: 'sys' });
    globalThis.fetch = async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"role":"assistant","content":"Hi"}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"a.js\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n'
      ]);
    let acc2 = '';
    const res3 = await streamChat(openaiCfg, [{ role: 'user', text: 'hi' }], [{ name: 'read_file', description: '', input_schema: { type: 'object', properties: {} } }], { onText: (c) => (acc2 += c), onToolStart: () => undefined }, new AbortController().signal);
    eq('openai text assembled', acc2, 'Hi');
    eq('openai tool name', res3.toolCalls[0]?.name, 'read_file');
    eq('openai tool args merged', JSON.stringify(res3.toolCalls[0]?.arguments), '{"path":"a.js"}');
    eq('openai stop reason', res3.stopReason, 'tool_calls');

    // HTTP error surfaces body
    globalThis.fetch = async () => new Response('{"error":"invalid key"}', { status: 401, statusText: 'Unauthorized' });
    let msg = '';
    try {
      await streamChat(baseConfig, [{ role: 'user', text: 'hi' }], [], { onText: () => undefined, onToolStart: () => undefined }, new AbortController().signal);
    } catch (e) {
      msg = (e as Error).message;
    }
    check('http error surfaces status+body', /401/.test(msg) && /invalid key/.test(msg), msg);
  } finally {
    globalThis.fetch = original;
  }
}

// ------------------------------------------------------------- agent loop

section('agent loop (end-to-end with mock provider)');
{
  const original = globalThis.fetch;
  try {
    await withTempDir(async (root) => {
      await fs.writeFile(join(root, 'hello.js'), 'export default 1;\n');

      const cfg = normalizeConfig({ provider: 'anthropic', apiKey: 'k', model: 'm', system: 'sys' });
      const session: Session = { id: 's1', title: 'Percakapan baru', model: 'm', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
      let touched = 0;
      let flushed = 0;
      const store = {
        getConfig: () => cfg,
        getWorkspaceRoot: () => root,
        getMode: () => 'code' as WorkspaceMode,
        getToolsEnabled: () => true,
        getSession: () => session,
        touch: () => { touched++; },
        flush: async () => { flushed++; }
      };

      const events: RunEvent[] = [];
      let call = 0;
      globalThis.fetch = async () => {
        call++;
        if (call === 1) {
          // turn 1: ask for list_dir
          return sseResponse([
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Saya cek dulu."}}\n\n',
            'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"list_dir"}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n'
          ]);
        }
        // turn 2: final answer
        return sseResponse([
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Ada hello.js."}}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'
        ]);
      };

      const status = await runAgent({ store: store as never, emit: (e) => events.push(e) }, 's1', 'isi workspace apa saja?', new AbortController().signal);

      eq('agent finished ok', status, 'done');
      eq('user message stored', session.messages[0]?.role, 'user');
      const assistant = session.messages[1];
      eq('assistant role', assistant?.role, 'assistant');
      check('assistant text includes streamed answer', assistant?.text.includes('Ada hello.js.'), assistant?.text);
      eq('one tool call recorded', assistant?.tool_calls?.length, 1);
      eq('tool result recorded', assistant?.tool_results?.length, 1);
      check('tool result contains listing', assistant?.tool_results?.[0].content.includes('hello.js'), assistant?.tool_results?.[0].content);
      check('store touched', touched > 0);
      eq('store flushed', flushed, 1);

      const types = events.map((e) => e.type);
      check('emitted started', types.includes('started'), types.join(','));
      check('emitted tool_start', types.includes('tool_start'), types.join(','));
      check('emitted tool_end', types.includes('tool_end'), types.join(','));
      check('emitted finished last', types[types.length - 1] === 'finished', types.join(','));
      const finished = events[events.length - 1] as Extract<RunEvent, { type: 'finished' }>;
      eq('finished status done', finished.status, 'done');
      eq('two provider round trips', call, 2);
    });

    // error path
    await withTempDir(async (root) => {
      const cfg = normalizeConfig({ provider: 'anthropic', apiKey: 'k', model: 'm', system: 's' });
      const session: Session = { id: 's2', title: 't', model: 'm', messages: [], createdAt: 1, updatedAt: 1 };
      const store = { getConfig: () => cfg, getWorkspaceRoot: () => root, getMode: () => 'code' as WorkspaceMode,
        getToolsEnabled: () => true, getSession: () => session, touch: () => undefined, flush: async () => undefined };
      globalThis.fetch = async () => new Response('nope', { status: 500, statusText: 'Server Error' });
      const status = await runAgent({ store: store as never, emit: () => undefined }, 's2', 'hai', new AbortController().signal);
      eq('agent reports error', status, 'error');
      check('error text persisted in message', session.messages[1]?.text.includes('HTTP 500'), session.messages[1]?.text);
    });

    // abort path
    await withTempDir(async (root) => {
      const cfg = normalizeConfig({ provider: 'anthropic', apiKey: 'k', model: 'm', system: 's' });
      const session: Session = { id: 's3', title: 't', model: 'm', messages: [], createdAt: 1, updatedAt: 1 };
      const store = { getConfig: () => cfg, getWorkspaceRoot: () => root, getMode: () => 'code' as WorkspaceMode,
        getToolsEnabled: () => true, getSession: () => session, touch: () => undefined, flush: async () => undefined };
      globalThis.fetch = async () => sseResponse([
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n'
      ]);
      const ac = new AbortController();
      ac.abort();
      const status = await runAgent({ store: store as never, emit: () => undefined }, 's3', 'hai', ac.signal);
      eq('agent reports stopped', status, 'stopped');
      check('stopped marker added', session.messages[1]?.text.includes('dihentikan'), session.messages[1]?.text);
    });

    // plan mode must not execute tools
    await withTempDir(async (root) => {
      const cfg = normalizeConfig({ provider: 'anthropic', apiKey: 'k', model: 'm', system: 's' });
      const session: Session = { id: 's4', title: 't', model: 'm', messages: [], createdAt: 1, updatedAt: 1 };
      const store = { getConfig: () => cfg, getWorkspaceRoot: () => root, getMode: () => 'writing' as WorkspaceMode,
        getToolsEnabled: () => true, getSession: () => session, touch: () => undefined, flush: async () => undefined };
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return sseResponse([
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Jawab saja."}}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'
        ]);
      };
      const status = await runAgent({ store: store as never, emit: () => undefined }, 's4', 'hai', new AbortController().signal);
      eq('plan mode single round trip', calls, 1);
      eq('plan mode done', status, 'done');
      eq('plan mode stores no tool results', session.messages[1]?.tool_results?.length ?? 0, 0);
    });
  } finally {
    globalThis.fetch = original;
  }
}

// ------------------------------------------------------------ request body

section('request body shape');
{
  const original = globalThis.fetch;
  try {
    let captured: any = null;
    globalThis.fetch = async (_url: any, init: any) => {
      captured = { url: String(_url), init, body: JSON.parse(init.body) };
      return sseResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n']);
    };
    const cfg = normalizeConfig({ provider: 'openai', apiKey: 'secret', model: 'gpt-5', system: 'SYS' });
    const history: ChatMessage[] = [
      { role: 'user', text: 'q1' },
      { role: 'assistant', text: '', tool_calls: [{ id: 'c1', name: 'list_dir', arguments: { path: '.' } }] },
      { role: 'user', text: '', tool_results: [{ tool_call_id: 'c1', name: 'list_dir', content: 'src' }] }
    ];
    await streamChat(cfg, history, [{ name: 'list_dir', description: 'd', input_schema: { type: 'object', properties: {} } }], { onText: () => undefined, onToolStart: () => undefined }, new AbortController().signal);

    eq('openai sends bearer auth', captured.init.headers.Authorization, 'Bearer secret');
    eq('openai stream flag', captured.body.stream, true);
    eq('system message first', captured.body.messages[0].role, 'system');
    eq('system content', captured.body.messages[0].content, 'SYS');
    eq('tool result becomes role tool', captured.body.messages[3].role, 'tool');
    eq('tool_call_id preserved', captured.body.messages[3].tool_call_id, 'c1');
    eq('tool schema shape', captured.body.tools[0].type, 'function');
    eq('tool name in schema', captured.body.tools[0].function.name, 'list_dir');
  } finally {
    globalThis.fetch = original;
  }
}

// The agent loop stores tool results on the ASSISTANT turn that made the calls,
// so the wire format has to be verified with that exact shape.
section('tool results follow the assistant turn (agent shape)');
{
  const original = globalThis.fetch;
  const agentHistory = (): ChatMessage[] => [
    { role: 'user', text: 'q1' },
    {
      role: 'assistant',
      text: 'checking',
      tool_calls: [{ id: 'c1', name: 'list_dir', arguments: { path: '.' } }],
      tool_results: [{ tool_call_id: 'c1', name: 'list_dir', content: 'src/app.js' }]
    }
  ];
  try {
    let openai: any = null;
    globalThis.fetch = async (_url: any, init: any) => {
      openai = JSON.parse(init.body);
      return sseResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n']);
    };
    const cfg = normalizeConfig({ provider: 'openai', apiKey: 'secret', model: 'gpt-5', system: 'SYS' });
    await streamChat(cfg, agentHistory(), [], { onText: () => undefined, onToolStart: () => undefined }, new AbortController().signal);
    const openaiMsgs = openai.messages.filter((m: any) => m.role !== 'system');
    eq('openai assistant before tool', openaiMsgs[1].role, 'assistant');
    eq('openai tool result present', openaiMsgs[2].role, 'tool');
    eq('openai tool_call_id preserved', openaiMsgs[2].tool_call_id, 'c1');
    eq('openai tool result content', openaiMsgs[2].content, 'src/app.js');

    let anthropic: any = null;
    globalThis.fetch = async (_url: any, init: any) => {
      anthropic = JSON.parse(init.body);
      return sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'
      ]);
    };
    const acfg = normalizeConfig({ provider: 'anthropic', apiKey: 'secret', model: 'claude-sonnet-5', system: 'SYS' });
    await streamChat(acfg, agentHistory(), [], { onText: () => undefined, onToolStart: () => undefined }, new AbortController().signal);
    eq('anthropic starts with user', anthropic.messages[0].role, 'user');
    eq('anthropic assistant turn', anthropic.messages[1].role, 'assistant');
    eq('anthropic tool_use block', anthropic.messages[1].content[1].type, 'tool_use');
    eq('anthropic tool_result in user turn', anthropic.messages[2].role, 'user');
    eq('anthropic tool_result block', anthropic.messages[2].content[0].type, 'tool_result');
    eq('anthropic tool_use_id', anthropic.messages[2].content[0].tool_use_id, 'c1');

    // a user turn right after tool results must merge into the same user message
    let merged: any = null;
    globalThis.fetch = async (_url: any, init: any) => {
      merged = JSON.parse(init.body);
      return sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'
      ]);
    };
    await streamChat(acfg, [...agentHistory(), { role: 'user', text: 'lanjut' }], [], { onText: () => undefined, onToolStart: () => undefined }, new AbortController().signal);
    eq('anthropic merges follow-up into user turn', merged.messages[2].content.length, 2);
  } finally {
    globalThis.fetch = original;
  }
}

// ------------------------------------------------------------------- Gemini

section('gemini wire format');
{
  const original = globalThis.fetch;
  try {
    let url = '';
    let sent: any = null;
    globalThis.fetch = async (u: any, init: any) => {
      url = String(u);
      sent = JSON.parse(init.body);
      return sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"Halo"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":" dunia"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":3}}\n\n'
      ]);
    };
    const gcfg = normalizeConfig({ provider: 'gemini', apiKey: 'AIzaKey', model: 'gemini-2.5-flash', system: 'SYS' });
    let acc = '';
    let usage: any = null;
    const res = await streamChat(gcfg, [{ role: 'user', text: 'hi' }], [], {
      onText: (c) => (acc += c),
      onToolStart: () => undefined,
      onUsage: (u) => (usage = u)
    }, new AbortController().signal);

    check('gemini streams from the streamGenerateContent path', url.includes(':streamGenerateContent?alt=sse'), url);
    eq('gemini auth header', authHeaders('GEMINI_CONTENT', 'AIzaKey')['x-goog-api-key'], 'AIzaKey');
    eq('gemini body has contents', sent.contents.length, 1);
    eq('gemini user turn role', sent.contents[0].role, 'user');
    eq('gemini system_instruction', sent.system_instruction.parts[0].text, 'SYS');
    eq('gemini generationConfig', sent.generationConfig.maxOutputTokens, 2048);
    check('gemini body never carries stream', sent.stream === undefined, JSON.stringify(sent.stream));
    eq('gemini text assembled', acc, 'Halo dunia');
    eq('gemini stop reason', res.stopReason, 'STOP');
    eq('gemini usage prompt tokens', usage.promptTokens, 9);
    eq('gemini usage completion tokens', usage.completionTokens, 3);

    // tool call + functionResponse round trip
    sent = null;
    globalThis.fetch = async (_u: any, init: any) => {
      sent = JSON.parse(init.body);
      return sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"list_dir","args":{"path":"src"}}}]}}]}\n\n'
      ]);
    };
    const toolCfg = normalizeConfig({ provider: 'gemini', apiKey: 'AIzaKey', model: 'gemini-2.5-flash' });
    const res2 = await streamChat(toolCfg, [
      { role: 'user', text: 'q' },
      { role: 'assistant', text: '', tool_calls: [{ id: 'g0', name: 'list_dir', arguments: { path: 'src' } }] },
      { role: 'assistant', text: '', tool_results: [{ tool_call_id: 'g0', name: 'list_dir', content: 'app.js' }] }
    ], [{ name: 'list_dir', description: 'd', input_schema: { type: 'object', properties: {} } }], { onText: () => undefined, onToolStart: () => undefined }, new AbortController().signal);

    eq('gemini tool call name', res2.toolCalls[0]?.name, 'list_dir');
    eq('gemini tool call args', JSON.stringify(res2.toolCalls[0]?.arguments), '{"path":"src"}');
    eq('gemini assistant turn becomes model', sent.contents[1].role, 'model');
    eq('gemini declares tools via functionDeclarations', sent.tools[0].functionDeclarations[0].name, 'list_dir');
    eq('gemini tool result is a user turn', sent.contents[2].role, 'user');
    eq('gemini functionResponse name', sent.contents[2].parts[0].functionResponse.name, 'list_dir');
    eq('gemini functionResponse payload', sent.contents[2].parts[0].functionResponse.response.result, 'app.js');

    // a non-SSE 200 is still readable (a proxy that ignored `stream`)
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'plain' }] }, finishReason: 'STOP' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    let plainAcc = '';
    const res3 = await streamChat(gcfg, [{ role: 'user', text: 'hi' }], [], { onText: (c) => (plainAcc += c), onToolStart: () => undefined }, new AbortController().signal);
    eq('non-SSE gemini body is read', plainAcc, 'plain');
    eq('non-SSE gemini stop reason', res3.stopReason, 'STOP');
  } finally {
    globalThis.fetch = original;
  }
}

// -------------------------------------------------------------- error taxonomy

section('error classification');
{
  eq('402 is billing', classifyError(402, 'payment required'), 'BILLING');
  eq('429 quota is billing', classifyError(429, 'You exceeded your quota'), 'BILLING');
  eq('429 plain is a rate limit', classifyError(429, 'slow down'), 'RATE_LIMIT');
  eq('401 is auth', classifyError(401, 'invalid api key'), 'AUTH');
  eq('403 is auth', classifyError(403, 'forbidden'), 'AUTH');
  eq('404 unknown model is a model error', classifyError(404, 'model not found'), 'MODEL');
  eq('410 retired model is a model error', classifyError(410, 'reached its end of life'), 'MODEL');
  eq('access refusal is a model error, not auth', classifyError(403, 'you do not have access to this model'), 'MODEL');
  eq('nvidia templating failure is a model error', classifyError(400, 'failed to template request: failed to render text output'), 'MODEL');
  eq('free-tier chat refusal is a model error', classifyError(400, 'Multiturn chat is not enabled for this model'), 'MODEL');
  eq('400 quota wording is billing', classifyError(400, 'insufficient credits'), 'BILLING');
  eq('5xx is server', classifyError(503, 'unavailable'), 'SERVER');
  eq('unrecognised 400 is unknown', classifyError(400, 'something odd'), 'UNKNOWN');
}

section('error message reading');
{
  eq('nested message', buildError('{"error":{"message":"max_tokens must be less than or equal to 512"}}'), 'max_tokens must be less than or equal to 512');
  eq('string error', buildError('{"error":"invalid key"}'), 'invalid key');
  eq('top-level message', buildError('{"message":"nope"}'), 'nope');
  eq('html body is discarded', buildError('<html>oops</html>'), 'Kesonakan tidak diketahui');
  eq('empty object is discarded', buildError('{}'), 'Kesonakan tidak diketahui');
  eq('plain body passes through', buildError('Connection reset'), 'Connection reset');
  eq('detail is truncated to 200', buildError(`{"error":{"message":"${'x'.repeat(400)}"}}`).length, 200);
}

section('self-healing triggers');
{
  eq('token ceiling read', maxTokensCeiling('max_tokens must be less than or equal to 512'), 512);
  eq('token ceiling absent', maxTokensCeiling('invalid api key'), null);

  check('streaming refusal detected', isStreamingUnsupported('This model does not support streaming'));
  check('an unrelated failure is not a streaming refusal', !isStreamingUnsupported('invalid api key'));

  check('retired parameter detected', shouldRetryWithAlternateParams('Unsupported value: max_tokens is not supported'));
  check('temperature-only refusal detected', shouldRetryWithAlternateParams('Unsupported_value: temperature does not support 0.6'));
  check('unrelated failure is not a parameter retry', !shouldRetryWithAlternateParams('invalid api key'));

  check('tool refusal detected', isToolUnsupported('tools is not supported by this model'));
  check('an unrelated failure is not a tool refusal', !isToolUnsupported('invalid api key'));

  eq('openai bodies carry stream', streamingBody('OPENAI_CHAT', { a: 1 }).stream, true);
  eq('anthropic bodies carry stream', streamingBody('ANTHROPIC_MESSAGES', { a: 1 }).stream, true);
  check('gemini bodies never carry stream', streamingBody('GEMINI_CONTENT', { a: 1 }).stream === undefined);
}

section('auth headers');
{
  eq('openai bearer', authHeaders('OPENAI_CHAT', 'k').Authorization, 'Bearer k');
  eq('anthropic version pinned', authHeaders('ANTHROPIC_MESSAGES', 'k')['anthropic-version'], '2023-06-01');
  eq('anthropic key header', authHeaders('ANTHROPIC_MESSAGES', 'k')['x-api-key'], 'k');
  eq('gemini key header', authHeaders('GEMINI_CONTENT', 'k')['x-goog-api-key'], 'k');
  eq('blank key sends nothing', Object.keys(authHeaders('OPENAI_CHAT', '   ')).length, 0);
}

// ------------------------------------------------------------------- economy

section('model economy');
{
  eq('a dated id carries no size', economyFor('claude-haiku-4-5-20251001', []).approxParamsB, null);
  eq('a size in the id is read', economyFor('llama-3.3-70b-versatile', []).approxParamsB, 70);
  eq('a 70b model is heavy', economyFor('llama-3.3-70b-versatile', []).tier, 'HEAVY');
  eq('an 8b model is cheap', economyFor('llama-3.1-8b-instant', []).tier, 'CHEAP');
  eq('the mini family is cheap', economyFor('gpt-4o-mini', []).tier, 'CHEAP');
  eq('an unknown id stays unknown', economyFor('something-new', []).tier, 'UNKNOWN');
  eq('tier glyphs', `${tierGlyph('CHEAP')}|${tierGlyph('MID')}|${tierGlyph('HEAVY')}`, '$|$$|$$$');

  // A published price outranks the name heuristic, ranked against the peers of
  // the same provider rather than a fixed threshold.
  const priced = [
    { id: 'cheap-model', inputPerMTok: 0.1, outputPerMTok: 0.1, contextLength: null },
    { id: 'mid-model', inputPerMTok: 1, outputPerMTok: 1, contextLength: null },
    { id: 'dear-model', inputPerMTok: 30, outputPerMTok: 30, contextLength: null }
  ];
  const cheap = economyFor('cheap-model', priced);
  eq('live price basis', cheap.basis, 'LIVE_PRICE');
  eq('live cheap tier', cheap.tier, 'CHEAP');
  eq('live mid tier', economyFor('mid-model', priced).tier, 'MID');
  eq('live heavy tier', economyFor('dear-model', priced).tier, 'HEAVY');
  eq('live prices are quoted', economyFor('cheap-model', priced).inputPerMTok, 0.1);
}

// ------------------------------------------------------- empty completions

section('empty completion handling');
{
  const original = globalThis.fetch;
  try {
    // A stream carrying neither prose nor a tool call is an empty completion, and
    // has to read as one: that is what earns a second attempt with a real budget.
    globalThis.fetch = async () =>
      sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'
      ]);
    let kind = '';
    try {
      await streamChat(baseConfig, [{ role: 'user', text: 'hi' }], [], { onText: () => undefined, onToolStart: () => undefined }, new AbortController().signal);
    } catch (err) {
      kind = (err as { kind?: string }).kind ?? '';
    }
    eq('blank stream is a parse error', kind, 'PARSE');

    // A turn that is only a tool call is a real answer, not a blank one.
    globalThis.fetch = async () =>
      sseResponse([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"list_dir"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n'
      ]);
    const toolOnly = await streamChat(
      baseConfig,
      [{ role: 'user', text: 'hi' }],
      [{ name: 'list_dir', description: '', input_schema: { type: 'object', properties: {} } }],
      { onText: () => undefined, onToolStart: () => undefined },
      new AbortController().signal
    );
    eq('a tool-only turn is not blank', toolOnly.text, '');
    eq('a tool-only turn keeps its call', toolOnly.toolCalls[0]?.name, 'list_dir');
  } finally {
    globalThis.fetch = original;
  }
}

// ------------------------------------------------------------------- modes

section('workspace modes');
{
  eq('seven modes', MODES.length, 7);
  eq('code is a mode', MODES.some((m) => m.id === 'code'), true);
  eq('every mode has a prompt', MODES.every((m) => m.prompt.trim().length > 40), true);
  eq('every mode has a label', MODES.every((m) => m.label.trim().length > 0), true);
  eq('tools used in code', modeUsesTools('code'), true);
  eq('tools used in research', modeUsesTools('research'), true);
  eq('tools not used in music', modeUsesTools('music'), false);

  const withBase = promptFor('BASE', 'research');
  check('base prompt is kept', withBase.startsWith('BASE'), withBase);
  check('mode instructions are appended', withBase.includes('peneliti'), withBase);
  eq('an empty base still yields instructions', promptFor('', 'music'), MODES.find((m) => m.id === 'music')!.prompt);
  eq('an unknown mode falls back', promptFor('X', 'nope' as never), `X\n\n${modeFor(DEFAULT_MODE).prompt}`);
}

// ------------------------------------------------------------------ images

section('image generation');
{
  eqList('openai models', imageModels('openai').map((m) => m.model), ['gpt-image-1', 'dall-e-3']);
  eqList('gemini models', imageModels('gemini').map((m) => m.model), [
    'gemini-2.5-flash-image',
    'imagen-4.0-generate-001',
    'imagen-3.0-generate-002'
  ]);
  eq('a provider with no drawing models', imageModels('groq').length, 0);
  // The endpoint comes from the curated list, not from the name: `gpt-image-1`
  // contains "image" but is served by OpenAI's endpoint, not Google's.
  eq('gpt-image-1 goes to the openai endpoint', findImageModel('openai', 'gpt-image-1')!.kind, 'OPENAI_IMAGE');
  eq('dall-e-3 goes to the openai endpoint', findImageModel('openai', 'dall-e-3')!.kind, 'OPENAI_IMAGE');
  eq('gemini image goes to the gemini endpoint', findImageModel('gemini', 'gemini-2.5-flash-image')!.kind, 'GEMINI_IMAGE');
  eq('imagen goes to :predict', findImageModel('gemini', 'imagen-4.0-generate-001')!.kind, 'IMAGEN');
  eq('flux goes to the openai endpoint', findImageModel('fireworks', 'flux-1-schnell-fp8')!.kind, 'OPENAI_IMAGE');
  eq('a chat model is refused', findImageModel('openai', 'gpt-4o'), null);
  eq('a drawing model on a chat-only provider is refused', findImageModel('groq', 'gpt-image-1'), null);
  eq('a hosted provider is never taken at its word', findImageModel('groq', 'some-flux-x'), null);
  eq('a custom gateway may be taken at its word', findImageModel('custom', 'some-flux-x')!.kind, 'OPENAI_IMAGE');
  eq('a custom gemini gateway routes to gemini', findImageModel('custom', 'qwen-image-x', 'GEMINI_CONTENT')!.kind, 'GEMINI_IMAGE');
  eq('a custom gateway keeps imagen', findImageModel('custom', 'imagen-9-x', 'GEMINI_CONTENT')!.kind, 'IMAGEN');
  eq('a custom gateway rejects an unnamed model', findImageModel('custom', 'mystery-model'), null);
  eq('can generate for a curated pair', canGenerate('openai', 'gpt-image-1'), true);
  eq('cannot generate for a chat model', canGenerate('openai', 'gpt-4o'), false);
  check('drawing providers are listed', imageProviderIds().includes('gemini') && imageProviderIds().includes('together'), imageProviderIds().join(','));
  check('flux is recognised', looksLikeImageModel('black-forest-labs/FLUX.1-schnell'));
  check('a chat model is not', !looksLikeImageModel('llama-3.3-70b-versatile'));
  eq('every curated model has an endpoint', allImageModels().every((m) => Boolean(m.kind)), true);

  // A model the account discovered is trusted when the catalogue is all we have.
  const discovered = [{ id: 'some-flux-preview', inputPerMTok: null, outputPerMTok: null, contextLength: null }];
  eqList('discovered drawing models are offered', imageModels('custom', discovered).map((m) => m.model), ['some-flux-preview']);
  eq('discovered text models are not', imageModels('custom', [{ id: 'gpt-4o', inputPerMTok: 1, outputPerMTok: 2, contextLength: null }]).length, 0);

  const req = { prompt: 'a cat', size: 'LANDSCAPE' as const, count: 2 };
  eq('openai url', imageUrl('https://api.openai.com/v1', 'gpt-image-1', 'OPENAI_IMAGE'), 'https://api.openai.com/v1/images/generations');
  eq('imagen url', imageUrl('https://g/v1beta', 'imagen-4.0-generate-001', 'IMAGEN'), 'https://g/v1beta/models/imagen-4.0-generate-001:predict');
  eq('gemini image url', imageUrl('https://g/v1beta', 'gemini-2.5-flash-image', 'GEMINI_IMAGE'), 'https://g/v1beta/models/gemini-2.5-flash-image:generateContent');

  const gpt = buildOpenAiBody('gpt-image-1', req);
  eq('openai model', gpt.model, 'gpt-image-1');
  eq('openai prompt', gpt.prompt, 'a cat');
  eq('openai count', gpt.n, 2);
  eq('openai size', gpt.size, '1536x1024');
  eq('gpt-image asks for png', gpt.output_format, 'png');
  check('gpt-image never sends response_format', gpt.response_format === undefined);

  const dalle = buildOpenAiBody('dall-e-3', { prompt: 'x', size: 'PORTRAIT', count: 1 });
  eq('dall-e3 portrait size', dalle.size, '1024x1792');
  eq('dall-e3 asks for bytes', dalle.response_format, 'b64_json');
  eq('dall-e-2 is fixed', buildOpenAiBody('dall-e-2', { prompt: 'x', size: 'SQUARE', count: 1 }).size, '512x512');

  const imagen = buildImagenBody(req);
  eq('imagen prompt nests under instances', (imagen.instances as Array<Record<string, unknown>>)[0].prompt, 'a cat');
  eq('imagen sample count', (imagen.parameters as Record<string, unknown>).sampleCount, 2);
  eq('imagen aspect ratio', (imagen.parameters as Record<string, unknown>).aspectRatio, '3:2');

  eq('openai parses b64', parseOpenAi({ data: [{ b64_json: 'AAA', revised_prompt: 'a nicer cat' }] }, 'gpt-image-1')[0].data, 'AAA');
  eq('openai keeps the revised prompt', parseOpenAi({ data: [{ b64_json: 'AAA', revised_prompt: 'nicer' }] }, 'm')[0].revisedPrompt, 'nicer');
  eq('imagen parses predictions', parseImagen({ predictions: [{ bytesBase64Encoded: 'BBB', mimeType: 'image/jpeg' }] }, 'imagen-4')[0].mimeType, 'image/jpeg');
  eq('gemini parses inline data', parseGemini({ candidates: [{ content: { parts: [{ inlineData: { data: 'CCC', mimeType: 'image/png' } }] } }] }, 'gemini-2.5-flash-image')[0].data, 'CCC');
  eq('a text-only gemini answer yields no image', parseGemini({ candidates: [{ content: { parts: [{ text: 'maaf' }] } }] }, 'm').length, 0);
  eq('extension follows the mime type', `${extensionFor('image/jpeg')}/${extensionFor('image/webp')}/${extensionFor('image/png')}`, 'jpg/webp/png');
  eq('three sizes offered', IMAGE_SIZES.length, 3);
}

// ------------------------------------------------------------------ backup

section('backup format');
{
  check('filename is stamped', /^selfdev-backup-\d{4}-\d{2}-\d{2}-\d{4}\.selfdev$/.test(suggestedFilename(1_758_000_000_000)), suggestedFilename(1758000000000));
  eq('extension', EXTENSION, 'selfdev');
  eq('format', FORMAT, 'selfdev-backup');
  eq('version', VERSION, 1);

  const session = { id: 's1', title: 't', model: 'm', projectId: null, messages: [], createdAt: 1, updatedAt: 1 };
  const settings = {
    config: normalizeConfig({ provider: 'groq', apiKey: 'secret-key', model: 'llama-3.3-70b-versatile' }),
    workspaceMode: 'code' as WorkspaceMode,
    toolsEnabled: true,
    speakReplies: false,
    language: 'id' as const,
    onboarded: true
  };

  const withoutKey = buildPayload({ settings, sessions: [session], projects: [], includeApiKey: false });
  eq('api key excluded by default', withoutKey.settings.config.apiKey, '');
  eq('sessions counted', withoutKey.counts.sessions, 1);
  const withKey = buildPayload({ settings, sessions: [session], projects: [], includeApiKey: true });
  eq('api key included on request', withKey.settings.config.apiKey, 'secret-key');

  // Round trip through the real cipher.
  const sealed = sealPayload(withKey, 'correct horse');
  check('ciphertext is not the plaintext', !sealed.toString('utf8').includes('secret-key'), 'plaintext leaked');
  const opened = openPayload(sealed, 'correct horse');
  eq('round trip keeps the model', opened.settings.config.model, 'llama-3.3-70b-versatile');
  eq('round trip keeps the key', opened.settings.config.apiKey, 'secret-key');
  eq('round trip keeps sessions', opened.sessions.length, 1);
  eq('round trip keeps the mode', opened.settings.workspaceMode, 'code');

  let wrong = '';
  try {
    openPayload(sealed, 'wrong passphrase');
  } catch (err) {
    wrong = (err as Error).message;
  }
  check('wrong passphrase is refused', /Passphrase salah/.test(wrong), wrong);

  let foreign = '';
  try {
    parsePayload(JSON.stringify({ format: 'something-else', version: 1 }));
  } catch (err) {
    foreign = (err as Error).message;
  }
  check('a foreign file is refused', /bukan backup SelfDev/.test(foreign), foreign);

  let future = '';
  try {
    parsePayload(JSON.stringify({ format: FORMAT, version: 99, settings }));
  } catch (err) {
    future = (err as Error).message;
  }
  check('a future version is refused, not guessed at', /tidak bisa dibaca/.test(future), future);
}

// ------------------------------------------------------------------- docs

section('docs content');
{
  eq('docs sections', DOCS.length, 8);
  check('every section has a body', DOCS.every((d) => d.body.length > 0), 'empty section');
  check('every section has a title', DOCS.every((d) => d.title.trim().length > 4), 'untitled section');
  check('answers name the providers this build ships', DOCS.some((d) => d.title.includes('Provider')), 'no provider entry');
}

// ------------------------------------------------------------------ files

section('attachment extraction');
{
  eq('a .ts file is code', kindFor('src/app.ts'), 'code');
  eq('a .md file is markdown', kindFor('README.md'), 'markdown');
  eq('a .csv file is csv', kindFor('data.csv'), 'csv');
  eq('a .pdf file is pdf', kindFor('doc.pdf'), 'pdf');
  eq('a .png file is an image', kindFor('shot.png'), 'image');
  eq('an unknown extension is binary', kindFor('thing.qqq'), 'binary');
  eq('pdf mime', mimeFor('a.pdf'), 'application/pdf');
  eq('png mime', mimeFor('a.png'), 'image/png');
  eq('fallback mime', mimeFor('a.qqq'), 'application/octet-stream');

  eq('bytes under a KB', humanBytes(512), '512 B');
  eq('bytes over a KB', humanBytes(2048), '2 KB');
  eq('bytes over a MB', humanBytes(3 * 1024 * 1024), '3.0 MB');

  // Plain text, the common case.
  const dir = await fs.mkdtemp(join(tmpdir(), 'selfdev-attach-'));
  const txt = join(dir, 'notes.md');
  await fs.writeFile(txt, '# Judul\n\nIsi catatan.\n');
  const read = await extractFile(txt);
  eq('markdown is read as text', read.kind, 'markdown');
  eq('markdown keeps its content', read.text.includes('Isi catatan.'), true);
  eq('a readable file is not native', read.native, false);
  eq('a readable file has no note', read.note, null);

  // A PDF with an uncompressed content stream: the shape a document exporter
  // produces, and the one that needs no inflate.
  const pdfPath = join(dir, 'laporan.pdf');
  const stream = 'BT /F1 12 Tf 72 720 Td (Kroeitang Laporan Kuartal) Tj 0 -16 Td (Pendapatan naik 12 persen.) Tj ET';
  await fs.writeFile(
    pdfPath,
    `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n` +
      `2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n` +
      `3 0 obj<</Type/Page/Parent 2 0 R/Contents 4 0 R>>endobj\n` +
      `4 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream endobj\n` +
      `trailer<</Root 1 0 R>>\n%%EOF\n`
  );
  const pdfRead = await extractFile(pdfPath);
  eq('pdf is recognised', pdfRead.kind, 'pdf');
  check('pdf text layer is extracted', pdfRead.text.includes('Kroeitang Laporan Kuartal'), pdfRead.text);
  check('the second line survives too', pdfRead.text.includes('naik 12 persen'), pdfRead.text);
  eq('a readable pdf is not sent as bytes', pdfRead.native, false);

  // A scanned pdf has no text layer; saying so is what lets the caller hand the
  // bytes over instead of sending an empty turn.
  const scanPath = join(dir, 'pindai.pdf');
  await fs.writeFile(
    scanPath,
    '%PDF-1.4\n4 0 obj<</Length 5>>stream\nhello\nendstream endobj\n%%EOF\n'
  );
  const scanRead = await extractFile(scanPath);
  eq('a pdf with no text layer carries no text', scanRead.text, '');
  eq('a pdf with no text layer travels as bytes', scanRead.native, true);
  check('and says why', Boolean(scanRead.note), 'no note');

  // DOCX is a zip; this builds a stored (uncompressed) one by hand.
  const docxPath = join(dir, 'notulen.docx');
  await fs.writeFile(docxPath, buildStoredZip('word/document.xml', docxXml('Rapat Tim','Keputusan:\nBikin backup mingguan.')));
  const docxRead = await extractFile(docxPath);
  eq('docx is recognised', docxRead.kind, 'docx');
  check('docx paragraphs are extracted', docxRead.text.includes('Bikin backup mingguan.'), docxRead.text);
  check('docx paragraphs keep their order', docxRead.text.indexOf('Rapat Tim') < docxRead.text.indexOf('Bikin backup'), docxRead.text);

  // Binary pretending to be text is refused rather than mangled.
  const bin = join(dir, 'fake.md');
  await fs.writeFile(bin, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]));
  const binRead = await extractFile(bin);
  eq('a binary masquerading as markdown is reported', binRead.text, '');
  check('the reason is stated', Boolean(binRead.note), 'no note');

  // The header is what tells the model which file is the subject.
  const composed = composeAttachmentText(read);
  check('the header names the file', composed.includes('notes.md'), composed);
  check('the header states the kind', composed.includes('(markdown'), composed);
  check('the body follows', composed.includes('Isi catatan.'), composed);

  const carried = messageFor('Ringkas ini', [read], [{ name: 'a.png', mimeType: 'image/png', base64: 'AAA' }]);
  eq('the prompt comes first', carried.text.startsWith('Ringkas ini'), true);
  eq('the parsed file is inlined', carried.text.includes('Isi catatan.'), true);
  eq('bytes travel separately', carried.attachments?.length, 1);
  eq('the turn is a user turn', carried.role, 'user');

  // Nothing parsed and nothing carried: the file is still named, so the model
  // knows something was sent even though it cannot read it.
  const empty = messageFor('', [{ path: '/x/a.bin', name: 'a.bin', bytes: 10, kind: 'binary', mimeType: 'application/octet-stream', text: '', native: false, note: 'Tidak ada pembaca teks.' }], undefined);
  check('an unreadable file is still named', empty.text.includes('a.bin'), empty.text);
}

// ------------------------------------------------------------------ summary

console.log(`\n${'='.repeat(56)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
console.log('='.repeat(56));
process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('test run crashed:', err);
  process.exit(1);
});