import type { ChildProcess } from 'node:child_process';
import cluster, { type Worker } from 'node:cluster';
import { once } from 'node:events';
import { watch, type FSWatcher } from 'node:fs';
import { flushCompileCache } from 'node:module';
import { join } from 'node:path';
import { Application, CLUSTER_WORKER, environment, Logger } from '@marmeon/core';
import { refuseUndecidedRoutes, heldOnLoopback, shadowedLocalhost, ServerConfig, startServer, ViteSetupError } from '@marmeon/server';
import { RouteAccessError } from '@marmeon/router';
import type { CommandInput } from '../command.ts';
import { DevProcesses, type DevProcess } from '../dev.ts';
import { startMarmeon } from '../spawn.ts';
import { RouteTypes } from '../route-types.ts';
import { warnUnlisted } from '../unlisted.ts';
import { writeRouteTypes } from './route-types.ts';

/**
 * Runs the HTTP server — `marmeon dev` (with its companions, {@link DevProcesses}) and `marmeon start` (`--workers=N`: a
 * `node:cluster` primary) both end up here. It returns on SIGINT/SIGTERM once the server drained; the handlers are in place
 * before the server listens, so a supervisor's SIGTERM right after the start line still drains.
 * See docs/deployment.md#stopping-without-dropped-requests and docs/console.md#the-development-server.
 */
export class ServeCommand {
  static command = 'serve';
  static description = 'Run the HTTP server';
  static hidden = true;
  static usage = '[--workers=N]';
  static options = { workers: { type: 'string' } } as const;

  readonly #app: Application;
  readonly #logger: Logger;
  readonly #routeTypes: RouteTypes;
  readonly #devProcesses: DevProcesses;

  constructor(app: Application, logger: Logger, routeTypes: RouteTypes, devProcesses: DevProcesses) {
    this.#app = app;
    this.#logger = logger;
    this.#routeTypes = routeTypes;
    this.#devProcesses = devProcesses;
  }

  async handle({ options, output, root }: CommandInput): Promise<number> {
    // Development tools — Vite's dev server, the route-types watcher, the worker and scheduler next to the server — run with
    // NODE_ENV=development only (`marmeon dev` sets it), never with "anything but production" (test, unset).
    const development = environment.isDevelopment();
    const workers = workerCount(options.workers);
    if (typeof workers === 'string') {
      output.error(workers);
      return 1;
    }
    if (workers !== undefined && development) {
      output.error('--workers is for marmeon start (the build): marmeon dev runs one server, with Vite in front of it.');
      return 1;
    }
    // `marmeon start` as development because a .env says so: allowed, but never quietly — a developer's
    // .env on a server. (`marmeon dev` clears the mark: it is development by itself.) Said once, by the primary of a cluster.
    const fromDotEnv = cluster.isPrimary ? environment.dotEnvDevelopmentWarning('start') : undefined;
    if (fromDotEnv) this.#logger.warn(fromDotEnv);
    if (workers !== undefined && cluster.isPrimary) {
      // Said once, here, not by each of the workers that would refuse the same start.
      try {
        refuseUndecidedRoutes(this.#app);
      } catch (error) {
        if (!(error instanceof RouteAccessError)) throw error;
        output.error(error.message);
        return 1;
      }
      return this.#primary(workers);
    }
    // From here on a signal is ours: one that comes while the server starts is answered once it listens — Node's
    // default would end the process without a drain (and PID 1 in a container would not end at all).
    const signals = listenForSignals();
    // `marmeon dev` keeps bootstrap/routes.ts current: on every start (Node restarts when a route file changes)
    // and when a view is added or removed (Node never loads views, so that restarts nothing).
    const views = development ? await this.#watchRouteTypes(output, root) : undefined;
    // Parses the modules' files: development only, so `marmeon start` never loads the parser. A failure is a warning, never fatal.
    if (development) {
      try {
        warnUnlisted(output, root, this.#app.modules);
      } catch (error) {
        output.warn(`Could not check for unlisted jobs and notifications: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    let server;
    try {
      server = await startServer({ app: this.#app, mode: development ? 'development' : 'production' });
    } catch (error) {
      signals.remove();
      // The route-types watcher would keep the process alive after the failed start.
      views?.close();
      // A setup problem (no Vite, no marmeon() plugin) or routes that do not say who may call them: a message, not a stack trace.
      if (!(error instanceof ViteSetupError) && !(error instanceof RouteAccessError)) throw error;
      output.error(error.message);
      return 1;
    }
    const companions = development ? this.#devProcesses.all().map((definition) => this.#companion(definition, root)) : [];
    // Everything the server needs is loaded now: write the compile cache (`marmeon start`) instead of waiting for the
    // process to exit — a container that is killed never gets there. Does nothing without a cache.
    flushCompileCache();
    const signal = await signals.received;
    // Ctrl+C reaches this process twice (from the terminal and forwarded by the launcher or a cluster's primary): later
    // signals must not cut the shutdown short — the listeners of `signals` stay. A shutdown that hangs still ends after 10
    // seconds (plus the shutdown delay).
    const delay = signal === 'SIGTERM' ? this.#shutdownDelayMs() : 0;
    setTimeout(() => process.exit(1), 10_000 + delay).unref();
    this.#logger.info(
      delay > 0
        ? `${signal} received, shutting down — not ready any more, still answering for ${delay / 1000} s (SHUTDOWN_DELAY)`
        : `${signal} received, shutting down`,
    );
    views?.close();
    await Promise.all([server.close({ immediately: signal !== 'SIGTERM' }), ...companions.map((companion) => companion.stop())]);
    // A cluster worker: the channel to the primary would keep it alive after the app shut down.
    if (cluster.isWorker) process.disconnect?.();
    return 0;
  }

  #shutdownDelayMs(): number {
    return this.#app.container.has(ServerConfig) ? this.#app.container.make(ServerConfig).shutdownDelayMs : 0;
  }

  /**
   * The primary of `marmeon start --workers=N`: forks the workers — this command again, in processes of `node:cluster`
   * that share the port — passes SIGTERM/SIGINT on to each, and ends when they ended: 0 when all ended with 0.
   */
  async #primary(count: number): Promise<number> {
    const logger = this.#logger;
    const workers = new Set<Worker>();
    let stopping: NodeJS.Signals | undefined;
    let code = 0;
    let done: () => void = () => {};
    const finished = new Promise<void>((resolve) => (done = resolve));
    const reason = (exitCode: number | null, signal: string | null) => (signal ? `signal ${signal}` : `code ${exitCode}`);

    const stop = (signal: NodeJS.Signals) => {
      if (stopping) return;
      stopping = signal;
      logger.info(`${signal} received, stopping ${workers.size} worker${workers.size === 1 ? '' : 's'}`);
      for (const worker of workers) worker.process.kill(signal);
      if (workers.size === 0) done();
      // Each worker ends by itself within 10 s (plus the shutdown delay); one that does not is ended here.
      const limit = 12_000 + (signal === 'SIGTERM' ? this.#shutdownDelayMs() : 0);
      setTimeout(() => {
        for (const worker of workers) {
          logger.error(`Worker ${worker.process.pid} did not end within ${limit / 1000} s; killing it`);
          worker.process.kill('SIGKILL');
        }
      }, limit).unref();
    };

    const fork = () => {
      // Its boot's warnings stay unsaid: this process booted the same app and said them once (CLUSTER_WORKER).
      const worker = cluster.fork({ [CLUSTER_WORKER]: '1' });
      workers.add(worker);
      let listening = false;
      worker.once('listening', () => (listening = true));
      worker.once('exit', (exitCode, signal) => {
        workers.delete(worker);
        const ended = exitCode ?? (signal ? 1 : 0);
        if (stopping) {
          if (ended !== 0) {
            logger.warn(`Worker ${worker.process.pid} ended with ${reason(exitCode, signal)}`);
            if (code === 0) code = ended;
          }
          if (workers.size === 0) done();
          return;
        }
        if (!listening) {
          // A start that fails (configuration, a missing build) would only fail again: the cluster ends with its code.
          logger.error(`Worker ${worker.process.pid} ended before it listened (${reason(exitCode, signal)}); stopping the cluster`);
          code = ended || 1;
          stop('SIGTERM');
          return;
        }
        logger.warn(`Worker ${worker.process.pid} ended (${reason(exitCode, signal)}); starting another`);
        setTimeout(() => !stopping && fork(), 1000).unref();
      });
    };

    // Kept until the process ends: Ctrl+C reaches the primary again (the terminal signals every process of the group).
    process.on('SIGINT', () => stop('SIGINT')).on('SIGTERM', () => stop('SIGTERM'));
    // Said once, here: a worker's own look would go through this process (the workers share its port).
    if (this.#app.container.has(ServerConfig)) {
      const { port, host } = this.#app.container.make(ServerConfig);
      const beside = await heldOnLoopback(port, host);
      if (beside) logger.warn(beside);
      const shadow = await shadowedLocalhost(port, host);
      if (shadow) logger.warn(shadow);
    }
    logger.info(`Starting ${count} worker${count === 1 ? '' : 's'} (node:cluster, primary ${process.pid})`);
    for (let n = 0; n < count; n++) fork();
    await finished;
    return code;
  }

  /** Runs `marmeon <args>` next to the server until `stop()`; one that ends on its own is started again (unless it fails right away). */
  #companion(definition: DevProcess, root: string): { stop(): Promise<void> } {
    let child: ChildProcess | undefined;
    let stopping = false;
    const start = () => {
      const started = Date.now();
      const current = startMarmeon(root, definition.args);
      child = current;
      current.once('exit', (code, signal) => {
        if (stopping || child !== current) return;
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        if (Date.now() - started < 3000) {
          this.#logger.error(`The ${definition.name} process (marmeon ${definition.args.join(' ')}) ended right after it started (${reason}); fix the problem and save a file to restart.`);
          return;
        }
        this.#logger.warn(`The ${definition.name} process ended (${reason}); starting it again`);
        setTimeout(() => !stopping && start(), 1000).unref();
      });
    };
    start();
    return {
      stop: async () => {
        stopping = true;
        const current = child;
        if (!current || current.exitCode !== null || current.signalCode !== null) return;
        const exited = once(current, 'exit');
        current.kill('SIGTERM');
        // It finishes its running job first (its --stop-timeout); the server's own 10-second limit still applies.
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 9000).unref())]);
      },
    };
  }

  async #watchRouteTypes(output: CommandInput['output'], root: string): Promise<FSWatcher | undefined> {
    // A failure here is reported, never fatal: the server runs on with the committed file.
    const regenerate = () =>
      writeRouteTypes(this.#routeTypes, output, root, { quiet: true }).catch((error: unknown) => {
        output.warn(`marmeon route:types failed — ${root}/bootstrap/routes.ts may be out of date: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      });
    await regenerate();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return watch(join(root, 'modules'), { recursive: true }, (event, file) => {
        if (event !== 'rename' || !file || !/(^|[/\\])views[/\\].+\.tsx$/.test(file)) return;
        clearTimeout(timer);
        timer = setTimeout(() => void regenerate(), 100);
      });
    } catch {
      return undefined; // no modules/ directory yet
    }
  }
}

/** `--workers=N`: a whole number from 1; undefined without the option; a message for anything else. */
function workerCount(value: unknown): number | undefined | string {
  if (value === undefined) return undefined;
  const count = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(count) || count < 1 || count > 256) return `--workers expects a number of processes from 1, like --workers=4 (got ${String(value)}).`;
  return count;
}

/**
 * SIGINT and SIGTERM from now on: which came first (later ones are the caller's to handle). The listeners stay until `remove()`
 * — never `once`: a library's signal-exit (Rolldown's, loaded with Vite 8's dev server) re-raises a signal when it finds itself the
 * only listener, and a `once` listener is gone by then — the process would end without its shutdown and leave the queue worker
 * and the scheduler of `marmeon dev` running.
 */
function listenForSignals(): { received: Promise<NodeJS.Signals>; remove(): void } {
  let resolve: (signal: NodeJS.Signals) => void = () => {};
  const received = new Promise<NodeJS.Signals>((settle) => (resolve = settle));
  const onInt = () => resolve('SIGINT');
  const onTerm = () => resolve('SIGTERM');
  process.on('SIGINT', onInt).on('SIGTERM', onTerm);
  return {
    received,
    remove: () => {
      process.off('SIGINT', onInt).off('SIGTERM', onTerm);
    },
  };
}
