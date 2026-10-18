import { Clock, defineConfig, env, EventDispatcher, Logger, Redactor, type Application, type ConfigOf, type Container, type ServiceProvider } from '@marmeon/core';
import { Connections } from '@marmeon/database';
import { LiveAudience } from '@marmeon/http';
import { Session, SessionConfig, SessionEndings, UserSessions } from '@marmeon/session';
import { MiddlewarePriority, Router } from '@marmeon/router';
import { AccountSessions } from './account-sessions.ts';
import { Auth } from './auth.ts';
import { NoStoreWhenSignedIn } from './caching.ts';
import { AuthConfig, PRIVATE_REGISTRATION_OFF_WARNING, rememberCookieName } from './config.ts';
import { DEFAULT_HASHER_OPTIONS, HASH_LIMITS, Hasher, PasswordHasher } from './hashing.ts';
import { Gate } from './gate.ts';
import { SignInAudience } from './live-audience.ts';
import { MakeAuthCommand } from './make-auth.ts';
import { EncryptionConfig } from '@marmeon/encryption';
import { SessionFingerprints } from './fingerprint.ts';
import { NewPassword } from './new-password.ts';
import { EndAllSessionsCommand } from './end-all-sessions.ts';
import { PruneTokensCommand } from './prune-tokens.ts';
import { MakeSignInsTableCommand } from './make-sign-ins-table.ts';
import { SignInStore, SignInTracker } from './sign-ins.ts';
import { DatabasePasswordResetTokens, PasswordResetTokenStore } from './password-reset.ts';
import { DatabaseRememberTokens, RememberTokenStore } from './remember.ts';
import { AccessTokenStore, DatabaseAccessTokens } from './tokens.ts';
import { NoSecondFactorPasskeys, NoTwoFactorState, SecondFactorPasskeys, TwoFactorState } from './two-factor/state.ts';
import { TwoFactorStore } from './two-factor/store.ts';
import { UserProvider } from './user.ts';
import { authMigrationUpgrades, requireAuthTables, UserProviderNotBound } from './upgrades.ts';

export { AccountSessions } from './account-sessions.ts';
export type { EveryoneEnded } from './account-sessions.ts';
export type { EndedSessions } from './account-sessions.ts';
export { Auth } from './auth.ts';
export type { AttemptError, LoginOptions } from './auth.ts';
export { AuthConfig, rememberCookieName } from './config.ts';
export { NO_STORE, NoStoreWhenSignedIn } from './caching.ts';
export { EverySessionEnded, Failed, Lockout, Login, Logout, PasswordChanged, PasswordReset, RecoveryCodesGenerated, RecoveryCodeUsed, RememberTokenReused, PasskeyCloneSuspected, PasskeyRegistered, PasskeyRemoved, PasskeySignInFailed, Registered, TwoFactorChallengeFailed, TwoFactorDisabled, TwoFactorEnabled } from './events.ts';
export type { LoginVia, EverySessionEndedInput, EverySessionEndedPayload, LoginInput, LoginPayload, PasskeyCloneSuspectedPayload, PasskeyRegisteredPayload, PasskeyRemovedInput, PasskeyRemovedPayload, PasskeySignInFailedInput, PasskeySignInFailedPayload, RecoveryCodeUsedPayload, RecoveryCodesGeneratedPayload, RegisteredPayload, RememberTokenReusedInput, RememberTokenReusedPayload, TwoFactorChallengeFailedInput, TwoFactorChallengeFailedPayload, TwoFactorDisabledPayload, TwoFactorEnabledPayload } from './events.ts';
export { DatabasePasswordResetTokens, PASSWORD_RESET_TABLE, PasswordBroker, PasswordResetTokenStore } from './password-reset.ts';
export { abilities, authenticate, confirmedPassword, guest } from './middleware.ts';
export type { AuthenticateOptions, ConfirmedPasswordOptions } from './middleware.ts';
export { DatabaseRememberTokens, REMEMBER_TABLE, RememberTokenStore } from './remember.ts';
export { combineFactors, TwoFactorState } from './two-factor/state.ts';
export type { SecondFactor } from './two-factor/state.ts';
export { TwoFactorStore } from './two-factor/store.ts';
export type { RememberedDevice, RememberTokenError } from './remember.ts';
export { allow, AuthorizationError, can, deny, denyAsNotFound, Gate, PolicyResponse } from './gate.ts';
export type { Abilities, AbilityOf, PolicyClass, PolicyResult, ProjectableAbility, Projection, ResourcelessAbility, ResourceOf, ResourcesOf, WithAbilities } from './gate.ts';
export { MakeAuthCommand } from './make-auth.ts';
export { EndAllSessionsCommand } from './end-all-sessions.ts';
export { PruneTokensCommand } from './prune-tokens.ts';
export { describeDevice } from './device.ts';
export type { DeviceDescription } from './device.ts';
export { MakeSignInsTableCommand } from './make-sign-ins-table.ts';
export { clearPasswordCheck, takePasswordCheck } from './password-throttle.ts';
export type { PasswordCheckScope, PasswordThrottled } from './password-throttle.ts';
export { DatabaseSignIns, SignInStore } from './sign-ins.ts';
export type { SignIn, SignInRecord, SignInWindow } from './sign-ins.ts';
export { password } from './rules.ts';
export { EmailVerification, verified } from './verification.ts';
export type { VerifiableUser, VerificationLinkOptions, VerifiedOptions } from './verification.ts';
export type { PasswordRuleOptions } from './rules.ts';
export { AccessTokenStore, DatabaseAccessTokens, parseAccessToken, tokenCan } from './tokens.ts';
export type { AccessToken, AccessTokenId, WithToken } from './tokens.ts';
export { UserProvider } from './user.ts';
export type { AuthTypes, AuthTypesNotDeclared, AuthUser, AuthUserId, Authenticated, Credentials, UserOf } from './user.ts';
export { HashError, Hasher, MAX_PASSWORD_BYTES, PasswordHasher } from './hashing.ts';
export type { Argon2Options, HashDriver, HasherOptions, PasswordHash, ScryptOptions } from './hashing.ts';

const whole = (fallback: number, [min, max]: readonly [number, number]) => env.integer().min(min).max(max).default(fallback);

export const HashConfig = defineConfig('hash', {
  env: env({
    /** `argon2id` (default, OWASP's first choice) or `scrypt` (where Node lacks argon2). Hashes of both are verified either way. */
    HASH_DRIVER: env.in(['argon2id', 'scrypt']).default(DEFAULT_HASHER_OPTIONS.driver),
    /** argon2id: KiB of memory per hash (OWASP: 19456). Tests set it low in `.env.test`. */
    HASH_ARGON_MEMORY: whole(DEFAULT_HASHER_OPTIONS.argon2.memory, HASH_LIMITS.argon2.memory),
    HASH_ARGON_TIME: whole(DEFAULT_HASHER_OPTIONS.argon2.time, HASH_LIMITS.argon2.time),
    HASH_ARGON_PARALLELISM: whole(DEFAULT_HASHER_OPTIONS.argon2.parallelism, HASH_LIMITS.argon2.parallelism),
    /** scrypt: log2 of N (OWASP: 17). */
    HASH_SCRYPT_COST: whole(DEFAULT_HASHER_OPTIONS.scrypt.cost, HASH_LIMITS.scrypt.cost),
    HASH_SCRYPT_BLOCK_SIZE: whole(DEFAULT_HASHER_OPTIONS.scrypt.blockSize, HASH_LIMITS.scrypt.blockSize),
    HASH_SCRYPT_PARALLELISM: whole(DEFAULT_HASHER_OPTIONS.scrypt.parallelism, HASH_LIMITS.scrypt.parallelism),
  }),
  resolve: (e) => ({
    driver: e.HASH_DRIVER,
    argon2: { memory: e.HASH_ARGON_MEMORY, time: e.HASH_ARGON_TIME, parallelism: e.HASH_ARGON_PARALLELISM },
    scrypt: { cost: e.HASH_SCRYPT_COST, blockSize: e.HASH_SCRYPT_BLOCK_SIZE, parallelism: e.HASH_SCRYPT_PARALLELISM },
  }),
});
export type HashConfig = ConfigOf<typeof HashConfig>;

/**
 * Registers the `Hasher` (`HASH_DRIVER`), `Auth` (per request) and the remember-me store, and adds
 * `NoStoreWhenSignedIn` to the `web` group. Found by `marmeon discover`.
 */
export class AuthServiceProvider implements ServiceProvider {
  static config = [HashConfig, AuthConfig];
  /** `marmeon make:upgrade-migrations` writes the reissue of the API tokens into an app whose token table has the first release's form. */
  static migrationUpgrades = authMigrationUpgrades();
  static commands = [MakeAuthCommand, MakeSignInsTableCommand, PruneTokensCommand, EndAllSessionsCommand];

  register(container: Container): void {
    // Built now, not on first use: a Node without argon2 stops the boot with the fix, not the first login.
    container.instance(Hasher, new PasswordHasher(container.make(HashConfig)));
    container.singleton(SessionFingerprints, (c) => new SessionFingerprints(c.make(EncryptionConfig)));
    container.scoped(Auth);
    // A live stream (`@marmeon/live`) asks it whether its sign-in still stands, when it opens and when its browser reconnects.
    container.scoped(LiveAudience, (c) => new SignInAudience(() => c.make(Auth), c.make(Session)));
    // Policies are built in the request's scope: they may depend on anything a controller can.
    container.scoped(Gate, (scope) => new Gate(scope.make(Auth), (Class) => scope.make(Class)));
    // On the app's `remember_tokens` table (its migration comes with make:auth); bind your own store to replace it.
    container.singleton(RememberTokenStore, DatabaseRememberTokens);
    // Nobody has a second factor until the app binds a source: container.bind(TwoFactorState, TwoFactorStore). Removing that binding turns two-factor off for every account.
    container.singleton(TwoFactorState, NoTwoFactorState);
    // Nor does anybody have a passkey as a second factor, until the app registers PasskeyServiceProvider (the passkeys subpath).
    container.singleton(SecondFactorPasskeys, NoSecondFactorPasskeys);
    container.singleton(TwoFactorStore);
    container.singleton(PasswordResetTokenStore, DatabasePasswordResetTokens);
    container.singleton(AccessTokenStore, DatabaseAccessTokens);
    // A new password (a change, a reset): the token store and the connections only when it revokes the API tokens.
    container.singleton(NewPassword, (c) => new NewPassword(() => c.make(AccessTokenStore), () => c.make(Connections), c.make(AuthConfig), c.make(Logger), c.make(SignInTracker), container.has(SessionEndings) ? c.make(SessionEndings) : undefined, () => ({ state: c.make(TwoFactorState), events: c.make(EventDispatcher) })));
    // `bind`, not `singleton`: the UserProvider it holds is bound per use as well.
    container.bind(AccountSessions, (c) => new AccountSessions(c.make(UserProvider), c.make(RememberTokenStore), container.has(UserSessions) ? c.make(UserSessions) : undefined, c.make(SignInTracker), c.make(EventDispatcher), c.make(Clock), () => c.make(PasswordResetTokenStore), () => c.make(AccessTokenStore), c.make(Logger), container.has(SessionEndings) ? c.make(SessionEndings) : undefined));
    // Sign-ins are opt-in: without `container.singleton(SignInStore, DatabaseSignIns)` (and its table) `Auth` tracks none.
    container.singleton(SignInTracker, (c) => new SignInTracker(container.has(SignInStore) ? () => c.make(SignInStore) : undefined));
    // Until the app binds its own (its auth module does — `marmeon make:auth` writes one), the first use explains.
    container.bind(UserProvider, () => {
      throw new UserProviderNotBound(
        'Authentication needs to know where users come from: bind a UserProvider in a provider of your auth module — ' +
          'container.bind(UserProvider, UserRepository) — and declare the user type: ' +
          "declare module '@marmeon/auth' { interface AuthTypes { user: User } }. `marmeon make:auth` sets this up.",
      );
    });
  }

  async boot(app: Application): Promise<void> {
    // Nothing a signed-in user saw stays in the browser's HTTP cache (Back after signing out).
    app.container.make(Router).middleware.append('web', NoStoreWhenSignedIn, MiddlewarePriority.preventCaching);
    // Private registration turned off where it counts: said once, at boot — like the log mailer.
    const config = app.container.make(AuthConfig);
    // The remember-me cookie's value signs in: never shown or recorded, whatever its name.
    if (app.container.has(Redactor) && app.container.has(SessionConfig)) {
      app.container.make(Redactor).addKeys(rememberCookieName(config, app.container.make(SessionConfig)));
    }
    if (config.protected && !config.privateRegistration) app.container.make(Logger).warn(PRIVATE_REGISTRATION_OFF_WARNING, { privateRegistration: false });
    // /up/ready is red until the tables of the stores in use have every column the stores need.
    await requireAuthTables(app.container);
  }
}
