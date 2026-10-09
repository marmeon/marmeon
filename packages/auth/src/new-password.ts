import type { Logger } from '@marmeon/core';
import type { Connections } from '@marmeon/database';
import type { AuthConfig } from './config.ts';
import type { PasswordHash } from './hashing.ts';
import type { RememberTokenStore } from './remember.ts';
import type { AccessTokenStore } from './tokens.ts';
import type { UserProvider } from './user.ts';

/**
 * Stores a new password — what `Auth.updatePassword()` and `PasswordBroker.reset()` share: the new hash, every remember-me token
 * of the user dropped, and with `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true` every API token of the user revoked, in one
 * transaction with the new hash (the app's `UserProvider` joins it, E107) — a password that changed never leaves a token behind,
 * and a failed revocation keeps the old password. The token store and the connections are looked up only then: an app that
 * keeps its tokens is not asked for them.
 */
export class NewPassword {
  readonly #tokens: () => AccessTokenStore;
  readonly #connections: () => Connections;
  readonly #config: AuthConfig;
  readonly #logger: Logger;

  constructor(tokens: () => AccessTokenStore, connections: () => Connections, config: AuthConfig, logger: Logger) {
    this.#tokens = tokens;
    this.#connections = connections;
    this.#config = config;
    this.#logger = logger;
  }

  /** Stores `hash` as the password of the user `id` (`via`: a change or a reset) — how many API tokens it revoked. */
  async store(users: UserProvider, remember: RememberTokenStore, id: string | number, hash: PasswordHash, via: 'change' | 'reset'): Promise<number> {
    const write = async (revoke: boolean): Promise<number> => {
      await users.updatePasswordHash(id as never, hash);
      await remember.forgetUser(id);
      return revoke ? this.#tokens().revokeAll(id) : 0;
    };
    if (!this.#config.revokeTokensOnPasswordChange) return write(false);
    const revoked = await this.#connections().transaction(() => write(true));
    this.#logger.info('A new password revoked the API tokens of the user', { user: id, tokens: revoked, via });
    return revoked;
  }
}
