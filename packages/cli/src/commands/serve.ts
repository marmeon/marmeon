import { Application } from '@bespokecore/core';
import { startServer } from '@bespokecore/server';
/** Runs the HTTP server. `bespoke dev` (with restarts) and `bespoke start` (production) both end up here. */
export class ServeCommand {
  static command = 'serve';
  static description = 'Run the HTTP server';
  static hidden = true;

  readonly #app: Application;

  constructor(app: Application) {
    this.#app = app;
  }

  async handle(): Promise<void> {
    await startServer({ app: this.#app, ssrEntry: 'bootstrap/ssr.tsx' });
  }
}
