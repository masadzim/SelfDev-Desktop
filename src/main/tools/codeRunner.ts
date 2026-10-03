import { fork, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

import type { ToolResult } from '../../shared/types';
import { trunc } from './fsTools';

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 20_000;
const MAX_LOGS = 500;

interface RunnerMessage {
  done?: boolean;
  logs?: Array<[string, string]>;
  result?: string;
  error?: string;
}

/** Execute JavaScript in a forked Node process with a hard timeout. */
export function runCode(args: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ToolResult> {
  const code = String(args.code ?? '');
  return new Promise<ToolResult>((resolve) => {
    if (!code.trim()) {
      resolve({ content: 'Kode kosong', isError: true });
      return;
    }

    const limit = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, timeoutMs));
    let child: ChildProcess;
    let timer: NodeJS.Timeout;
    let done = false;

    const finish = (res: ToolResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already exited */
      }
      resolve(res);
    };

    try {
      child = fork(join(__dirname, 'runner.js'), [], {
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          LANG: process.env.LANG ?? 'en_US.UTF-8',
          NODE_OPTIONS: '',
          SELFDEV_SANDBOX: '1'
        },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        detached: false
      });
    } catch (err) {
      resolve({ content: `Gagal menjalankan sandbox: ${err instanceof Error ? err.message : String(err)}`, isError: true });
      return;
    }

    timer = setTimeout(() => {
      finish({ content: `⏱ Timeout setelah ${limit / 1000} detik — proses dihentikan`, isError: true });
    }, limit);

    child.on('message', (raw: unknown) => {
      const m = raw as RunnerMessage;
      if (!m || m.done !== true) return;
      const logs = (m.logs ?? []).slice(0, MAX_LOGS).map(([t, v]) => (t === 'err' ? '⚠ ' : '') + v);
      const resultLine = m.error ? '' : `\n=> ${m.result}`;
      finish({
        content: trunc(`${logs.join('\n') || '(tidak ada output)'}${resultLine}`, MAX_OUTPUT),
        isError: Boolean(m.error)
      });
    });

    child.on('error', (err) => finish({ content: `Gagal menjalankan sandbox: ${err.message}`, isError: true }));

    child.on('exit', (code, signal) => {
      if (done) return;
      if (signal) finish({ content: `Proses dihentikan (${signal})`, isError: true });
      else finish({ content: `Proses selesai tanpa output (exit code ${code ?? 0})`, isError: code !== 0 });
    });

    try {
      child.send({ code });
    } catch (err) {
      finish({ content: `Gagal mengirim kode: ${err instanceof Error ? err.message : String(err)}`, isError: true });
    }
  });
}