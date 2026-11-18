import { Clock, ConsoleLogger, createApplication, Logger, type Application, type Container, type Logger as LoggerType, type ServiceProvider } from '@marmeon/core';
import { CacheServiceProvider } from '@marmeon/cache';
import { Connections, DatabaseServiceProvider } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { ServerServiceProvider } from '@marmeon/server';
import { SessionServiceProvider } from '@marmeon/session';
import { describe, expect, it, vi } from 'vitest';
import { workspaceTempDir } from '../../../scripts/test/temp-dir.js';
import { defineGuard } from './define-guard.ts';
import { AccessTokenStore, AuthServiceProvider, DatabaseEmailChanges, EmailChangeStore, PasswordResetTokenStore, SignInStore, TwoFactorStore, UserProvider } from './index.ts';
import { PasskeyServiceProvider } from './passkeys/provider.ts';
import { PasskeyStore } from './passkeys/store.ts';
import { storeDatabase } from './store-drivers.ts';
import { MemoryUsers } from './test-helpers/users.ts';

/** Makes the named connection answer with a driver the packages have no SQL for, and records every connection or transaction taken from it. */
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
    vi.spyOn(Connections.prototype, 'transaction').mockImplementation((() => {
      taken.push('transaction');
      throw new Error('no transaction may be begun');
    }) as never),
  ];
  return { taken, restore: () => spies.forEach((spy) => spy.mockRestore()) };
}
const silent: LoggerType = Object.assign(new ConsoleLogger(), { debug() {}, info() {} });

class OfficeUsers extends MemoryUsers<{ readonly id: number; readonly name: string; readonly email: string }> {}
const OfficeGuard = defineGuard('office', { users: OfficeUsers, tablePrefix: 'office_', settings: () => ({}) });
class OfficeProvider implements ServiceProvider {
  register(container: Container): void {
    OfficeGuard.register(container);
  }
}

const open = (extra: (new () => ServiceProvider)[], wire: (container: Container) => void = () => {}): Promise<Application> =>
  createApplication(
    {
      root: workspaceTempDir('marmeon-auth-driver-'),
      discover: false,
      providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, CacheServiceProvider, AuthServiceProvider, ...extra] as never,
    },
    {
      env: { DB_DRIVER: 'sqlite', DB_DATABASE: ':memory:', NODE_ENV: 'test', APP_KEY: generateKey(), SESSION_DRIVER: 'memory', LOG_LEVEL: 'silent', CACHE_DRIVER: 'memory' },
      override: (container) => {
        container.instance(Logger, silent);
        wire(container);
      },
    },
  );

const signedIn = (container: Container) => container.instance(UserProvider, {} as UserProvider);
/** The stores the app brings itself: none of ours keeps rows. */
const ownStores = (container: Container) => {
  signedIn(container);
  for (const key of [SignInStore, PasswordResetTokenStore, EmailChangeStore, AccessTokenStore]) container.instance(key as never, {} as never);
};

describe('the database stores of authentication on a driver they have no SQL for', () => {
  it.each([
    ['the stores of the app', [], signedIn, /\[marmeon:D29\] The database store of authentication needs a sqlite or pgsql connection, not "mysql"\./],
    ['the tables of a guard, with no store of the app', [OfficeProvider], () => {}, /\[marmeon:D29\] The table of a guard needs a sqlite or pgsql connection, not "mysql"\./],
    ['the passkeys table', [PasskeyServiceProvider], () => {}, /\[marmeon:D29\] The passkeys table needs a sqlite or pgsql connection, not "mysql"\./],
  ] as const)('refuses the start with %s (D29) before a connection is taken', async (_what, extra, wire, message) => {
    const mysql = onMysql('default');
    try {
      await expect(open([...extra], wire)).rejects.toThrow(message);
      expect(mysql.taken).toEqual([]);
    } finally {
      mysql.restore();
    }
  });

  it('starts an app whose stores are its own, without a guard, on a connection of such a driver', async () => {
    const mysql = onMysql('default');
    try {
      await using app = await open([], ownStores);
      expect(app.container.make(UserProvider)).toBeDefined();
      expect(mysql.taken).toEqual([]);
    } finally {
      mysql.restore();
    }
  });

  const userId = 1 as never;
  const passkey = { userId, userHandle: 'h', credentialId: 'c', publicKey: 'k', algorithm: -7, signCount: 0, transports: [], aaguid: 'a', backupEligible: false, backedUp: false, name: 'n' };
  // Each store, at its first use after the start: every kind of method, the ones that begin a transaction and the repository of the passkeys included.
  const stores: [string, (app: Application) => Promise<unknown>, string][] = [
    ['the sign-in store', (app) => app.container.make(SignInStore).endAll(userId), 'The sign-in store'],
    ['the email-change store', (app) => new DatabaseEmailChanges(app.container.make(Connections), app.container.make(Clock)).waiting(userId), 'The email-change store'],
    ['the password-reset store (create)', (app) => app.container.make(PasswordResetTokenStore).create('ada@example.com', 60), 'The password-reset store'],
    ['the password-reset store (consume)', (app) => app.container.make(PasswordResetTokenStore).consume('ada@example.com', 'v'.repeat(43), 60), 'The password-reset store'],
    ['the access-token store', (app) => app.container.make(AccessTokenStore).list(userId), 'The access-token store'],
    ['the passkey store (read)', (app) => app.container.make(PasskeyStore).forUser(userId), 'The passkey store'],
    ['the passkey store (create)', (app) => app.container.make(PasskeyStore).create(passkey), 'The passkey store'],
    ['the passkey store (remove)', (app) => app.container.make(PasskeyStore).remove(userId, 1, { lastFactorAllowed: true }), 'The passkey store'],
    ['the two-factor store (find)', (app) => app.container.make(TwoFactorStore).find(userId), 'The two-factor store'],
    ['the two-factor store (confirm)', (app) => app.container.make(TwoFactorStore).confirm(userId, 1, 's', null), 'The two-factor store'],
    ['the two-factor store (new codes)', (app) => app.container.make(TwoFactorStore).replaceRecoveryCodes(userId, []), 'The two-factor store'],
    ['the two-factor store (remove)', (app) => app.container.make(TwoFactorStore).removeTotp(userId, { lastFactor: true }), 'The two-factor store'],
  ];

  it.each(stores)('refuses %s on first use when the connection changed driver after the start, before a connection or transaction is taken', async (_what, use, name) => {
    await using app = await open([PasskeyServiceProvider], signedIn);
    const mysql = onMysql('default');
    try {
      await expect(use(app)).rejects.toThrow(new RegExp(`\\[marmeon:D29\\] ${name} needs a sqlite or pgsql connection, not "mysql"\\.`));
      expect(mysql.taken).toEqual([]);
    } finally {
      mysql.restore();
    }
  });

  it('storeDatabase() takes no connection on such a driver, and takes the default one otherwise', async () => {
    await using app = await open([]);
    const connections = app.container.make(Connections);
    const mysql = onMysql('default');
    try {
      expect(() => storeDatabase(connections, 'A store')).toThrow(/\[marmeon:D29\] A store needs a sqlite or pgsql connection, not "mysql"\./);
      expect(mysql.taken).toEqual([]);
    } finally {
      mysql.restore();
    }
    expect(storeDatabase(connections, 'A store')).toBe(connections.get());
  });
});
