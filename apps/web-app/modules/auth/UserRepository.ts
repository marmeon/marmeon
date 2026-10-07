import type { Credentials, PasswordHash, UserProvider } from '@marmeon/auth';
import { Repository, secret, sql } from '@marmeon/database';
import type { User } from './users.ts';

/**
 * Access to users — the auth module's public, injectable API (other modules only read `users` via
 * `exposes`). Also where authentication finds users (`UserProvider`): the only place that reads the
 * password hash, which travels next to the user, never inside it.
 */
export class UserRepository extends Repository<'users'> implements UserProvider<User> {
  static table = 'users' as const;
  static timestamps = true;

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

  /** Whether an account has this e-mail (normalized: trimmed, lower case) — the registration's uniqueness rule. */
  async emailTaken(email: string): Promise<boolean> {
    return (await this.query().select('id').where('email', '=', email).executeTakeFirst()) !== undefined;
  }

  /** A new user — `undefined` when the e-mail is taken (decided by the unique index, so two sign-ups cannot race past a check). */
  register(values: { name: string; email: string; password: PasswordHash; locale: string }): Promise<User | undefined> {
    return this.tryInsert(values);
  }

  /** The language the user chose — mails reach them in it. */
  async updateLocale(id: number, locale: string): Promise<void> {
    await this.update(id, { locale });
  }

  async markEmailVerified(id: number): Promise<void> {
    await this.update(id, { email_verified_at: new Date() });
  }

  /**
   * A new address at once, unverified — `'duplicate'` when another account has it. Only with `AUTH_PRIVATE_REGISTRATION=false`
   * (E193): the default keeps a change pending (`requestEmailChange`) until its link is clicked.
   */
  async changeEmail(id: number, email: string): Promise<User | undefined | 'duplicate'> {
    return this.tryUpdate(id, { email, email_verified_at: null, pending_email: null, pending_email_token: null, pending_email_expires_at: null });
  }

  /**
   * A change of address, pending (private registration, E146): the new address waits beside the account's own — with the hash of
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
   * statement that checks it, so two clicks at once change it once. `'taken'` when another account has the address by now: the
   * unique index decides (`tryUpdate`), the request is dropped. The previous address comes back for the note to it.
   */
  async confirmEmailChange(id: number, tokenHash: string, now: Date): Promise<{ user: User; previous: string } | 'invalid' | 'taken'> {
    return this.transaction(async (users) => {
      const claimed = await users.db
        .updateTable('users')
        .set({ pending_email_token: null })
        .where('id', '=', id)
        .where(sql.ref('pending_email_token'), '=', tokenHash)
        .where('pending_email_expires_at', '>', now.toISOString())
        .returning(['email', 'pending_email'])
        .executeTakeFirst();
      if (!claimed?.pending_email) return 'invalid';
      const changes = { pending_email: null, pending_email_expires_at: null };
      const changed = await users.tryUpdate(id, { email: claimed.pending_email, email_verified_at: now, ...changes });
      if (changed === 'duplicate') {
        await users.update(id, changes);
        return 'taken';
      }
      return changed ? { user: changed, previous: claimed.email } : 'invalid';
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

  async updatePasswordHash(id: number, hash: PasswordHash): Promise<void> {
    await this.update(id, { password: hash });
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

  async #credentials(query: ReturnType<UserRepository['query']>): Promise<Credentials<User> | undefined> {
    const row = await query.selectAll().select((eb) => secret(eb, 'password')).executeTakeFirst();
    if (!row) return undefined;
    const { password, ...user } = row;
    return { user, passwordHash: password as PasswordHash };
  }
}
