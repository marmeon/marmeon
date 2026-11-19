import { createApplication } from '@marmeon/core';
import { Connections, DatabaseServiceProvider } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { freshDirectory, removeDirectories } from './__fixtures__/disks.ts';
import { StorageServiceProvider } from './index.ts';
import { TemporaryUploads } from './uploads/service.ts';

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

const boot = (connection: string) =>
  createApplication(
    { root: freshDirectory(), discover: false, providers: [EncryptionServiceProvider, DatabaseServiceProvider, HttpServiceProvider, StorageServiceProvider] },
    { env: { APP_KEY: generateKey(), LOG_LEVEL: 'silent', DB_MANAGED: 'false', DB_DRIVER: 'sqlite', DB_DATABASE: ':memory:', UPLOADS_CONNECTION: connection } },
  );

describe('uploads on a driver they have no SQL for', () => {
  afterAll(() => removeDirectories());

  it('refuse at the first use (D29) before a connection is taken', async () => {
    const mysql = onMysql('reporting');
    try {
      await using app = await boot('reporting');
      await expect(
        app.container.make(TemporaryUploads).target({ route: 'avatar.update', field: 'avatar', rule: { maxBytes: 100, mime: undefined }, session: 's', name: 'a.png', size: 10 }),
      ).rejects.toThrow(/\[marmeon:D29\] The uploads table needs a sqlite or pgsql connection, not "mysql"; point UPLOADS_CONNECTION at one\./);
      expect(mysql.taken).toEqual([]);
    } finally {
      mysql.restore();
    }
  });

  it('leave the start of an app that makes no use of them alone, on the default connection', async () => {
    const mysql = onMysql('default');
    try {
      await using app = await boot('default');
      expect(app.container.make(TemporaryUploads)).toBeDefined();
      expect(mysql.taken).toEqual([]);
    } finally {
      mysql.restore();
    }
  });
});
