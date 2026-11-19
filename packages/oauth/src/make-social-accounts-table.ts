import { Application } from '@marmeon/core';
import type { CommandInput } from 'marmeon';

/** The file the command copies. */
export const SOCIAL_ACCOUNTS_MIGRATION = new URL('../stubs/migrations/0001_01_01_000000_create_social_accounts_table.ts', import.meta.url);

/**
 * `marmeon make:social-accounts-table [--module=system]`: writes the migration of the `social_accounts` table into an app module,
 * with a fresh timestamp, so it sorts after the migration of `users`. Then `marmeon migrate`. It does what `marmeon publish
 * @marmeon/oauth` does for a package installed from the registry, and it also works for a linked one. See docs/oauth.md#storing-tokens.
 */
export class MakeSocialAccountsTableCommand {
  static command = 'make:social-accounts-table';
  static description = 'Create the migration for the linked provider accounts (social_accounts)';
  static usage = '[--module=system]';
  static options = { module: { type: 'string', short: 'm' } } as const;

  readonly #app: Application;

  constructor(app: Application) {
    this.#app = app;
  }

  async handle(input: CommandInput): Promise<number> {
    const [{ publishOwnMigrations }, { OAuthServiceProvider }] = await Promise.all([import('@marmeon/database/internal'), import('./provider.ts')]);
    return publishOwnMigrations(input, new URL('../', import.meta.url), OAuthServiceProvider, this.#app.providers);
  }
}
