// Boots an app with live props the way a worker of `marmeon start --workers=N` does: the primary forks one worker of
// node:cluster with the workers' mark (CLUSTER_WORKER) and ends with its code. `single` boots in this process instead, with the
// mark left in the environment — no worker. Prints `booted` or `failed: <message>`. Used by server.test.ts.
import cluster from 'node:cluster';
import { createApplication } from '@marmeon/core';
import { CLUSTER_WORKER } from '@marmeon/core/internal';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { LiveServiceProvider } from '../index.ts';

const [root = '.', mode = 'worker'] = process.argv.slice(2);

async function boot(): Promise<number> {
  try {
    const app = await createApplication({
      root,
      discover: false,
      providers: [EncryptionServiceProvider, HttpServiceProvider, LiveServiceProvider],
    }, { env: { APP_KEY: generateKey(), LIVE_DRIVER: 'memory', LOG_LEVEL: 'silent', NODE_ENV: 'production' } });
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
