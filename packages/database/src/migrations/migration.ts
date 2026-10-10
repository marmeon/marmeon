import type { Resolver } from '@marmeon/core';
import type { Schema } from '../schema/schema.ts';

/**
 * The database connection a migration runs on: a connection's name, or a function that reads it from the app's
 * configuration when the migration runs — `(c) => c.make(CacheConfig).connection` — so the table lands where the code
 * that uses it looks (e.g. the cache's own SQLite file).
 */
export type MigrationConnection = string | ((container: Resolver) => string);

/** A migration: `up` changes the schema, `down` undoes it (optional — without it, rollback stops there). */
export interface Migration {
  /**
   * Another connection than `default` (Laravel's `$connection`). The migrator keeps its record of the migration on
   * `default`, and the table's owner and secret columns on the connection the table is on.
   */
  readonly connection?: MigrationConnection;
  up(schema: Schema): void | Promise<void>;
  down?(schema: Schema): void | Promise<void>;
}

/**
 * The default export of a migration file in a module's `migrations/` directory, named
 * `YYYY_MM_DD_HHMMSS_what_it_does.ts`. See `docs/migrations.md#migration-structure`.
 */
export function defineMigration(migration: Migration): Migration {
  return migration;
}
