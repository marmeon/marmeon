import { createApplication, Logger } from '@marmeon/core';
import { Connections, DatabaseServiceProvider } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { describe, expect, it, vi } from 'vitest';
import { silent } from './__fixtures__/targets.ts';
import { QueueConnections } from './connections.ts';
import { QueueServiceProvider } from './index.ts';

/** Makes the named connection answer with a driver the packages have no SQL for, and records every connection taken from it. */
function onMysql(connection: string): { taken: string[]; restore: () => void } {
  const taken: string[] = [];
  const options = Connections.prototype.options;
  const spies = [
    vi.spyOn(Connections.prototype, 'options').mockImplementation(function (this: Connections, name?: string) {
      return (name ?? 'default') === connection ? ({ driver: 'mysql', url: 'mysql://x@127.0.0.1/db' } as never) : options.call(this, name);
    }),
    vi.spyOn(Connections.prototype, 'get').mockImplementation((name?: string) => {
      taken.push(`get ${name ?? ''}`);
      throw new Error('no connection may be taken');
    }),
    vi.spyOn(Connections.prototype, 'infrastructure').mockImplementation((name?: string) => {
      taken.push(`infrastructure ${name ?? ''}`);
      throw new Error('no connection may be taken');
    }),
  ];
  return { taken, restore: () => spies.forEach((spy) => spy.mockRestore()) };
}
function boot(env: Record<string, string>) {
  return createApplication(
    { root: '/tmp', discover: false, providers: [DatabaseServiceProvider, EncryptionServiceProvider, QueueServiceProvider] },
    { env: { DB_MANAGED: 'false', DB_DRIVER: 'sqlite', DB_DATABASE: ':memory:', APP_KEY: generateKey(), NODE_ENV: 'test', ...env }, override: (container) => container.instance(Logger, silent) },
  );
}

describe('the database queue and the failed-job store on a driver they have no SQL for', () => {
  it.each([
    ['the queue', { QUEUE_DRIVER: 'database', QUEUE_DATABASE_CONNECTION: 'reporting' }, /\[marmeon:D29\] QUEUE_DRIVER=database needs a sqlite or pgsql connection, not "mysql"; use QUEUE_DRIVER=redis or sync\./],
    [
      'the failed jobs of a database queue',
      { QUEUE_DRIVER: 'database', QUEUE_FAILED_DRIVER: 'database', QUEUE_FAILED_CONNECTION: 'reporting' },
      /\[marmeon:D29\] QUEUE_FAILED_DRIVER=database needs a sqlite or pgsql connection, not "mysql"; set QUEUE_FAILED_DRIVER=null, or QUEUE_FAILED_CONNECTION to a sqlite or pgsql connection\./,
    ],
  ])('refuses the connection of %s at startup (D29) before a connection is taken', async (_what, env, message) => {
    const mysql = onMysql('reporting');
    try {
      await expect(boot(env)).rejects.toThrow(message);
      expect(mysql.taken).toEqual([]);
    } finally {
      mysql.restore();
    }
  });

  it.each([
    ['a sync queue with no failed-job store', { QUEUE_DRIVER: 'sync', QUEUE_FAILED_DRIVER: 'null' }],
    ['a sync queue whose failed jobs go to the database (judged on first use)', { QUEUE_DRIVER: 'sync', QUEUE_FAILED_DRIVER: 'database' }],
  ])('starts %s on a connection of such a driver, and takes none', async (_what, env) => {
    const mysql = onMysql('default');
    try {
      await using app = await boot(env);
      expect(app.container.make(QueueConnections).options('sync').driver).toBe('sync');
      expect(mysql.taken).toEqual([]);
    } finally {
      mysql.restore();
    }
  });

  it('refuses the failed-job store of a sync queue on first use, before a connection is taken', async () => {
    await using app = await boot({ QUEUE_DRIVER: 'sync', QUEUE_FAILED_DRIVER: 'database' });
    const mysql = onMysql('default');
    try {
      await expect(app.container.make(QueueConnections).failed().all()).rejects.toThrow(/\[marmeon:D29\] QUEUE_FAILED_DRIVER=database needs a sqlite or pgsql connection, not "mysql"/);
      expect(mysql.taken).toEqual([]);
    } finally {
      mysql.restore();
    }
  });

  it('refuses the queue on first use when the connection changed driver after the start, before a connection is taken', async () => {
    await using app = await boot({ QUEUE_DRIVER: 'database' });
    const mysql = onMysql('default');
    try {
      await expect(app.container.make(QueueConnections).driver('database').size('default')).rejects.toThrow(/\[marmeon:D29\] QUEUE_DRIVER=database needs a sqlite or pgsql connection, not "mysql"/);
      expect(mysql.taken).toEqual([]);
    } finally {
      mysql.restore();
    }
  });
});
