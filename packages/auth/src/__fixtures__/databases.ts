import { ConsoleLogger, type Application, type Logger } from '@marmeon/core';
import { Connections, Migrator, sql, type ConnectionOptions } from '@marmeon/database';

/** Postgres runs when `MARMEON_TEST_PGSQL_URL` is set (`pnpm test:pgsql`), like the database package's own tests. */
export const PGSQL_URL = process.env.MARMEON_TEST_PGSQL_URL;
export const drivers = PGSQL_URL ? (['sqlite', 'pgsql'] as const) : (['sqlite'] as const);

const silent: Logger = Object.assign(new ConsoleLogger(), { debug() {}, info() {} });

/** Connections on a fresh, migrated database (the remember_tokens fixture); `close()` drops it. */
export async function migratedConnections(driver: 'sqlite' | 'pgsql'): Promise<{ connections: Connections; close: () => Promise<void> }> {
  let options: ConnectionOptions = { driver: 'sqlite', database: ':memory:' };
  let drop = async () => {};
  if (driver === 'pgsql') {
    const name = `marmeon_auth_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const admin = new Connections({ connections: { default: { driver: 'pgsql', url: PGSQL_URL! } }, root: '/', logger: silent });
    await sql`create database ${sql.id(name)}`.execute(admin.get());
    const url = new URL(PGSQL_URL!);
    url.pathname = `/${name}`;
    options = { driver: 'pgsql', url: url.href, poolMax: 3 };
    drop = async () => {
      await sql`drop database ${sql.id(name)} with (force)`.execute(admin.get());
      await admin.destroy();
    };
  }
  const connections = new Connections({ connections: { default: options }, root: '/', logger: silent });
  const modules = [{ name: 'auth', migrations: new URL('./migrations/', import.meta.url) }];
  await new Migrator({ modules, root: '/' } as unknown as Application, connections).migrate();
  return {
    connections,
    close: async () => {
      await connections.destroy();
      await drop();
    },
  };
}
