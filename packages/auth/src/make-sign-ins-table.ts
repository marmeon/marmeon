import { Application } from '@marmeon/core';
import type { CommandInput } from 'marmeon';

/** The file the command copies. */
export const SIGN_INS_MIGRATION = new URL('../stubs/migrations/0001_01_01_000000_create_sign_ins_table.ts', import.meta.url);

/**
 * `marmeon make:sign-ins-table [--module=system]`: writes the migration of the `sign_ins` table that `DatabaseSignIns` uses
 * into an app module. Then `marmeon migrate`.
 */
export class MakeSignInsTableCommand {
  static command = 'make:sign-ins-table';
  static description = 'Create the migration for the sign-ins list (sign_ins)';
  static usage = '[--module=system]';
  static options = { module: { type: 'string', short: 'm' } } as const;

  readonly #app: Application;

  constructor(app: Application) {
    this.#app = app;
  }

  async handle(input: CommandInput): Promise<number> {
    const [{ publishOwnMigrations }, { AuthServiceProvider }] = await Promise.all([import('@marmeon/database/internal'), import('./index.ts')]);
    return publishOwnMigrations(input, new URL('../', import.meta.url), AuthServiceProvider, this.#app.providers);
  }
}
