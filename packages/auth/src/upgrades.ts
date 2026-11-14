import type { Container, Key } from '@marmeon/core';
import { Connections, type SchemaRequirements } from '@marmeon/database';
import { DatabaseEmailChanges, EMAIL_CHANGE_COLUMNS, EMAIL_CHANGES_TABLE, EmailChangeStore } from './email-changes.ts';
import { DatabasePasswordResetTokens, PASSWORD_RESET_COLUMNS, PasswordResetTokenStore } from './password-reset.ts';
import { DatabaseSignIns, SIGN_INS_COLUMNS, SignInStore } from './sign-ins.ts';
import { ACCESS_TOKEN_COLUMNS, ACCESS_TOKEN_TABLE, AccessTokenStore, DatabaseAccessTokens } from './tokens.ts';
import { factorSources, TwoFactorState } from './two-factor/state.ts';
import { RECOVERY_CODE_COLUMNS, TWO_FACTOR_COLUMNS, TwoFactorStore } from './two-factor/store.ts';
import { assertSignInFinder, UserProvider } from './user.ts';

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

/** Stops the boot of an app whose `UserProvider` still has the old name of `findForSignIn()`, instead of the first sign-in or a queued job. */
export function requireSignInFinder(container: Container): void {
  let users: UserProvider;
  try {
    users = container.make(UserProvider);
  } catch {
    return;
  }
  assertSignInFinder(users);
}

/** The tables of the stores to wait for, by store: an entry is a store in use, its value the table it keeps its rows in. */
export interface StoreTables {
  readonly signIns?: string;
  readonly passwordResets?: string;
  readonly emailChanges?: string;
  readonly accessTokens?: string;
  /** The TOTP factor and its recovery codes, which the factor cannot be used without: both tables or none. */
  readonly twoFactor?: { readonly factor: string; readonly recoveryCodes: string };
}

/**
 * Makes `/up/ready` red until each of these tables has every column its store reads and writes. Package-internal. The passkeys' table is
 * not here: the main entry must not reach the `passkeys` subpath, so its provider names it.
 */
export function requireStoreTables(requirements: SchemaRequirements, { connection, tables }: { readonly connection: string; readonly tables: StoreTables }): void {
  const need = (table: string | undefined, columns: readonly string[], secrets: readonly string[]) => {
    if (table !== undefined) requirements.require({ connection, table, columns, secrets });
  };
  need(tables.passwordResets, PASSWORD_RESET_COLUMNS, ['token_hash']);
  need(tables.emailChanges, EMAIL_CHANGE_COLUMNS, ['session_key', 'token_hash']);
  need(tables.accessTokens, ACCESS_TOKEN_COLUMNS, ['token_hash']);
  need(tables.signIns, SIGN_INS_COLUMNS, ['remember_selector', 'remember_validator_hash', 'remember_previous_validator_hash']);
  need(tables.twoFactor?.factor, TWO_FACTOR_COLUMNS, ['secret']);
  need(tables.twoFactor?.recoveryCodes, RECOVERY_CODE_COLUMNS, ['code_hash']);
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
  // A store that cannot be built here (it depends on something scoped, say) is the app's own, not ours.
  const bound = <T>(key: Key<T>): T | undefined => {
    try {
      return container.has(key) ? container.make(key) : undefined;
    } catch {
      return undefined;
    }
  };

  // The authenticator app is a source of the state the app bound, alone or joined with the passkeys.
  const state = bound(TwoFactorState);
  const totp = state === undefined ? undefined : factorSources(state).find((source): source is TwoFactorStore => source instanceof TwoFactorStore);
  const passwordResets = bound(PasswordResetTokenStore);
  const signIns = bound(SignInStore);
  // The tables the bound stores were given, not the defaults: a store on other tables is waited for there.
  requireStoreTables(requirements, {
    connection: 'default',
    tables: {
      passwordResets: passwordResets instanceof DatabasePasswordResetTokens ? passwordResets.table : undefined,
      emailChanges: bound(EmailChangeStore) instanceof DatabaseEmailChanges ? EMAIL_CHANGES_TABLE : undefined,
      accessTokens: bound(AccessTokenStore) instanceof DatabaseAccessTokens ? ACCESS_TOKEN_TABLE : undefined,
      signIns: signIns instanceof DatabaseSignIns ? signIns.table : undefined,
      twoFactor: totp?.tables,
    },
  });
}
