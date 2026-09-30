import { Application, Logger } from '@bespokecore/core';
import { startServer } from '@bespokecore/server';

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

  constructor(app: Application, logger: Logger) {
    this.#app = app;
    this.#logger = logger;
  }

  async handle(): Promise<void> {
    const server = await startServer({ app: this.#app, ssrEntry: 'bootstrap/ssr.tsx' });
    const signal = await new Promise<string>((resolve) => {
      process.once('SIGINT', resolve).once('SIGTERM', resolve);
    });
    // Ctrl+C reaches this process twice (from the terminal and forwarded by the launcher): later
    // signals must not cut the shutdown short. A shutdown that hangs still ends after 10 seconds.
    const ignore = () => {};
    process.on('SIGINT', ignore).on('SIGTERM', ignore);
    setTimeout(() => process.exit(1), 10_000).unref();
    this.#logger.info(`${signal} received, shutting down`);
    await server.close();
  }
}
