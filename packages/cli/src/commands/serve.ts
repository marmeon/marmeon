import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { Application, Logger } from '@bespokecore/core';
import { startServer, ViteSetupError } from '@bespokecore/server';
import type { CommandInput } from '../command.ts';
import { RouteTypes } from '../route-types.ts';
import { writeRouteTypes } from './route-types.ts';

/**
 * Runs the HTTP server. `bespoke dev` (with restarts) and `bespoke start` (production) both end up here.
 * It returns on SIGINT/SIGTERM (Ctrl+C, `node --watch` restarting, a deployment): the server stops
 * accepting requests, open keep-alive connections close, and then the CLI shuts the app down.
 */
export class ServeCommand {
  static command = 'serve';
  static description = 'Run the HTTP server';
  static hidden = true;

  readonly #app: Application;
  readonly #logger: Logger;
  readonly #routeTypes: RouteTypes;

  constructor(app: Application, logger: Logger, routeTypes: RouteTypes) {
    this.#app = app;
    this.#logger = logger;
    this.#routeTypes = routeTypes;
  }

  async handle({ output, root }: CommandInput): Promise<number> {
    // `bespoke dev` keeps bootstrap/routes.ts current: on every start (Node restarts when a route file changes)
    // and when a view is added or removed (Node never loads views, so that restarts nothing).
    const development = process.env.NODE_ENV !== 'production';
    const views = development ? await this.#watchRouteTypes(output, root) : undefined;
    let server;
    try {
      server = await startServer({ app: this.#app });
    } catch (error) {
      // A setup problem (no Vite, no bespoke() plugin) is a message, not a stack trace.
      if (!(error instanceof ViteSetupError)) throw error;
      output.error(error.message);
      return 1;
    }
    const signal = await new Promise<string>((resolve) => {
      process.once('SIGINT', resolve).once('SIGTERM', resolve);
    });
    // Ctrl+C reaches this process twice (from the terminal and forwarded by the launcher): later
    // signals must not cut the shutdown short. A shutdown that hangs still ends after 10 seconds.
    const ignore = () => {};
    process.on('SIGINT', ignore).on('SIGTERM', ignore);
    setTimeout(() => process.exit(1), 10_000).unref();
    this.#logger.info(`${signal} received, shutting down`);
    views?.close();
    await server.close();
    return 0;
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
