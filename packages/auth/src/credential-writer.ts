import type { Connection } from '@marmeon/database';
import { sql } from '@marmeon/database';
import type { PasswordHash } from './hashing.ts';
import type { UserProvider } from './user.ts';

/** The writes of a `UserProvider` that decide whether a session survives. */
export type CredentialWriter = Pick<UserProvider, 'updatePasswordHash' | 'updateSessionKey' | 'updateEverySessionKey'>;

const TABLE_NAME = /^[a-z_][a-z0-9_]*$/;
const SHORT_KEY = 'A session key is at least 32 characters: use a random value, as auth.updateSessionKey() does.';

/**
 * The statements behind `UserProvider.updatePasswordHash()`, `updateSessionKey()` and `updateEverySessionKey()`, for a table with the
 * columns `id`, `password`, `session_key` and `updated_at` (what the starter kit's migration creates). Delegate to it from your
 * repository instead of writing the compare-and-set SQL yourself: a fix reaches you with an update. Pass the repository's `this.db`,
 * so the writes follow an enclosing transaction. See docs/authentication.md#for-your-own-user-provider.
 */
export function credentialWriter(db: Connection<any>, options: { table?: string } = {}): CredentialWriter {
  const table = options.table ?? 'users';
  if (!TABLE_NAME.test(table)) throw new TypeError(`credentialWriter(): "${table}" is not a plain table name (lower case letters, digits and underscores).`);
  // `Connection<any>` types no table; the name is checked above and reaches the statement as an identifier only.
  const tbl = db as Connection<Record<string, any>>;

  // Both columns are secrets: they cannot be compared in a typed `where`, and every comparison stays in the one statement that writes.
  const keyIs = (key: string | null) => (key === null ? sql<boolean>`session_key is null` : sql<boolean>`session_key = ${key}`);

  return {
    async updatePasswordHash(id, hash: PasswordHash, options = {}) {
      const { expected, sessionKey, expectedSessionKey } = options;
      // An empty key would give the fingerprint of an account without one (NULL).
      if (sessionKey !== undefined && sessionKey.length < 32) throw new Error(SHORT_KEY);
      const result = await tbl
        .updateTable(table)
        .set({ password: hash, ...(sessionKey === undefined ? {} : { session_key: sessionKey }), updated_at: new Date() })
        .where('id', '=', id)
        .$if(expected !== undefined, (query) => query.where(sql<boolean>`password = ${expected}`))
        // Only together with a new key: the key is what the check protects.
        .$if(sessionKey !== undefined && expectedSessionKey !== undefined, (query) => query.where(keyIs(expectedSessionKey!)))
        .executeTakeFirst();
      return result.numUpdatedRows > 0n;
    },

    async updateSessionKey(id, key, expected) {
      if (key.length < 32) throw new Error(SHORT_KEY);
      const result = await tbl
        .updateTable(table)
        .set({ session_key: key, updated_at: new Date() })
        .where('id', '=', id)
        .$if(expected !== undefined, (query) => query.where(keyIs(expected!)))
        .executeTakeFirst();
      return result.numUpdatedRows > 0n;
    },

    async updateEverySessionKey(key) {
      if (key.length < 32) throw new Error('A session key is at least 32 characters: use a random value, as AccountSessions.endEveryone() does.');
      // No `updated_at`: the accounts themselves did not change, only the end of their sessions.
      const result = await tbl.updateTable(table).set({ session_key: key }).executeTakeFirst();
      const accounts = Number(result.numUpdatedRows);
      if (accounts === 0) return { accounts, sampleId: undefined };
      // Chosen by the new key, so an account created after the UPDATE cannot be the sample (it would not hold the key).
      const sample = await tbl
        .selectFrom(table)
        .select('id')
        .where(sql<boolean>`session_key = ${key}`)
        .limit(1)
        .executeTakeFirst();
      return { accounts, sampleId: sample?.id };
    },
  };
}
