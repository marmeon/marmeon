import { Clock, err, ok, type Result } from '@marmeon/core';
import type { SocialUser } from '@marmeon/oauth';
import type { SocialUserProvider } from '@marmeon/oauth/accounts';
import { Translator } from '@marmeon/i18n';
import { UserRepository, type User } from '#modules/auth';

/**
 * The bridge between the people who sign in at a provider and the users of this app. `@marmeon/oauth` never reads or writes a user itself: it
 * asks this class, which assumes the starter kit's `users` table and `UserRepository` (a name, an e-mail address, an optional password
 * hash, `email_verified_at`). If your users look different, this file is the one to change.
 */
export class SocialUsers implements SocialUserProvider<User> {
  readonly #users: UserRepository;
  readonly #clock: Clock;
  readonly #translator: Translator;

  constructor(users: UserRepository, clock: Clock, translator: Translator) {
    this.#users = users;
    this.#clock = clock;
    this.#translator = translator;
  }

  /** The user with this address, and whether the app has confirmed it. The address is the provider's text: it is normalized as the kit normalizes every address. */
  async findByEmail(email: string) {
    const user = await this.#users.findByEmail(email.trim().toLowerCase());
    return user === undefined ? undefined : { user, emailVerified: this.emailConfirmed(user) };
  }

  /** The question the password reset asks of the column: is `email_verified_at` set? */
  emailConfirmed(user: User): boolean {
    return (user.email_verified_at ?? null) !== null;
  }

  /**
   * A new user without a password (the account signs in at the provider; a reset link gives it a password later). The address counts as
   * confirmed only when the provider vouched for it: nobody else did.
   */
  async create(social: SocialUser & { readonly email: string }, options: { readonly emailVerified: boolean }): Promise<Result<User, { readonly kind: 'duplicate' }>> {
    const email = social.email.trim().toLowerCase();
    const name = [social.name, social.nickname, email.split('@')[0]].map((candidate) => candidate?.trim() ?? '').find((candidate) => candidate !== '') ?? email;
    const created = await this.#users.register({ name: Array.from(name).slice(0, 255).join(''), email, password: null, locale: this.#translator.locale });
    if (!created.ok) return err(created.error);
    if (!options.emailVerified) return created;
    await this.#users.markEmailVerified(created.value.id, new Date(this.#clock.now()));
    return ok((await this.#users.find(created.value.id)) ?? created.value);
  }
}
