import type { Schema } from '../schema/schema.ts';

/** A migration: `up` changes the schema, `down` undoes it (optional — without it, rollback stops there). */
export interface Migration {
  up(schema: Schema): void | Promise<void>;
  down?(schema: Schema): void | Promise<void>;
}

/**
 * The default export of a migration file in a module's `migrations/` directory, named
 * `YYYY_MM_DD_HHMMSS_what_it_does.ts`:
 *
 * ```ts
 * export default defineMigration({
 *   up: (schema) => schema.create('users', (table) => { table.id(); table.string('email').unique(); table.timestamps(); }),
 *   down: (schema) => schema.drop('users'),
 * });
 * ```
 */
export function defineMigration(migration: Migration): Migration {
  return migration;
}
