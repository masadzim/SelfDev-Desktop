import { build } from 'esbuild';
import { mkdirSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dev = process.env.SELFDEV_DEV === '1';

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: dev,
  minify: false,
  logLevel: 'info',
  // electron & node builtins stay external; electron-updater must stay external
  // so it is resolved from node_modules at runtime (it does dynamic requires
  // and reads its own metadata files, so it must not be inlined).
  external: ['electron', 'electron-updater'],
  define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') }
};

mkdirSync(resolve(root, 'dist/main'), { recursive: true });
mkdirSync(resolve(root, 'dist/preload'), { recursive: true });
mkdirSync(resolve(root, 'dist/renderer'), { recursive: true });

// 1. main process
await build({
  ...shared,
  entryPoints: [resolve(root, 'src/main/main.ts')],
  outfile: resolve(root, 'dist/main/main.js')
});

// 2. preload (must be CJS: sandboxed preloads cannot be ESM)
await build({
  ...shared,
  entryPoints: [resolve(root, 'src/preload/preload.ts')],
  outfile: resolve(root, 'dist/preload/preload.js')
});

// 3. renderer (bundled IIFE so it runs from file:// without CORS issues)
await build({
  bundle: true,
  platform: 'browser',
  target: 'chrome120',
  format: 'iife',
  sourcemap: dev,
  minify: false,
  logLevel: 'info',
  entryPoints: [resolve(root, 'src/renderer/main.ts')],
  outfile: resolve(root, 'dist/renderer/renderer.js')
});

// 4. the sandbox runner is plain JS and is forked at runtime -> ship as-is
copyFileSync(resolve(root, 'src/main/tools/runner.js'), resolve(root, 'dist/main/runner.js'));

// 5. static renderer assets
copyFileSync(resolve(root, 'src/renderer/index.html'), resolve(root, 'dist/renderer/index.html'));
copyFileSync(resolve(root, 'src/renderer/styles.css'), resolve(root, 'dist/renderer/styles.css'));

if (!existsSync(resolve(root, 'assets/icon.png'))) {
  console.warn('[build] warning: assets/icon.png missing');
}

// 5. tests (bundled next to runner.js so the sandbox fork path resolves)
if (process.env.SELFDEV_BUILD_TESTS === '1') {
  await build({
    ...shared,
    entryPoints: [resolve(root, 'tests/run.ts')],
    outfile: resolve(root, 'dist/main/tests.js')
  });
} else {
  // Never ship the test bundle: a previous `npm test` leaves it behind.
  const stale = resolve(root, 'dist/main/tests.js');
  if (existsSync(stale)) rmSync(stale, { force: true });
}

console.log('[build] done ->', resolve(root, 'dist'));