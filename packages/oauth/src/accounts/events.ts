import type { AuthUser } from '@marmeon/auth';

/** A provider account was linked to a user, by signing in or registering with it, or by linking it. Dispatched after the change. See docs/oauth.md#linking-and-unlinking. */
export class SocialAccountLinked {
  static readonly event = 'oauth.social-account-linked';
  readonly #event = true;
  readonly user: AuthUser;
  readonly provider: string;
  readonly email: string | null;
  readonly nickname: string | null;

  /** @internal Made by `SocialAccounts` when it dispatches the event. */
  constructor(user: AuthUser, provider: string, email: string | null, nickname: string | null) {
    this.user = user;
    this.provider = provider;
    this.email = email;
    this.nickname = nickname;
  }
}

/** A user unlinked a provider account. Dispatched after the change. See docs/oauth.md#linking-and-unlinking. */
export class SocialAccountUnlinked {
  static readonly event = 'oauth.social-account-unlinked';
  readonly #event = true;
  readonly user: AuthUser;
  readonly provider: string;

  /** @internal Made by `SocialAccounts` when it dispatches the event. */
  constructor(user: AuthUser, provider: string) {
    this.user = user;
    this.provider = provider;
  }
}
