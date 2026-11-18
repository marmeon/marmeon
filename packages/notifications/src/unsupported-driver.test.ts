import { createApplication, Logger } from '@marmeon/core';
import { Connections, DatabaseServiceProvider } from '@marmeon/database';
import { describe, expect, it, vi } from 'vitest';
import { Faxed, KEY, silent, Welcome } from './__fixtures__/app.ts';
import { NotificationServiceProvider } from './index.ts';
import { NotificationStore } from './store.ts';

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

const open = (notifications: unknown[], connection = 'default') =>
  createApplication(
    { root: '/tmp', discover: false, providers: [DatabaseServiceProvider, NotificationServiceProvider], modules: [{ name: 'a', notifications: notifications as never }] },
    { env: { DB_MANAGED: 'false', DB_DRIVER: 'sqlite', DB_DATABASE: ':memory:', APP_KEY: KEY, NOTIFICATIONS_CONNECTION: connection }, override: (c) => c.instance(Logger, silent) },
  );

describe('the database channel of notifications on a driver it has no SQL for', () => {
  it('refuses the start of an app that delivers to the table (D29) before a connection is taken', async () => {
    const mysql = onMysql('reporting');
    try {
      await expect(open([Welcome], 'reporting')).rejects.toThrow(/\[marmeon:D29\] The database channel of notifications needs a sqlite or pgsql connection, not "mysql"\./);
      expect(mysql.taken).toEqual([]);
    } finally {
      mysql.restore();
    }
  });

  it('refuses the store on first use when the connection changed driver after the start, before a connection is taken', async () => {
    await using app = await open([Welcome]);
    const mysql = onMysql('default');
    try {
      await expect(app.container.make(NotificationStore).list({ type: 'member', id: 1 })).rejects.toThrow(/\[marmeon:D29\] The database channel of notifications needs a sqlite or pgsql connection, not "mysql"/);
      expect(mysql.taken).toEqual([]);
    } finally {
      mysql.restore();
    }
  });

  it('starts an app without a notification that has `static database` on a connection of such a driver', async () => {
    const mysql = onMysql('default');
    try {
      await using app = await open([Faxed]);
      expect(app.container.make(NotificationStore)).toBeDefined();
      expect(mysql.taken).toEqual([]);
    } finally {
      mysql.restore();
    }
  });
});
