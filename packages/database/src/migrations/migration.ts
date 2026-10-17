import type { Resolver } from '@marmeon/core';
import type { Schema } from '../schema/schema.ts';

/**
 * The database connection a migration runs on: a connection's name, or a function that reads it from the app's
 * configuration when the migration runs — `(c) => c.make(CacheConfig).connection` — so the table lands where the code
 * that uses it looks (e.g. the cache's own SQLite file).
 */
export type MigrationConnection = string | ((container: Resolver) => string);

/**
 * A migration: `up` builds the plan that changes the schema, `down` the plan that undoes it (optional — without it, rollback stops
 * there). Both only add steps to the `schema` and run nothing, so they are synchronous; data changes are steps of their own,
 * `schema.data(async (db) => …)`.
 */
export interface Migration {
  /**
   * Another connection than `default`. The migrator keeps its record of the migration on
   * `default`, and the table's owner and secret columns on the connection the table is on.
   */
  readonly connection?: MigrationConnection;
  up(schema: Schema): void;
  down?(schema: Schema): void;
}

/** `never` for a function that returns a promise, so an `async` `up` or `down` is a type error. */
type Synchronous<F> = F extends (...args: never[]) => infer R ? ([R] extends [never] ? F : [R] extends [PromiseLike<unknown>] ? never : F) : F;

/**
 * The default export of a migration file in a module's `migrations/` directory, named
 * `YYYY_MM_DD_HHMMSS_what_it_does.ts`. `up` and `down` must not be `async`. See `docs/migrations.md#migration-structure`.
 */
export function defineMigration<Up extends Migration['up'], Down extends Migration['down']>(migration: {
  readonly connection?: MigrationConnection;
  up: Up & Synchronous<Up>;
  down?: Down & Synchronous<Down>;
}): Migration {
  return migration;
}
