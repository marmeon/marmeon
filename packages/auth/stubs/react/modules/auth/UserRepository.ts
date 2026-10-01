import type { Credentials, PasswordHash, UserProvider } from '@bespokecore/auth';
import { Repository, secret } from '@bespokecore/database';
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

  /** A new user — `undefined` when the e-mail is taken (decided by the unique index, so two sign-ups cannot race past a check). */
  register(values: { name: string; email: string; password: PasswordHash; locale: string }): Promise<User | undefined> {
    return this.tryInsert(values);
  }

  async markEmailVerified(id: number): Promise<void> {
    await this.update(id, { email_verified_at: new Date() });
  }

  /** A new address, unverified — `'duplicate'` when another account has it. */
  async changeEmail(id: number, email: string): Promise<User | undefined | 'duplicate'> {
    return this.tryUpdate(id, { email, email_verified_at: null });
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
