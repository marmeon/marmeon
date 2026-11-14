import { Clock, EventDispatcher, Logger, token, type Container, type Resolver } from '@marmeon/core';
import { Connections } from '@marmeon/database';
import { SessionEndings, UserSessions } from '@marmeon/session';
import { AccountSessions } from './account-sessions.ts';
import { Auth } from './auth.ts';
import { AuthConfig } from './config.ts';
import { EmailChangeStore } from './email-changes.ts';
import { SessionFingerprints } from './fingerprint.ts';
import { APP_GUARD_NAMES } from './guard-names.ts';
import { GuardContext } from './guard-context.ts';
import { NewPassword } from './new-password.ts';
import { PasswordResetTokenStore } from './password-reset.ts';
import { SignInStore } from './sign-ins.ts';
import { SignInThrottle } from './sign-in-throttle.ts';
import { AccessTokenStore } from './tokens.ts';
import { SecondFactorPasskeys, TwoFactorState } from './two-factor/state.ts';
import { TwoFactorStore } from './two-factor/store.ts';
import { UserProvider } from './user.ts';

/**
 * Where `PasskeyServiceProvider` hands the app's `PasskeyStore` to the app guard. A token of its own, because the main entry may not
 * import the store (the passkeys subpath stays out of it, even for a type); without the provider nothing is bound and the guard has no passkeys.
 *
 * @internal
 */
export const APP_PASSKEY_STORE = token<object>('AppPasskeyStore');

/**
 * The app's guard: every part is the service the container holds under the framework's own token, looked up on first use, so a binding
 * the app makes (`container.bind(UserProvider, …)`, its own stores) is what the services see. It reads from the container it was built
 * for — a request's scope, or the root for a singleton and a command.
 *
 * @internal
 */
export class AppGuardContext extends GuardContext {
  readonly names = APP_GUARD_NAMES;
  readonly #resolver: Resolver;
  readonly #container: Pick<Container, 'has'>;
  #users: UserProvider | undefined;
  #accountSessions: AccountSessions | undefined;
  #factors: TwoFactorState | undefined;

  constructor(resolver: Resolver, container: Pick<Container, 'has'>) {
    super();
    this.#resolver = resolver;
    this.#container = container;
  }

  get settings(): AuthConfig {
    return this.#resolver.make(AuthConfig);
  }

  get fingerprints(): SessionFingerprints {
    return this.#resolver.make(SessionFingerprints);
  }

  get signInThrottle(): SignInThrottle {
    return this.#resolver.make(SignInThrottle);
  }

  // Kept: the provider is bound per use, and a service holds one for as long as it lives.
  users(): UserProvider {
    return (this.#users ??= this.#resolver.make(UserProvider));
  }

  signIns(): SignInStore {
    return this.#resolver.make(SignInStore);
  }

  passwordResets(): PasswordResetTokenStore {
    return this.#resolver.make(PasswordResetTokenStore);
  }

  accessTokens(): AccessTokenStore {
    return this.#resolver.make(AccessTokenStore);
  }

  emailChanges(): EmailChangeStore | undefined {
    return this.#container.has(EmailChangeStore) ? this.#resolver.make(EmailChangeStore) : undefined;
  }

  userSessions(): UserSessions | undefined {
    return this.#container.has(UserSessions) ? this.#resolver.make(UserSessions) : undefined;
  }

  factors(): TwoFactorState {
    return (this.#factors ??= this.#resolver.make(TwoFactorState));
  }

  totp(): TwoFactorStore {
    return this.#resolver.make(TwoFactorStore);
  }

  passkeyStore(): object | undefined {
    return this.#container.has(APP_PASSKEY_STORE) ? this.#resolver.make(APP_PASSKEY_STORE) : undefined;
  }

  secondFactorPasskeys(): SecondFactorPasskeys {
    return this.#resolver.make(SecondFactorPasskeys);
  }

  newPassword(): NewPassword {
    return this.#resolver.make(NewPassword);
  }

  accountSessions(): AccountSessions {
    return (this.#accountSessions ??= this.#resolver.make(AccountSessions));
  }

  auth(): Auth {
    return this.#resolver.make(Auth);
  }

  connections(): Connections {
    return this.#resolver.make(Connections);
  }

  events(): EventDispatcher {
    return this.#resolver.make(EventDispatcher);
  }

  clock(): Clock {
    return this.#resolver.make(Clock);
  }

  logger(): Logger {
    return this.#resolver.make(Logger);
  }

  endings(): SessionEndings | undefined {
    return this.#container.has(SessionEndings) ? this.#resolver.make(SessionEndings) : undefined;
  }

  event<E extends object>(event: E): E {
    return event;
  }
}
