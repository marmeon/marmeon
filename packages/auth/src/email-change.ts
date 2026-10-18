import { RateLimiter } from '@marmeon/cache';
import { Clock, commitAnyway, err, EventDispatcher, ok, type Result } from '@marmeon/core';
import { Connections } from '@marmeon/database';
import { Session } from '@marmeon/session';
import { ACCOUNT_STILL_CLAIMED, Auth, CLAIM_ACCOUNT, VERIFIED_SESSION_KEY } from './auth.ts';
import { AuthConfig } from './config.ts';
import { EmailChangeStore } from './email-changes.ts';
import { EmailChanged } from './events.ts';
import type { PasswordCheckError } from './password-throttle.ts';
import { FACTOR_CHANGE_MAX_AGE, secondFactorProvenWithin } from './two-factor/proof.ts';
import { TwoFactorState } from './two-factor/state.ts';
import { idOf, type AuthUserId } from './user.ts';

/** A change of address that waits for its link: what the mail job composes the link from. */
export interface PendingEmailChange {
  readonly userId: AuthUserId;
  /** The address the account asked for; it is not the account's until the link is used. */
  readonly email: string;
  /** The secret of the link. Shown once, to the mail; the store keeps only its hash. */
  readonly token: string;
  readonly expiresAt: Date;
}

/**
 * Writes `email` as the account's address (`verifiedAt` is when the owner of the address was proven, `null`: not yet) and answers the
 * account as the app keeps it. `duplicate`: another account has the address; `missing`: this account is gone.
 */
export type ApplyEmail<U> = (userId: AuthUserId, email: string, verifiedAt: Date | null) => Promise<Result<U, { readonly kind: 'duplicate' } | { readonly kind: 'missing' }>>;

/** What the app hands `EmailChange.request()`. */
export interface EmailChangeHandlers<U> {
  /** Private registration: puts the link in the mail (usually a queued job). Runs in the transaction that stores the change; if it throws, nothing is stored. */
  readonly deliver: (change: PendingEmailChange) => Promise<void>;
  /** Registration not private: writes the address at once. */
  readonly apply: ApplyEmail<U>;
}

/** What `EmailChange.request()` answers: a change that waits for its link, or (`AUTH_PRIVATE_REGISTRATION=false`) what `apply` returned. */
export type EmailChangeRequested<U> = { readonly pending: true } | { readonly pending: false; readonly value: U };

/** Why `EmailChange.request()` changed nothing. */
export type RequestEmailChangeError = PasswordCheckError | { readonly kind: 'duplicate' };

/** Why `EmailChange.confirm()` changed nothing. */
export type ConfirmEmailChangeError =
  /** Private registration is off: there are no links. */
  | { readonly kind: 'not-found' }
  /** The link is for another account than the signed-in one; it stays valid for the right one. */
  | { readonly kind: 'wrong-account' }
  /** Unknown, used, expired or replaced. */
  | { readonly kind: 'invalid' }
  /** Another account took the address meanwhile. The link is used up. */
  | { readonly kind: 'taken'; readonly email: string };

/**
 * The signed-in user's change of address, as far as it is a matter of security: a second factor proven lately where the account has
 * one, the account's password typed and counted by `Auth.checkPassword()`, a link that is used once, only by the account it was made
 * for, and — with private registration (the default) — the same answer for an address that is free and one that another account has.
 * The app writes the address itself (`apply`), because it owns the `users` table, and mails the link (`deliver`).
 *
 * Bind a store to use it: `container.singleton(EmailChangeStore, DatabaseEmailChanges)`; without one `make(EmailChange)` fails with K1.
 * See `docs/authentication.md#changing-the-address`.
 */
export class EmailChange {
  readonly #auth: Auth;
  readonly #session: Session;
  readonly #state: TwoFactorState;
  readonly #store: EmailChangeStore;
  readonly #config: AuthConfig;
  readonly #clock: Clock;
  readonly #connections: Connections;
  readonly #limiter: RateLimiter;
  readonly #events: EventDispatcher;

  constructor(auth: Auth, session: Session, state: TwoFactorState, store: EmailChangeStore, config: AuthConfig, clock: Clock, connections: Connections, limiter: RateLimiter, events: EventDispatcher) {
    this.#auth = auth;
    this.#session = session;
    this.#state = state;
    this.#store = store;
    this.#config = config;
    this.#clock = clock;
    this.#connections = connections;
    this.#limiter = limiter;
    this.#events = events;
  }

  /**
   * Asks for `email` as the signed-in user's address. Throws without a signed-in user, and where the account has a second factor that
   * this session did not prove within fifteen minutes (put the route behind `confirmedSecondFactor()`). The password is checked by
   * `Auth.checkPassword()`, so a wrong one counts against the throttle and the `err` is its.
   *
   * With private registration (the default) the change is stored and `deliver` called in one transaction — the same two steps for a free
   * address and one another account has, which this method never asks about — and the answer is `{ pending: true }`. With
   * `AUTH_PRIVATE_REGISTRATION=false`, `apply` writes the address at once (unverified): `duplicate` is the `err`, a missing account throws.
   * Throws when the session ended while the password was checked (a new password, `AccountSessions.end()`): nothing is stored then.
   */
  async request<U>(email: string, currentPassword: string, handlers: EmailChangeHandlers<U>): Promise<Result<EmailChangeRequested<U>, RequestEmailChangeError>> {
    const user = await this.#requireUser('request');
    const userId = idOf(user);
    // Also without the route's confirmedSecondFactor(): a route added by hand must not skip the factor. A passkey alone can confirm sudo mode.
    if ((await this.#state.factors(userId)).length > 0 && !secondFactorProvenWithin(this.#session, FACTOR_CHANGE_MAX_AGE, Math.floor(this.#clock.now() / 1000))) {
      throw new Error('emailChange.request() needs a second factor proven within 15 minutes on an account that has one — put the route behind confirmedSecondFactor().');
    }
    // Typed now, whatever confirmed sudo mode: a hijacked session must not take the account over by changing the address and resetting the password.
    const checked = await this.#auth.checkPassword(currentPassword);
    if (!checked.ok) return err(checked.error);

    if (!this.#config.privateRegistration) {
      // The session must still fit the account when the address is written, as when a link is stored: the lock is held until the commit.
      const applied = await this.#connections.transaction(async () => ((await this.#auth[CLAIM_ACCOUNT]()) ? handlers.apply(userId, email, null) : undefined));
      if (applied === undefined) return this.#sessionEnded();
      if (!applied.ok) {
        if (applied.error.kind === 'duplicate') return err({ kind: 'duplicate' });
        throw new Error(`emailChange.request(): the account ${userId} is gone.`);
      }
      await this.#store.forget(userId);
      await this.#events.dispatch(new EmailChanged(userId, previousEmail(user), email));
      return ok({ pending: false, value: applied.value });
    }

    // One request a pause per account: a right password clears the password throttle, so without this a loop could mail any address.
    // A request inside the pause is answered like the others and does nothing.
    const pause = `email-change:account:${userId}`;
    if (this.#config.emailChangeThrottle > 0 && !(await this.#limiter.attempt(pause, 1, this.#config.emailChangeThrottle))) return ok({ pending: true });

    // One transaction: the stored change and the mail, or neither. Nothing here asks whether the address has an account.
    // The pause is for a link that was sent: nothing stored or mailed gives it back, so that the retry is not answered with nothing.
    const stored = await this.#connections.transaction(async () => {
      const expiresAt = new Date(this.#clock.now() + this.#config.emailChangeMinutes * 60_000);
      const token = await this.#store.create(userId, email, expiresAt, this.#auth[VERIFIED_SESSION_KEY]());
      if (token === undefined) return false;
      await handlers.deliver({ userId, email, token, expiresAt });
      return true;
    }).catch(async (error: unknown) => {
      await this.#limiter.clear(pause);
      throw error;
    });
    if (!stored) {
      await this.#limiter.clear(pause);
      return this.#sessionEnded();
    }
    return ok({ pending: true });
  }

  /** Drops the signed-in user's own pending change, if any. Throws without a signed-in user. */
  async cancel(): Promise<void> {
    const user = await this.#requireUser('cancel');
    await this.#store.forget(idOf(user));
  }

  /**
   * The expiry of the change of `userId` to `email`, as long as `token` is its token and it has not expired: what the mail job asks
   * before it sends the link (it has no session). `undefined` when the change was replaced, used or dropped meanwhile.
   */
  pending(userId: AuthUserId, email: string, token: string): Promise<Date | undefined> {
    return this.#store.pending(userId, email, token);
  }

  /**
   * Uses the link up for the signed-in user: `linkUserId` is the account the link names (from its URL), `token` its secret. Only that
   * account can use it — another signed-in user gets `wrong-account` and the link stays valid. The link is claimed and `apply` writes
   * the address (verified now) in one transaction, so a failing write leaves the link usable; an address another account took meanwhile
   * is `taken`, and the link is used up all the same. Without private registration there are no links: `not-found`.
   * Dispatches `EmailChanged` once the address is written. Inside a transaction of your own, a `taken` answer rolls the spent link back with
   * it. Throws without a signed-in user.
   */
  async confirm<U>(linkUserId: string, token: string, apply: ApplyEmail<U>): Promise<Result<U, ConfirmEmailChangeError>> {
    const user = await this.#requireUser('confirm');
    if (!this.#config.privateRegistration) return err({ kind: 'not-found' });
    const userId = idOf(user);
    if (linkUserId !== String(userId)) return err({ kind: 'wrong-account' });
    let changed: string | undefined;
    const confirmed = await this.#connections.transaction(async (): Promise<Result<U, ConfirmEmailChangeError>> => {
      const now = new Date(this.#clock.now());
      const email = await this.#store.claim(userId, token, now);
      if (email === undefined) return err({ kind: 'invalid' });
      const applied = await apply(userId, email, now);
      if (applied.ok) {
        changed = email;
        return ok(applied.value);
      }
      // The link is spent whether or not the address was free: the deletion stays when the transaction would roll back an err.
      return applied.error.kind === 'duplicate' ? commitAnyway(err({ kind: 'taken', email })) : err({ kind: 'invalid' });
    });
    if (confirmed.ok && changed !== undefined) await this.#events.dispatch(new EmailChanged(userId, previousEmail(user), changed));
    return confirmed;
  }

  /** The account's session key changed since the password was checked: this session is over, and no change was left behind. */
  async #sessionEnded(): Promise<never> {
    await this.#auth[ACCOUNT_STILL_CLAIMED]();
    throw new Error('emailChange.request() needs a signed-in user — this session was ended while the change was asked for.');
  }

  async #requireUser(method: string) {
    const user = await this.#auth.user();
    if (!user) throw new Error(`emailChange.${method}() needs a signed-in user — put the route behind authenticate().`);
    return user;
  }
}

function previousEmail(user: unknown): string | null {
  const email = (user as { email?: unknown }).email;
  return typeof email === 'string' ? email : null;
}
