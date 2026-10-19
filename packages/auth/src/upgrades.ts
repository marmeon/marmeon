import type { Container, Key } from '@marmeon/core';
import { Connections } from '@marmeon/database';
import { DatabaseEmailChanges, EMAIL_CHANGE_COLUMNS, EMAIL_CHANGES_TABLE, EmailChangeStore } from './email-changes.ts';
import { DatabasePasswordResetTokens, PASSWORD_RESET_COLUMNS, PASSWORD_RESET_TABLE, PasswordResetTokenStore } from './password-reset.ts';
import { DatabaseSignIns, SIGN_INS_COLUMNS, SIGN_INS_TABLE, SignInStore } from './sign-ins.ts';
import { ACCESS_TOKEN_COLUMNS, ACCESS_TOKEN_TABLE, AccessTokenStore, DatabaseAccessTokens } from './tokens.ts';
import { factorSources, TwoFactorState } from './two-factor/state.ts';
import { RECOVERY_CODE_COLUMNS, RECOVERY_CODES_TABLE, TWO_FACTOR_COLUMNS, TWO_FACTOR_TABLE, TwoFactorStore } from './two-factor/store.ts';
import { UserProvider } from './user.ts';

/** Thrown by the `UserProvider` nothing replaced: authentication is not set up. */
export class UserProviderNotBound extends Error {
  override readonly name = 'UserProviderNotBound';
}

/** Whether the app bound a `UserProvider` of its own. What else a bound one throws when it is built is no concern of this check. */
export function authenticationIsSetUp(container: Container): boolean {
  try {
    container.make(UserProvider);
    return true;
  } catch (error) {
    return !(error instanceof UserProviderNotBound);
  }
}

/**
 * Makes `/up/ready` red until the tables of the stores the app uses have every column the stores read and write.
 * A table is waited for only where its store is the database one: a store of the app's own keeps its own table, and an app that
 * has set up no authentication (no `UserProvider`) uses none of them.
 */
export async function requireAuthTables(container: Container): Promise<void> {
  if (!container.has(Connections) || !authenticationIsSetUp(container)) return;
  const { SchemaRequirements } = await import('@marmeon/database');
  const requirements = container.make(SchemaRequirements);
  const need = (table: string, columns: readonly string[], secrets: readonly string[]) => requirements.require({ connection: 'default', table, columns, secrets });
  // A store that cannot be built here (it depends on something scoped, say) is the app's own, not ours.
  const bound = <T>(key: Key<T>): T | undefined => {
    try {
      return container.has(key) ? container.make(key) : undefined;
    } catch {
      return undefined;
    }
  };

  if (bound(PasswordResetTokenStore) instanceof DatabasePasswordResetTokens) need(PASSWORD_RESET_TABLE, PASSWORD_RESET_COLUMNS, ['token_hash']);
  if (bound(EmailChangeStore) instanceof DatabaseEmailChanges) need(EMAIL_CHANGES_TABLE, EMAIL_CHANGE_COLUMNS, ['session_key', 'token_hash']);
  if (bound(AccessTokenStore) instanceof DatabaseAccessTokens) need(ACCESS_TOKEN_TABLE, ACCESS_TOKEN_COLUMNS, ['token_hash']);
  if (bound(SignInStore) instanceof DatabaseSignIns) need(SIGN_INS_TABLE, SIGN_INS_COLUMNS, ['remember_selector', 'remember_validator_hash', 'remember_previous_validator_hash']);
  // The authenticator app is a source of the state the app bound, alone or joined with the passkeys.
  const state = bound(TwoFactorState);
  if (state && factorSources(state).some((source) => source instanceof TwoFactorStore)) {
    need(TWO_FACTOR_TABLE, TWO_FACTOR_COLUMNS, ['secret']);
    need(RECOVERY_CODES_TABLE, RECOVERY_CODE_COLUMNS, ['code_hash']);
  }
}
