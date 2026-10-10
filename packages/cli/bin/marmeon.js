#!/usr/bin/env node
/**
 * The `marmeon` launcher. It runs the command **in this process** — `marmeon start`, `queue:work`, `schedule:work`,
 * `migrate` and every other command of an installed app: the injection hook is registered with `module.registerHooks`
 * before the command loads, so signals, exit codes (a stuck worker's 70) and `NODE_OPTIONS='--import …'` (telemetry) reach
 * exactly one Node process — PID 1 in a container.
 *
 * Node is started once more only for what a running process cannot switch on: `node --watch` for `marmeon dev`, and the
 * `@marmeon/source` condition inside the framework's monorepo — where a `pnpm-workspace.yaml` lists this package (its
 * packages resolve to their TypeScript sources; a published package does not carry the condition — `pnpm pack` writes the
 * `publishConfig.exports` without it — and a copied one is not given it).
 *
 * `marmeon start` turns on Node's compile cache before anything else loads — `storage/framework/compile-cache` of the
 * app, or Node's own `NODE_COMPILE_CACHE` (`NODE_DISABLE_COMPILE_CACHE=1` turns it off). Node keys an entry by the module's
 * URL and checks it against a hash of the source it compiles — the source after the injection hook — so a changed module
 * is compiled afresh, never served from an old entry. A directory that cannot be written leaves the start uncached.
 *
 * `NODE_ENV` is resolved once, in the process that runs the command, before anything of the app loads
 * (`resolveEnvironment` of `@marmeon/core/environment`): the environment's value wins; else the app's `.env` (marked, and
 * named as `NODE_ENV from .env`); else `marmeon start` and `marmeon build` set `production` and `marmeon dev` `development`;
 * else it stays unset — production. A value that is none of `development`, `test`, `production` stops every command here,
 * with the hint to set `NODE_ENV=production` and `APP_ENV=<name>` — before a development tool or a check could read it.
 */
import { spawn } from 'node:child_process';
import { enableCompileCache, getCompileCacheDir } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inWorkspace } from './workspace.js';

const SOURCE_CONDITION = '@marmeon/source';
const [command, ...rest] = process.argv.slice(2);

// A companion of `marmeon dev` (the queue worker, the scheduler — `startMarmeon`): when the channel to its server closes, the server
// ended without stopping it (killed, crashed) — it stops as on SIGTERM: the command finishes its running job, or this launcher passes
// the signal on to its child. The channel never keeps the process alive.
if (process.env.MARMEON_COMPANION === '1') {
  delete process.env.MARMEON_COMPANION;
  if (process.channel) {
    process.channel.unref();
    process.once('disconnect', () => process.kill(process.pid, 'SIGTERM'));
  }
}

if (process.env.MARMEON_CHILD === '1') {
  await runHere(process.argv.slice(2), process.env.MARMEON_LAUNCH);
} else {
  // `dev` and `start` both run the server (`serve`); `dev` restarts on changes, `start` runs the build.
  const args = command === 'dev' || command === 'start' ? ['serve', ...rest] : process.argv.slice(2);

  // `start` serves the build: the packages' `dist/`, also inside the monorepo — never their sources.
  const source = command !== 'start' && inWorkspace(fileURLToPath(new URL('..', import.meta.url))) && !sourceConditionActive();
  // `marmeon dev --help` prints the help and ends — nothing to watch.
  const own = rest.includes('--') ? rest.slice(0, rest.indexOf('--')) : rest;
  const watch = command === 'dev' && !own.includes('--help') && !own.includes('-h');
  if (source || watch) {
    // `marmeon dev`: checked here too (on a copy — the child resolves for itself), or `node --watch` would wait for changes after
    // the child's start error.
    if (watch && !(await environmentKnown({ ...process.env }))) process.exit(1);
    const flags = [...(source ? [`--conditions=${SOURCE_CONDITION}`] : []), ...(watch ? ['--watch'] : [])];
    const child = spawn(process.execPath, [...flags, fileURLToPath(import.meta.url), ...args], {
      stdio: 'inherit',
      env: { ...process.env, MARMEON_CHILD: '1', MARMEON_LAUNCH: command },
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
    child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  } else {
    if (command === 'start') compileCache();
    await runHere(args, command);
  }
}

/** Node's compile cache for `marmeon start`, unless Node runs one already (`NODE_COMPILE_CACHE`) or it is turned off. */
function compileCache() {
  if (process.env.NODE_DISABLE_COMPILE_CACHE || getCompileCacheDir() !== undefined) return;
  // A directory that cannot be created or written is no error: Node reports it in the returned status and runs uncached.
  enableCompileCache(join(process.cwd(), 'storage', 'framework', 'compile-cache'));
}

/**
 * Resolves `NODE_ENV`, registers the injection hook (`module.registerHooks`, which reads it: precomputed lists only where
 * the app is protected), then runs the command — in this process.
 */
async function runHere(args, launch) {
  const { buildEnvironment, DOTENV_MARKER, environment, resolveEnvironment } = await import('@marmeon/core/environment');
  // `start` is production unless the environment or .env says development; `dev` is development (development-only
  // tools check for `NODE_ENV=development`, never for "not production").
  // `build` builds for production without one (Vite would read a NODE_ENV of the .env files itself).
  const fallback = launch === 'start' || launch === 'build' ? 'production' : launch === 'dev' ? 'development' : undefined;
  let resolved;
  try {
    resolved = resolveEnvironment(process.cwd(), { fallback });
  } catch (error) {
    // An unknown NODE_ENV: the start error, nothing of the app loaded.
    if (error?.name !== 'ConfigError') throw error;
    process.stderr.write(`✗ ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  for (const warning of resolved.warnings) process.stderr.write(`⚠ ${warning}\n`);
  if (launch === 'build') {
    // What the build bakes into dist/client: production unless the environment says development — never a NODE_ENV=development
    // of .env, never test.
    const { notes, warnings } = buildEnvironment();
    for (const note of notes) process.stderr.write(`${note}\n`);
    for (const warning of warnings) process.stderr.write(`⚠ ${warning}\n`);
  }
  if (launch === 'dev') {
    // `marmeon dev` is development by itself — its server, worker and scheduler are no production commands, whatever .env says.
    if (environment.isDevelopment()) delete process.env[DOTENV_MARKER];
    else {
      process.stderr.write(
        `marmeon dev with NODE_ENV=${environment.describe()}: the development tools (Vite's dev server, the error page, the devtools) run with NODE_ENV=development only — this serves the build (marmeon build first).\n`,
      );
    }
  }
  delete process.env.MARMEON_LAUNCH;
  await import('@marmeon/core/register');
  const { run } = await import('marmeon/main');
  process.exitCode = await run(args);
  // A worker of `marmeon start --workers=N` that could not start (its app failed to boot): its channel to the primary would keep it
  // alive — and the primary, waiting for it to end, with it. It ends with its code once its output is written (letting
  // go of the channel instead would end it with 0: node:cluster's own rule).
  if (process.exitCode !== 0 && process.env.MARMEON_CLUSTER_WORKER === '1' && process.connected) {
    process.stderr.write('', () => process.stdout.write('', () => process.exit()));
  }
}

/** Whether `NODE_ENV` is one the framework knows — else its start error is written. `env` is resolved in place. */
async function environmentKnown(env) {
  // Without this condition the monorepo's core resolves to its dist/ — not built yet in a fresh checkout: the child checks then.
  const loaded = await import('@marmeon/core/environment').catch(() => undefined);
  if (!loaded) return true;
  const { resolveEnvironment } = loaded;
  try {
    resolveEnvironment(process.cwd(), { env });
    return true;
  } catch (error) {
    if (error?.name !== 'ConfigError') throw error;
    process.stderr.write(`✗ ${error.message}\n`);
    return false;
  }
}

/** Started with the condition already (`node --conditions=@marmeon/source …/marmeon.js`, `NODE_OPTIONS`): no second Node. */
function sourceConditionActive() {
  const flags = [...process.execArgv, ...(process.env.NODE_OPTIONS ?? '').split(/\s+/)].join(' ');
  return new RegExp(`(?:--conditions|-C)[= ]${SOURCE_CONDITION.replace('/', '\\/')}(?:\\s|$)`).test(flags);
}
