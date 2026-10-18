import { randomBytes } from 'node:crypto';
import { afterCommit, type EventDispatcher, type Logger } from '@marmeon/core';
import { withCode } from '@marmeon/core/internal';
import type { Connections } from '@marmeon/database';
import type { SessionEndings } from '@marmeon/session';
import { accountScope } from '@marmeon/session/internal';
import { keyNotStored, passwordHashWritten, writeRefused } from './account-sessions.ts';
import type { AuthConfig } from './config.ts';
import { PasskeyRemoved, TwoFactorDisabled } from './events.ts';
import type { PasswordHash } from './hashing.ts';
import type { RememberTokenStore } from './remember.ts';
import { SignInTracker } from './sign-ins.ts';
import type { AccessTokenStore } from './tokens.ts';
import { factorSources, NoTwoFactorState, type TwoFactorState } from './two-factor/state.ts';
import type { AuthUser, AuthUserId, UserProvider } from './user.ts';

/** Thrown by {@link NewPassword.store} when the session key of the account changed since the caller read it (an ending landed meanwhile): the password change is rolled back. */
export class AccountClaimLost extends Error {}

/**
 * Stores a new password — what `Auth.updatePassword()` and `PasswordBroker.reset()` share: the new hash with a new session key (that
 * ends every other session), every remember-me token
 * of the user dropped, and with `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true` every API token of the user revoked, in one
 * transaction with the new hash (the app's `UserProvider` joins it), the tokens first — a password that changed never
 * leaves a token behind, and a failed revocation keeps the old password. The token store and the connections are looked up
 * only then: an app that keeps its tokens is not asked for them.
 *
 * A reset of an account whose address was never confirmed (`email_verified_at` is `null` and so is `first_verified_at`, the mark an
 * address once confirmed leaves behind; a user without that property counts by `email_verified_at` alone) also removes every passkey, the authenticator and the recovery codes and revokes every API token, whatever
 * the setting: whoever registered the address first may have attached a way in of their own, and the reset is the owner proving the
 * mailbox. The factors are read again afterwards; one that survived is logged as an error. See `docs/passwords.md#resetting-the-password`.
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
   * Stores `hash` as the password of the user `id` (`via`: a change or a reset), together with a new session key — how many API tokens it
   * revoked and the key (`Auth.updatePassword()` anchors its own session with it). A reset passes the
   * `user` it was made for: with `email_verified_at` of `null` it removes the account's factors and tokens too. A user without that
   * property (an app that does not verify addresses, or a provider that did not load the column) loses nothing; with a factor source
   * bound, that is logged once. A change passes `read`, the session key its session was checked against (`null`: none): the provider
   * writes the new key only over that one, in the statement of the hash (`expectedSessionKey`). A new key written over the key of an
   * `AccountSessions.end()` that landed meanwhile would bring the ended session back, so a refused write — or a later key found
   * when it is read back — throws {@link AccountClaimLost}. Everything runs in one transaction, so that also rolls the tokens back.
   */
  async store(users: UserProvider, remember: RememberTokenStore, id: AuthUserId, hash: PasswordHash, via: 'change' | 'reset', user?: AuthUser, read?: string | null): Promise<{ readonly revoked: number; readonly sessionKey: string }> {
    const sessionKey = randomBytes(32).toString('base64url');
    const unconfirmed = via === 'reset' && user !== undefined && neverConfirmed(user);
    if (via === 'reset' && user !== undefined && (user as { email_verified_at?: unknown }).email_verified_at === undefined) this.#warnVerificationUnknown();
    const removed: { passkeys: boolean; factors: boolean } = { passkeys: false, factors: false };
    // A reset has no session of its own to keep: it writes over whatever key stands.
    const guarded = via === 'change' && read !== undefined;
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
      // The remember-me tokens go before the hash and key: a remember-me sign-in that is running (it consumed its token, then reads the
      // account) must not see the new key next to a token that still exists.
      await remember.forgetUser(id);
      // Inside the transaction: the tokens revoked above come back when the provider refuses to write. The new key is what ends every
      // other session (the fingerprint is made of the id and the key), written in the same statement as the hash.
      // The key a reset replaces is read now, so the read-back below can tell an ignored `sessionKey` from a later ending.
      const previous = read !== undefined ? read : ((await users.findById(id as never))?.sessionKey ?? null);
      const wrote = passwordHashWritten(await users.updatePasswordHash(id as never, hash, guarded ? { sessionKey, expectedSessionKey: read } : { sessionKey }), 'NewPassword');
      if (!wrote) {
        if (guarded) throw new AccountClaimLost('The sessions of the account ended before its password was changed.');
        throw writeRefused('NewPassword');
      }
      // Read back, as `rotateSessionKey()` does: a key that is not a string, or the old one, means the provider ignored `sessionKey` and
      // no other session would end. Another string is a later ending, which ended them as well.
      const stored = await users.findById(id as never);
      if (stored !== undefined && stored.sessionKey !== sessionKey) {
        if (typeof stored.sessionKey !== 'string' || stored.sessionKey === previous) throw keyNotStored('NewPassword');
        if (guarded) throw new AccountClaimLost('The sessions of the account ended before its password was changed.');
      }
      // A reset has no session of its own to keep: every sign-in of the user is over, and none stays listed (a change keeps the current one, `Auth` ends the others).
      if (via === 'reset' && this.#signIns.enabled) await this.#signIns.endAll(id);
      return revoked;
    };
    const revokeTokens = this.#config.revokeTokensOnPasswordChange || unconfirmed;
    // Always in a transaction: a provider that breaks its contract (error A5) or a lost claim leaves neither the hash nor the revocations.
    const revoked = await this.#connections().transaction(() => write(revokeTokens));
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
    return { revoked, sessionKey };
  }

  /**
   * Throws, before a reset token is spent, when a source of the bound `TwoFactorState` cannot remove its factors (no `removeAll()`: JavaScript, a cast):
   * the reset of an account with an unconfirmed address would otherwise fail after the token is used up, and the owner could never reset.
   */
  assertReady(): void {
    const state = this.#factors?.().state;
    if (state && factorSources(state).some((source) => typeof source.removeAll !== 'function')) {
      throw new TypeError(
        withCode(
          'A6',
          'The bound TwoFactorState has a source without removeAll(userId): a password reset could not remove the factors of an account with an unconfirmed address. Implement removeAll() in your source (docs/two-factor-authentication.md#setting-up).',
        ),
      );
    }
  }

  /** A user without `email_verified_at` is never treated as unconfirmed — which with factors bound means the rule is off, and the app should know. */
  #warnVerificationUnknown(): void {
    if (this.#warnedUnknownVerification || !this.#factors || this.#factors().state instanceof NoTwoFactorState) return;
    this.#warnedUnknownVerification = true;
    this.#logger.warn('The user has no email_verified_at, so a password reset cannot tell an unconfirmed account and keeps its second factors and API tokens. Load the column in the UserProvider, or ignore this if the app does not verify addresses.');
  }
}

/** Whether the address of `user` never was confirmed — not once before a later change of address cleared `email_verified_at`. */
function neverConfirmed(user: AuthUser): boolean {
  const { email_verified_at: confirmed, first_verified_at: first } = user as { email_verified_at?: unknown; first_verified_at?: unknown };
  return confirmed === null && (first === null || first === undefined);
}
