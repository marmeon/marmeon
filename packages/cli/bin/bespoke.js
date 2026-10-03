#!/usr/bin/env node
/**
 * The `bespoke` launcher. Every BespokeCore process needs a startup flag that cannot
 * be set once Node runs — the `@bespokecore/source` condition, harmless outside the
 * framework monorepo because published packages do not carry it. So the launcher
 * re-executes Node once with it; the child then registers the injection hook before
 * loading any command, so commands get constructor injection too.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [command, ...rest] = process.argv.slice(2);

if (process.env.BESPOKE_CHILD === '1') {
  await import('@bespokecore/core/register');
  const { run } = await import('@bespokecore/cli/main');
  process.exitCode = await run(process.argv.slice(2));
} else {
  // `dev` and `start` both run the server (`serve`); `dev` restarts on changes, `start` runs the build.
  const production = command === 'start';
  const flags = [...(production ? [] : ['--conditions=@bespokecore/source']), ...(command === 'dev' ? ['--watch'] : [])];
  const args = command === 'dev' || command === 'start' ? ['serve', ...rest] : process.argv.slice(2);

  // `start` is production; `dev` is development (E115: development-only tools — `Server-Timing`, devtools — check for
  // `NODE_ENV=development`, never for "not production"), unless the environment says otherwise.
  const mode = production ? { NODE_ENV: 'production' } : command === 'dev' && !process.env.NODE_ENV ? { NODE_ENV: 'development' } : {};
  const child = spawn(process.execPath, [...flags, fileURLToPath(import.meta.url), ...args], {
    stdio: 'inherit',
    env: { ...process.env, BESPOKE_CHILD: '1', ...mode },
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}
