import { readFileSync } from 'node:fs';
import type { Container, Key } from '@marmeon/core';
import { Connections } from '@marmeon/database';
import { AuthConfig } from './config.ts';
import { DatabasePasswordResetTokens, PASSWORD_RESET_COLUMNS, PASSWORD_RESET_TABLE, PasswordResetTokenStore } from './password-reset.ts';
import { DatabaseRememberTokens, REMEMBER_COLUMNS, REMEMBER_TABLE, RememberTokenStore } from './remember.ts';
import { DatabaseSignIns, SIGN_INS_COLUMNS, SIGN_INS_TABLE, SignInStore } from './sign-ins.ts';
import { ACCESS_TOKEN_COLUMNS, ACCESS_TOKEN_TABLE, AccessTokenStore, DatabaseAccessTokens } from './tokens.ts';
import { factorSources, TwoFactorState } from './two-factor/state.ts';
import { RECOVERY_CODE_COLUMNS, RECOVERY_CODES_TABLE, TWO_FACTOR_COLUMNS, TWO_FACTOR_TABLE, TwoFactorStore } from './two-factor/store.ts';
import { UserProvider } from './user.ts';

/** The migration `make:upgrade-migrations` writes for apps whose auth tables still have the old names. */
export const AUTH_RENAME_MIGRATION = new URL('../stubs/migrations/rename_auth_tables_to_marmeon.ts', import.meta.url);

/** The migration `make:upgrade-migrations` writes for apps whose sign-ins table still has the old name. */
export const SIGN_INS_RENAME_MIGRATION = new URL('../stubs/migrations/rename_sign_ins_table_to_marmeon.ts', import.meta.url);

/** The renames of the auth tables: the starter kit's tables as one set, and the sign-ins list, which `make:sign-ins-table` writes on its own. */
export function authMigrationUpgrades() {
  return [
    {
      set: 'auth',
      revision: 2,
      name: 'rename_auth_tables_to_marmeon',
      createdBy: [
        'create_remember_tokens_table',
        'create_password_reset_tokens_table',
        'create_personal_access_tokens_table',
        'create_two_factor_tables',
        'create_two_factor_authentications_table',
        'create_two_factor_recovery_codes_table',
        'create_passkeys_table',
      ],
      contents: readFileSync(AUTH_RENAME_MIGRATION, 'utf8'),
    },
    {
      set: 'sign-ins',
      revision: 2,
      name: 'rename_sign_ins_table_to_marmeon',
      createdBy: ['create_sign_ins_table'],
      contents: readFileSync(SIGN_INS_RENAME_MIGRATION, 'utf8'),
    },
  ];
}

/** Thrown by the `UserProvider` nothing replaced: authentication is not set up. */
export class UserProviderNotBound extends Error {
  override readonly name = 'UserProviderNotBound';
}

/** Whether the app bound a `UserProvider` of its own. What else a bound one throws when it is built is no concern of this check. */
function authenticationIsSetUp(container: Container): boolean {
  try {
    container.make(UserProvider);
    return true;
  } catch (error) {
    return !(error instanceof UserProviderNotBound);
  }
}

/**
 * Makes `/up/ready` red until the tables of the stores the app uses have their new names and every column the stores read and write.
 * A table is waited for only where its store is the database one: a store of the app's own keeps its own table, and an app that
 * has set up no authentication (no `UserProvider`) uses none of them.
 */
export async function requireAuthTables(container: Container): Promise<void> {
  if (!container.has(Connections) || !authenticationIsSetUp(container)) return;
  const { SchemaRequirements } = await import('@marmeon/database/internal');
  const requirements = container.make(SchemaRequirements);
  const need = (table: string, columns: readonly string[], secrets: readonly string[], set: string) => requirements.require({ connection: 'default', table, columns, secrets, set });
  // A store that cannot be built here (it depends on something scoped, say) is the app's own, not ours.
  const bound = <T>(key: Key<T>): T | undefined => {
    try {
      return container.has(key) ? container.make(key) : undefined;
    } catch {
      return undefined;
    }
  };

  if (container.make(AuthConfig).remember && bound(RememberTokenStore) instanceof DatabaseRememberTokens) need(REMEMBER_TABLE, REMEMBER_COLUMNS, ['validator_hash', 'previous_validator_hash'], 'auth');
  if (bound(PasswordResetTokenStore) instanceof DatabasePasswordResetTokens) need(PASSWORD_RESET_TABLE, PASSWORD_RESET_COLUMNS, ['token_hash'], 'auth');
  if (bound(AccessTokenStore) instanceof DatabaseAccessTokens) need(ACCESS_TOKEN_TABLE, ACCESS_TOKEN_COLUMNS, ['token_hash'], 'auth');
  if (bound(SignInStore) instanceof DatabaseSignIns) need(SIGN_INS_TABLE, SIGN_INS_COLUMNS, [], 'sign-ins');
  // The authenticator app is a source of the state the app bound, alone or joined with the passkeys.
  const state = bound(TwoFactorState);
  if (state && factorSources(state).some((source) => source instanceof TwoFactorStore)) {
    need(TWO_FACTOR_TABLE, TWO_FACTOR_COLUMNS, ['secret'], 'auth');
    need(RECOVERY_CODES_TABLE, RECOVERY_CODE_COLUMNS, ['code_hash'], 'auth');
  }
}
