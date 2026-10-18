import { AccessTokenStore, type AccessToken, type AccessTokenId } from '../tokens.ts';
import { TwoFactorState, type SecondFactor } from '../two-factor/state.ts';
import type { AuthUserId } from '../user.ts';

/** The methods of a {@link TwoFactorState} a test can replace in {@link twoFactorState}. */
export interface TwoFactorParts {
  factors?: (userId: AuthUserId) => Promise<readonly SecondFactor[]>;
  enabledSince?: (userId: AuthUserId) => Promise<Date | undefined>;
  removeAll?: (userId: AuthUserId) => Promise<void>;
}

/** A {@link TwoFactorState} for a test: no factors and nothing to remove, unless the test hands in the method it needs. */
export function twoFactorState(parts: TwoFactorParts = {}): TwoFactorState {
  return new FakeTwoFactorState(parts);
}

class FakeTwoFactorState extends TwoFactorState {
  readonly #parts: TwoFactorParts;

  constructor(parts: TwoFactorParts) {
    super();
    this.#parts = parts;
  }

  async factors(userId: AuthUserId): Promise<readonly SecondFactor[]> {
    return (await this.#parts.factors?.(userId)) ?? [];
  }

  async enabledSince(userId: AuthUserId): Promise<Date | undefined> {
    return this.#parts.enabledSince?.(userId);
  }

  async removeAll(userId: AuthUserId): Promise<void> {
    await this.#parts.removeAll?.(userId);
  }
}

/** The methods of an {@link AccessTokenStore} a test can replace in {@link accessTokenStore}. */
export type AccessTokenParts = {
  [K in 'create' | 'find' | 'touch' | 'list' | 'revoke' | 'revokeAll' | 'prune' | 'revokeEveryone']?: AccessTokenStore[K];
};

/** An {@link AccessTokenStore} that holds no tokens: `create` throws, `find` finds nothing, every revocation counts zero — unless the test replaces a method. */
export function accessTokenStore(parts: AccessTokenParts = {}): AccessTokenStore {
  return new FakeAccessTokens(parts);
}

class FakeAccessTokens extends AccessTokenStore {
  readonly #parts: AccessTokenParts;

  constructor(parts: AccessTokenParts) {
    super();
    this.#parts = parts;
  }

  async create(...args: Parameters<AccessTokenStore['create']>): ReturnType<AccessTokenStore['create']> {
    if (this.#parts.create === undefined) throw new Error('not used');
    return this.#parts.create(...args);
  }

  async find(plainText: string): Promise<AccessToken | undefined> {
    return this.#parts.find?.(plainText);
  }

  async touch(token: AccessToken): Promise<void> {
    await this.#parts.touch?.(token);
  }

  async list(userId: AuthUserId): Promise<AccessToken[]> {
    return (await this.#parts.list?.(userId)) ?? [];
  }

  async revoke(userId: AuthUserId, id: AccessTokenId): Promise<boolean> {
    return (await this.#parts.revoke?.(userId, id)) ?? false;
  }

  async revokeAll(userId: AuthUserId): Promise<number> {
    return (await this.#parts.revokeAll?.(userId)) ?? 0;
  }

  async prune(graceSeconds?: number): Promise<number> {
    return (await this.#parts.prune?.(graceSeconds)) ?? 0;
  }

  async revokeEveryone(): Promise<number> {
    return (await this.#parts.revokeEveryone?.()) ?? 0;
  }
}
