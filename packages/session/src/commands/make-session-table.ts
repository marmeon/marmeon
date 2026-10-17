import { readFileSync } from 'node:fs';
import type { CommandInput } from 'marmeon';

/** The migration the command copies — a real file, so the store tests run exactly what apps get. */
export const SESSIONS_MIGRATION = new URL('../../stubs/migrations/create_sessions_table.ts', import.meta.url);

/** The migration `make:upgrade-migrations` writes for apps whose table still has the old name. */
export const RENAME_MIGRATION = new URL('../../stubs/migrations/rename_sessions_table_to_marmeon.ts', import.meta.url);

/**
 * `marmeon make:session-table [--module=system]`: writes the migration of the `database` session driver's table into an app
 * module (the table is the app's, `db:types` sees it like any other). Then `marmeon migrate`.
 */
export class MakeSessionTableCommand {
  static command = 'make:session-table';
  static description = 'Create the migration for the database session driver (marmeon_sessions)';
  static usage = '[--module=system]';
  static options = { module: { type: 'string', short: 'm' } } as const;

  async handle(input: CommandInput): Promise<number> {
    const { publishMigration } = await import('@marmeon/database/internal');
    return publishMigration(input, { name: 'create_sessions_table', table: 'marmeon_sessions', contents: readFileSync(SESSIONS_MIGRATION, 'utf8') });
  }
}
