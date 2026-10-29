import { ConsoleLogger, type Application, type Logger, type ModuleDefinition } from '@marmeon/core';
import { sql, type Kysely } from 'kysely';
import { Connections } from '../connections.ts';
import type { ConnectionOptions } from '../config.ts';
import { createMigrationsTable } from '../migration-state.ts';
import { migratorConnection } from '../migrator-connection.ts';
import { Migrator } from '../migrations/migrator.ts';
import { TypeGenerator } from '../types-gen/generator.ts';

/** Postgres runs when `MARMEON_TEST_PGSQL_URL` is set (`docker compose up -d`, then `pnpm test:pgsql`). */
export const PGSQL_URL = process.env.MARMEON_TEST_PGSQL_URL;
export const drivers = PGSQL_URL ? (['sqlite', 'pgsql'] as const) : (['sqlite'] as const);
export type TestDriver = (typeof drivers)[number];

export const silent: Logger = Object.assign(new ConsoleLogger(), { debug() {}, info() {} });

/** A fresh database per suite: SQLite in memory, or a new Postgres database dropped by `drop()`. */
export async function freshDatabase(driver: 'sqlite' | 'pgsql', { managed = true }: { managed?: boolean } = {}): Promise<{ options: ConnectionOptions; drop: () => Promise<void> }> {
  // `managed: false` for a test that builds its tables itself instead of migrating them: no record of migrations, and none is asked for.
  const unmanaged = managed ? {} : { managed: false };
  if (driver === 'sqlite') return { options: { driver: 'sqlite', database: ':memory:', ...unmanaged }, drop: async () => {} };
  const name = `marmeon_test_${process.env.MARMEON_TEST_DATABASE_TAG ?? 'untagged'}_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = new Connections({ connections: { default: { driver: 'pgsql', url: PGSQL_URL! } }, root: '/', logger: silent });
  await sql`create database ${sql.id(name)}`.execute(admin.get());
  const url = new URL(PGSQL_URL!);
  url.pathname = `/${name}`;
  return {
    options: { driver: 'pgsql', url: url.href, poolMax: 3, ...unmanaged },
    drop: async () => {
      await sql`drop database ${sql.id(name)} with (force)`.execute(admin.get());
      await admin.destroy();
    },
  };
}

/** The three tables Marmeon 0.3 kept beside `migrations`, as 0.3 created them — empty, on `db`. Nothing of this release reads or writes them. */
export async function createLegacyTables(db: Kysely<any>): Promise<void> {
  await db.schema.createTable('table_owners').addColumn('table_name', 'varchar(255)', (c) => c.primaryKey()).addColumn('module', 'varchar(255)', (c) => c.notNull()).execute();
  await db.schema
    .createTable('secret_columns')
    .addColumn('table_name', 'varchar(255)', (c) => c.notNull())
    .addColumn('column_name', 'varchar(255)', (c) => c.notNull())
    .addPrimaryKeyConstraint('secret_columns_pkey', ['table_name', 'column_name'])
    .execute();
  await db.schema
    .createTable('schema_markers')
    .addColumn('table_name', 'varchar(255)', (c) => c.notNull())
    .addColumn('column_name', 'varchar(255)', (c) => c.notNull().defaultTo(''))
    .addColumn('marker', 'varchar(32)', (c) => c.notNull())
    .addColumn('value', 'varchar(255)')
    .addPrimaryKeyConstraint('schema_markers_pkey', ['table_name', 'column_name', 'marker'])
    .execute();
}

/** A `Connections` on a fresh database; `close()` destroys it and drops the database. */
export async function freshConnections(
  driver: 'sqlite' | 'pgsql',
  options: { managed?: boolean; record?: boolean; now?: () => number } = {},
): Promise<{ connections: Connections; close: () => Promise<void> }> {
  const fresh = await freshDatabase(driver, options);
  const connections = new Connections({ connections: { default: fresh.options }, root: '/', logger: silent, ...(options.now ? { now: options.now } : {}) });
  // The empty record of migrations a first `migrate` writes: a test that builds its tables itself runs the default path.
  if (options.managed !== false && options.record !== false) await createMigrationsTable(migratorConnection(connections), connections.options().driver);
  return {
    connections,
    close: async () => {
      await connections.destroy();
      await fresh.drop();
    },
  };
}

/**
 * An app that is only its modules and its root: where a process of it finds the migrations its connections take their schema from.
 * `root` is where the projection is cached (`.marmeon/schema.json`) — a temporary directory, never `/`. When the modules are the
 * repository's fixtures it comes from `workspaceTempDir()`: their migrations have to lie in the app or its workspace.
 */
export function appOf(modules: ModuleDefinition[], root: string): Application {
  return { modules, root, container: { has: () => false } } as unknown as Application;
}

/**
 * Leaves the schema metadata of `connections` not fresh, as it is for the first query of a process: queries are not compiled with it
 * but resolved on the connection that runs them. The function it returns makes it fresh again.
 */
export function unfresh(connections: Connections): () => void {
  const owner = {};
  const metadata = connections.metadata();
  metadata.during(owner, connections.projection());
  return () => metadata.after(owner);
}

/** A `TypeGenerator` for the modules of `app`: it reads migration files and the driver, so no database is opened. */
export function typeGenerator(app: Application, driver: 'sqlite' | 'pgsql' = 'sqlite'): TypeGenerator {
  const connections = { options: () => ({ driver }) } as unknown as Connections;
  return new TypeGenerator(app, connections, new Migrator(app, connections));
}
