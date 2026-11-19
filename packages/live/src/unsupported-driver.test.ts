import { createApplication, Logger, type Application } from '@marmeon/core';
import { Connections, DatabaseServiceProvider } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { SessionServiceProvider } from '@marmeon/session';
import { describe, expect, it, vi } from 'vitest';
import { LiveBackend } from './backend.ts';
import { LiveConfig } from './config.ts';
import { LiveServiceProvider } from './index.ts';
import { LiveTableHealthCheck } from './table-check.ts';

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

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const boot = (env: Record<string, string>): Promise<Application> =>
  createApplication(
    { root: import.meta.dirname, discover: false, providers: [EncryptionServiceProvider, HttpServiceProvider, DatabaseServiceProvider, SessionServiceProvider, LiveServiceProvider] },
    {
      env: { APP_KEY: generateKey(), NODE_ENV: 'test', SESSION_DRIVER: 'memory', DB_DRIVER: 'sqlite', DB_DATABASE: ':memory:', DB_MANAGED: 'false', ...env },
      override: (container) => container.instance(Logger, silent),
    },
  );

describe('LIVE_DRIVER=database on a driver it has no SQL for', () => {
  it('refuses the start (D29) before a connection is taken', async () => {
    const mysql = onMysql('reporting');
    try {
      await expect(boot({ LIVE_DRIVER: 'database', LIVE_CONNECTION: 'reporting' })).rejects.toThrow(
        /\[marmeon:D29\] LIVE_DRIVER=database needs a sqlite or pgsql connection, not "mysql"; use LIVE_DRIVER=redis or memory\./,
      );
      expect(mysql.taken).toEqual([]);
    } finally {
      mysql.restore();
    }
  });

  it('refuses the backend on first use when the connection changed driver after the start, before a connection is taken', async () => {
    await using app = await boot({ LIVE_DRIVER: 'database' });
    const mysql = onMysql('default');
    try {
      await expect(app.container.make(LiveBackend).seqs(['a'])).rejects.toThrow(/\[marmeon:D29\] LIVE_DRIVER=database needs a sqlite or pgsql connection, not "mysql"/);
      expect(mysql.taken).toEqual([]);
    } finally {
      mysql.restore();
    }
  });

  it('refuses the readiness check of the hints table before a connection is taken', async () => {
    await using app = await boot({ LIVE_DRIVER: 'database' });
    const mysql = onMysql('default');
    try {
      await expect(new LiveTableHealthCheck(app, app.container.make(LiveConfig)).handle()).rejects.toThrow(/\[marmeon:D29\] LIVE_DRIVER=database needs a sqlite or pgsql connection, not "mysql"/);
      expect(mysql.taken).toEqual([]);
    } finally {
      mysql.restore();
    }
  });

  it('starts LIVE_DRIVER=memory on a connection of a driver the backend has no SQL for', async () => {
    const mysql = onMysql('default');
    try {
      await using app = await boot({ LIVE_DRIVER: 'memory' });
      expect(app.container.make(LiveBackend)).toBeDefined();
      expect(mysql.taken).toEqual([]);
    } finally {
      mysql.restore();
    }
  });
});
