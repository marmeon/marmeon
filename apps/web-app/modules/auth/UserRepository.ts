import { randomBytes } from 'node:crypto';
import { credentialWriter, type Credentials, type PasswordHash, type UserProvider } from '@marmeon/auth';
import { err, ok, type Result } from '@marmeon/core';
import { Repository, secret, sql } from '@marmeon/database';
import type { User } from './users.ts';

/**
 * Access to users — the auth module's public, injectable API (other modules only read `users` via
 * `exposes`). Also where authentication finds users (`UserProvider`): the only place that reads the
 * password hash, which travels next to the user, never inside it.
 */
export class UserRepository extends Repository<'users'> implements UserProvider<User> {
  static table = 'users' as const;
  /** `/users/:user` shows the UUID, not the integer id (which stays the key of the relations). */
  static routeKey = 'public_id';

  findById(id: number): Promise<Credentials<User> | undefined> {
    return this.#credentials(this.query().where('id', '=', id));
  }

  /** By e-mail — as the login request normalized it (trimmed, lower case). */
  findForSignIn(email: string): Promise<Credentials<User> | undefined> {
    return this.#credentials(this.query().where('email', '=', email));
  }

  /** The account with this e-mail (normalized: trimmed, lower case), if there is one. */
  findByEmail(email: string): Promise<User | undefined> {
    return this.query().selectAll().where('email', '=', email).executeTakeFirst();
  }

  /** A new user — or `duplicate` when the e-mail is taken (decided by the unique index, so two sign-ups cannot race past a check). */
  register(values: { name: string; email: string; password: PasswordHash; locale: string }): Promise<Result<User, { kind: 'duplicate' }>> {
    // A key from the start: an account whose key is NULL has no row to lock when a factor is added (docs/authentication.md#the-user-type-and-where-users-come-from).
    return this.tryInsert({ ...values, session_key: randomBytes(32).toString('base64url') });
  }

  /** The language the user chose — mails reach them in it. */
  async updateLocale(id: number, locale: string): Promise<void> {
    await this.update(id, { locale });
  }

  /** Confirms the address at `at` — pass `new Date(clock.now())` from the app's `Clock`, so `app.travel()` moves it. */
  async markEmailVerified(id: number, at: Date): Promise<void> {
    // The first confirmation is kept for good: a later unconfirmed change of address never makes the account prunable.
    await this.db
      .updateTable('users')
      .set({ email_verified_at: at, first_verified_at: sql<Date>`coalesce(first_verified_at, ${at.toISOString()})`, updated_at: at })
      .where('id', '=', id)
      .execute();
  }

  /**
   * Writes `email` as the account's address, confirmed `verifiedAt` (`null`: not yet) — what `EmailChange` hands its `apply` handlers. The
   * unique index decides whether another account has the address (`duplicate`); `missing` when this account is gone.
   */
  async applyEmailChange(id: number, email: string, verifiedAt: Date | null): Promise<Result<User, { kind: 'duplicate' } | { kind: 'missing' }>> {
    // A confirmed account stays one: what confirmed it — its link, or `email_verified_at` alone (an import, a seeder, an
    // admin) — is kept in `first_verified_at` before a new address clears `email_verified_at`, so the prune of unconfirmed accounts never takes it.
    // (A taken address changes nothing else: the account was confirmed all the same.)
    await this.db.updateTable('users').set({ first_verified_at: sql<Date>`coalesce(first_verified_at, email_verified_at)` }).where('id', '=', id).execute();
    const changed = await this.tryUpdate(id, { email, email_verified_at: verifiedAt });
    if (!changed.ok) return err(changed.error);
    // A confirmed address — the first one, if the account had none before (kept for good).
    if (verifiedAt) await this.db.updateTable('users').set({ first_verified_at: verifiedAt }).where('id', '=', id).where('first_verified_at', 'is', null).execute();
    return ok(changed.value);
  }

  /**
   * Up to `limit` accounts (oldest first) that never confirmed an address and were made before `since` — what
   * `auth:prune-unverified` deletes. Never one that was confirmed once (`first_verified_at`): with
   * `AUTH_PRIVATE_REGISTRATION=false` a change of address leaves it unconfirmed, and it stays all the same. `except`: ids to skip
   * (the ones a module refused to lose).
   */
  async unconfirmedSince(since: Date, limit: number, except: readonly number[] = []): Promise<number[]> {
    const at = since.toISOString();
    let query = this.query().select('id').where('email_verified_at', 'is', null).where('first_verified_at', 'is', null).where('created_at', '<=', at);
    if (except.length > 0) query = query.where('id', 'not in', [...except]);
    const rows = await query
      .orderBy('id')
      .limit(limit)
      .execute();
    return rows.map((row) => row.id);
  }

  /**
   * Reads the accounts `ids` that `deleteAccounts` would delete (same `only`), locking their rows with `lock` (Postgres; SQLite
   * has one writer at a time) so nothing changes them between the question `AccountDeleting` asks and the delete.
   */
  async lockAccounts(ids: readonly number[], only?: { unconfirmedSince: Date }, lock = false): Promise<User[]> {
    let query = this.db.selectFrom('users').selectAll().where('id', 'in', [...ids]).orderBy('id');
    if (only) {
      const at = only.unconfirmedSince.toISOString();
      query = query.where('email_verified_at', 'is', null).where('first_verified_at', 'is', null).where('created_at', '<=', at);
    }
    if (lock) query = query.forUpdate();
    return (await query.execute()) as User[];
  }

  /**
   * Deletes the accounts `ids` — through `AccountDeletion`, which clears what belongs to them. With `unconfirmedSince`, only
   * those never confirmed and made before then — decided by this statement, so one confirmed meanwhile stays. `except` are ids
   * the statement leaves alone (the ones a module refused). Their remember-me and API tokens go with them (the foreign keys
   * cascade). The deleted accounts come back.
   */
  async deleteAccounts(ids: readonly number[], only?: { unconfirmedSince: Date }, except: readonly number[] = []): Promise<User[]> {
    let query = this.db.deleteFrom('users').where('id', 'in', [...ids]);
    if (except.length > 0) query = query.where('id', 'not in', [...except]);
    if (only) {
      const at = only.unconfirmedSince.toISOString();
      query = query.where('email_verified_at', 'is', null).where('first_verified_at', 'is', null).where('created_at', '<=', at);
    }
    return (await query.returningAll().execute()) as User[];
  }

  /**
   * Writes `hash` and answers whether it wrote. With `expected`, only where the stored hash still equals it, in one statement: a
   * rehash or "sign out other devices" never puts an old password back over a reset that landed meanwhile. Without it, writes
   * regardless. With `sessionKey`, the same statement stores that session key too, so the hash and the key never stand apart; with
   * `expectedSessionKey` as well (`null`: none), only where the stored key still is that one — a session that was ended since it was
   * checked (`AccountSessions.end()` replaced the key) must not be brought back by a password change.
   */
  updatePasswordHash(id: number, hash: PasswordHash, options?: { expected?: PasswordHash; sessionKey?: string; expectedSessionKey?: string | null }): Promise<boolean> {
    return this.#credentialWriter().updatePasswordHash(id, hash, options);
  }

  /** Everyone's id and name, by name — optionally only names containing `search` (any case). */
  list({ search = '', except }: { search?: string; except?: number } = {}) {
    let query = this.query().select(['id', 'name']).orderBy('name');
    if (search) {
      // LIKE, with its wildcards in the search taken literally; lower() on both sides for Postgres.
      const pattern = `%${search.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      query = query.where(sql<boolean>`lower(name) like ${pattern} escape '\\'`);
    }
    if (except !== undefined) query = query.where('id', '!=', except);
    return query.execute();
  }

  /**
   * The provider half of ending sessions: stores `key` only while the stored key is still `expected` (`null`: none), in one
   * statement, and says whether it did — so two callers that read the same key cannot both win. `undefined` stores it regardless
   * (`AccountSessions.end()` only). Call `auth.updateSessionKey()` or
   * `AccountSessions.end()` instead: they pass `expected`, and also drop the remember-me tokens.
   */
  updateSessionKey(id: number, key: string, expected: string | null | undefined): Promise<boolean> {
    return this.#credentialWriter().updateSessionKey(id, key, expected);
  }

  /**
   * The provider half of ending every session of every account: writes `key` into every account in one `UPDATE` without a `WHERE`
   * clause, and answers how many rows it wrote and one account it wrote (`sampleId`), which `AccountSessions` reads back. Call
   * `AccountSessions.endEveryone()` instead: it also drops the remember-me tokens and the sign-in rows.
   */
  updateEverySessionKey(key: string): Promise<{ accounts: number; sampleId: number | undefined }> {
    return this.#credentialWriter().updateEverySessionKey(key);
  }

  /** The package's statements for the hash and the session key — on `this.db`, so they join an enclosing transaction. */
  #credentialWriter() {
    return credentialWriter(this.db);
  }

  async #credentials(query: ReturnType<UserRepository['query']>): Promise<Credentials<User> | undefined> {
    const row = await query
      .selectAll()
      .select((eb) => [secret(eb, 'password'), secret(eb, 'session_key')])
      .executeTakeFirst();
    if (!row) return undefined;
    const { password, session_key: sessionKey, ...user } = row;
    return { user, passwordHash: password as PasswordHash, sessionKey: sessionKey as string | null };
  }
}
