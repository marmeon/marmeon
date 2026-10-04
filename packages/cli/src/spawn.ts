import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** The `bespoke` launcher of this package — `bin/bespoke.js`, next to `src/` and `dist/`. */
const LAUNCHER = fileURLToPath(new URL('../bin/bespoke.js', import.meta.url));

/** `bespoke <args>` in `root` as a new process (the launcher sets conditions and the injection hook itself). */
export function spawnBespoke(root: string, args: readonly string[]): Promise<number> {
  const { BESPOKE_CHILD: _child, BESPOKE_LAUNCH: _launch, ...env } = process.env;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [LAUNCHER, ...args], { cwd: root, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

/**
 * Starts `bespoke <args>` in `root` as a long-running child process (output to this console) — what `bespoke dev` uses for
 * the processes it runs next to the server (a queue worker). The caller stops it.
 */
export function startBespoke(root: string, args: readonly string[]): ChildProcess {
  const { BESPOKE_CHILD: _child, BESPOKE_LAUNCH: _launch, ...env } = process.env;
  return spawn(process.execPath, [LAUNCHER, ...args], { cwd: root, env, stdio: 'inherit' });
}
