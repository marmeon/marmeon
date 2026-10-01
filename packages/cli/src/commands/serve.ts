import { Application, Logger } from '@bespokecore/core';
import { startServer, ViteSetupError } from '@bespokecore/server';
import type { CommandInput } from '../command.ts';

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

  async handle({ output }: CommandInput): Promise<number> {
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
    await server.close();
    return 0;
  }
}
