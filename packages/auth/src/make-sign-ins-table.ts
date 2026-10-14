import { readFileSync } from 'node:fs';
import type { CommandInput } from 'marmeon';

/** The file the command copies. */
export const SIGN_INS_MIGRATION = new URL('../stubs/migrations/create_sign_ins_table.ts', import.meta.url);

/**
 * `marmeon make:sign-ins-table [--module=system]`: writes the migration of the `sign_ins` table that `DatabaseSignIns` uses
 * into an app module. Then `marmeon migrate`.
 */
export class MakeSignInsTableCommand {
  static command = 'make:sign-ins-table';
  static description = 'Create the migration for the sign-ins list (sign_ins)';
  static usage = '[--module=system]';
  static options = { module: { type: 'string', short: 'm' } } as const;

  async handle(input: CommandInput): Promise<number> {
    const { publishMigration } = await import('@marmeon/database');
    return publishMigration(input, { name: 'create_sign_ins_table', table: 'sign_ins', contents: readFileSync(SIGN_INS_MIGRATION, 'utf8') });
  }
}
