import { token, type Result, type Token } from '@marmeon/core';
import type { AuthUser } from '@marmeon/auth';
import type { SocialUser } from '../definition.ts';

/**
 * How the app finds and makes the users that sign in at a provider. The package never writes a user itself: `create` is the app's
 * registration, with whatever its `users` table holds. Bind it in a provider: `container.bind(SocialUserProvider, SocialUsers)`.
 * See docs/oauth.md#signing-users-in.
 */
export interface SocialUserProvider<U = AuthUser> {
  /**
   * The user whose address is `email`, and whether the app has confirmed that address; `undefined` or `null` when no user has it.
   * The address is unvalidated data of the provider: it has no control characters and is at most 254 characters, but it is not checked
   * as an address, so compare it the way the app compares addresses (lower case, say) and never trust it further. Before an account is
   * linked to the user found, it is called once more inside the transaction that writes the link: read the current row through the
   * app's database (which joins that transaction), not a cache or a replica, or the second look proves nothing.
   */
  findByEmail(email: string): Promise<{ readonly user: U; readonly emailVerified: boolean } | undefined | null>;
  /**
   * Whether the app has confirmed the address of `user`: `true` exactly when `email_verified_at` is set, which is what the password reset
   * reads when it decides whether to remove the user's linked accounts. `link()` refuses a user for whom this is not `true`.
   */
  emailConfirmed(user: U): boolean | Promise<boolean>;
  /**
   * Makes the user for `social`, whose address is unvalidated data of the provider (see {@link findByEmail}). `options.emailVerified` is
   * whether the provider vouched for the address: store it as confirmed only then. A user with that address already (a race with
   * another registration) is `err({ kind: 'duplicate' })`. It runs in the transaction that also links the account, so an `err` and a
   * throw both undo it.
   */
  create(social: SocialUser & { readonly email: string }, options: { readonly emailVerified: boolean }): Promise<Result<U, { readonly kind: 'duplicate' }>>;
}

/** The binding of the app's {@link SocialUserProvider}. */
export const SocialUserProvider: Token<SocialUserProvider> = token<SocialUserProvider>('SocialUserProvider');
