import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const bin = join(repo, 'packages/cli/bin/marmeon.js');
export const webApp = join(repo, 'apps/web-app');

export interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The parent's environment for a `marmeon` child: the launcher must re-exec, and the database is the one a test names. */
export function environment(env: Record<string, string>): NodeJS.ProcessEnv {
  const { MARMEON_CHILD: _child, DB_CONNECTION: _connection, DB_URL: _url, ...parent } = process.env;
  return { ...parent, NO_COLOR: '1', ...env };
}

export function marmeon(args: readonly string[], env: Record<string, string>): Run {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: webApp, encoding: 'utf8', env: environment(env) });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** `marmeon tinker` with piped input (`stdin.end(…)`, or the REPL never sees the end of its input). */
export function session(args: readonly string[], env: Record<string, string>, input: string): Promise<Run> {
  const child = spawn(process.execPath, [bin, 'tinker', ...args], { cwd: webApp, env: environment(env) });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data: Buffer) => (stdout += data));
  child.stderr.on('data', (data: Buffer) => (stderr += data));
  child.stdin.end(input);
  return new Promise((resolve) => child.on('exit', (code) => resolve({ code, stdout, stderr })));
}
