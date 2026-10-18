import { err, type Result } from '@marmeon/core';
import { SignInStore, type RememberedDevice, type RememberTokenError, type SignInRecord, type SignInWindow } from '../sign-ins.ts';
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

/** The methods of a {@link SignInStore} a test can replace in {@link signInStore}. */
export type SignInParts = {
  [K in 'create' | 'seen' | 'list' | 'end' | 'endAll' | 'endEveryone' | 'prune' | 'issueToken' | 'dropToken' | 'consume' | 'remembered' | 'forgetToken' | 'rebind']?: SignInStore[K];
};

/** A {@link SignInStore} that holds no sign-ins: nothing is found or ended, no cookie is valid, `issueToken` throws — unless the test replaces a method. */
export function signInStore(parts: SignInParts = {}): SignInStore {
  return new FakeSignIns(parts);
}

class FakeSignIns extends SignInStore {
  readonly #parts: SignInParts;

  constructor(parts: SignInParts) {
    super();
    this.#parts = parts;
  }

  async create(input: Parameters<SignInStore['create']>[0]): Promise<string> {
    return (await this.#parts.create?.(input)) ?? 'A'.repeat(22);
  }

  async seen(userId: AuthUserId, id: string, touch: boolean): Promise<boolean> {
    return (await this.#parts.seen?.(userId, id, touch)) ?? true;
  }

  async list(userId: AuthUserId, window: SignInWindow): Promise<readonly SignInRecord[]> {
    return (await this.#parts.list?.(userId, window)) ?? [];
  }

  async end(userId: AuthUserId, id: string): Promise<boolean> {
    return (await this.#parts.end?.(userId, id)) ?? false;
  }

  async endAll(userId: AuthUserId, except?: string): Promise<number> {
    return (await this.#parts.endAll?.(userId, except)) ?? 0;
  }

  async endEveryone(): Promise<number> {
    return (await this.#parts.endEveryone?.()) ?? 0;
  }

  async prune(window: SignInWindow, rememberMaxAgeDays: number): Promise<number> {
    return (await this.#parts.prune?.(window, rememberMaxAgeDays)) ?? 0;
  }

  async issueToken(userId: AuthUserId, id: string, token: { until: Date; fingerprint: string }): Promise<string> {
    if (this.#parts.issueToken === undefined) throw new Error('not used');
    return this.#parts.issueToken(userId, id, token);
  }

  async dropToken(userId: AuthUserId, id: string): Promise<void> {
    await this.#parts.dropToken?.(userId, id);
  }

  async consume(cookie: string): Promise<Result<RememberedDevice, RememberTokenError>> {
    return (await this.#parts.consume?.(cookie)) ?? err({ kind: 'invalid' });
  }

  async remembered(cookie: string): Promise<boolean> {
    return (await this.#parts.remembered?.(cookie)) ?? false;
  }

  async forgetToken(cookie: string): Promise<void> {
    await this.#parts.forgetToken?.(cookie);
  }

  async rebind(userId: AuthUserId, cookie: string, fingerprint: string): Promise<Result<void, RememberTokenError>> {
    return (await this.#parts.rebind?.(userId, cookie, fingerprint)) ?? err({ kind: 'invalid' });
  }
}

/** A {@link SignInStore} that hands every call on to another one: a test overrides the method it wants to change or watch. */
export class DelegatingSignIns extends SignInStore {
  readonly inner: SignInStore;

  constructor(inner: SignInStore) {
    super();
    this.inner = inner;
  }

  create(...args: Parameters<SignInStore['create']>): Promise<string> {
    return this.inner.create(...args);
  }
  seen(...args: Parameters<SignInStore['seen']>): Promise<boolean> {
    return this.inner.seen(...args);
  }
  list(...args: Parameters<SignInStore['list']>): Promise<readonly SignInRecord[]> {
    return this.inner.list(...args);
  }
  end(...args: Parameters<SignInStore['end']>): Promise<boolean> {
    return this.inner.end(...args);
  }
  endAll(...args: Parameters<SignInStore['endAll']>): Promise<number> {
    return this.inner.endAll(...args);
  }
  endEveryone(): Promise<number> {
    return this.inner.endEveryone();
  }
  prune(...args: Parameters<SignInStore['prune']>): Promise<number> {
    return this.inner.prune(...args);
  }
  issueToken(...args: Parameters<SignInStore['issueToken']>): Promise<string> {
    return this.inner.issueToken(...args);
  }
  dropToken(...args: Parameters<SignInStore['dropToken']>): Promise<void> {
    return this.inner.dropToken(...args);
  }
  consume(cookie: string): Promise<Result<RememberedDevice, RememberTokenError>> {
    return this.inner.consume(cookie);
  }
  remembered(cookie: string): Promise<boolean> {
    return this.inner.remembered(cookie);
  }
  forgetToken(cookie: string): Promise<void> {
    return this.inner.forgetToken(cookie);
  }
  rebind(...args: Parameters<SignInStore['rebind']>): Promise<Result<void, RememberTokenError>> {
    return this.inner.rebind(...args);
  }
}
