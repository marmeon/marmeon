// A server process that stops like `bespoke serve` (E102): on SIGTERM, `close()`, then `app.shutdown()`, then exit.
// POST /reset answers at once and sends its "mail" after the response (`afterResponse.defer`) over a transport that
// takes 300 ms and is closed by the app's shutdown — the way a pool or an SMTP connection is. Used by shutdown.test.ts.
import { setTimeout as sleep } from 'node:timers/promises';
import { createApplication, defineModule, type ServiceProvider } from '@bespokecore/core';
import { EncryptionServiceProvider, generateKey } from '@bespokecore/encryption';
import { AfterResponse, defineRoutes, HttpServiceProvider } from '@bespokecore/http';
import { startServer } from '../kernel.ts';
import { ServerServiceProvider } from '../provider.ts';

const transport = {
  open: true,
  async send(message: string): Promise<void> {
    await sleep(300);
    if (!this.open) throw new Error('the transport is closed');
    process.stdout.write(`sent ${message}\n`);
  },
};

class TransportProvider implements ServiceProvider {
  shutdown(): void {
    transport.open = false;
    process.stdout.write('shutdown\n');
  }
}

class SendResetLinkController {
  static inject = [AfterResponse] as const; // no injection hook in this bare process
  readonly #after: AfterResponse;
  constructor(after: AfterResponse) {
    this.#after = after;
  }
  handle() {
    this.#after.defer(() => transport.send('reset link'));
    return { status: 'We have e-mailed your reset link.' };
  }
}

const app = await createApplication({
  root: process.argv[2]!,
  discover: false,
  env: { APP_KEY: generateKey(), LOG_LEVEL: 'silent' },
  providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, TransportProvider],
  modules: [defineModule({ name: 'reset', apiRoutes: defineRoutes((Route) => Route.post('/reset', SendResetLinkController)) })],
});
const server = await startServer({ app, ssrEntry: 'ssr.ts', host: '127.0.0.1', port: 0, mode: 'development' });
process.once('SIGTERM', async () => {
  await server.close();
  await app.shutdown();
  process.exit(0);
});
process.stdout.write(`listening ${(server.server.address() as { port: number }).port}\n`);
