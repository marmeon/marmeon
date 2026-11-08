import { Application } from '@marmeon/core';
import type { CommandInput } from 'marmeon';

/** The migration the command copies — a real file, so the backend tests run exactly what apps get. */
export const LIVE_HINTS_MIGRATION = new URL('../../stubs/migrations/0001_01_01_000000_create_live_hints_table.ts', import.meta.url);

/**
 * `marmeon make:live-table [--module=system]`: writes the migration of the `database` live driver's table into an app module
 * (the table is the app's, `db:types` sees it like any other). Then `marmeon migrate`.
 */
export class MakeLiveTableCommand {
  static command = 'make:live-table';
  static description = 'Create the migration for the database live driver (live_hints)';
  static usage = '[--module=system]';
  static options = { module: { type: 'string', short: 'm' } } as const;

  readonly #app: Application;

  constructor(app: Application) {
    this.#app = app;
  }

  async handle(input: CommandInput): Promise<number> {
    const [{ publishOwnMigrations }, { LiveServiceProvider }] = await Promise.all([import('@marmeon/database/internal'), import('../index.ts')]);
    return publishOwnMigrations(input, new URL('../../', import.meta.url), LiveServiceProvider, this.#app.providers);
  }
}
