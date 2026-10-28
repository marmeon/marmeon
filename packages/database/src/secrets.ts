import { AliasNode, FunctionNode, IdentifierNode, sql } from 'kysely';
import { SECRET } from './placeholders.ts';
import type { AliasedExpression, ColumnType, Expression, ExpressionBuilder, SqlBool, UpdateType } from 'kysely';

/**
 * A column its migration marked `.secret()` (a password hash, a 2FA secret): written like any
 * column, but never read by accident. Kysely's `Selectable` — and so `Row<'users'>` — leaves it out,
 * and at runtime the connection spells `selectAll()` and `returningAll()` out without it and refuses
 * any other read of it unless {@link secret} asks. Reading it takes {@link secret}.
 */
export type Secret<T> = ColumnType<never, T, T>;

type IsSecret<C> = [C] extends [ColumnType<infer S, any, infer U>] ? ([S] extends [never] ? ([U] extends [never] ? false : true) : false) : false;

/** The secret columns of the tables in scope: `'password'` or `'users.password'`. */
export type SecretReference<DB, TB extends keyof DB> = {
  [T in TB & string]: { [C in keyof DB[T] & string]: IsSecret<DB[T][C]> extends true ? C | `${T}.${C}` : never }[keyof DB[T] & string];
}[TB & string];

type SecretName<R extends string> = R extends `${string}.${infer C}` ? C : R;
type SecretValue<DB, TB extends keyof DB, R extends string> = R extends `${infer T}.${infer C}`
  ? T extends TB ? (C extends keyof DB[T] ? UpdateType<DB[T][C]> : never) : never
  : { [T in TB]: R extends keyof DB[T] ? UpdateType<DB[T][R]> : never }[TB];

/**
 * Reads a secret column — deliberately, where it is needed (checking a password at login):
 *
 * ```ts
 * this.query().select((eb) => ['id', secret(eb, 'password')]).where('email', '=', email)
 * ```
 */
export function secret<DB, TB extends keyof DB, R extends SecretReference<DB, TB>>(
  eb: ExpressionBuilder<DB, TB>,
  column: R,
): AliasedExpression<SecretValue<DB, TB, R>, SecretName<R>> {
  const name = column.slice(column.lastIndexOf('.') + 1);
  // Marked as asked for: the connection lets this selection — and only it — read the secret column.
  const marked = FunctionNode.create(SECRET, [eb.ref(column as never).toOperationNode()]);
  return { expression: eb.ref(column as never), alias: name, toOperationNode: () => AliasNode.create(marked, IdentifierNode.create(name)) } as never;
}

/** The shortest value {@link secretEquals} compares: a hex SHA-256 is 64 characters, a base64url one 43. */
const LEAST_HASH_LENGTH = 32;

/**
 * Compares a secret column with a value in `where()`, for a token looked up by the hash a unique index holds. Only for the hash
 * of a secret with at least 128 random bits: the answer says whether the value matches, so a short or guessable secret
 * (a PIN, a password) must be checked in code. Throws a `TypeError` for a value under 32 characters, without naming it. See
 * `docs/queries.md#finding-a-row-by-a-hashed-secret`.
 *
 * ```ts
 * this.query().selectAll().where((eb) => secretEquals(eb, 'token_hash', hashLinkToken(presented)))
 * ```
 */
export function secretEquals<DB, TB extends keyof DB, R extends SecretReference<DB, TB>>(
  eb: ExpressionBuilder<DB, TB>,
  column: R,
  value: SecretValue<DB, TB, R>,
): Expression<SqlBool> {
  if (typeof value !== 'string' || value.length < LEAST_HASH_LENGTH) {
    throw new TypeError('secretEquals(): compare the hash of a random token (at least 32 characters) — a short secret can be guessed; check it in code.');
  }
  return sql<SqlBool>`${eb.ref(column as never)} = ${value}`;
}
