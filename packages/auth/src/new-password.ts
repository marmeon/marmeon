import { afterCommit, type Logger } from '@marmeon/core';
import type { Connections } from '@marmeon/database';
import { accountScope, type SessionEndings } from '@marmeon/session';
import type { AuthConfig } from './config.ts';
import type { PasswordHash } from './hashing.ts';
import type { RememberTokenStore } from './remember.ts';
import { SignInTracker } from './sign-ins.ts';
import type { AccessTokenStore } from './tokens.ts';
import type { UserProvider } from './user.ts';

/**
 * Stores a new password — what `Auth.updatePassword()` and `PasswordBroker.reset()` share: the new hash, every remember-me token
 * of the user dropped, and with `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true` every API token of the user revoked, in one
 * transaction with the new hash (the app's `UserProvider` joins it), the tokens first — a password that changed never
 * leaves a token behind, and a failed revocation keeps the old password. The token store and the connections are looked up
 * only then: an app that keeps its tokens is not asked for them.
 */
export class NewPassword {
  readonly #tokens: () => AccessTokenStore;
  readonly #connections: () => Connections;
  readonly #config: AuthConfig;
  readonly #logger: Logger;
  readonly #signIns: SignInTracker;
  readonly #endings: SessionEndings | undefined;

  constructor(tokens: () => AccessTokenStore, connections: () => Connections, config: AuthConfig, logger: Logger, signIns: SignInTracker = new SignInTracker(undefined), endings?: SessionEndings) {
    this.#endings = endings;
    this.#tokens = tokens;
    this.#connections = connections;
    this.#config = config;
    this.#logger = logger;
    this.#signIns = signIns;
  }

  /** Stores `hash` as the password of the user `id` (`via`: a change or a reset) — how many API tokens it revoked. */
  async store(users: UserProvider, remember: RememberTokenStore, id: string | number, hash: PasswordHash, via: 'change' | 'reset'): Promise<number> {
    const write = async (revoke: boolean): Promise<number> => {
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
    const revoked = this.#config.revokeTokensOnPasswordChange ? await this.#connections().transaction(() => write(true)) : await write(false);
    if (this.#config.revokeTokensOnPasswordChange) this.#logger.info('A new password revoked the API tokens of the user', { user: id, tokens: revoked, via });
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
}
