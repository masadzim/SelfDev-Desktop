/**
 * SelfDev sandbox runner.
 *
 * Runs inside a forked child process. Captures console output, evaluates the
 * user snippet (awaiting async results), then reports back over IPC. Any
 * uncaught error or infinite loop is handled by the parent (which kills the
 * process on timeout).
 */
'use strict';

const logs = [];
let logCount = 0;
const MAX_RAW_LOGS = 2000;

function push(type, value) {
  if (logCount >= MAX_RAW_LOGS) return;
  logCount++;
  try {
    if (typeof value === 'string') logs.push([type, value]);
    else if (value instanceof Error) logs.push([type, value.stack || value.message]);
    else logs.push([type, safeStringify(value)]);
  } catch (e) {
    logs.push(['err', String(value)]);
  }
}

function safeStringify(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const t = typeof value;
  if (t === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (t === 'symbol') return value.toString();
  if (t === 'bigint') return `${value}n`;
  try {
    return JSON.stringify(
      value,
      (_k, v) => {
        if (typeof v === 'bigint') return `${v}n`;
        if (typeof v === 'function') return `[Function ${v.name || 'anonymous'}]`;
        return v;
      },
      2
    );
  } catch (e) {
    return String(value);
  }
}

function emitError(message) {
  logs.push(['err', String(message)]);
}

// console-like formatting: strings print raw, everything else is inspected
const format = (args) => args.map((v) => (typeof v === 'string' ? v : safeStringify(v))).join(' ');

globalThis.print = function print() {
  push('log', format(Array.prototype.slice.call(arguments)));
};
globalThis.console = {
  log: globalThis.print,
  info: function info() {
    push('log', format(Array.prototype.slice.call(arguments)));
  },
  warn: function warn() {
    push('log', '⚠ ' + format(Array.prototype.slice.call(arguments)));
  },
  error: function error() {
    push('err', format(Array.prototype.slice.call(arguments)));
  },
  debug: globalThis.print,
  table: function table(v) {
    push('log', safeStringify(v));
  },
  trace: function trace() {
    push('err', new Error('trace').stack || 'trace');
  }
};
globalThis.onerror = function onerror(m) {
  emitError(m);
};

process.on('uncaughtException', (e) => {
  emitError(e && e.stack ? e.stack : String(e));
  send(true);
});
process.on('unhandledRejection', (e) => {
  emitError('UnhandledRejection: ' + (e && e.stack ? e.stack : String(e)));
  send(true);
});

let sent = false;
function send(isError) {
  if (sent) return;
  sent = true;
  let result = '';
  try {
    if (!isError) {
      const pending = lastResult;
      result = pending === undefined ? 'undefined' : safeStringify(pending);
    }
  } catch (e) {
    result = String(e && e.message ? e.message : e);
  }
  try {
    process.send({ done: true, logs, result, error: isError ? true : undefined });
  } catch (e) {
    /* parent gone */
  }
}

let lastResult;

process.on('message', async (msg) => {
  const code = msg && msg.code ? String(msg.code) : '';
  try {
    // Compile the snippet as an async function body so that top-level
    // `return` and `await` both work, the way a REPL expects them to.
    const factory = new Function('return (async function () {\n' + code + '\n});');
    lastResult = await factory()();
    send(false);
  } catch (e) {
    emitError(e && e.stack ? e.stack : String(e));
    send(true);
  }
});

process.on('SIGTERM', () => process.exit(143));