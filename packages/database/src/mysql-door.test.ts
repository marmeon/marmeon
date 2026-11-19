import { createApplication, defineConfig, env, Logger } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { DatabaseConfig } from './config.ts';
import { Connections } from './connections.ts';
import { DatabaseServiceProvider } from './provider.ts';
import { UnsupportedDriverError } from './supported-driver.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

// MySQL runs for a `Connections` built directly, but an app cannot select it: every way to a MySQL connection of an app ends at the provider.

const root = tempDir('marmeon-mysql-door-');
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const url = 'mysql://app:hunter2x@127.0.0.1:1/app';

const boot = (config: unknown[], override?: (container: never) => void) =>
  createApplication(
    { root, discover: false, providers: [DatabaseServiceProvider], config: config as never },
    { env: { DB_DRIVER: 'sqlite', DB_DATABASE: ':memory:' }, override: (container) => { container.instance(Logger, silent); override?.(container as never); } },
  );

describe('an app that is given a MySQL connection', () => {
  it('is refused with D29 for a connection definition built by hand, whatever its name', async () => {
    // `defineConnection` refuses the driver itself; a definition is only duck-typed by its `connection` name.
    const byHand = { ...defineConfig('database.analytics', { env: env({}), resolve: () => ({ driver: 'mysql', url }) }), connection: 'analytics' };
    const error = await boot([byHand]).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnsupportedDriverError);
    expect((error as Error).message).toBe('[marmeon:D29] The connection "analytics" names the driver "mysql"; use sqlite or pgsql.');
  });

  it('is refused with D29 when the default is overridden with one', async () => {
    const error = await boot([], (container: any) => container.instance(DatabaseConfig, { default: { driver: 'mysql', url } })).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnsupportedDriverError);
    expect((error as Error).message).toBe('[marmeon:D29] The connection "default" names the driver "mysql"; use sqlite or pgsql.');
  });

  it('is the only way in: a Connections built directly takes the connection', () => {
    expect(() => new Connections({ connections: { default: { driver: 'mysql', url } }, root: '/', logger: silent })).not.toThrow();
  });
});
