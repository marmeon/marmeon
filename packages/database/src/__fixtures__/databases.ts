import { ConsoleLogger, type Logger } from '@marmeon/core';
import { sql } from 'kysely';
import { Connections } from '../connections.ts';
import type { ConnectionOptions } from '../config.ts';

/** Postgres runs when `MARMEON_TEST_PGSQL_URL` is set (`docker compose up -d`, then `pnpm test:pgsql`). */
export const PGSQL_URL = process.env.MARMEON_TEST_PGSQL_URL;
export const drivers = PGSQL_URL ? (['sqlite', 'pgsql'] as const) : (['sqlite'] as const);
export type TestDriver = (typeof drivers)[number];

export const silent: Logger = Object.assign(new ConsoleLogger(), { debug() {}, info() {} });

/** A fresh database per suite: SQLite in memory, or a new Postgres database dropped by `drop()`. */
export async function freshDatabase(driver: 'sqlite' | 'pgsql'): Promise<{ options: ConnectionOptions; drop: () => Promise<void> }> {
  if (driver === 'sqlite') return { options: { driver: 'sqlite', database: ':memory:' }, drop: async () => {} };
  const name = `marmeon_test_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = new Connections({ connections: { default: { driver: 'pgsql', url: PGSQL_URL! } }, root: '/', logger: silent });
  await sql`create database ${sql.id(name)}`.execute(admin.get());
  const url = new URL(PGSQL_URL!);
  url.pathname = `/${name}`;
  return {
    options: { driver: 'pgsql', url: url.href, poolMax: 3 },
    drop: async () => {
      await sql`drop database ${sql.id(name)} with (force)`.execute(admin.get());
      await admin.destroy();
    },
  };
}

/** A `Connections` on a fresh database; `close()` destroys it and drops the database. */
export async function freshConnections(driver: 'sqlite' | 'pgsql'): Promise<{ connections: Connections; close: () => Promise<void> }> {
  const fresh = await freshDatabase(driver);
  const connections = new Connections({ connections: { default: fresh.options }, root: '/', logger: silent });
  return {
    connections,
    close: async () => {
      await connections.destroy();
      await fresh.drop();
    },
  };
}
