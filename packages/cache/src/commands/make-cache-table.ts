import { readFileSync } from 'node:fs';
import type { CommandInput } from 'marmeon';

/** The migration the command copies — a real file, so the store tests run exactly what apps get. */
export const CACHE_MIGRATION = new URL('../../stubs/migrations/create_cache_table.ts', import.meta.url);

/** The migration `make:upgrade-migrations` writes for apps whose tables still have the old names. */
export const RENAME_MIGRATION = new URL('../../stubs/migrations/rename_cache_tables_to_marmeon.ts', import.meta.url);

/**
 * `marmeon make:cache-table [--module=system]`: writes the migration of the `database` cache driver's tables into an app
 * module (the tables are the app's, `db:types` sees them like any other). Then `marmeon migrate`.
 */
export class MakeCacheTableCommand {
  static command = 'make:cache-table';
  static description = 'Create the migration for the database cache driver (marmeon_cache, marmeon_cache_locks)';
  static usage = '[--module=system]';
  static options = { module: { type: 'string', short: 'm' } } as const;

  async handle(input: CommandInput): Promise<number> {
    const { publishMigration } = await import('@marmeon/database/internal');
    return publishMigration(input, { name: 'create_cache_table', table: 'marmeon_cache', contents: readFileSync(CACHE_MIGRATION, 'utf8') });
  }
}
