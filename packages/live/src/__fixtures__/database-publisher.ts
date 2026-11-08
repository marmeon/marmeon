// A queue worker or scheduler stand-in: boots a minimal app on the SQLite file in `root` (LIVE_DRIVER=database), sends a refresh
// hint through its Broadcaster and exits. Prints `sent <row id>` or `failed: <message>`. Used by processes.test.ts.
import { createApplication } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, sql } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { join } from 'node:path';
import { Broadcaster, LiveServiceProvider } from '../index.ts';

const [root = '.', channel = 'orders.7'] = process.argv.slice(2);

// A hung boot or write must not leave the process behind.
setTimeout(() => {
  process.stdout.write('failed: timed out\n');
  process.exit(70);
}, 20_000).unref();

try {
  const app = await createApplication(
    { root, discover: false, providers: [EncryptionServiceProvider, HttpServiceProvider, DatabaseServiceProvider, LiveServiceProvider] },
    { env: { APP_KEY: generateKey(), LIVE_DRIVER: 'database', LOG_LEVEL: 'silent', NODE_ENV: 'production', DB_DRIVER: 'sqlite', DB_DATABASE: join(root, 'live.sqlite'), DB_MANAGED: 'false' } },
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
