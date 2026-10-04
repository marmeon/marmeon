import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { watch, type FSWatcher } from 'node:fs';
import { flushCompileCache } from 'node:module';
import { join } from 'node:path';
import { Application, environment, Logger } from '@bespokecore/core';
import { startServer, ViteSetupError } from '@bespokecore/server';
import type { CommandInput } from '../command.ts';
import { DevProcesses, type DevProcess } from '../dev.ts';
import { startBespoke } from '../spawn.ts';
import { RouteTypes } from '../route-types.ts';
import { writeRouteTypes } from './route-types.ts';

/**
 * Runs the HTTP server. `bespoke dev` (with restarts) and `bespoke start` (production) both end up here.
 * It returns on SIGINT/SIGTERM (Ctrl+C, `node --watch` restarting, a deployment): the server stops
 * accepting requests, open keep-alive connections close, and then the CLI shuts the app down.
 *
 * `bespoke dev` also runs what packages add to {@link DevProcesses} (a queue worker, E101) — started with the server,
 * stopped with it (so `node --watch` restarts them on a code change too), restarted if one ends on its own.
 */
export class ServeCommand {
  static command = 'serve';
  static description = 'Run the HTTP server';
  static hidden = true;

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

  async handle({ output, root }: CommandInput): Promise<number> {
    // `bespoke dev` keeps bootstrap/routes.ts current: on every start (Node restarts when a route file changes)
    // and when a view is added or removed (Node never loads views, so that restarts nothing).
    // Development tools — Vite's dev server, the route-types watcher, the worker and scheduler next to the server — run with
    // NODE_ENV=development only (E115; `bespoke dev` sets it), never with "anything but production" (staging, test, unset).
    const development = environment.isDevelopment();
    const views = development ? await this.#watchRouteTypes(output, root) : undefined;
    let server;
    try {
      server = await startServer({ app: this.#app, mode: development ? 'development' : 'production' });
    } catch (error) {
      // A setup problem (no Vite, no bespoke() plugin) is a message, not a stack trace.
      if (!(error instanceof ViteSetupError)) throw error;
      output.error(error.message);
      return 1;
    }
    const companions = development ? this.#devProcesses.all().map((definition) => this.#companion(definition, root)) : [];
    const signalled = new Promise<string>((resolve) => {
      process.once('SIGINT', resolve).once('SIGTERM', resolve);
    });
    // Everything the server needs is loaded now: write the compile cache (`bespoke start`, E138) instead of waiting for the
    // process to exit — a container that is killed never gets there. Does nothing without a cache. After the signal handlers:
    // a SIGTERM while it writes still drains.
    flushCompileCache();
    const signal = await signalled;
    // Ctrl+C reaches this process twice (from the terminal and forwarded by the launcher): later
    // signals must not cut the shutdown short. A shutdown that hangs still ends after 10 seconds.
    const ignore = () => {};
    process.on('SIGINT', ignore).on('SIGTERM', ignore);
    setTimeout(() => process.exit(1), 10_000).unref();
    this.#logger.info(`${signal} received, shutting down`);
    views?.close();
    await Promise.all([server.close(), ...companions.map((companion) => companion.stop())]);
    return 0;
  }

  /** Runs `bespoke <args>` next to the server until `stop()`; one that ends on its own is started again (unless it fails right away). */
  #companion(definition: DevProcess, root: string): { stop(): Promise<void> } {
    let child: ChildProcess | undefined;
    let stopping = false;
    const start = () => {
      const started = Date.now();
      const current = startBespoke(root, definition.args);
      child = current;
      current.once('exit', (code, signal) => {
        if (stopping || child !== current) return;
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        if (Date.now() - started < 3000) {
          this.#logger.error(`The ${definition.name} process (bespoke ${definition.args.join(' ')}) ended right after it started (${reason}); fix the problem and save a file to restart.`);
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
        output.warn(`bespoke route:types failed — ${root}/bootstrap/routes.ts may be out of date: ${error instanceof Error ? error.message : String(error)}`);
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
