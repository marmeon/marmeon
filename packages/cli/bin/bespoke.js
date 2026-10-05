#!/usr/bin/env node
/**
 * The `bespoke` launcher (E159). It runs the command **in this process** — `bespoke start`, `queue:work`, `schedule:work`,
 * `migrate` and every other command of an installed app: the injection hook is registered with `module.registerHooks`
 * before the command loads, so signals, exit codes (a stuck worker's 70) and `NODE_OPTIONS='--import …'` (telemetry) reach
 * exactly one Node process — PID 1 in a container.
 *
 * Node is started once more only for what a running process cannot switch on: `node --watch` for `bespoke dev`, and the
 * `@bespokecore/source` condition inside the framework's monorepo — where a `pnpm-workspace.yaml` lists this package (its
 * packages resolve to their TypeScript sources; a published package does not carry the condition — `pnpm pack` writes the
 * `publishConfig.exports` without it — and a copied one is not given it).
 *
 * `bespoke start` turns on Node's compile cache (E138) before anything else loads — `storage/framework/compile-cache` of the
 * app, or Node's own `NODE_COMPILE_CACHE` (`NODE_DISABLE_COMPILE_CACHE=1` turns it off). Node keys an entry by the module's
 * URL and checks it against a hash of the source it compiles — the source after the injection hook — so a changed module
 * is compiled afresh, never served from an old entry. A directory that cannot be written leaves the start uncached.
 *
 * `NODE_ENV` (E139, E170) is resolved once, in the process that runs the command, before anything of the app loads
 * (`resolveEnvironment` of `@bespokecore/core/environment`): the environment's value wins; else the app's `.env` (marked, and
 * named as `development (from .env)`); else `bespoke start` sets `production` and `bespoke dev` `development`; else it stays
 * unset — protected like production.
 */
import { spawn } from 'node:child_process';
import { enableCompileCache, getCompileCacheDir } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inWorkspace } from './workspace.js';

const SOURCE_CONDITION = '@bespokecore/source';
const [command, ...rest] = process.argv.slice(2);

if (process.env.BESPOKE_CHILD === '1') {
  await runHere(process.argv.slice(2), process.env.BESPOKE_LAUNCH);
} else {
  // `dev` and `start` both run the server (`serve`); `dev` restarts on changes, `start` runs the build.
  const args = command === 'dev' || command === 'start' ? ['serve', ...rest] : process.argv.slice(2);

  // `start` serves the build: the packages' `dist/`, also inside the monorepo — never their sources.
  const source = command !== 'start' && inWorkspace(fileURLToPath(new URL('..', import.meta.url))) && !sourceConditionActive();
  const watch = command === 'dev';
  if (source || watch) {
    const flags = [...(source ? [`--conditions=${SOURCE_CONDITION}`] : []), ...(watch ? ['--watch'] : [])];
    const child = spawn(process.execPath, [...flags, fileURLToPath(import.meta.url), ...args], {
      stdio: 'inherit',
      env: { ...process.env, BESPOKE_CHILD: '1', BESPOKE_LAUNCH: command },
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
    child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  } else {
    if (command === 'start') compileCache();
    await runHere(args, command);
  }
}

/** Node's compile cache for `bespoke start`, unless Node runs one already (`NODE_COMPILE_CACHE`) or it is turned off. */
function compileCache() {
  if (process.env.NODE_DISABLE_COMPILE_CACHE || getCompileCacheDir() !== undefined) return;
  // A directory that cannot be created or written is no error: Node reports it in the returned status and runs uncached.
  enableCompileCache(join(process.cwd(), 'storage', 'framework', 'compile-cache'));
}

/**
 * Resolves `NODE_ENV` (E170), registers the injection hook (`module.registerHooks`, which reads it: precomputed lists only where
 * the app is protected), then runs the command — in this process.
 */
async function runHere(args, launch) {
  const { DOTENV_MARKER, environment, resolveEnvironment } = await import('@bespokecore/core/environment');
  // `start` is production unless the environment or .env says otherwise (staging); `dev` is development (E115: development-only
  // tools check for `NODE_ENV=development`, never for "not production").
  const fallback = launch === 'start' ? 'production' : launch === 'dev' ? 'development' : undefined;
  const resolved = resolveEnvironment(process.cwd(), { fallback });
  for (const warning of resolved.warnings) process.stderr.write(`⚠ ${warning}\n`);
  if (launch === 'dev') {
    // `bespoke dev` is development by itself — its server, worker and scheduler are no production commands, whatever .env says.
    if (environment.isDevelopment()) delete process.env[DOTENV_MARKER];
    else {
      process.stderr.write(
        `bespoke dev with NODE_ENV=${environment.describe()}: the development tools (Vite's dev server, the error page, the devtools) run with NODE_ENV=development only — this serves the build (bespoke build first).\n`,
      );
    }
  }
  delete process.env.BESPOKE_LAUNCH;
  await import('@bespokecore/core/register');
  const { run } = await import('@bespokecore/cli/main');
  process.exitCode = await run(args);
}

/** Started with the condition already (`node --conditions=@bespokecore/source …/bespoke.js`, `NODE_OPTIONS`): no second Node. */
function sourceConditionActive() {
  const flags = [...process.execArgv, ...(process.env.NODE_OPTIONS ?? '').split(/\s+/)].join(' ');
  return new RegExp(`(?:--conditions|-C)[= ]${SOURCE_CONDITION.replace('/', '\\/')}(?:\\s|$)`).test(flags);
}
