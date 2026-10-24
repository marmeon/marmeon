import { createApplication, HealthChecks, Logger } from '@marmeon/core';
import { DatabaseServiceProvider, type Migration } from '@marmeon/database';
import { SchemaRequirements } from '@marmeon/database';
import { runMigration } from '@marmeon/database/internal';
import { EncryptionServiceProvider } from '@marmeon/encryption';
import { RedisServiceProvider } from '@marmeon/redis';
import { CliServiceProvider } from 'marmeon';
import { describe, expect, it } from 'vitest';
import { connectionOptions, databaseConnections, databaseKinds, freshTarget, REDIS_URL, silent, type SharedTarget } from './__fixtures__/targets.ts';
import { QUEUE_MIGRATION } from './commands/failed.ts';
import { QueueServiceProvider } from './index.ts';

const load = async (file: URL) => ((await import(file.href)) as { default: Migration }).default;

describe.each(databaseKinds)('the queue migration on %s', (kind) => {
  it('stops an app migration that creates jobs a second time at the CREATE TABLE', async () => {
    const { target, drop } = await freshTarget(kind);
    const connections = databaseConnections(connectionOptions(target as SharedTarget));
    try {
      // The target was made by the stub; the same migration again is an app migration that creates jobs a second time.
      await expect(runMigration(connections, await load(QUEUE_MIGRATION))).rejects.toThrow(/jobs/);
    } finally {
      await connections.destroy();
      await drop();
    }
  });
});

describe('the tables readiness waits for', () => {
  async function required(providers: Parameters<typeof createApplication>[0]['providers'], env: Record<string, string>) {
    await using application = await createApplication(
      { root: '/tmp', discover: false, providers },
      { env: { DB_DRIVER: 'sqlite', DB_DATABASE: ':memory:', APP_KEY: 'base64:J1THMmM0weaSNoc1xHnSWExHWTxE/5A9NwgE4YJajvY=', NODE_ENV: 'test', ...env }, override: (container) => container.instance(Logger, silent) },
    );
    return { tables: application.container.make(SchemaRequirements).all().map((requirement) => requirement.table), report: await application.container.make(HealthChecks).run(application.container) };
  }

  it('are none for QUEUE_DRIVER=sync, so /up/ready stays green without them', async () => {
    const { tables, report } = await required([CliServiceProvider, DatabaseServiceProvider, EncryptionServiceProvider, QueueServiceProvider], { QUEUE_DRIVER: 'sync' });
    expect(tables).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('are both for the database queue', async () => {
    const { tables } = await required([CliServiceProvider, DatabaseServiceProvider, EncryptionServiceProvider, QueueServiceProvider], {});
    expect(tables).toEqual(['jobs', 'failed_jobs']);
  });

  it.skipIf(!REDIS_URL)('are the failed-job table alone for a Redis queue that keeps its failures in the database', async () => {
    const { tables } = await required([CliServiceProvider, DatabaseServiceProvider, RedisServiceProvider, EncryptionServiceProvider, QueueServiceProvider], { QUEUE_DRIVER: 'redis', REDIS_URL: REDIS_URL!, REDIS_PREFIX: 'tables-test:', QUEUE_FAILED_DRIVER: 'database' });
    expect(tables).toEqual(['failed_jobs']);
  });
});
