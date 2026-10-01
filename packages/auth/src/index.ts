import { defineConfig, type Application, type ConfigOf, type Container, type ServiceProvider } from '@bespokecore/core';
import * as v from 'valibot';
import { Auth } from './auth.ts';
import { AuthConfig } from './config.ts';
import { DEFAULT_HASHER_OPTIONS, HASH_LIMITS, Hasher, PasswordHasher } from './hashing.ts';
import { Gate } from './gate.ts';
import { DatabasePasswordResetTokens, PasswordResetTokenStore } from './password-reset.ts';
import { DatabaseRememberTokens, RememberTokenStore } from './remember.ts';
import { AccessTokenStore, DatabaseAccessTokens } from './tokens.ts';
import { UserProvider } from './user.ts';

// Authentication (Wave 4): hashing, the session guard, middleware; policies and tokens follow.
export { Auth, AUTH_SESSION_KEYS, passwordFingerprint } from './auth.ts';
export type { LoginOptions } from './auth.ts';
export { AuthConfig } from './config.ts';
export { Failed, Lockout, Login, Logout, PasswordChanged, PasswordReset, Registered } from './events.ts';
export { DatabasePasswordResetTokens, PASSWORD_RESET_TABLE, PasswordBroker, PasswordResetTokenStore } from './password-reset.ts';
export type { PasswordResetTokenTable } from './password-reset.ts';
export { abilities, authenticate, confirmedPassword, guest } from './middleware.ts';
export type { AuthenticateOptions, ConfirmedPasswordOptions } from './middleware.ts';
export { DatabaseRememberTokens, REMEMBER_TABLE, RememberTokenStore } from './remember.ts';
export type { RememberResult, RememberTokenTable } from './remember.ts';
export { allow, AuthorizationError, can, deny, denyAsNotFound, Gate, PolicyResponse } from './gate.ts';
export type { AbilityOf, PolicyClass, PolicyResult, ResourcesOf } from './gate.ts';
export { confirmed, password } from './rules.ts';
export { EmailVerification, emailHash, verified } from './verification.ts';
export type { VerifiableUser, VerificationLinkOptions, VerifiedOptions } from './verification.ts';
export type { PasswordRuleOptions } from './rules.ts';
export { authenticatedSession, authenticatedToken } from './testing.ts';
export { ACCESS_TOKEN_TABLE, AccessTokenStore, DatabaseAccessTokens, parseAccessToken, tokenCan } from './tokens.ts';
export type { AccessToken, AccessTokenTable, WithToken } from './tokens.ts';
export { UserProvider } from './user.ts';
export type { AuthTypes, AuthTypesNotDeclared, AuthUser, AuthUserId, Authenticated, Credentials, UserOf } from './user.ts';
export {
  argon2Available,
  DEFAULT_HASHER_OPTIONS,
  HASH_LIMITS,
  HashError,
  Hasher,
  MAX_PASSWORD_BYTES,
  PasswordHasher,
} from './hashing.ts';
export type { Argon2Options, HashDriver, HasherOptions, PasswordHash, ScryptOptions } from './hashing.ts';

const whole = (fallback: number, [min, max]: readonly [number, number]) =>
  v.optional(v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(min), v.maxValue(max)), String(fallback));

export const HashConfig = defineConfig('hash', {
  env: v.object({
    /** `argon2id` (default, OWASP's first choice) or `scrypt` (where Node lacks argon2). Hashes of both are verified either way. */
    HASH_DRIVER: v.optional(v.picklist(['argon2id', 'scrypt']), DEFAULT_HASHER_OPTIONS.driver),
    /** argon2id: KiB of memory per hash (OWASP: 19456). Tests set it low in `.env.test`. */
    HASH_ARGON_MEMORY: whole(DEFAULT_HASHER_OPTIONS.argon2.memory, HASH_LIMITS.argon2.memory),
    HASH_ARGON_TIME: whole(DEFAULT_HASHER_OPTIONS.argon2.time, HASH_LIMITS.argon2.time),
    HASH_ARGON_PARALLELISM: whole(DEFAULT_HASHER_OPTIONS.argon2.parallelism, HASH_LIMITS.argon2.parallelism),
    /** scrypt: log2 of N (OWASP: 17). */
    HASH_SCRYPT_COST: whole(DEFAULT_HASHER_OPTIONS.scrypt.cost, HASH_LIMITS.scrypt.cost),
    HASH_SCRYPT_BLOCK_SIZE: whole(DEFAULT_HASHER_OPTIONS.scrypt.blockSize, HASH_LIMITS.scrypt.blockSize),
    HASH_SCRYPT_PARALLELISM: whole(DEFAULT_HASHER_OPTIONS.scrypt.parallelism, HASH_LIMITS.scrypt.parallelism),
  }),
  resolve: (env) => ({
    driver: env.HASH_DRIVER,
    argon2: { memory: env.HASH_ARGON_MEMORY, time: env.HASH_ARGON_TIME, parallelism: env.HASH_ARGON_PARALLELISM },
    scrypt: { cost: env.HASH_SCRYPT_COST, blockSize: env.HASH_SCRYPT_BLOCK_SIZE, parallelism: env.HASH_SCRYPT_PARALLELISM },
  }),
});
export type HashConfig = ConfigOf<typeof HashConfig>;

/** Registers the `Hasher` (`HASH_DRIVER`), `Auth` (per request) and the remember-me store. Found by `bespoke discover`. */
export class AuthServiceProvider implements ServiceProvider {
  static config = [HashConfig, AuthConfig];

  register(container: Container): void {
    // Built now, not on first use: a Node without argon2 stops the boot with the fix, not the first login.
    container.instance(Hasher, new PasswordHasher(container.make(HashConfig)));
    container.scoped(Auth);
    // Policies are built in the request's scope: they may depend on anything a controller can.
    container.scoped(Gate, (scope) => new Gate(scope.make(Auth), (Class) => scope.make(Class)));
    // On the app's `remember_tokens` table (its migration comes with make:auth); bind your own store to replace it.
    container.singleton(RememberTokenStore, DatabaseRememberTokens);
    container.singleton(PasswordResetTokenStore, DatabasePasswordResetTokens);
    container.singleton(AccessTokenStore, DatabaseAccessTokens);
  }

  boot(app: Application): void {
    if (app.modules.length > 0 && !app.container.has(UserProvider)) {
      throw new Error(
        'Authentication needs to know where users come from: bind a UserProvider in a provider of your auth module — ' +
          'container.bind(UserProvider, UserRepository) — and declare the user type: ' +
          "declare module '@bespokecore/auth' { interface AuthTypes { user: User } }.",
      );
    }
  }
}
