import type { Credentials, PasswordHash, UserProvider } from '@marmeon/auth';
import { commitAnyway, err, ok, type Result } from '@marmeon/core';
import { Repository, secret, sql } from '@marmeon/database';
import type { User } from './users.ts';

/**
 * Access to users — the auth module's public, injectable API (other modules only read `users` via
 * `exposes`). Also where authentication finds users (`UserProvider`): the only place that reads the
 * password hash, which travels next to the user, never inside it.
 */
export class UserRepository extends Repository<'users'> implements UserProvider<User> {
  static table = 'users' as const;

  findById(id: number): Promise<Credentials<User> | undefined> {
    return this.#credentials(this.query().where('id', '=', id));
  }

  /** By e-mail — as the login request normalized it (trimmed, lower case). */
  findForLogin(email: string): Promise<Credentials<User> | undefined> {
    return this.#credentials(this.query().where('email', '=', email));
  }

  /** The account with this e-mail (normalized: trimmed, lower case), if there is one. */
  findByEmail(email: string): Promise<User | undefined> {
    return this.query().selectAll().where('email', '=', email).executeTakeFirst();
  }

  /** A new user — or `duplicate` when the e-mail is taken (decided by the unique index, so two sign-ups cannot race past a check). */
  register(values: { name: string; email: string; password: PasswordHash; locale: string }): Promise<Result<User, { kind: 'duplicate' }>> {
    return this.tryInsert(values);
  }

  async markEmailVerified(id: number): Promise<void> {
    const now = new Date();
    // The first confirmation is kept for good: a later unconfirmed change of address never makes the account prunable.
    await this.db
      .updateTable('users')
      .set({ email_verified_at: now, first_verified_at: sql<Date>`coalesce(first_verified_at, ${now.toISOString()})`, updated_at: now })
      .where('id', '=', id)
      .execute();
  }

  /**
   * A new address at once, unverified — `duplicate` when another account has it, `missing` when the account is gone. Only with
   * `AUTH_PRIVATE_REGISTRATION=false`: the default keeps a change pending (`requestEmailChange`) until its link is clicked.
   */
  async changeEmail(id: number, email: string): Promise<Result<User, { kind: 'duplicate' } | { kind: 'missing' }>> {
    // A confirmed account stays one: what confirmed it — its link, or `email_verified_at` alone (an import, a seeder, an
    // admin) — is kept in `first_verified_at` before the new address clears `email_verified_at`, so `auth:prune-unverified` never takes it.
    // (A taken address changes nothing else: the account was confirmed all the same.)
    await this.db.updateTable('users').set({ first_verified_at: sql<Date>`coalesce(first_verified_at, email_verified_at)` }).where('id', '=', id).execute();
    return this.tryUpdate(id, { email, email_verified_at: null, pending_email: null, pending_email_token: null, pending_email_expires_at: null });
  }

  /**
   * A change of address, pending (private registration): the new address waits beside the account's own — with the hash of
   * its link's token and when it expires — until the link is clicked. A newer request replaces it (and so its link). Written the
   * same for a free address and a taken one: whether another account has it is never asked here.
   */
  async requestEmailChange(id: number, change: { email: string; tokenHash: string; expiresAt: Date }): Promise<void> {
    await this.update(id, { pending_email: change.email, pending_email_token: change.tokenHash, pending_email_expires_at: change.expiresAt });
  }

  /** When the pending change of `id` to `email` with this token expires — `undefined` once it is replaced, used, cancelled or pruned. */
  async pendingEmailChange(id: number, email: string, tokenHash: string): Promise<Date | undefined> {
    const row = await this.query()
      .select('pending_email_expires_at')
      .where('id', '=', id)
      .where('pending_email', '=', email)
      .where(sql.ref('pending_email_token'), '=', tokenHash)
      .executeTakeFirst();
    return row?.pending_email_expires_at ? new Date(row.pending_email_expires_at) : undefined;
  }

  /**
   * The click on a change link: the pending address becomes the account's, confirmed `now`. Only for the account `id` (the signed-in
   * user), only with the token of its current request, only before it expires — and only once: the token is claimed in the same
   * statement that checks it, so two clicks at once change it once. `taken` when another account has the address by now: the
   * unique index decides (`tryUpdate`), and the request is dropped for good. The previous address comes back for the note to it.
   * Propagated out of an enclosing transaction, the `taken` err rolls the dropped request back — re-mark it with `commitAnyway` (see
   * docs/transactions.md#returning-an-err).
   */
  async confirmEmailChange(
    id: number,
    tokenHash: string,
    now: Date,
  ): Promise<Result<{ user: User; previous: string }, { kind: 'invalid' } | { kind: 'taken'; email: string }>> {
    return this.transaction(async (users) => {
      const claimed = await users.db
        .updateTable('users')
        .set({ pending_email_token: null })
        .where('id', '=', id)
        .where(sql.ref('pending_email_token'), '=', tokenHash)
        .where('pending_email_expires_at', '>', now.toISOString())
        .returning(['email', 'pending_email'])
        .executeTakeFirst();
      if (!claimed?.pending_email) return err({ kind: 'invalid' });
      const changes = { pending_email: null, pending_email_expires_at: null };
      const changed = await users.tryUpdate(id, { email: claimed.pending_email, email_verified_at: now, ...changes });
      if (!changed.ok) {
        if (changed.error.kind === 'missing') return err({ kind: 'invalid' });
        await users.update(id, changes);
        // Committed although it is an err: the dropped request must stay dropped, so its link no longer works.
        return commitAnyway(err({ kind: 'taken', email: claimed.pending_email }));
      }
      // A confirmed address — the first one, if the account had none before (kept for good).
      await users.db.updateTable('users').set({ first_verified_at: now }).where('id', '=', id).where('first_verified_at', 'is', null).execute();
      return ok({ user: changed.value, previous: claimed.email });
    });
  }

  /** Drops a pending change of address (its link stops working). */
  async cancelEmailChange(id: number): Promise<void> {
    await this.update(id, { pending_email: null, pending_email_token: null, pending_email_expires_at: null });
  }

  /** Clears the pending changes of address that expired before `now` (the schedule) — how many. */
  async pruneEmailChanges(now: Date): Promise<number> {
    const result = await this.db
      .updateTable('users')
      .set({ pending_email: null, pending_email_token: null, pending_email_expires_at: null })
      .where('pending_email_expires_at', '<=', now.toISOString())
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  /**
   * Up to `limit` accounts (oldest first) that never confirmed an address and were made before `since` — what
   * `auth:prune-unverified` deletes. Never one that was confirmed once (`first_verified_at`): with
   * `AUTH_PRIVATE_REGISTRATION=false` a change of address leaves it unconfirmed, and it stays all the same.
   */
  async unconfirmedSince(since: Date, limit: number): Promise<number[]> {
    const at = since.toISOString();
    const rows = await this.query()
      .select('id')
      .where('email_verified_at', 'is', null)
      .where('first_verified_at', 'is', null)
      .where('created_at', '<=', at)
      .orderBy('id')
      .limit(limit)
      .execute();
    return rows.map((row) => row.id);
  }

  /**
   * Deletes the accounts `ids` — through `AccountDeletion`, which clears what belongs to them. With `unconfirmedSince`, only
   * those never confirmed and made before then — decided by this statement, so one confirmed meanwhile stays. Their
   * remember-me and API tokens go with them (the foreign keys cascade). The deleted accounts come back.
   */
  async deleteAccounts(ids: readonly number[], only?: { unconfirmedSince: Date }): Promise<User[]> {
    let query = this.db.deleteFrom('users').where('id', 'in', [...ids]);
    if (only) {
      const at = only.unconfirmedSince.toISOString();
      query = query.where('email_verified_at', 'is', null).where('first_verified_at', 'is', null).where('created_at', '<=', at);
    }
    return (await query.returningAll().execute()) as User[];
  }

  async updatePasswordHash(id: number, hash: PasswordHash): Promise<void> {
    await this.update(id, { password: hash });
  }

  async #credentials(query: ReturnType<UserRepository['query']>): Promise<Credentials<User> | undefined> {
    const row = await query.selectAll().select((eb) => secret(eb, 'password')).executeTakeFirst();
    if (!row) return undefined;
    const { password, ...user } = row;
    return { user, passwordHash: password as PasswordHash };
  }
}
