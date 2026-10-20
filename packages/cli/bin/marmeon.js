#!/usr/bin/env node
/**
 * The `marmeon` launcher: resolves `NODE_ENV` (docs/configuration.md#where-node_env-comes-from), registers the injection hook
 * and runs the command **in this process**, so signals and exit codes reach one Node process (docs/deployment.md#one-process).
 * Node is started again only for `node --watch` (`marmeon dev`) and for the `@marmeon/source` condition inside the framework's
 * monorepo. `marmeon start` turns on Node's compile cache, which checks each entry against the source after the hook.
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
    // A wrong call ends here, too: the child would exit 2 and `node --watch` wait for changes.
    if (watch && !(await argumentsKnown(rest))) process.exit(2);
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
  // `start` is production unless the process environment says development (a .env's is refused below); `dev` is development
  // (development-only tools check for `NODE_ENV=development`, never for "not production").
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
  // A developer's .env on a server must never start the development stack: the server (`start`, `serve`) runs as development or
  // test only when the process environment says so — `marmeon dev` alone takes it from .env. Nothing of the app is loaded.
  const fromDotEnv = resolved.source === '.env' && (environment.isDevelopment() || process.env.NODE_ENV === 'test');
  if (args[0] === 'serve' && launch !== 'dev' && fromDotEnv) {
    const name = process.env.NODE_ENV;
    const way =
      name === 'development'
        ? 'run `marmeon dev`, set NODE_ENV=production to try the build, or set NODE_ENV=development in the environment to start it on purpose'
        : 'run `marmeon dev`, or set NODE_ENV=production to try the build';
    process.stderr.write(`✗ marmeon ${launch ?? 'serve'} runs in production. NODE_ENV=${name} comes from .env only — ${way}.\n`);
    process.exitCode = 1;
    return;
  }
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
  // `marmeon docs | head`: a reader that closes the pipe early is no failure of the command. It stops writing (Node drops later
  // writes to the closed stream) and ends with its own exit code. Any other write error stays one. The server (`serve`) is left
  // out: one whose log pipe breaks must crash, so its supervisor restarts it, instead of running on without logs.
  if (args[0] !== 'serve') {
    for (const stream of [process.stdout, process.stderr]) {
      stream.on('error', (error) => {
        if (error?.code !== 'EPIPE') throw error;
      });
    }
  }
  await import('@marmeon/core/register');
  const { run } = await import('marmeon/main');
  process.exitCode = await run(args);
  // `marmeon check` ran app code and checks of packages: one that left a timer or a socket open must not keep the report waiting.
  if (args[0] === 'check') {
    process.stderr.write('', () => process.stdout.write('', () => process.exit()));
  }
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

/** Whether `rest` fits the options of `marmeon dev` — else the error is written. Not checked when the CLI cannot be loaded (the child does). */
async function argumentsKnown(args) {
  const loaded = await import('marmeon/main').catch(() => undefined);
  if (!loaded) return true;
  try {
    loaded.checkArgs('serve', args, 'dev');
    return true;
  } catch (error) {
    if (error?.name !== 'CommandArgumentsError') throw error;
    process.stderr.write(`✗ ${error.message}\n`);
    return false;
  }
}

/** Started with the condition already (`node --conditions=@marmeon/source …/marmeon.js`, `NODE_OPTIONS`): no second Node. */
function sourceConditionActive() {
  const flags = [...process.execArgv, ...(process.env.NODE_OPTIONS ?? '').split(/\s+/)].join(' ');
  return new RegExp(`(?:--conditions|-C)[= ]${SOURCE_CONDITION.replace('/', '\\/')}(?:\\s|$)`).test(flags);
}
