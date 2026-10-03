#!/usr/bin/env node
/**
 * Boots the packaged-shape app headlessly with an isolated userData dir and a
 * mock provider, so real user state is never touched.
 *
 *   SELFDEV_MOCK=1 node scripts/smoke.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const withAgent = process.env.SELFDEV_MOCK === '1';
const port = Number(process.env.SELFDEV_MOCK_PORT ?? 8765);
// 'openai' or 'anthropic' -- exercises both wire formats end to end
const format = process.env.SELFDEV_MOCK_FORMAT ?? 'openai';
const mockBase = `http://127.0.0.1:${port}`;
// What the app must be configured with so requests land on the mock handler.
const appBase = format === 'anthropic' ? mockBase : `${mockBase}/v1`;
const appProvider = format === 'anthropic' ? 'anthropic' : 'custom';

const ud = mkdtempSync(join(tmpdir(), 'selfdev-smoke-ud-'));
const ws = mkdtempSync(join(tmpdir(), 'selfdev-smoke-ws-'));
const log = join(tmpdir(), 'selfdev-mock-requests.log');
mkdirSync(ud, { recursive: true });

writeFileSync(
  join(ud, 'state.json'),
  JSON.stringify({
    version: 1,
    config: {
      provider: format === 'anthropic' ? 'anthropic' : 'custom',
      baseUrl: appBase,
      apiKey: 'smoke-key',
      model: 'mock-model',
      temperature: 0,
      maxTokens: 512,
      system: 'smoke',
      mode: 'dev'
    },
    sessions: [],
    activeSessionId: null,
    workspaceRoot: ws,
    theme: 'dark',
    createdAt: Date.now()
  })
);

const args = [
  'npx',
  'electron',
  '.',
  `--user-data-dir=${ud}`,
  '--disable-gpu',
  '--disable-software-rasterizer'
];

const env = {
  ...process.env,
  SELFDEV_SMOKE: '1',
  SELFDEV_SHOT: process.env.SELFDEV_SHOT ?? '/tmp/opencode/selfdev-smoke.png'
};

let mock = null;
if (withAgent) {
  env.SELFDEV_SMOKE_E2E = '1';
  env.SELFDEV_MOCK_URL = appBase;
  env.SELFDEV_MOCK_BASE = appBase;
  env.SELFDEV_MOCK_PROVIDER = appProvider;
  env.SELFDEV_MOCK_LOG = log;
  mock = spawn(process.execPath, ['tests/mock-provider.mjs'], {
    cwd: root,
    env: { ...process.env, SELFDEV_MOCK_PORT: String(port), SELFDEV_MOCK_LOG: log },
    stdio: 'inherit'
  });
  await new Promise((r) => setTimeout(r, 700));
}

const xvfb = spawn('xvfb-run', ['-a', '--server-args=-screen 0 1400x900x24', ...args], {
  cwd: root,
  env,
  stdio: 'inherit'
});

const timer = setTimeout(() => {
  console.error('SMOKE_FAIL timeout');
  xvfb.kill('SIGKILL');
  mock?.kill('SIGKILL');
  process.exit(1);
}, 150000);

xvfb.on('exit', (code) => {
  clearTimeout(timer);
  mock?.kill('SIGTERM');
  console.log(`smoke finished (exit ${code}) userData=${ud} workspace=${ws}`);
  process.exit(code ?? 1);
});