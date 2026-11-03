import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Redactor } from '@marmeon/core';
import { NO_INTERACTION_ENV } from './prompt.ts';

/** The `marmeon` launcher of this package — `bin/marmeon.js`, next to `src/` and `dist/`. */
const LAUNCHER = fileURLToPath(new URL('../bin/marmeon.js', import.meta.url));

/** Splits chunks of text into complete lines for `onLine`; `flush` passes on what is left when the stream ends. */
export function lineBuffer(onLine: (line: string) => void): { readonly write: (chunk: string) => void; readonly flush: () => void } {
  let rest = '';
  return {
    write(chunk) {
      const parts = (rest + chunk).split('\n');
      rest = parts.pop() ?? '';
      for (const line of parts) onLine(line);
    },
    flush() {
      if (rest !== '') onLine(rest);
      rest = '';
    },
  };
}

/**
 * `marmeon <args>` in `root` as a new process (the launcher sets conditions and the injection hook itself). Its output goes to
 * this console, or to `onOutput` when given, one complete line at a time (stdout and stderr buffered apart, the rest flushed on exit).
 */
export function spawnMarmeon(root: string, args: readonly string[], noInteraction = false, onOutput?: (line: string) => void): Promise<number> {
  const { MARMEON_CHILD: _child, MARMEON_LAUNCH: _launch, ...inherited } = process.env;
  // `--no-interaction` is not among the arguments the command passes on; the child learns it from the environment.
  const env = noInteraction ? { ...inherited, [NO_INTERACTION_ENV]: '1' } : inherited;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [LAUNCHER, ...args], { cwd: root, env, stdio: onOutput ? ['inherit', 'pipe', 'pipe'] : 'inherit' });
    const buffers = onOutput ? [child.stdout, child.stderr].map((stream) => {
      const buffer = lineBuffer(onOutput);
      stream?.setEncoding('utf8').on('data', buffer.write);
      return buffer;
    }) : [];
    child.once('error', reject);
    // `close`, not `exit`: the pipes are drained by then.
    child.once('close', (code, signal) => {
      for (const buffer of buffers) buffer.flush();
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

/** Set for a companion of `marmeon dev`: the launcher stops it as on SIGTERM when its channel to the server closes. */
export const COMPANION = 'MARMEON_COMPANION';

/**
 * Starts `marmeon <args>` in `root` as a long-running child process (output to this console) — what `marmeon dev` uses for
 * the processes it runs next to the server (a queue worker). The caller stops it (SIGTERM); and when this process ends without
 * doing so — killed, crashed, a signal it never handled — the child's IPC channel closes and it stops by itself (the launcher:
 * `disconnect` → SIGTERM to itself), never left running beside the next server.
 */
export function startMarmeon(root: string, args: readonly string[]): ChildProcess {
  const { MARMEON_CHILD: _child, MARMEON_LAUNCH: _launch, ...env } = process.env;
  return spawn(process.execPath, [LAUNCHER, ...args], { cwd: root, env: { ...env, [COMPANION]: '1' }, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
}

/** What `runMarmeonJson` made of a child process. */
export interface JsonRun {
  readonly code: number;
  /** What the child printed on stdout, parsed — only after exit 0 and only when it was one JSON document. */
  readonly document: unknown | undefined;
  /** The last 4 KiB of its stderr, redacted. */
  readonly stderrTail: string;
  /** It was stopped after `timeoutMs`. */
  readonly timedOut: boolean;
  /** It was stopped because it printed more than `maxStdoutBytes`. */
  readonly tooLarge: boolean;
}

/** How long a child that was asked to end (SIGTERM) has before it is killed. */
const GRACE_MS = 5_000;

const STDERR_TAIL_BYTES = 4096;

/** What is kept of stderr before it is redacted: more than is shown, so a `KEY=value` the cut would split is whole once the partial line is dropped. */
const STDERR_WINDOW_BYTES = 8192;

/** The end of `window` (raw stderr): its partial first line dropped, redacted, then cut to {@link STDERR_TAIL_BYTES} at a line start. */
export function stderrTailOf(window: Buffer, truncated: boolean): string {
  let text = window.toString('utf8');
  if (truncated) {
    const newline = text.indexOf('\n');
    text = newline === -1 ? '' : text.slice(newline + 1);
  }
  let redacted = new Redactor().text(text);
  if (Buffer.byteLength(redacted) > STDERR_TAIL_BYTES) {
    const cut = Buffer.from(redacted).subarray(-STDERR_TAIL_BYTES).toString('utf8');
    const newline = cut.indexOf('\n');
    redacted = newline === -1 ? '' : cut.slice(newline + 1);
  }
  return redacted;
}

/**
 * `marmeon <args>` in `root` as a new process, whose stdout is one JSON document (`--json`). No shell, nothing on stdin, both
 * outputs piped; the arguments are an array, never a string. Ends the child (SIGTERM, SIGKILL after a grace period) after
 * `timeoutMs`, when `signal` aborts, and when it prints more than `maxStdoutBytes`.
 */
export function runMarmeonJson(root: string, args: readonly string[], { timeoutMs, signal, maxStdoutBytes }: { readonly timeoutMs: number; readonly signal?: AbortSignal; readonly maxStdoutBytes: number }): Promise<JsonRun> {
  const { MARMEON_CHILD: _child, MARMEON_LAUNCH: _launch, ...inherited } = process.env;
  // A call that was cancelled while it waited in the queue never starts the app.
  if (signal?.aborted) return Promise.resolve({ code: 1, document: undefined, stderrTail: '', timedOut: false, tooLarge: false });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [LAUNCHER, ...args], { cwd: root, env: { ...inherited, [NO_INTERACTION_ENV]: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let outBytes = 0;
    let errWindow: Buffer = Buffer.alloc(0);
    let errCut = false;
    let timedOut = false;
    let tooLarge = false;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => {
        child.kill('SIGKILL');
        // A process the launcher started may ignore SIGTERM and hold the pipes after the launcher is gone: without `close` the call would never end.
        child.stdout.destroy();
        child.stderr.destroy();
        // A line the destroy cut short may end inside a token, below the length its pattern needs to be redacted.
        errWindow = errWindow.subarray(0, errWindow.lastIndexOf(0x0a) + 1);
      }, GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > maxStdoutBytes) {
        tooLarge = true;
        out.length = 0;
        stop();
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errWindow = Buffer.concat([errWindow, chunk]);
      if (errWindow.length > STDERR_WINDOW_BYTES) {
        errWindow = errWindow.subarray(errWindow.length - STDERR_WINDOW_BYTES);
        errCut = true;
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(error);
    });
    // `close`, not `exit`: the pipes are drained by then.
    child.once('close', (code, signalName) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', stop);
      let document: unknown;
      if (code === 0 && !tooLarge) {
        try {
          document = JSON.parse(Buffer.concat(out).toString('utf8'));
        } catch {
          document = undefined;
        }
      }
      resolve({ code: code ?? (signalName ? 1 : 0), document, stderrTail: stderrTailOf(errWindow, errCut), timedOut, tooLarge });
    });
  });
}
