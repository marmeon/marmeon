import { join } from 'node:path';
import type { Logger } from '@marmeon/core';
import { Connections, sql, type ConnectionOptions, type Migration } from '@marmeon/database';
import { runMigration } from '@marmeon/database/internal';
import { DatabaseLiveBackend, type DatabaseLiveOptions } from '../database.ts';
import { Redactor } from '@marmeon/core';

/** Postgres runs when `MARMEON_TEST_PGSQL_URL` is set (`pnpm test:pgsql`). */
export const PGSQL_URL = process.env.MARMEON_TEST_PGSQL_URL;

export const silent: Logger = { debug() {}, info() {}, warn() {}, error: (message, context) => console.error(message, context), child: () => silent };

/** The migration `marmeon make:live-table` will copy. */
export const LIVE_HINTS_MIGRATION = new URL('../../stubs/migrations/0001_01_01_000000_create_live_hints_table.ts', import.meta.url);

export function databaseConnections(options: ConnectionOptions): Connections {
  return new Connections({ connections: { default: { ...options, managed: false } }, root: '/', logger: silent });
}

/** Runs the live_hints migration on a connection. */
export async function migrate(connections: Connections, name = 'default'): Promise<void> {
  const migration = ((await import(LIVE_HINTS_MIGRATION.href)) as { default: Migration }).default;
  await runMigration(connections, migration, { connection: name });
}

/** Where the table lives: a SQLite file in `directory`, or a database of its own on the Postgres server. */
export type LiveTarget = { driver: 'sqlite'; file: string } | { driver: 'pgsql'; url: string };

export function connectionsAt(target: LiveTarget): Connections {
  return databaseConnections(target.driver === 'sqlite' ? { driver: 'sqlite', database: target.file } : { driver: 'pgsql', url: target.url, poolMax: 2 });
}

export function sqliteTarget(directory: string): LiveTarget {
  return { driver: 'sqlite', file: join(directory, 'live.sqlite') };
}

/** A fresh Postgres database with the table; `drop` removes it. */
export async function freshPostgres(): Promise<{ target: LiveTarget; drop: () => Promise<void> }> {
  const name = `marmeon_live_${process.env.MARMEON_TEST_DATABASE_TAG ?? 'untagged'}_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = databaseConnections({ driver: 'pgsql', url: PGSQL_URL! });
  await sql`create database ${sql.id(name)}`.execute(admin.get());
  const url = new URL(PGSQL_URL!);
  url.pathname = `/${name}`;
  const target: LiveTarget = { driver: 'pgsql', url: url.href };
  const connections = connectionsAt(target);
  await migrate(connections);
  await connections.destroy();
  return {
    target,
    drop: async () => {
      await sql`drop database ${sql.id(name)} with (force)`.execute(admin.get());
      await admin.destroy();
    },
  };
}

/** A backend on the infrastructure connection of `connections`, like the provider builds it. */
export function openBackend(connections: Connections, driver: 'sqlite' | 'pgsql', options: Partial<DatabaseLiveOptions> = {}): DatabaseLiveBackend {
  return new DatabaseLiveBackend(async () => ({ db: connections.infrastructure('default'), driver }), { pollMs: 500, logger: silent, redactor: new Redactor(), ...options });
}

/** Every row of the table, oldest first. */
export async function rows(connections: Connections): Promise<{ id: number; channel: string | null; message: string }[]> {
  const result = await sql<{ id: number | string; channel: string | null; message: string }>`select id, channel, message from live_hints order by id`.execute(connections.get());
  return result.rows.map((row) => ({ ...row, id: Number(row.id) }));
}

/** A logger that keeps what it is told. */
export function recorder(): { logger: Logger; logs: { level: string; message: string }[] } {
  const logs: { level: string; message: string }[] = [];
  const logger: Logger = {
    debug() {},
    info: (message) => void logs.push({ level: 'info', message }),
    warn: (message) => void logs.push({ level: 'warn', message }),
    error: (message) => void logs.push({ level: 'error', message }),
    child: () => logger,
  };
  return { logger, logs };
}
