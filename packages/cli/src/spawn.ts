import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** The `marmeon` launcher of this package — `bin/marmeon.js`, next to `src/` and `dist/`. */
const LAUNCHER = fileURLToPath(new URL('../bin/marmeon.js', import.meta.url));

/** `marmeon <args>` in `root` as a new process (the launcher sets conditions and the injection hook itself). */
export function spawnMarmeon(root: string, args: readonly string[]): Promise<number> {
  const { MARMEON_CHILD: _child, MARMEON_LAUNCH: _launch, ...env } = process.env;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [LAUNCHER, ...args], { cwd: root, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

/**
 * Starts `marmeon <args>` in `root` as a long-running child process (output to this console) — what `marmeon dev` uses for
 * the processes it runs next to the server (a queue worker). The caller stops it.
 */
export function startMarmeon(root: string, args: readonly string[]): ChildProcess {
  const { MARMEON_CHILD: _child, MARMEON_LAUNCH: _launch, ...env } = process.env;
  return spawn(process.execPath, [LAUNCHER, ...args], { cwd: root, env, stdio: 'inherit' });
}
