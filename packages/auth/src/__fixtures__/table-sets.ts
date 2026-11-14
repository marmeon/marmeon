import { secret, type Connections } from '@marmeon/database';
import { expect } from 'vitest';
import { drivers } from './databases.ts';

/** The tables of one set of auth stores: the app's (the defaults) or a second sign-in circle's, named by prefix. */
export interface TableSet {
  readonly name: 'app' | 'office';
  readonly signIns: string;
  readonly passwordResets: string;
  readonly twoFactor: string;
  readonly recoveryCodes: string;
  readonly passkeys: string;
}

export const APP_TABLES: TableSet = { name: 'app', signIns: 'sign_ins', passwordResets: 'password_reset_tokens', twoFactor: 'two_factor_authentications', recoveryCodes: 'two_factor_recovery_codes', passkeys: 'passkeys' };
export const OFFICE_TABLES: TableSet = { name: 'office', signIns: 'office_sign_ins', passwordResets: 'office_password_reset_tokens', twoFactor: 'office_two_factor_authentications', recoveryCodes: 'office_two_factor_recovery_codes', passkeys: 'office_passkeys' };

/** `describe.each` rows: every driver with each set as the one under test. The suite reads the sets with {@link setsOf}. */
export const setCases = drivers.flatMap((driver) => (['app', 'office'] as const).map((set) => [driver, set] as const));

export function setsOf(name: 'app' | 'office'): { readonly own: TableSet; readonly other: TableSet } {
  return name === 'app' ? { own: APP_TABLES, other: OFFICE_TABLES } : { own: OFFICE_TABLES, other: APP_TABLES };
}

/** The constructor option for the tables of a set; `{}` for the app's, so the defaults are what runs. */
export const optionsFor = (set: TableSet) => ({
  signIns: set.name === 'app' ? {} : { table: set.signIns },
  passwordResets: set.name === 'app' ? {} : { table: set.passwordResets },
  twoFactor: set.name === 'app' ? {} : { tables: { twoFactor: set.twoFactor, recoveryCodes: set.recoveryCodes } },
  passkeys: set.name === 'app' ? {} : { tables: { passkeys: set.passkeys, twoFactor: set.twoFactor, recoveryCodes: set.recoveryCodes } },
});

/** The secret columns of each auth table, which `selectAll()` leaves out. */
const SECRETS: Record<string, readonly string[]> = {
  sign_ins: ['remember_selector', 'remember_validator_hash', 'remember_previous_validator_hash'],
  password_reset_tokens: ['token_hash'],
  two_factor_authentications: ['secret'],
  two_factor_recovery_codes: ['code_hash'],
  passkeys: [],
};

/** Every row of these tables, secret columns included, to compare before and after a test: the other set must come out of it unchanged. */
export async function snapshot(connections: Connections, tables: readonly string[]): Promise<string> {
  const out: Record<string, unknown[]> = {};
  for (const table of tables) {
    const secrets = SECRETS[table.replace(/^office_/, '')] ?? [];
    const order = table.endsWith('password_reset_tokens') ? 'email' : 'id';
    const rows = await connections
      .get<any>()
      .selectFrom(table)
      .selectAll()
      .select((eb: any) => secrets.map((column) => secret(eb, column as never)))
      .orderBy(order)
      .execute();
    out[table] = rows as unknown[];
  }
  return JSON.stringify(out, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
}

export function expectUnchanged(before: string, after: string): void {
  expect(after, 'the other set of tables changed').toBe(before);
}
