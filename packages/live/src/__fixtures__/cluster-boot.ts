// Boots an app with live props the way a worker of `marmeon start --workers=N` does: the primary forks one worker of
// node:cluster with the workers' mark (CLUSTER_WORKER) and ends with its code. `single` boots in this process instead, with the
// mark left in the environment — no worker. The third argument is LIVE_DRIVER (default `memory`); `database` boots with a SQLite
// file in `root` and its table. Prints `booted` or `failed: <message>`. Used by server.test.ts.
import cluster from 'node:cluster';
import { createApplication, Logger } from '@marmeon/core';
import { CLUSTER_WORKER } from '@marmeon/core/internal';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { DatabaseServiceProvider } from '@marmeon/database';
import { join } from 'node:path';
import { LiveServiceProvider } from '../index.ts';

// No @marmeon/log here, so core's console logger would print; the fixture's only output is its result line.
const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet };

const [root = '.', mode = 'worker', driver = 'memory'] = process.argv.slice(2);

async function boot(): Promise<number> {
  try {
    const app = await createApplication({
      root,
      discover: false,
      providers: [EncryptionServiceProvider, HttpServiceProvider, ...(driver === 'database' ? [DatabaseServiceProvider] : []), LiveServiceProvider],
    }, { env: { APP_KEY: generateKey(), LIVE_DRIVER: driver, NODE_ENV: 'production', ...(driver === 'database' ? { DB_DRIVER: 'sqlite', DB_DATABASE: join(root, 'live.sqlite'), DB_MANAGED: 'false' } : {}) }, override: (container) => container.instance(Logger, quiet) });
    await app.shutdown();
    process.stdout.write('booted\n');
    return 0;
  } catch (error) {
    process.stdout.write(`failed: ${(error as Error).message}\n`);
    return 70;
  }
}

if (mode === 'single' || cluster.isWorker) {
  // A worker's channel to its primary keeps it alive: it ends itself.
  process.exit(await boot());
} else {
  cluster.fork({ [CLUSTER_WORKER]: '1' }).once('exit', (code) => (process.exitCode = code ?? 1));
}
