import { afterCommit, type EventDispatcher, type Logger } from '@marmeon/core';
import type { Connections } from '@marmeon/database';
import { accountScope, type SessionEndings } from '@marmeon/session';
import type { AuthConfig } from './config.ts';
import { PasskeyRemoved, TwoFactorDisabled } from './events.ts';
import type { PasswordHash } from './hashing.ts';
import type { RememberTokenStore } from './remember.ts';
import { SignInTracker } from './sign-ins.ts';
import type { AccessTokenStore } from './tokens.ts';
import { NoTwoFactorState, type TwoFactorState } from './two-factor/state.ts';
import type { AuthUser, UserProvider } from './user.ts';

/**
 * Stores a new password — what `Auth.updatePassword()` and `PasswordBroker.reset()` share: the new hash, every remember-me token
 * of the user dropped, and with `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true` every API token of the user revoked, in one
 * transaction with the new hash (the app's `UserProvider` joins it), the tokens first — a password that changed never
 * leaves a token behind, and a failed revocation keeps the old password. The token store and the connections are looked up
 * only then: an app that keeps its tokens is not asked for them.
 *
 * A reset of an account whose address is not confirmed (`email_verified_at` is `null`: never confirmed, or cleared by a change of address
 * that was not confirmed yet) also removes every passkey, the authenticator and the recovery codes and revokes every API token, whatever
 * the setting: whoever registered the address first may have attached a way in of their own, and the reset is the owner proving the
 * mailbox. The factors are read again afterwards; one that survived is logged as an error. See `docs/passwords.md`.
 */
export class NewPassword {
  readonly #tokens: () => AccessTokenStore;
  readonly #connections: () => Connections;
  readonly #config: AuthConfig;
  readonly #logger: Logger;
  readonly #signIns: SignInTracker;
  readonly #endings: SessionEndings | undefined;
  readonly #factors: (() => { readonly state: TwoFactorState; readonly events: EventDispatcher }) | undefined;
  #warnedUnknownVerification = false;

  constructor(
    tokens: () => AccessTokenStore,
    connections: () => Connections,
    config: AuthConfig,
    logger: Logger,
    signIns: SignInTracker = new SignInTracker(undefined),
    endings?: SessionEndings,
    factors?: () => { readonly state: TwoFactorState; readonly events: EventDispatcher },
  ) {
    this.#factors = factors;
    this.#endings = endings;
    this.#tokens = tokens;
    this.#connections = connections;
    this.#config = config;
    this.#logger = logger;
    this.#signIns = signIns;
  }

  /**
   * Stores `hash` as the password of the user `id` (`via`: a change or a reset) — how many API tokens it revoked. A reset passes the
   * `user` it was made for: with `email_verified_at` of `null` it removes the account's factors and tokens too. A user without that
   * property (an app that does not verify addresses, or a provider that did not load the column) loses nothing; with a factor source
   * bound, that is logged once.
   */
  async store(users: UserProvider, remember: RememberTokenStore, id: string | number, hash: PasswordHash, via: 'change' | 'reset', user?: AuthUser): Promise<number> {
    const unconfirmed = via === 'reset' && user !== undefined && (user as { email_verified_at?: unknown }).email_verified_at === null;
    if (via === 'reset' && user !== undefined && (user as { email_verified_at?: unknown }).email_verified_at === undefined) this.#warnVerificationUnknown();
    const removed: { passkeys: boolean; factors: boolean } = { passkeys: false, factors: false };
    const write = async (revoke: boolean): Promise<number> => {
      const state = unconfirmed ? this.#factors?.().state : undefined;
      if (state) {
        const had = await state.factors(id);
        // Always: `factors()` counts only confirmed factors, and an authenticator still being set up (its secret included) must go too.
        await state.removeAll(id);
        const left = await state.factors(id);
        removed.passkeys = had.includes('passkey') && !left.includes('passkey');
        // The owner is told only when nothing is left, so the mail is true.
        removed.factors = had.length > 0 && left.length === 0;
        if (left.length > 0) this.#logger.error('A password reset could not remove every second factor of an account whose address is not confirmed', { user: id, left });
      }
      // The tokens go first: a revocation that fails writes no hash, also where the provider keeps its accounts outside this
      // transaction — a new password never stands next to live tokens.
      const revoked = revoke ? await this.#tokens().revokeAll(id) : 0;
      // The remember-me tokens go before the hash: a remember-me sign-in that is running (it consumed its token, then reads the
      // account) must not see the new hash next to a token that still exists.
      await remember.forgetUser(id);
      await users.updatePasswordHash(id as never, hash);
      // A reset has no session of its own to keep: every sign-in of the user is over, and none stays listed (a change keeps the current one, `Auth` ends the others).
      if (via === 'reset' && this.#signIns.enabled) await this.#signIns.endAll(id);
      return revoked;
    };
    const revokeTokens = this.#config.revokeTokensOnPasswordChange || unconfirmed;
    const revoked = revokeTokens ? await this.#connections().transaction(() => write(true)) : await write(false);
    if (revokeTokens) this.#logger.info('A new password revoked the API tokens of the user', { user: id, tokens: revoked, via });
    if (unconfirmed && user !== undefined) {
      const events = this.#factors?.().events;
      if (removed.passkeys) await events?.dispatch(new PasskeyRemoved(user, 'reset'));
      if (removed.factors) await events?.dispatch(new TwoFactorDisabled(user, 'reset'));
    }
    // A reset ends every sign-in: the live streams of the account close once it committed (a change is announced by `Auth`, which
    // keeps its own session). Clean-up after the real effect: a failure is logged, never thrown.
    if (via === 'reset') {
      await afterCommit(async () => {
        try {
          await this.#endings?.endAccount(accountScope(id));
        } catch (error) {
          this.#logger.error('The live streams of an account could not be told its sign-ins ended', { error: error instanceof Error ? error.message : String(error) });
        }
      });
    }
    return revoked;
  }

  /** A user without `email_verified_at` is never treated as unconfirmed — which with factors bound means the rule is off, and the app should know. */
  #warnVerificationUnknown(): void {
    if (this.#warnedUnknownVerification || !this.#factors || this.#factors().state instanceof NoTwoFactorState) return;
    this.#warnedUnknownVerification = true;
    this.#logger.warn('The user has no email_verified_at, so a password reset cannot tell an unconfirmed account and keeps its second factors and API tokens. Load the column in the UserProvider, or ignore this if the app does not verify addresses.');
  }
}
