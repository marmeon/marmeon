// A queue worker or scheduler stand-in: boots a minimal app on the SQLite file in `root` (LIVE_DRIVER=database), sends a refresh
// hint through its Broadcaster and exits. Prints `sent <row id>` or `failed: <message>`. Used by processes.test.ts.
import { createApplication, Logger } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, sql } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { join } from 'node:path';
import { Broadcaster, LiveServiceProvider } from '../index.ts';

// The fixture loads no @marmeon/log, so core's console logger would print every query.
const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet };

const [root = '.', channel = 'orders.7'] = process.argv.slice(2);

// A hung boot or write must not leave the process behind.
setTimeout(() => {
  process.stdout.write('failed: timed out\n');
  process.exit(70);
}, 20_000).unref();

try {
  const app = await createApplication(
    { root, discover: false, providers: [EncryptionServiceProvider, HttpServiceProvider, DatabaseServiceProvider, LiveServiceProvider] },
    { env: { APP_KEY: generateKey(), LIVE_DRIVER: 'database', NODE_ENV: 'production', DB_DRIVER: 'sqlite', DB_DATABASE: join(root, 'live.sqlite'), DB_MANAGED: 'false' }, override: (container) => container.instance(Logger, quiet) },
  );
  await app.container.make(Broadcaster).refresh(channel, { only: ['status'] });
  const row = await sql<{ id: number }>`select max(id) as id from live_hints`.execute(app.container.make(Connections).get());
  await app.shutdown();
  process.stdout.write(`sent ${row.rows[0]!.id}\n`);
  process.exit(0);
} catch (error) {
  process.stdout.write(`failed: ${(error as Error).message}\n`);
  process.exit(70);
}
