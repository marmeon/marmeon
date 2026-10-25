import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
