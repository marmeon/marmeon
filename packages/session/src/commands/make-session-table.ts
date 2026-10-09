import { readFileSync } from 'node:fs';
import type { CommandInput } from 'marmeon';

/** The migration the command copies — a real file, so the store tests run exactly what apps get. */
export const SESSIONS_MIGRATION = new URL('../../stubs/migrations/create_sessions_table.ts', import.meta.url);
/** The migration `--upgrade` copies: the table of an app made before hashed ids and versions (E144, E145), made anew. */
export const SESSIONS_UPGRADE_MIGRATION = new URL('../../stubs/migrations/upgrade_sessions_table.ts', import.meta.url);

/**
 * `marmeon make:session-table [--module=system] [--upgrade]`: writes the migration of the `database` session driver's table into
 * an app module (E96 — the table is the app's, `db:types` sees it like any other). `--upgrade` writes the one an existing table
 * needs for hashed session ids and versions (W8). Then `marmeon migrate`.
 */
export class MakeSessionTableCommand {
  static command = 'make:session-table';
  static description = 'Create the migration for the database session driver (sessions) — --upgrade for a table made before Marmeon 0.1.0';
  static usage = '[--module=system] [--upgrade]';
  static options = { module: { type: 'string', short: 'm' }, upgrade: { type: 'boolean' } } as const;

  async handle(input: CommandInput): Promise<number> {
    const { publishMigration } = await import('@marmeon/database');
    const upgrade = input.options.upgrade === true;
    return publishMigration(input, {
      name: upgrade ? 'upgrade_sessions_table' : 'create_sessions_table',
      table: 'sessions',
      contents: readFileSync(upgrade ? SESSIONS_UPGRADE_MIGRATION : SESSIONS_MIGRATION, 'utf8'),
    });
  }
}
